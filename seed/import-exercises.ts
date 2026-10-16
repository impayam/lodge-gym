// Exercise library import (SPEC-v2 §7.1, SPEC-v11 M14 Phase A): free-exercise-db (Unlicense) at a pinned commit, the
// hand-written gap fill, and the reviewed rows from the M14 sources (wger, everkinetic, ExerciseDB, Liftosaur,
// exercemus; seed/library/m14/) → D1 rows; every library exercise's region tags → exercise_regions; images copied to
// the private R2 bucket (free-exercise-db's, and wger's and everkinetic's whose own licence allows it); each source
// snapshotted in R2. Idempotent and resumable: rows and tags are written only when a value differs, and R2 manifests
// list the images and snapshots already stored, so an interrupted run continues where it stopped. Polite to the
// sources: a few downloads in flight, with a short pause after each. With --time-budget the image copy stops starting
// new uploads after that many seconds (Workers Builds stops a build at 20 minutes); the next run resumes.
//
//   npx tsx seed/import-exercises.ts --remote [--only d1|media] [--time-budget <s>]   production (deploy:ci)
//   npx tsx seed/import-exercises.ts --local [--persist-to <dir>] [--dataset <file>] [--images <dir>] [--source-media skip]
//   npx tsx seed/import-exercises.ts --report [--dataset <file>]   writes seed/library/IMPORT-REPORT.md and seed/library/m14/IMPORT-REPORT.md only

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEDB_PREFIX,
  FEDB_RAW,
  FEDB_SHA,
  buildLibrary,
  imageKeys,
  librarySql,
  reportMarkdown,
  unknownReviewIds,
  type EquipmentReview,
  type FedbExercise,
  type LibraryRow,
  type ManualExercise,
  type PatternFile,
  type SeedMatch,
} from "../worker/lib/library";
import {
  SOURCE_MEDIA_PREFIX,
  exactRepeats,
  imageType,
  libraryRegionTags,
  regionsSql,
  sourceImageKey,
  sourceRows,
  validateDecisions,
  type DecisionFile,
  type DedupeEntry,
  type ScreeningFile,
} from "../worker/lib/libraryDecisions";
import { SOURCES, SOURCE_ORDER, sourceFileUrl, type SourceKey } from "../worker/lib/librarySources";
import { m14ReportMarkdown } from "../worker/lib/libraryReport";
import type { RegionOverrides } from "../worker/lib/regions";

const BUCKET = "lodge-gym-photos";
const MANIFEST = `${FEDB_PREFIX}manifest.json`;
const SOURCES_MANIFEST = `${SOURCE_MEDIA_PREFIX}manifest.json`;
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const root = here("../");
const readJson = <T>(p: string): T => JSON.parse(readFileSync(here(p), "utf8")) as T;

interface Args {
  mode: "remote" | "local" | "report";
  persistTo?: string;
  dataset?: string;
  images?: string;
  only?: "d1" | "media";
  timeBudget?: number;
  sourceMedia: "copy" | "skip";
}

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = { sourceMedia: "copy" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--remote" || k === "--local" || k === "--report") a.mode = k.slice(2) as Args["mode"];
    else if (k === "--persist-to") a.persistTo = argv[++i];
    else if (k === "--dataset") a.dataset = argv[++i];
    else if (k === "--images") a.images = argv[++i];
    else if (k === "--only") a.only = argv[++i] as Args["only"];
    else if (k === "--time-budget") a.timeBudget = Number(argv[++i]);
    else if (k === "--source-media") a.sourceMedia = argv[++i] as Args["sourceMedia"];
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.mode) throw new Error("pass --remote, --local or --report");
  if (a.only && a.only !== "d1" && a.only !== "media") throw new Error("--only takes d1 or media");
  if (a.timeBudget !== undefined && !(a.timeBudget > 0)) throw new Error("--time-budget takes a number of seconds");
  if (a.sourceMedia !== "copy" && a.sourceMedia !== "skip") throw new Error("--source-media takes copy or skip");
  return a as Args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "lodge-gym-library-import (personal app)" } });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) throw new Error(`${url}: HTTP ${res.status}`);
      if (attempt >= 4) throw new Error(`${url}: HTTP ${res.status}`);
    } catch (e) {
      if (attempt >= 4 || (e instanceof Error && e.message.includes("HTTP 4"))) throw e;
    }
    await sleep(2000 * 2 ** attempt);
  }
}

/** Runs wrangler from this project's node_modules. Resolves with stdout; rejects with stderr on failure. */
function wrangler(args: string[], target: Args): Promise<Buffer> {
  const where = target.mode === "remote" ? ["--remote"] : ["--local", ...(target.persistTo ? ["--persist-to", target.persistTo] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(join(root, "node_modules/.bin/wrangler"), [...args, ...where], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`wrangler ${args.slice(0, 3).join(" ")} exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`))));
  });
}

interface Manifest {
  sha: string;
  snapshot: string | null;
  images: string[];
}
/** The M14 sources' manifest: the snapshot stored per source commit, and the images already copied. */
interface SourcesManifest {
  snapshots: Record<string, string>;
  images: string[];
}

async function getObject(t: Args, dir: string, key: string): Promise<string | null> {
  const file = join(dir, "object.json");
  try {
    await wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--file", file], t);
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

async function putJson(t: Args, dir: string, key: string, value: unknown) {
  const file = join(dir, "put.json");
  writeFileSync(file, JSON.stringify(value));
  await wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", "application/json"], t);
}

async function readManifest(t: Args, dir: string): Promise<Manifest> {
  const text = await getObject(t, dir, MANIFEST);
  const m = text ? (JSON.parse(text) as Manifest) : null;
  return m && m.sha === FEDB_SHA ? m : { sha: FEDB_SHA, snapshot: null, images: [] };
}

const writeManifest = (t: Args, dir: string, m: Manifest) => putJson(t, dir, MANIFEST, { ...m, images: [...new Set(m.images)].sort() });

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

/** The M14 inputs: decision files, the duplicate review, the screening and the reviewed region overrides. */
function m14Inputs() {
  const files: DecisionFile[] = SOURCE_ORDER.filter((s) => existsSync(here(`./library/m14/${s}.json`))).map((s) => readJson<DecisionFile>(`./library/m14/${s}.json`));
  const dedupe = existsSync(here("./library/m14/dedupe-review.json")) ? readJson<DedupeEntry[]>("./library/m14/dedupe-review.json") : [];
  const screening = existsSync(here("./library/m14/screening.json")) ? readJson<ScreeningFile>("./library/m14/screening.json") : null;
  const overrides = readJson<RegionOverrides>("./library/region-overrides.json");
  return { files, dedupe, screening, overrides };
}

async function main() {
  const started = Date.now();
  const t = parseArgs(process.argv.slice(2));
  const datasetText = t.dataset ? readFileSync(t.dataset, "utf8") : await (await fetchRetry(`${FEDB_RAW}/dist/exercises.json`)).text();
  const dataset = JSON.parse(datasetText) as FedbExercise[];
  const review = readJson<EquipmentReview>("./library/fedb-equipment.json");
  // The review file describes the pinned dataset; a --dataset file (test fixtures) holds only a sample of it.
  const unknown = t.dataset ? [] : unknownReviewIds(dataset, review);
  if (unknown.length) throw new Error(`seed/library/fedb-equipment.json names entries the dataset does not have: ${unknown.join(", ")}`);
  const program = readJson<{ exercises: { id: string; name_en: string; muscle_primary: string; equipment: LibraryRow["equipment"] }[] }>("./program.json");
  const seedPrimary = Object.fromEntries(program.exercises.map((e) => [e.id, e.muscle_primary]));
  const lib = buildLibrary(
    dataset,
    readJson<PatternFile>("./library/fedb-patterns.json"),
    readJson<SeedMatch[]>("./library/seed-matches.json"),
    readJson<ManualExercise[]>("./library/manual.json"),
    seedPrimary,
    review
  );

  // M14 sources: reviewed decisions → rows. Exact repeats of the library are refused, never merged.
  const m14 = m14Inputs();
  const base = [...program.exercises.map((e) => ({ id: e.id, name_en: e.name_en, equipment: e.equipment })), ...lib.rows];
  // As with the equipment review: a --dataset sample lacks most duplicate targets (tests/lib/m14Data.test.ts checks them).
  const decisionErrors = validateDecisions(m14.files, m14.dedupe, t.dataset ? null : new Set(base.map((r) => r.id)));
  if (decisionErrors.length) throw new Error("seed/library/m14 decisions are invalid:\n" + decisionErrors.join("\n"));
  const added = sourceRows(m14.files, m14.dedupe);
  const repeats = exactRepeats(added, base);
  if (repeats.length) throw new Error("reviewed rows repeat library exercises (decide them in seed/library/m14/dedupe-review.json):\n" + repeats.join("\n"));
  const rows = [...lib.rows, ...added];

  // Region tags (SPEC-v11 A3) of every exercise the import manages: the seeded ones and the library rows.
  const tags = libraryRegionTags(program.exercises, lib.seedUpdates, rows, m14.overrides);

  if (t.mode === "report") {
    writeFileSync(here("./library/IMPORT-REPORT.md"), reportMarkdown(lib.report) + "\n");
    if (!m14.screening) throw new Error("seed/library/m14/screening.json is missing: run seed/library/m14/screen.ts first");
    const seedRows = program.exercises.map((e) => {
      const s = lib.seedUpdates.find((u) => u.id === e.id);
      return { id: e.id, name_en: e.name_en, muscle_primary: e.muscle_primary, category: "strength" as const, source: "seed" as const, muscles_secondary: s?.muscles_secondary ?? [] };
    });
    writeFileSync(here("./library/m14/IMPORT-REPORT.md"), m14ReportMarkdown({ screening: m14.screening, files: m14.files, dedupe: m14.dedupe, before: [...seedRows, ...lib.rows], added, tags }) + "\n");
    console.log(`seed/library/IMPORT-REPORT.md and seed/library/m14/IMPORT-REPORT.md: ${rows.length} library rows (${added.length} from the M14 sources), ${[...tags.values()].reduce((n, x) => n + x.length, 0)} region tags`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "lg-library-"));
  try {
    if (t.only !== "media") {
      const sqlFile = join(dir, "library.sql");
      writeFileSync(sqlFile, [...librarySql(rows, lib.seedUpdates), ...regionsSql(tags)].join("\n") + "\n");
      await wrangler(["d1", "execute", "DB", "--file", sqlFile, "--yes"], t);
      console.log(
        `D1: ${rows.length} library rows (${added.length} from the M14 sources) and ${lib.seedUpdates.length} seeded exercises upserted; region tags for ${tags.size} exercises (unchanged rows and tags are not rewritten)`
      );
    }
    if (t.only === "d1") return;

    const manifest = await readManifest(t, dir);
    if (!manifest.snapshot) {
      const key = `${FEDB_PREFIX}${new Date().toISOString().slice(0, 10)}.json`;
      const snap = join(dir, "snapshot.json");
      writeFileSync(snap, datasetText);
      await wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", snap, "--content-type", "application/json"], t);
      manifest.snapshot = key;
      await writeManifest(t, dir, manifest);
      console.log(`R2: snapshot ${key}`);
    }
    const done = new Set(manifest.images);
    const todo = imageKeys(lib.rows, lib.seedUpdates).filter((k) => k.startsWith(FEDB_PREFIX) && !done.has(k));
    console.log(`R2: ${done.size} free-exercise-db images already copied, ${todo.length} to copy`);
    let since = 0;
    let saving: Promise<void> = Promise.resolve();
    // Local R2 storage does not take concurrent writers; production copies six at a time.
    let copied = 0;
    await pool(todo, t.mode === "local" ? 1 : 6, async (key) => {
      if (t.timeBudget && Date.now() - started > t.timeBudget * 1000) return;
      const rel = key.slice(`${FEDB_PREFIX}images/`.length);
      let bytes: Uint8Array;
      if (t.images) {
        const p = join(t.images, rel);
        if (!existsSync(p)) throw new Error(`missing fixture image ${p}`);
        bytes = readFileSync(p);
      } else {
        bytes = new Uint8Array(await (await fetchRetry(`${FEDB_RAW}/exercises/${rel}`)).arrayBuffer());
        await sleep(150);
      }
      const file = join(dir, rel.replace(/[^A-Za-z0-9._-]/g, "_"));
      writeFileSync(file, bytes);
      await wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", "image/jpeg"], t);
      rmSync(file);
      manifest.images.push(key);
      copied++;
      if (++since >= 40) {
        since = 0;
        saving = saving.then(() => writeManifest(t, dir, manifest));
        await saving;
      }
    });
    await saving;
    await writeManifest(t, dir, manifest);
    console.log(`R2: ${copied} free-exercise-db images copied${copied < todo.length ? `, ${todo.length - copied} left for the next run (time budget)` : ""}`);

    if (t.sourceMedia === "skip") return;
    await copySources(t, dir, started, added, m14.files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Snapshots each M14 source (once per pinned commit) and copies the images the added rows store. */
async function copySources(t: Args, dir: string, started: number, added: LibraryRow[], files: DecisionFile[]) {
  const text = await getObject(t, dir, SOURCES_MANIFEST);
  const manifest: SourcesManifest = text ? (JSON.parse(text) as SourcesManifest) : { snapshots: {}, images: [] };
  const save = () => putJson(t, dir, SOURCES_MANIFEST, { snapshots: manifest.snapshots, images: [...new Set(manifest.images)].sort() });
  const date = new Date().toISOString().slice(0, 10);
  for (const s of files.map((f) => f.source)) {
    const id = `${s}@${SOURCES[s].sha}`;
    if (manifest.snapshots[id]) continue;
    for (const role of Object.keys(SOURCES[s].files)) {
      const key = `${SOURCE_MEDIA_PREFIX}${s}/snapshots/${date}-${SOURCES[s].sha.slice(0, 7)}-${role}${SOURCES[s].files[role].replace(/^.*(\.[a-z]+)$/, "$1")}`;
      const file = join(dir, "snapshot");
      writeFileSync(file, new Uint8Array(await (await fetchRetry(sourceFileUrl(s as SourceKey, role))).arrayBuffer()));
      await wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", key.endsWith(".json") ? "application/json" : "text/plain"], t);
    }
    if (s === "wger") {
      const key = `${SOURCE_MEDIA_PREFIX}wger/snapshots/${date}-images.json`;
      await wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", here("./library/m14/wger-images.json"), "--content-type", "application/json"], t);
    }
    manifest.snapshots[id] = date;
    await save();
    console.log(`R2: ${s} snapshot (${SOURCES[s].sha.slice(0, 7)})`);
  }
  const urls = new Map<string, string>();
  for (const f of files) for (const d of f.decisions) for (const i of d.images ?? []) urls.set(sourceImageKey(f.source, i.url), i.url);
  const done = new Set(manifest.images);
  const todo = [...new Set(added.flatMap((r) => r.media.map((m) => m.r2_key!).filter((k) => k.startsWith(SOURCE_MEDIA_PREFIX))))].filter((k) => !done.has(k)).sort();
  console.log(`R2: ${done.size} source images already copied, ${todo.length} to copy`);
  let copied = 0;
  let since = 0;
  await pool(todo, t.mode === "local" ? 1 : 4, async (key) => {
    if (t.timeBudget && Date.now() - started > t.timeBudget * 1000) return;
    const url = urls.get(key)!;
    const file = join(dir, key.replace(/[^A-Za-z0-9._-]/g, "_"));
    writeFileSync(file, new Uint8Array(await (await fetchRetry(url)).arrayBuffer()));
    await sleep(250);
    await wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", imageType(key)!], t);
    rmSync(file);
    manifest.images.push(key);
    copied++;
    if (++since >= 25) {
      since = 0;
      await save();
    }
  });
  await save();
  console.log(`R2: ${copied} source images copied${copied < todo.length ? `, ${todo.length - copied} left for the next run (time budget)` : ""}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

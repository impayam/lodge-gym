// Exercise library import (SPEC-v2 §7.1): free-exercise-db (Unlicense) at a pinned commit → D1 rows, images copied
// to the private R2 bucket, dataset snapshot in R2. Idempotent and resumable: rows are upserted only when a value
// differs, and an R2 manifest lists the images already copied, so an interrupted run continues where it stopped.
// Polite to GitHub: a few image downloads in flight, with a short pause after each. With --time-budget the image copy
// stops starting new uploads after that many seconds (Workers Builds stops a build at 20 minutes); the next run resumes.
//
//   npx tsx seed/import-exercises.ts --remote [--only d1|media] [--time-budget <s>]   production (deploy:ci)
//   npx tsx seed/import-exercises.ts --local [--persist-to <dir>] [--dataset <file>] [--images <dir>]
//   npx tsx seed/import-exercises.ts --report [--dataset <file>]       writes seed/library/IMPORT-REPORT.md only

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
  type ManualExercise,
  type PatternFile,
  type SeedMatch,
} from "../worker/lib/library";

const BUCKET = "lodge-gym-photos";
const MANIFEST = `${FEDB_PREFIX}manifest.json`;
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
}

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--remote" || k === "--local" || k === "--report") a.mode = k.slice(2) as Args["mode"];
    else if (k === "--persist-to") a.persistTo = argv[++i];
    else if (k === "--dataset") a.dataset = argv[++i];
    else if (k === "--images") a.images = argv[++i];
    else if (k === "--only") a.only = argv[++i] as Args["only"];
    else if (k === "--time-budget") a.timeBudget = Number(argv[++i]);
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.mode) throw new Error("pass --remote, --local or --report");
  if (a.only && a.only !== "d1" && a.only !== "media") throw new Error("--only takes d1 or media");
  if (a.timeBudget !== undefined && !(a.timeBudget > 0)) throw new Error("--time-budget takes a number of seconds");
  return a as Args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
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

async function readManifest(t: Args, dir: string): Promise<Manifest> {
  const file = join(dir, "manifest.json");
  try {
    await wrangler(["r2", "object", "get", `${BUCKET}/${MANIFEST}`, "--file", file], t);
    const m = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    return m.sha === FEDB_SHA ? m : { sha: FEDB_SHA, snapshot: null, images: [] };
  } catch {
    return { sha: FEDB_SHA, snapshot: null, images: [] };
  }
}

async function writeManifest(t: Args, dir: string, m: Manifest) {
  const file = join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify({ ...m, images: [...new Set(m.images)].sort() }));
  await wrangler(["r2", "object", "put", `${BUCKET}/${MANIFEST}`, "--file", file, "--content-type", "application/json"], t);
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
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
  const seedPrimary = Object.fromEntries(readJson<{ exercises: { id: string; muscle_primary: string }[] }>("./program.json").exercises.map((e) => [e.id, e.muscle_primary]));
  const lib = buildLibrary(
    dataset,
    readJson<PatternFile>("./library/fedb-patterns.json"),
    readJson<SeedMatch[]>("./library/seed-matches.json"),
    readJson<ManualExercise[]>("./library/manual.json"),
    seedPrimary,
    review
  );

  if (t.mode === "report") {
    writeFileSync(here("./library/IMPORT-REPORT.md"), reportMarkdown(lib.report) + "\n");
    console.log(`seed/library/IMPORT-REPORT.md: ${lib.report.imported} rows, ${lib.report.excluded_equipment.length} excluded by equipment, ${lib.report.excluded_review.length} excluded on review, ${lib.report.reviewed_equipment.length} reviewed equipment mappings, ${lib.report.unmapped_pattern.length} without a pattern`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "lg-library-"));
  try {
    if (t.only !== "media") {
      const sqlFile = join(dir, "library.sql");
      writeFileSync(sqlFile, librarySql(lib.rows, lib.seedUpdates).join("\n") + "\n");
      await wrangler(["d1", "execute", "DB", "--file", sqlFile, "--yes"], t);
      console.log(`D1: ${lib.rows.length} library rows and ${lib.seedUpdates.length} seeded exercises upserted (unchanged rows are not rewritten)`);
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
    const todo = imageKeys(lib.rows, lib.seedUpdates).filter((k) => !done.has(k));
    console.log(`R2: ${done.size} images already copied, ${todo.length} to copy`);
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
    console.log(`R2: ${copied} images copied${copied < todo.length ? `, ${todo.length - copied} left for the next run (time budget)` : ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

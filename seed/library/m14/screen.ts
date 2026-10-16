// M14 Phase A: screens the pinned exercise sources against the library (SPEC-v11 A2) and writes
// seed/library/m14/screening.json (every record with its outcome) and seed/library/m14/wger-images.json (wger's image
// list, so the images a row stores are pinned with the decisions). With --candidates <file> it also writes the
// candidates with their mapped facts and suggestions, the input of the review. Developer tool: not run on deploy.
//
//   NODE_USE_ENV_PROXY=1 npx tsx seed/library/m14/screen.ts [--cache <dir>] [--candidates <file>] [--refresh-images]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEDB_RAW, buildLibrary, type EquipmentReview, type FedbExercise, type ManualExercise, type PatternFile, type SeedMatch } from "../../../worker/lib/library";
import {
  COMPOUND_PATTERNS,
  SOURCES,
  SOURCE_ORDER,
  parseLiftosaur,
  readEverkinetic,
  readExercemus,
  readExerciseDb,
  readLiftosaur,
  readWger,
  recordKey,
  screenSources,
  sourceFileUrl,
  suggestPattern,
  type LibraryName,
  type SourceKey,
  type SourceRecord,
  type WgerImage,
} from "../../../worker/lib/librarySources";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

function args(argv: string[]) {
  const a: { cache?: string; candidates?: string; refreshImages: boolean } = { refreshImages: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cache") a.cache = argv[++i];
    else if (argv[i] === "--candidates") a.candidates = argv[++i];
    else if (argv[i] === "--refresh-images") a.refreshImages = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

async function get(url: string, cache?: string): Promise<string> {
  const file = cache ? join(cache, url.replace(/^https:\/\//, "").replace(/[^A-Za-z0-9._-]/g, "_")) : null;
  if (file && existsSync(file)) return readFileSync(file, "utf8");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (file) writeFileSync(file, text);
  return text;
}

/** wger's image list, trimmed to what the import needs. */
async function wgerImages(refresh: boolean): Promise<WgerImage[]> {
  const file = here("./wger-images.json");
  if (!refresh && existsSync(file)) return readJson<{ images: WgerImage[] }>(file).images;
  const res = await fetch("https://wger.de/api/v2/exerciseimage/?limit=1000");
  if (!res.ok) throw new Error(`wger images: HTTP ${res.status}`);
  const body = (await res.json()) as { count: number; results: WgerImage[] };
  if (body.results.length !== body.count) throw new Error(`wger images: ${body.results.length} of ${body.count}`);
  const images = body.results
    .map(({ exercise, image, is_main, license, license_author, is_ai_generated }) => ({ exercise, image, is_main, license, license_author: license_author ?? "", is_ai_generated }))
    .sort((a, b) => a.exercise - b.exercise || a.image.localeCompare(b.image));
  writeFileSync(file, JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), source: "https://wger.de/api/v2/exerciseimage/", images }, null, 1) + "\n");
  return images;
}

export async function loadRecords(cache?: string, refreshImages = false): Promise<SourceRecord[]> {
  const j = async <T>(s: SourceKey, role: string) => JSON.parse(await get(sourceFileUrl(s, role), cache)) as T;
  const [wBase, wTrans, ek, edb, lift, exm, images] = await Promise.all([
    j<Parameters<typeof readWger>[0]>("wger", "base"),
    j<Parameters<typeof readWger>[1]>("wger", "translations"),
    j<Parameters<typeof readEverkinetic>[0]>("everkinetic", "exercises"),
    j<Parameters<typeof readExerciseDb>[0]>("exercisedb", "exercises"),
    get(sourceFileUrl("liftosaur", "exercises"), cache),
    j<Parameters<typeof readExercemus>[0]>("exercemus", "exercises"),
    wgerImages(refreshImages),
  ]);
  return [...readWger(wBase, wTrans, images), ...readEverkinetic(ek), ...readExerciseDb(edb), ...readLiftosaur(parseLiftosaur(lift)), ...readExercemus(exm)];
}

/** The library the sources are compared with: seeded, free-exercise-db and hand-written exercises. */
export async function libraryNames(cache?: string): Promise<LibraryName[]> {
  const L = here("../");
  const dataset = JSON.parse(await get(`${FEDB_RAW}/dist/exercises.json`, cache)) as FedbExercise[];
  const program = readJson<{ exercises: { id: string; name_en: string; equipment: LibraryName["equipment"]; muscle_primary: string }[] }>(join(L, "../program.json"));
  const lib = buildLibrary(
    dataset,
    readJson<PatternFile>(join(L, "fedb-patterns.json")),
    readJson<SeedMatch[]>(join(L, "seed-matches.json")),
    readJson<ManualExercise[]>(join(L, "manual.json")),
    Object.fromEntries(program.exercises.map((e) => [e.id, e.muscle_primary])),
    readJson<EquipmentReview>(join(L, "fedb-equipment.json"))
  );
  return [...program.exercises.map((e) => ({ id: e.id, name_en: e.name_en, equipment: e.equipment })), ...lib.rows.map((r) => ({ id: r.id, name_en: r.name_en, equipment: r.equipment }))];
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.cache) mkdirSync(a.cache, { recursive: true });
  const records = await loadRecords(a.cache, a.refreshImages);
  const screened = screenSources(records, await libraryNames(a.cache));
  const out = {
    generated_by: "seed/library/m14/screen.ts",
    sources: Object.fromEntries(SOURCE_ORDER.map((s) => [s, SOURCES[s].sha])),
    records: Object.fromEntries(SOURCE_ORDER.map((s) => [s, screened.filter((x) => x.source === s).map(({ source: _s, ...rest }) => rest)])),
  };
  writeFileSync(here("./screening.json"), JSON.stringify(out, null, 1) + "\n");
  const counts = new Map<string, number>();
  for (const x of screened) counts.set(`${x.source} ${x.kind}`, (counts.get(`${x.source} ${x.kind}`) ?? 0) + 1);
  console.log([...counts].map(([k, v]) => `${k}: ${v}`).join("\n"));
  if (a.candidates) {
    const byKey = new Map(records.map((r) => [recordKey(r), r]));
    const cands = screened
      .filter((x) => x.kind === "candidate")
      .map((x) => {
        const r = byKey.get(recordKey(x))!;
        const pattern = suggestPattern(r.name, r.primary);
        return {
          source: r.source,
          sid: r.sid,
          name: r.name,
          category: r.category,
          equipment: r.equipment,
          equipment_from: r.equipmentFrom,
          muscle_primary: r.primary,
          muscles_secondary: r.secondary,
          suggested_pattern: pattern,
          suggested_mechanic: pattern ? (COMPOUND_PATTERNS.has(pattern) ? "compound" : "isolation") : null,
          images: r.images.length,
          closest: x.match ?? null,
        };
      });
    writeFileSync(a.candidates, JSON.stringify(cands, null, 1) + "\n");
    console.log(`${cands.length} candidates written to ${a.candidates}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

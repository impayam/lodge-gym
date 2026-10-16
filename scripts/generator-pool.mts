// Writes tests/fixtures/generator/library.json: the exercise library as production has it after the import (seed,
// free-exercise-db at the pinned commit, manual gap fill, the reviewed M14 sources), with only the fields the program
// generator reads. The generator's property and snapshot tests run on it, so they choose from the same exercises
// Payam's library offers.
//
//   npx tsx scripts/generator-pool.mts [--dataset <exercises.json>]   (default: downloads the pinned dataset)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FEDB_RAW, buildLibrary, type EquipmentReview, type FedbExercise, type ManualExercise, type PatternFile, type SeedMatch } from "../worker/lib/library";
import { sourceRows, type DecisionFile, type DedupeEntry } from "../worker/lib/libraryDecisions";
import { SOURCE_ORDER } from "../worker/lib/librarySources";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const readJson = <T>(p: string): T => JSON.parse(readFileSync(here(p), "utf8")) as T;

const i = process.argv.indexOf("--dataset");
const datasetText = i > 0 ? readFileSync(process.argv[i + 1], "utf8") : await (await fetch(`${FEDB_RAW}/dist/exercises.json`)).text();
const program = readJson<{ exercises: { id: string; name_fa: string; name_en: string; muscle_primary: string; equipment: string }[] }>("../seed/program.json");
const seedMatches = readJson<SeedMatch[]>("../seed/library/seed-matches.json");
const { rows, seedUpdates } = buildLibrary(
  JSON.parse(datasetText) as FedbExercise[],
  readJson<PatternFile>("../seed/library/fedb-patterns.json"),
  seedMatches,
  readJson<ManualExercise[]>("../seed/library/manual.json"),
  Object.fromEntries(program.exercises.map((e) => [e.id, e.muscle_primary])),
  readJson<EquipmentReview>("../seed/library/fedb-equipment.json")
);
const seedRows = program.exercises.map((e) => {
  const u = seedUpdates.find((s) => s.id === e.id)!;
  return {
    id: e.id,
    name_en: e.name_en,
    muscle_primary: e.muscle_primary,
    muscles_secondary: u.muscles_secondary,
    equipment: e.equipment,
    pattern: u.pattern,
    mechanic: u.mechanic,
    level: u.level,
    category: "strength",
    source: "seed",
  };
});
const libRows = rows.map((r) => ({
  id: r.id,
  name_en: r.name_en,
  muscle_primary: r.muscle_primary,
  muscles_secondary: r.muscles_secondary,
  equipment: r.equipment,
  pattern: r.pattern,
  mechanic: r.mechanic,
  level: r.level,
  category: r.category,
  source: r.source,
}));
// The rows the M14 sources add after review (SPEC-v11 A2), as the import writes them.
const sources = SOURCE_ORDER.filter((x) => existsSync(here(`../seed/library/m14/${x}.json`))).map((x) => readJson<DecisionFile>(`../seed/library/m14/${x}.json`));
const dedupe = existsSync(here("../seed/library/m14/dedupe-review.json")) ? readJson<DedupeEntry[]>("../seed/library/m14/dedupe-review.json") : [];
const m14Rows = sourceRows(sources, dedupe).map((r) => ({
  id: r.id,
  name_en: r.name_en,
  muscle_primary: r.muscle_primary,
  muscles_secondary: r.muscles_secondary,
  equipment: r.equipment,
  pattern: r.pattern,
  mechanic: r.mechanic,
  level: r.level,
  category: r.category,
  source: r.source,
}));
const out = [...seedRows, ...libRows, ...m14Rows];
writeFileSync(here("../tests/fixtures/generator/library.json"), "[\n" + out.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n");
console.log(`${out.length} exercises (${seedRows.length} seed, ${libRows.length} library, ${m14Rows.length} from the M14 sources)`);

// The generator's test library (tests/fixtures/generator/library.json, written by scripts/generator-pool.mts from the
// pinned free-exercise-db commit) as app exercises with the region tags the import writes, plus Payam's current program
// and exercise history.

import lib from "./library.json";
import overrides from "../../../seed/library/region-overrides.json";
import { program } from "../report-data";
import { regionTags, type RegionOverrides } from "../../../worker/lib/regions";
import type { Exercise } from "../../../worker/lib/types";

type Row = Pick<Exercise, "id" | "name_en" | "muscle_primary" | "muscles_secondary" | "equipment" | "pattern" | "mechanic" | "level" | "category" | "source">;

export const libraryExercises = (): Exercise[] =>
  (lib as Row[]).map((r) => ({
    ...r,
    name_fa: "",
    cue_fa: "",
    cue_en: null,
    is_lower: false,
    media: [],
    instructions_en: [],
    archived_at: null,
    license: null,
    license_author: null,
    regions: regionTags(r, overrides as unknown as RegionOverrides).map(({ region, emphasis, evidence }) => ({ region, emphasis, evidence })),
  }));

/** The active seed program, with every exercise of it treated as having logged sets. */
export function currentProgram() {
  const current = program();
  const historyIds = new Set(current.days.flatMap((d) => d.exercises.map((x) => x.exercise_id)));
  return { current, historyIds };
}

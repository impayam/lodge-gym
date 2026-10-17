// Library screen logic (SPEC-v8 §6.05): the muscle-group chips and the number at the end of each row. Pure,
// unit-tested.

import { REGIONS, REGION_INFO, type Region } from "../../../worker/lib/regions";
import { bestSet } from "../../../worker/lib/reports";
import type { Unit, WorkoutSession } from "../../../worker/lib/types";

export type LibraryGroup = "all" | "chest" | "back" | "legs" | "shoulders" | "arms" | "core";

/** The chips of mockup 05; a group holds the canonical muscles under it (neck only shows under All). */
export const LIBRARY_GROUPS: readonly { key: LibraryGroup; label: string; muscles: readonly string[] | null }[] = [
  { key: "all", label: "All", muscles: null },
  { key: "chest", label: "Chest", muscles: ["chest"] },
  { key: "back", label: "Back", muscles: ["back_lats", "back_upper", "traps", "lower_back"] },
  { key: "legs", label: "Legs", muscles: ["quads", "hamstrings", "glutes", "calves", "adductors", "abductors"] },
  { key: "shoulders", label: "Shoulders", muscles: ["shoulders_front", "shoulders_side", "rear_delts"] },
  { key: "arms", label: "Arms", muscles: ["biceps", "triceps", "forearms"] },
  { key: "core", label: "Core", muscles: ["core"] },
];

/** The region chips under each muscle chip (SPEC-v11 A4), in the region list's order. */
const GROUP_REGION_FAMILIES: Readonly<Record<Exclude<LibraryGroup, "all">, readonly string[]>> = {
  chest: ["chest"],
  back: ["back"],
  legs: ["quads", "hamstrings", "glutes", "calves", "adductors"],
  shoulders: ["shoulders"],
  arms: ["triceps", "biceps", "forearms"],
  core: ["core"],
};
export function regionsForGroup(group: LibraryGroup): Region[] {
  if (group === "all") return [];
  const families = GROUP_REGION_FAMILIES[group];
  return REGIONS.filter((r) => families.includes(REGION_INFO[r].muscle));
}
/** A region chip's label: short where the chip row is one muscle, otherwise naming the muscle too. */
export function regionChipLabel(region: Region, group: LibraryGroup): string {
  const info = REGION_INFO[region];
  if (group === "chest" || group === "shoulders" || group === "back" || group === "core") return info.short;
  return CHIP_LABEL[region] ?? info.label;
}
const CHIP_LABEL: Partial<Record<Region, string>> = {
  triceps_long: "Triceps long head",
  triceps_lateral_medial: "Triceps lateral/medial",
  biceps_long: "Biceps long head",
  biceps_short: "Biceps short head",
  brachialis: "Brachialis",
  forearm_flexors: "Forearm flexors",
  forearm_extensors: "Forearm extensors",
  quads_squat: "Quads, squat",
  quads_knee_ext: "Quads, knee extension",
  hamstrings_hinge: "Hamstrings, hinge",
  hamstrings_curl: "Hamstrings, curl",
  glutes_ext: "Glutes, extension",
  glutes_abd: "Glutes, abduction",
  calves_gastroc: "Calves, straight knee",
  calves_soleus: "Calves, bent knee",
  adductors: "Adductors",
};

/** Whether an exercise trains a region as its main focus (a primary tag). */
export const emphasises = (regions: readonly { region: string; emphasis: string }[], region: string) => regions.some((r) => r.region === region && r.emphasis === "primary");

/** "Upper chest · moderate evidence" style line parts for the exercise detail. */
export const EVIDENCE_LABEL: Readonly<Record<"strong" | "moderate" | "weak", string>> = { strong: "strong evidence", moderate: "moderate evidence", weak: "weak evidence" };

/** Ids of exercises with at least one done set: "New to me" shows the others (SPEC-v11 A4). */
export function loggedExerciseIds(sessions: readonly WorkoutSession[]): Set<string> {
  const ids = new Set<string>();
  for (const s of sessions) for (const x of s.sets) if (x.done) ids.add(x.exercise_id);
  return ids;
}

/** Whether an exercise belongs to a chip: its main muscle is in the group. */
export function inGroup(primary: string, group: LibraryGroup): boolean {
  const muscles = LIBRARY_GROUPS.find((g) => g.key === group)?.muscles ?? null;
  return muscles === null || muscles.includes(primary);
}

export interface RowFact {
  value: number;
  /** "est. 1RM", "last × 8", "last, seconds" or "last, reps". */
  label: string;
}

/**
 * The number at the end of each row, from done sets: the best estimated 1RM for the big three, otherwise the last
 * session's top set (weight × reps), or its longest hold or most reps when there is no weight.
 */
export function rowFacts(sessions: readonly WorkoutSession[], unit: Unit, bigThree: ReadonlySet<string>): Map<string, RowFact> {
  const best = new Map<string, number>();
  const last = new Map<string, RowFact>();
  const done = sessions.filter((s) => s.status === "done").sort((a, b) => (a.local_date + a.started_at).localeCompare(b.local_date + b.started_at));
  for (const s of done) {
    const sets = s.sets.filter((x) => x.done);
    const ids = new Set(sets.map((x) => x.exercise_id));
    const session = { ...s, sets };
    for (const id of ids) {
      const top = bestSet(session, id, unit);
      if (top) {
        best.set(id, Math.max(best.get(id) ?? 0, top.e1rm));
        last.set(id, { value: top.weight, label: `last × ${top.reps}` });
        continue;
      }
      const mine = sets.filter((x) => x.exercise_id === id);
      const secs = Math.max(0, ...mine.map((x) => x.seconds ?? 0));
      const reps = Math.max(0, ...mine.map((x) => x.reps ?? 0));
      if (secs > 0) last.set(id, { value: secs, label: "last, seconds" });
      else if (reps > 0) last.set(id, { value: reps, label: "last, reps" });
    }
  }
  const out = new Map<string, RowFact>(last);
  for (const [id, e1rm] of best) if (bigThree.has(id)) out.set(id, { value: Math.round(e1rm), label: "est. 1RM" });
  return out;
}

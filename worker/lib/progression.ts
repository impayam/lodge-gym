// Progression suggestion (SPEC §7, same logic as the artifact) and weight increments (SPEC §6).

import type { DayExercise, Equipment, SetEntry, Unit } from "./types";

export interface ExerciseInfo {
  equipment: Equipment;
  is_lower: boolean;
}

/** Suggestion increment: barbell/machine/cable upper +5 lb (+2.5 kg), lower +10 lb (+5 kg), dumbbell +5 lb per hand (+2 kg). */
export function weightIncrement(ex: ExerciseInfo, unit: Unit): number {
  if (ex.equipment === "dumbbell") return unit === "kg" ? 2 : 5;
  if (ex.is_lower) return unit === "kg" ? 5 : 10;
  return unit === "kg" ? 2.5 : 5;
}

/** Step used by the −/+ weight buttons. Bodyweight (added load or assistance) uses the upper-body step. */
export function stepperIncrement(ex: ExerciseInfo, unit: Unit): number {
  if (ex.equipment === "bodyweight") return unit === "kg" ? 2.5 : 5;
  return weightIncrement(ex, unit);
}

export interface PastPerformance {
  session_id: string;
  local_date: string;
  unit: Unit;
  sets: SetEntry[];
}

export interface PerfSession {
  id: string;
  local_date: string;
  started_at: string;
  status: "active" | "done";
  unit: Unit;
  sets: SetEntry[];
}

const hasData = (s: SetEntry) => s.reps != null || s.weight != null || s.seconds != null;

/** Most recent done session (other than `excludeId`) where the exercise has any logged data. */
export function lastPerformance(exerciseId: string, sessions: PerfSession[], excludeId?: string): PastPerformance | null {
  const done = sessions
    .filter((s) => s.status === "done" && s.id !== excludeId)
    .sort((a, b) => (b.local_date + b.started_at).localeCompare(a.local_date + a.started_at));
  for (const s of done) {
    const sets = s.sets.filter((x) => x.exercise_id === exerciseId).sort((a, b) => a.set_index - b.set_index);
    if (sets.some(hasData)) return { session_id: s.id, local_date: s.local_date, unit: s.unit, sets };
  }
  return null;
}

export type Suggestion =
  | { kind: "weight"; allHit: boolean; easy: boolean; weight: number; unit: Unit; lastTop: number }
  | { kind: "bodyweight"; allHit: boolean; easy: boolean; weight: number | null; unit: Unit }
  | { kind: "time"; allHit: boolean; easy: boolean; seconds: number }
  | { kind: "none" };

/** RIR 3 stands for "3 or more reps in reserve". */
export const RIR_EASY = 3;

/**
 * Progression (SPEC §7 plus approved RIR rules):
 * - every planned set done at the top of the range with RIR 3+ → double increment ("easy");
 * - every planned set done at the top of the range → one increment;
 * - otherwise (including RIR 0 with missed reps) → same weight.
 */
export function suggest(plan: Pick<DayExercise, "sets" | "reps_max" | "is_time">, ex: ExerciseInfo, last: PastPerformance | null): Suggestion {
  if (!last) return { kind: "none" };
  const planned = last.sets.slice(0, plan.sets);
  const enough = last.sets.length >= plan.sets;
  const easyAll = (hit: boolean) => hit && planned.every((s) => s.rir === RIR_EASY);
  if (plan.is_time) {
    const secs = last.sets.map((s) => s.seconds).filter((v): v is number => v != null);
    if (!secs.length) return { kind: "none" };
    const allHit = enough && planned.every((s) => s.done && (s.seconds ?? 0) >= plan.reps_max);
    const easy = easyAll(allHit);
    const top = Math.max(...secs);
    return { kind: "time", allHit, easy, seconds: allHit ? Math.max(top, plan.reps_max) + (easy ? 30 : 15) : top };
  }
  const withReps = last.sets.filter((s) => s.reps != null);
  if (!withReps.length) return { kind: "none" };
  const allHit = enough && planned.every((s) => s.done && (s.reps ?? 0) >= plan.reps_max);
  const easy = easyAll(allHit);
  const weights = withReps.map((s) => s.weight).filter((w): w is number => w != null);
  const top = weights.length ? Math.max(...weights) : null;
  if (ex.equipment === "bodyweight") return { kind: "bodyweight", allHit, easy, weight: top, unit: last.unit };
  if (top == null) return { kind: "none" };
  const inc = weightIncrement(ex, last.unit);
  return { kind: "weight", allHit, easy, weight: allHit ? top + inc * (easy ? 2 : 1) : top, unit: last.unit, lastTop: top };
}

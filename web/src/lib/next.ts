// Home → the next session's table (SPEC-v8 §6.01): Exercise / Last / Today. Last is the top set of the last session
// that did the exercise; Today is the progression target (worker/lib/progression.ts) with the planned reps.

import { fmtNum } from "../../../worker/lib/digits";
import { lastPerformance, suggest, type PastPerformance } from "../../../worker/lib/progression";
import type { DayExercise, Exercise, Unit, WorkoutSession } from "../../../worker/lib/types";

export interface NextRow {
  exercise_id: string;
  name: string;
  last: string;
  today: string;
}

const reps = (p: Pick<DayExercise, "reps_min" | "reps_max">) => (p.reps_min && p.reps_min !== p.reps_max ? `${fmtNum(p.reps_min)}–${fmtNum(p.reps_max)}` : fmtNum(p.reps_max));
const withUnit = (text: string, u: Unit, table: Unit) => (u === table ? text : `${text} ${u}`);

/** The top set of a past performance: the longest hold, or the heaviest set (most reps on a tie), or the most reps. */
export function topSetText(last: PastPerformance | null, isTime: boolean, table: Unit): string {
  if (!last) return "–";
  const sets = last.sets.filter((x) => x.reps != null || x.weight != null || x.seconds != null);
  if (!sets.length) return "–";
  if (isTime) return `${fmtNum(Math.max(...sets.map((x) => x.seconds ?? 0)))} s`;
  const weighted = sets.filter((x) => x.weight != null && x.reps != null);
  if (weighted.length) {
    const top = weighted.reduce((a, b) => (b.weight! > a.weight! || (b.weight === a.weight && b.reps! > a.reps!) ? b : a));
    return withUnit(`${fmtNum(top.weight!)} × ${fmtNum(top.reps!)}`, last.unit, table);
  }
  return `${fmtNum(Math.max(...sets.map((x) => x.reps ?? 0)))} reps`;
}

/** Today's target: the suggested weight (or time) with the planned reps; just the planned reps without a history. */
export function todayText(plan: DayExercise, ex: Pick<Exercise, "equipment" | "is_lower">, last: PastPerformance | null, table: Unit): string {
  const sg = suggest(plan, ex, last);
  if (plan.is_time) return `${fmtNum(sg.kind === "time" ? sg.seconds : plan.reps_max)} s`;
  if ((sg.kind === "weight" || sg.kind === "bodyweight") && sg.weight != null && sg.weight > 0) return withUnit(`${fmtNum(sg.weight)} × ${reps(plan)}`, sg.unit, table);
  return `${reps(plan)} reps`;
}

/** The rows for a day's (or a plan's) exercises, in order. */
export function nextRows(exercises: DayExercise[], byId: Map<string, Exercise>, sessions: WorkoutSession[], table: Unit): NextRow[] {
  return [...exercises]
    .sort((a, b) => a.position - b.position)
    .map((p) => {
      const ex = byId.get(p.exercise_id);
      const last = lastPerformance(p.exercise_id, sessions);
      return {
        exercise_id: p.exercise_id,
        name: ex?.name_en ?? p.exercise_id,
        last: topSetText(last, p.is_time, table),
        today: ex ? todayText(p, ex, last, table) : `${reps(p)} reps`,
      };
    });
}

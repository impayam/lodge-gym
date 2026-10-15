// Session facts for the session cards (Home → Recent sessions, History), from the reports' own best-set rule
// (worker/lib/reports.ts): a record is a best estimated 1RM that beats every earlier session's best for that exercise.

import { bestIn, bestSet, type SetResult } from "../../../worker/lib/reports";
import type { DayExercise, Unit, WorkoutSession } from "../../../worker/lib/types";

const order = (s: WorkoutSession) => s.local_date + s.started_at;

/** Done sessions before `s` (by date and start time). */
function earlier(done: WorkoutSession[], s: WorkoutSession): WorkoutSession[] {
  return done.filter((x) => x.status === "done" && x.id !== s.id && order(x) < order(s));
}

/** Whether `s` set a record: some exercise's best e1RM in it beats that exercise's best in all earlier sessions. */
export function hasRecord(all: WorkoutSession[], s: WorkoutSession, unit: Unit): boolean {
  const before = earlier(all, s);
  const ids = [...new Set(s.sets.filter((x) => x.done).map((x) => x.exercise_id))];
  return ids.some((id) => {
    const best = bestSet(s, id, unit);
    const prev = bestIn(before, id, unit);
    return !!best && !!prev && best.e1rm > prev.e1rm;
  });
}

/** The session's best set of its day's main exercise; without one, the heaviest set of any exercise in it. */
export function topLift(s: WorkoutSession, dayExercises: Pick<DayExercise, "exercise_id" | "is_main">[], unit: Unit): { exercise_id: string; set: SetResult } | null {
  const main = dayExercises.find((e) => e.is_main)?.exercise_id;
  const ids = main && bestSet(s, main, unit) ? [main] : [...new Set(s.sets.map((x) => x.exercise_id))];
  let top: { exercise_id: string; set: SetResult } | null = null;
  for (const id of ids) {
    const b = bestSet(s, id, unit);
    if (b && (!top || b.weight > top.set.weight)) top = { exercise_id: id, set: b };
  }
  return top;
}

/** Each done session's best e1RM for one exercise since `from` (inclusive), oldest first. */
export function e1rmPoints(all: WorkoutSession[], exerciseId: string, unit: Unit, from: string): { date: string; value: number; set: SetResult }[] {
  // One point per day: the day's best (two sessions on one date keep the higher).
  const byDay = new Map<string, SetResult>();
  for (const s of all) {
    if (s.status !== "done" || s.local_date < from) continue;
    const b = bestSet(s, exerciseId, unit);
    const cur = byDay.get(s.local_date);
    if (b && (!cur || b.e1rm > cur.e1rm)) byDay.set(s.local_date, b);
  }
  return [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, set]) => ({ date, value: set.e1rm, set }));
}

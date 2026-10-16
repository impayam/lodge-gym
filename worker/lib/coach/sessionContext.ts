// "Ask Coach" from the session screen (Payam, 2026-10-16): the message carries the open session, and the app writes what
// he is doing now into the message's CONTEXT block: the day, the exercise and set on his screen, and his done sets so
// far. Pure; the numbers are his logged sets as saved.

import { localHM } from "../time";
import type { ReportData } from "../reports";
import type { WorkoutSession } from "../types";
import { sessionDay } from "../ai/report";

export interface SessionFacts {
  day: string;
  /** Local start time, "17:05". */
  started: string;
  unit: string;
  /** The exercise and set on his screen (1-based), when the app sent them. */
  current: { exercise: string; set: number; of: number } | null;
  /** Done sets per exercise, in the order he did them: "135×5, 135×5" ("×12" without a weight, "45 s" for a hold). */
  done: { exercise: string; sets: string }[];
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

export function sessionFacts(d: Pick<ReportData, "exercises" | "program" | "programs">, s: WorkoutSession, exerciseId: string | null, set: number | null, tz: string): SessionFacts {
  const names = new Map(d.exercises.map((e) => [e.id, e.name_en]));
  const name = (id: string) => names.get(id) ?? id;
  const done = s.sets.filter((x) => x.done).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const order = [...new Set(done.map((x) => x.exercise_id))];
  const of = exerciseId ? s.sets.filter((x) => x.exercise_id === exerciseId).length : 0;
  return {
    day: sessionDay(d as ReportData, s.program_day_id)?.name_en ?? s.program_day_id,
    started: localHM(tz, s.started_at),
    unit: s.unit,
    current: exerciseId && set != null && of > 0 ? { exercise: name(exerciseId), set: Math.min(set, of - 1) + 1, of } : null,
    done: order.map((id) => ({
      exercise: name(id),
      sets: done
        .filter((x) => x.exercise_id === id)
        .sort((a, b) => a.set_index - b.set_index)
        .map((x) => (x.seconds != null && x.reps == null ? `${fmt(x.seconds)} s` : `${x.weight != null ? fmt(x.weight) : ""}×${x.reps ?? "–"}`))
        .join(", "),
    })),
  };
}

/** The CONTEXT block's lines for the session. */
export function sessionLines(f: SessionFacts): string[] {
  return [
    `He is training now (the session open today): ${f.day}, started ${f.started}.`,
    ...(f.current ? [`On his screen: ${f.current.exercise}, set ${f.current.set} of ${f.current.of}.`] : []),
    f.done.length ? `Done so far (${f.unit}): ${f.done.map((x) => `${x.exercise} ${x.sets}`).join("; ")}.` : "Done so far: no set yet.",
  ];
}

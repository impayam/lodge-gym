// Coach tool propose_session_additions (Payam, 2026-10-16): at the gym he says "today I'm doing back, add biceps and
// forearms" and the coach proposes 2–3 exercises for a session. The model only picks exercises and says why; every
// number comes from the app: sets and reps from his active program when the exercise is in it, otherwise from his last
// session with it, and the weight from the session screen's progression (worker/lib/progression.ts lastPerformance +
// suggest). Without history the weight stays empty. Where they go is chosen by date (./additionTarget.ts) and shown on
// the card; nothing is added until he taps Add, and Change offers the other sessions. The program never changes.

import { z } from "zod";
import { nextDay, versionAliases } from "../cycle";
import { HOLD_SECONDS, scheme } from "../generator/model";
import { looksTimed } from "../generator/pick";
import { lastPerformance, suggest, type PastPerformance } from "../progression";
import { hm } from "../calendar";
import type { DayExercise, Exercise, ProgramDay, Unit } from "../types";
import { additionTargets, targetLabel, type AdditionTarget } from "./additionTarget";
import type { CoachData, ToolOutcome } from "./tools";

/** Exercises one proposal may hold. */
export const MAX_ADDITIONS = 6;
/** Sets of an exercise added without a program entry or history: the 3D picker adds three. */
export const EXTRA_SETS = 3;

export const PROPOSE_SESSION_ADDITIONS_TOOL = {
  name: "propose_session_additions",
  description: `Proposes exercises to add to a session, when he asks to add two or more exercises for today or for a session (for example "today is back, add biceps and forearms"); for one exercise use propose_exercise. Give exercise ids from get_library or get_program and one short line in Persian for each (reason_fa). Do not give sets, reps or weights: the app fills them from his program and history with its progression rule, and leaves the weight empty when he has no history with the exercise. program_day_id: only when he says which day he trains today (an id from get_program). The app picks where they go by date: a session open today (added to it); else today (the day he named, or today's planned gym session's day); else his nearest planned gym session; else Home's next day. For a session not started yet they go into that day's plan, and they are in the session when he starts it. The result says which ("target"). Ids not in the library, repeats and exercises already in that session or day are dropped, and the result says why. The app shows a card with "Add" and "Change" (another session); nothing is added before he taps it, and his program never changes. At most ${MAX_ADDITIONS} exercises.`,
  input_schema: {
    type: "object",
    properties: {
      program_day_id: { type: "string", description: "A day id from get_program: the day he says he trains today. Leave it out otherwise." },
      items: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ADDITIONS,
        items: {
          type: "object",
          properties: {
            exercise_id: { type: "string", description: "Exercise id from get_library or get_program, exactly as written." },
            reason_fa: { type: "string", description: "Why this exercise today, one short line in Persian." },
          },
          required: ["exercise_id", "reason_fa"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
} as const;

const input = z
  .object({
    program_day_id: z.string().min(1).optional(),
    items: z
      .array(z.object({ exercise_id: z.string().min(1), reason_fa: z.string().trim().min(1).max(200) }).strict())
      .min(1)
      .max(MAX_ADDITIONS),
  })
  .strict();

/** Where the sets and reps of an addition come from. */
export type AdditionBasis = "program" | "history" | "none";

export interface Addition {
  exercise_id: string;
  name: string;
  sets: number;
  /** Rep range; for a timed exercise, seconds. */
  reps_min: number;
  reps_max: number;
  is_time: boolean;
  /** Suggested weight in `weight_unit`, or null (no history, or bodyweight without added load). */
  weight: number | null;
  weight_unit: Unit | null;
  basis: AdditionBasis;
  /** The progression step the app took, in words ("+5 lb: every set reached 12 reps last time"). */
  rule: string;
  /** His last session with the exercise, as the session screen's "Last" line shows it. */
  last: { date: string; sets: string } | null;
  reason_fa: string;
}

/** The target as the result shows it: the shared rule's target with names and times. */
export type ShownTarget = AdditionTarget & { day: string; start: string | null; label: string };

export interface SessionAdditions {
  shown: true;
  /** Where the items go by default (his tap confirms it; Change offers the others). */
  target: ShownTarget;
  /** The day he said he trains today, as given (the card recomputes the target from it). */
  named_day_id: string | null;
  items: Addition[];
  dropped: { exercise_id: string; reason: string }[];
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** "30×12, 30×11, 30×10" (time: "45 s"; no weight: "×12"), the logged sets that hold data. */
function lastLine(last: PastPerformance): string {
  return last.sets
    .filter((s) => s.reps != null || s.weight != null || s.seconds != null)
    .map((s) => (s.seconds != null && s.reps == null ? `${fmt(s.seconds)} s` : `${s.weight != null ? fmt(s.weight) : ""}×${s.reps ?? "–"}`))
    .join(", ");
}

/** The active program's next day, as Home picks it (worker/lib/cycle.ts nextDay with the version aliases). */
export function nextProgramDay(d: CoachData): ProgramDay {
  const days = [...d.program.days].sort((a, b) => a.position - b.position);
  const others = (d.programs ?? []).flatMap((p) => p.days.map((x) => ({ id: x.id, program_id: p.id, position: x.position })));
  const next = nextDay(
    days.map((x) => x.id),
    d.sessions,
    versionAliases(d.programs ?? [], others, days)
  );
  return days.find((x) => x.id === next.dayId) ?? days[0];
}

/** The first entry of an exercise in the active program (by day, then position). */
export function programEntry(d: CoachData, exerciseId: string): DayExercise | null {
  for (const day of [...d.program.days].sort((a, b) => a.position - b.position)) {
    const hit = [...day.exercises].sort((a, b) => a.position - b.position).find((x) => x.exercise_id === exerciseId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Sets, reps and weight of one addition, by the app's rules:
 * - in the active program: that entry's sets and rep range, and the session screen's suggestion from his last session;
 * - not in the program, done before: his last session's set count and top reps, and the same progression on them;
 * - never done: three sets (as the 3D picker adds them), the generator's rep range for the exercise's kind
 *   (accessory 8–12, isolation 10–15, core 10–15; timed holds 30–45 s), and no weight.
 */
export function additionNumbers(d: CoachData, ex: Exercise, excludeSessionId?: string): Omit<Addition, "exercise_id" | "name" | "reason_fa"> {
  const last = lastPerformance(ex.id, d.sessions, excludeSessionId);
  const entry = programEntry(d, ex.id);
  let plan: Pick<DayExercise, "sets" | "reps_min" | "reps_max" | "is_time">;
  let basis: AdditionBasis;
  if (entry) {
    plan = { sets: entry.sets, reps_min: entry.reps_min, reps_max: entry.reps_max, is_time: entry.is_time };
    basis = "program";
  } else if (last) {
    const logged = last.sets.filter((s) => s.reps != null || s.weight != null || s.seconds != null);
    const timed = logged.some((s) => s.seconds != null) && !logged.some((s) => s.reps != null);
    const top = Math.max(0, ...logged.map((s) => (timed ? (s.seconds ?? 0) : (s.reps ?? 0))));
    plan = { sets: Math.max(1, logged.length), reps_min: top, reps_max: top, is_time: timed };
    basis = "history";
  } else {
    const isolation = ex.mechanic === "isolation" || ex.pattern === "isolation";
    const s = scheme(ex.pattern === "core" ? "core" : isolation ? "isolation" : "accessory", false);
    plan = looksTimed(ex) ? { sets: EXTRA_SETS, reps_min: HOLD_SECONDS[0], reps_max: HOLD_SECONDS[1], is_time: true } : { sets: EXTRA_SETS, reps_min: s.reps[0], reps_max: s.reps[1], is_time: false };
    basis = "none";
  }

  const g = suggest(plan, ex, last);
  let weight: number | null = null;
  let unit: Unit | null = null;
  let rule: string;
  const range = plan.is_time ? `${plan.reps_max} s` : `${plan.reps_max} reps`;
  if (g.kind === "weight") {
    weight = g.weight;
    unit = g.unit;
    const step = g.weight - g.lastTop;
    const per = ex.equipment === "dumbbell" ? " per dumbbell" : "";
    rule = step > 0 ? `+${fmt(step)} ${g.unit}${per}: every set reached ${range} last time${g.easy ? " with RIR 3+" : ""}` : `Same weight: not every set reached ${range} last time`;
  } else if (g.kind === "bodyweight") {
    weight = g.weight;
    unit = g.weight == null ? null : g.unit;
    rule = g.weight == null ? "Bodyweight" : "Same added load as last time";
  } else if (g.kind === "time") {
    rule = g.allHit ? `+${g.easy ? 30 : 15} s: every set reached ${range} last time` : "Same time as last time";
    plan = { ...plan, reps_min: g.seconds, reps_max: g.seconds };
  } else {
    rule = last ? "No weight in your last session with it: enter the weight" : "No history with this exercise: enter the weight";
  }
  return { sets: plan.sets, reps_min: plan.reps_min, reps_max: plan.reps_max, is_time: plan.is_time, weight, weight_unit: unit, basis, rule, last: last ? { date: last.local_date, sets: lastLine(last) } : null };
}

/** propose_session_additions: checks the ids, fills the numbers and names the session they go into. */
export function proposeSessionAdditions(d: CoachData, raw: unknown): ToolOutcome {
  const parsed = input.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") };
  const { program_day_id, items } = parsed.data;
  const days = [...d.program.days].sort((a, b) => a.position - b.position);
  if (program_day_id && !days.some((x) => x.id === program_day_id))
    return { ok: false, error: `Unknown program_day_id "${program_day_id}": use a day id of his active program from get_program, or ask him which day he is training.` };

  const { target } = additionTargets({
    today: d.today,
    sessions: d.sessions,
    plans: d.calendar?.plans ?? [],
    dayIds: days.map((x) => x.id),
    nextDayId: nextProgramDay(d).id,
    named: program_day_id ?? null,
  });
  const dayName = (id: string) => days.find((x) => x.id === id)?.name_en ?? id;
  const open = target.kind === "open_session" ? d.sessions.find((s) => s.id === target.session_id) : null;
  // What is already there: the open session's exercises, or the day's.
  const already = new Set(open ? open.sets.map((s) => s.exercise_id) : (days.find((x) => x.id === target.day_id)?.exercises.map((x) => x.exercise_id) ?? []));
  const where = open ? "today's open session" : dayName(target.day_id);

  const lib = new Map(d.exercises.map((e) => [e.id, e]));
  const out: Addition[] = [];
  const dropped: SessionAdditions["dropped"] = [];
  for (const it of items) {
    const ex = lib.get(it.exercise_id);
    if (!ex || ex.archived_at) dropped.push({ exercise_id: it.exercise_id, reason: "not in the library: use an id from get_library" });
    else if (out.some((x) => x.exercise_id === ex.id)) dropped.push({ exercise_id: ex.id, reason: "listed twice" });
    else if (already.has(ex.id)) dropped.push({ exercise_id: ex.id, reason: `already in ${where}` });
    else out.push({ exercise_id: ex.id, name: ex.name_en, ...additionNumbers(d, ex, open?.id), reason_fa: it.reason_fa });
  }
  if (!out.length) return { ok: false, error: `No exercise could be proposed: ${dropped.map((x) => `${x.exercise_id} (${x.reason})`).join(", ")}.` };

  const day = dayName(target.day_id);
  const shown: ShownTarget = { ...target, day, start: target.kind === "open_session" || target.start_min == null ? null : hm(target.start_min), label: targetLabel(target, day, d.today) };
  const result: SessionAdditions = { shown: true, target: shown, named_day_id: program_day_id ?? null, items: out, dropped };
  return { ok: true, result };
}

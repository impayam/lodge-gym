// Session helpers built on the bootstrap data.

import { nextDay, restAdvised, weekRange } from "../../worker/lib/cycle";
import { lastPerformance, stepperIncrement, suggest, type Suggestion } from "../../worker/lib/progression";
import { zonedToUtcISO } from "../../worker/lib/time";
import type { DayExercise, Exercise, ProgramDay, SetEntry, WorkoutSession } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import type { BootData } from "./localdb";

export const exerciseMap = (boot: BootData) => new Map(boot.exercises.map((e) => [e.id, e]));

export function dayInfo(boot: BootData, dayId: string): { id: string; name_fa: string; name_en: string; focus_fa: string; legacy: boolean; position: number } {
  const d = boot.program.days.find((x) => x.id === dayId) ?? boot.other_days.find((x) => x.id === dayId);
  if (!d) return { id: dayId, name_fa: dayId, name_en: "", focus_fa: "", legacy: true, position: 0 };
  return { id: d.id, name_fa: d.name_fa, name_en: d.name_en, focus_fa: d.focus_fa, legacy: d.program_id !== boot.program.id, position: d.position };
}

export const sortedSessions = (sessions: Record<string, WorkoutSession>) =>
  Object.values(sessions).sort((a, b) => (b.local_date + b.started_at).localeCompare(a.local_date + a.started_at));

export const activeSession = (sessions: Record<string, WorkoutSession>) => sortedSessions(sessions).find((s) => s.status === "active") ?? null;

export function homeModel(boot: BootData, sessions: Record<string, WorkoutSession>, today: string) {
  const all = Object.values(sessions);
  const next = nextDay(
    boot.program.days.map((d) => d.id),
    all
  );
  const week = weekRange(today, boot.settings.week_start);
  const weekDone = all.filter((s) => s.status === "done" && s.local_date >= week.start && s.local_date <= week.end).length;
  return {
    next,
    rest: restAdvised(today, all),
    weekDone,
    recent: sortedSessions(sessions)
      .filter((s) => s.status === "done")
      .slice(0, 4),
  };
}

export function newSession(boot: BootData, day: ProgramDay, today: string): WorkoutSession {
  const now = new Date().toISOString();
  const sets: SetEntry[] = [];
  for (const de of day.exercises)
    for (let i = 0; i < de.sets; i++)
      sets.push({ id: ulid(), exercise_id: de.exercise_id, set_index: i, weight: null, reps: null, seconds: null, done: false, updated_at: now });
  return {
    id: ulid(),
    program_day_id: day.id,
    local_date: today,
    started_at: now,
    ended_at: null,
    status: "active",
    unit: boot.settings.unit,
    note: "",
    created_at: now,
    updated_at: now,
    source: "app",
    sets,
  };
}

export interface ExerciseBlock {
  ex: Exercise;
  plan: DayExercise;
  sets: SetEntry[];
}

/** Exercise cards for a session: the day's plan in order, plus any other exercises present in the logged sets. */
export function sessionBlocks(boot: BootData, s: WorkoutSession): ExerciseBlock[] {
  const exMap = exerciseMap(boot);
  const day = boot.program.days.find((d) => d.id === s.program_day_id);
  const plans = day ? day.exercises : [];
  const blocks: ExerciseBlock[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    const ex = exMap.get(plan.exercise_id);
    if (!ex) continue;
    seen.add(plan.exercise_id);
    blocks.push({ ex, plan, sets: s.sets.filter((x) => x.exercise_id === plan.exercise_id).sort((a, b) => a.set_index - b.set_index) });
  }
  const extra = [...new Set(s.sets.map((x) => x.exercise_id))].filter((id) => !seen.has(id));
  for (const id of extra) {
    const ex = exMap.get(id);
    if (!ex) continue;
    const sets = s.sets.filter((x) => x.exercise_id === id).sort((a, b) => a.set_index - b.set_index);
    const maxReps = Math.max(0, ...sets.map((x) => x.reps ?? 0));
    const isTime = sets.some((x) => x.seconds != null) && !sets.some((x) => x.reps != null);
    blocks.push({
      ex,
      plan: {
        id: `extra_${id}`,
        exercise_id: id,
        position: 99,
        sets: sets.length,
        reps_min: maxReps,
        reps_max: maxReps,
        per_leg: false,
        is_time: isTime,
        rest_sec: 90,
        superset_tag: null,
        is_main: false,
      },
      sets,
    });
  }
  return blocks;
}

export interface Guidance {
  last: ReturnType<typeof lastPerformance>;
  suggestion: Suggestion;
  /** Suggested weight to prefill (only when the last session used the same unit). */
  prefillWeight: number | null;
  prefillSeconds: number | null;
  step: number;
}

export function guidance(block: ExerciseBlock, s: WorkoutSession, sessions: Record<string, WorkoutSession>): Guidance {
  const last = lastPerformance(block.ex.id, Object.values(sessions), s.id);
  const suggestion = suggest(block.plan, block.ex, last);
  let prefillWeight: number | null = null;
  if ((suggestion.kind === "weight" || suggestion.kind === "bodyweight") && suggestion.unit === s.unit) prefillWeight = suggestion.weight;
  const prefillSeconds = block.plan.is_time ? (suggestion.kind === "time" ? suggestion.seconds : block.plan.reps_max) : null;
  return { last, suggestion, prefillWeight, prefillSeconds, step: stepperIncrement(block.ex, s.unit) };
}

/** Re-anchors started_at/ended_at when the local date or times are edited. */
export function retime(s: WorkoutSession, tz: string, date: string, startHM: string, endHM: string | null): WorkoutSession {
  const started_at = zonedToUtcISO(date, startHM, tz);
  let ended_at: string | null = null;
  if (endHM) {
    ended_at = zonedToUtcISO(date, endHM, tz);
    if (Date.parse(ended_at) < Date.parse(started_at)) ended_at = zonedToUtcISO(addOne(date), endHM, tz);
  }
  return { ...s, local_date: date, started_at, ended_at };
}

function addOne(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

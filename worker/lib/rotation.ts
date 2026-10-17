// Exercise rotation (SPEC-v11 M14 Phase B, approved by Payam 2026-10-17): how long each exercise of the active program
// has been in it, whether it has stalled, and whether it is due for a change. Pure, from data the app already keeps (the
// program versions with their activations, and the logged sessions): no migration.
//
// | Role                                   | Keeps it at least | Changes between                                        | Changes by |
// | Main and secondary lifts               | 6 weeks           | 6–8 weeks, if stalled or no new best in its last 2 weeks | 8 weeks    |
// | Accessory, isolation and core work     | 3 weeks           | 3–4 weeks, if stalled                                    | 4 weeks    |
//
// Weeks in the program are counted from when the exercise entered the program in that role (main or other), across
// program versions that kept it in that role; weeks with no training at all (no done set that week) don't count.
// Stalled is the training overview's rule: its last 3 sessions did not beat the best before them. Nothing changes on
// its own: a due exercise is only shown (the Program screen, the Coach) and replaced in a new program Payam approves.

import { epley, convertWeight } from "./reports";
import { weekRange } from "./cycle";
import { localDate } from "./time";
import type { DayExercise, Exercise, Program, ProgramVersion, Settings, Unit, WeekStart, WorkoutSession } from "./types";

/** The two rotation roles: main and secondary lifts follow the main-lift rule (Payam, 2026-10-17); the rest the other. */
export type RotationRole = "main" | "other";

export const ROTATION_RULES: Readonly<Record<RotationRole, { min: number; max: number }>> = {
  main: { min: 6, max: 8 },
  other: { min: 3, max: 4 },
};
/** A main or secondary lift past its minimum changes when it had no new best in this many of its last training weeks. */
export const NEW_BEST_WEEKS = 2;
/** The training overview's stall rule (worker/lib/ai/overview.ts STALL_EXPOSURES): the last 3 sessions. */
export const STALL_SESSIONS = 3;
/** The Program screen shows at most this many due lines, most overdue first. */
export const DUE_LINES = 3;

export type DueReason = "max" | "stalled" | "no_new_best";

export interface RotationStatus {
  exercise_id: string;
  role: RotationRole;
  /** Training weeks it has been in the program in this role. */
  weeks: number;
  /** The local date its run began (the first local date of the earliest activation in the run); null without one. */
  since: string | null;
  min: number;
  max: number;
  /** Its last 3 sessions did not beat its best before them (those 3 inside this run). */
  stalled: boolean;
  /** Main role: a new best in its last 2 training weeks. Null for the other role. */
  new_best: boolean | null;
  due: boolean;
  reason: DueReason | null;
  /** Not due now, and due after one more training week on the same facts (the weekly review's "due next week"). */
  due_next_week: boolean;
}

/**
 * The rotation role of a program entry. Generated programs carry the slot; the seed program does not, so there a
 * main lift and every other compound lift (its secondaries) follow the main-lift rule, and isolation and core work
 * the other.
 */
export function rotationRole(x: Pick<DayExercise, "slot" | "is_main">, ex: Pick<Exercise, "mechanic" | "pattern"> | undefined): RotationRole {
  if (x.slot) return x.slot === "main" || x.slot === "secondary" ? "main" : "other";
  if (x.is_main) return "main";
  return ex && ex.mechanic === "compound" && ex.pattern !== null && ex.pattern !== "isolation" && ex.pattern !== "core" ? "main" : "other";
}

/** Each exercise's role in a program: main when it has the main role on any day. */
export function programRoles(days: readonly { exercises: readonly Pick<DayExercise, "exercise_id" | "slot" | "is_main">[] }[], ex: ReadonlyMap<string, Exercise>): Map<string, RotationRole> {
  const out = new Map<string, RotationRole>();
  for (const d of days)
    for (const x of d.exercises) {
      const r = rotationRole(x, ex.get(x.exercise_id));
      if (out.get(x.exercise_id) !== "main") out.set(x.exercise_id, r);
    }
  return out;
}

/** A session's performance on an exercise: the best e1RM (Epley) when a set has weight, else the most reps, else the longest hold. */
interface Exposure {
  started_at: string;
  week: string;
  kind: "e1rm" | "reps" | "seconds";
  score: number;
}

function exposure(s: WorkoutSession, id: string, unit: Unit, weekStart: WeekStart): Exposure | null {
  let e1rm = 0;
  let reps = 0;
  let seconds = 0;
  for (const x of s.sets) {
    if (x.exercise_id !== id || !x.done) continue;
    if (x.weight != null && x.weight > 0 && x.reps != null && x.reps > 0) e1rm = Math.max(e1rm, epley(convertWeight(x.weight, s.unit, unit), x.reps));
    if (x.reps != null && x.reps > 0) reps = Math.max(reps, x.reps);
    if (x.seconds != null && x.seconds > 0) seconds = Math.max(seconds, x.seconds);
  }
  const week = weekRange(s.local_date, weekStart).start;
  if (e1rm > 0) return { started_at: s.started_at, week, kind: "e1rm", score: Math.round(e1rm * 10) / 10 };
  if (reps > 0) return { started_at: s.started_at, week, kind: "reps", score: reps };
  if (seconds > 0) return { started_at: s.started_at, week, kind: "seconds", score: seconds };
  return null;
}

const hasDoneSet = (s: WorkoutSession) => s.sets.some((x) => x.done && (x.weight != null || x.reps != null || x.seconds != null));

export interface RotationInput {
  /** The active program (its version id and days). */
  program: { id: string; days: readonly { exercises: readonly Pick<DayExercise, "exercise_id" | "slot" | "is_main">[] }[] };
  /** Every program version with its days and activations. */
  programs: readonly Pick<ProgramVersion, "id" | "days" | "activations">[];
  sessions: readonly WorkoutSession[];
  exercises: ReadonlyMap<string, Exercise>;
  /** Local today: sessions after it do not count. */
  today: string;
  weekStart: WeekStart;
  unit: Unit;
  /** The local date of an activation's start. */
  localDateOf: (iso: string) => string;
}

/** The rotation status of every exercise in the active program, in program order. */
export function rotationStatus(input: RotationInput): RotationStatus[] {
  const roles = programRoles(input.program.days, input.exercises);
  // Activations oldest first, each with its program's roles; the active program's open activation is the last.
  const versions = new Map(input.programs.map((p) => [p.id, p]));
  const activations = input.programs
    .flatMap((p) => p.activations.map((a) => ({ program_id: p.id, started_at: a.started_at })))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  const rolesOf = new Map<string, Map<string, RotationRole>>();
  const versionRoles = (id: string) => {
    let r = rolesOf.get(id);
    if (!r) rolesOf.set(id, (r = id === input.program.id ? roles : programRoles(versions.get(id)?.days ?? [], input.exercises)));
    return r;
  };
  const done = input.sessions.filter((s) => s.status === "done" && s.local_date <= input.today && hasDoneSet(s)).sort((a, b) => a.started_at.localeCompare(b.started_at));

  return [...roles].map(([id, role]) => {
    const rule = ROTATION_RULES[role];
    // The run: the latest activations whose program had the exercise in this role, back to the first that did not.
    let start: string | null = null;
    for (let i = activations.length - 1; i >= 0; i--) {
      if (versionRoles(activations[i].program_id).get(id) !== role) break;
      start = activations[i].started_at;
    }
    const inRun = (s: { started_at: string }) => start === null || s.started_at >= start;
    const weeks = [...new Set(done.filter(inRun).map((s) => weekRange(s.local_date, input.weekStart).start))].sort();

    const all = done.flatMap((s) => {
      const e = exposure(s, id, input.unit, input.weekStart);
      return e ? [e] : [];
    });
    // One kind of score: e1RM when the run has a weighted set, else reps, else seconds.
    const runKinds = new Set(all.filter(inRun).map((e) => e.kind));
    const kind = runKinds.has("e1rm") ? "e1rm" : runKinds.has("reps") ? "reps" : "seconds";
    const exposures = all.filter((e) => e.kind === kind);
    const last = exposures.slice(-STALL_SESSIONS);
    const stalled = exposures.length > STALL_SESSIONS && last.every(inRun) && Math.max(...last.map((e) => e.score)) <= Math.max(...exposures.slice(0, -STALL_SESSIONS).map((e) => e.score));

    let newBest: boolean | null = null;
    if (role === "main") {
      const recent = new Set(weeks.slice(-NEW_BEST_WEEKS));
      newBest = exposures.some((e, i) => recent.has(e.week) && inRun(e) && (i === 0 || e.score > Math.max(...exposures.slice(0, i).map((p) => p.score))));
    }
    const reasonAt = (w: number): DueReason | null => (w >= rule.max ? "max" : w >= rule.min && stalled ? "stalled" : w >= rule.min && role === "main" && !newBest ? "no_new_best" : null);
    const reason = reasonAt(weeks.length);
    return {
      exercise_id: id,
      role,
      weeks: weeks.length,
      since: start === null ? null : input.localDateOf(start),
      min: rule.min,
      max: rule.max,
      stalled,
      new_best: newBest,
      due: reason !== null,
      reason,
      due_next_week: reason === null && reasonAt(weeks.length + 1) !== null,
    };
  });
}

/** The rotation status of the active program from the app's data (the bootstrap, the Coach, the generator). */
export function programRotation(d: { settings: Settings; program: Pick<Program, "id" | "days">; programs?: readonly Pick<ProgramVersion, "id" | "days" | "activations">[]; exercises: readonly Exercise[]; sessions: readonly WorkoutSession[] }, today: string): RotationStatus[] {
  return rotationStatus({
    program: d.program,
    programs: d.programs ?? [],
    sessions: d.sessions,
    exercises: new Map(d.exercises.map((e) => [e.id, e])),
    today,
    weekStart: d.settings.week_start,
    unit: d.settings.unit,
    localDateOf: (iso) => localDate(d.settings.timezone, iso),
  });
}

/** Due exercises, most overdue first (weeks past the maximum, then past the minimum), then in program order. */
export function dueList(statuses: readonly RotationStatus[]): RotationStatus[] {
  return statuses
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.due)
    .sort((a, b) => b.s.weeks - b.s.max - (a.s.weeks - a.s.max) || b.s.weeks - b.s.min - (a.s.weeks - a.s.min) || a.i - b.i)
    .map((x) => x.s);
}

const REASON_TEXT: Readonly<Record<DueReason, (weeks: number) => string>> = {
  max: (w) => `${w} weeks in the program`,
  stalled: (w) => `${w} weeks, no progress in the last ${STALL_SESSIONS} sessions`,
  no_new_best: (w) => `${w} weeks, no new best in the last ${NEW_BEST_WEEKS} weeks`,
};

/** A due reason in words: "8 weeks in the program". */
export const reasonText = (reason: DueReason, weeks: number): string => REASON_TEXT[reason](weeks);

/** The reason in words, for the Program screen's due line and the Coach: "8 weeks in the program". */
export const dueText = (s: RotationStatus): string => (s.reason ? reasonText(s.reason, s.weeks) : `${s.weeks} of ${s.max} weeks`);

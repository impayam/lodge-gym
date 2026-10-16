// Coach tool propose_exercise (Payam, 2026-10-16): he asks for one more exercise on a day ("on my chest day add one
// exercise for more chest focus") and gets one card with only the change, "Day 1 · Chest: + Butterfly 3 × 10–15, after
// Seated Cable Row", and two buttons:
//   - Only this session: the existing propose_session_additions path and its rules (a session open today gets it;
//     otherwise that day's plan, so it is in the session when he taps Start). The program does not change.
//   - Whole program: a program draft the app builds itself (his active program with this one exercise in that place),
//     saved under Me → Program → Drafts by the existing Add to Planner endpoint; approving it stays a separate tap.
// The model only picks the day, the exercise and the place (and which button comes first); it writes no numbers and
// no program. Sets, reps and weight come from the same rules as propose_session_additions (sessionTools.ts
// additionNumbers); rest and target RIR from his program entry when the exercise is in it, else the generator's scheme.
// "Worth knowing" holds only what this change causes: the weekly sets it changes, the day's length, and any note of
// the program check that the change adds. Information only, never blocking.

import { z } from "zod";
import { scheme } from "../generator/model";
import { looksTimed } from "../generator/pick";
import { programName } from "../programRules";
import { addItem, planFromDay, planMinutes, seqIds } from "../plan";
import { TARGET_GROUPS } from "../muscles";
import { GROUP_NAME } from "../ai/report";
import type { DayExercise, Exercise, ProgramDay } from "../types";
import { scoreDraft, spacingMessage, type CleanDraft, type DraftExercise } from "./draft";
import { additionNumbers, programEntry, type Addition } from "./sessionTools";
import type { CoachData, ToolOutcome } from "./tools";

export const PROPOSE_EXERCISE_TOOL = {
  name: "propose_exercise",
  description:
    'Proposes ONE exercise for one day of his program, when he asks for one more exercise on a day (for example "add one chest exercise on my chest day"), also when it is only for today. Give the day (program_day_id from get_program), the exercise (an id from get_library or get_program) and the exercise of that day it goes after (after_exercise_id; leave it out to put it at the end of the day; after a member of a superset or tri-set it goes after the whole group). Give no sets, reps or weights: the app fills them with its rules. prefer: "session" when he said it is only for today or this session, "program" when he said from now on or for his program; leave it out when he did not say. The app shows one card with the change and two buttons: "Only this session" (added to his next session of that day; his program stays as it is) and "Whole program" (a program draft under Me → Program → Drafts for his approval). Nothing changes before he taps. The result gives the numbers and what the change does to his weekly sets and the day\'s length. An id not in the library, an exercise already in that day or a day not in his active program returns an error.',
  input_schema: {
    type: "object",
    properties: {
      program_day_id: { type: "string", description: "A day id of his active program, from get_program." },
      exercise_id: { type: "string", description: "Exercise id from get_library or get_program, exactly as written." },
      after_exercise_id: { type: "string", description: "An exercise id of that day; the new exercise goes after it. Leave it out for the end of the day." },
      prefer: { type: "string", enum: ["session", "program"], description: "Which button comes first: what he asked for, when he said it." },
    },
    required: ["program_day_id", "exercise_id"],
    additionalProperties: false,
  },
} as const;

const input = z
  .object({
    program_day_id: z.string().min(1),
    exercise_id: z.string().min(1),
    after_exercise_id: z.string().min(1).optional(),
    prefer: z.enum(["session", "program"]).optional(),
  })
  .strict();

/** The proposed exercise: the card's numbers (as propose_session_additions gives them) and its program entry. */
export type ProposedExercise = Omit<Addition, "reason_fa"> & Required<Pick<DraftExercise, "per_leg" | "rest_sec">> & { target_rir_min: number | null; target_rir_max: number | null };

/** The tool result: what the card shows, and what Whole program saves. */
export interface ExerciseChange {
  shown: true;
  /** The draft's program id on Whole program (a second tap returns the same draft). */
  draft_id: string;
  /** The active program version the change is made to. */
  program_id: string;
  prefer: "session" | "program" | null;
  day: { id: string; name: string; position: number };
  exercise: ProposedExercise;
  /** The exercise it goes after (the last member when he named one in a group); null for an empty day. */
  after: { exercise_id: string; name: string } | null;
  /** Worth knowing: only what this change causes. */
  notes: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => String(round1(n));
const byPosition = <T extends { position: number }>(xs: readonly T[]) => [...xs].sort((a, b) => a.position - b.position);

/** A program's days as draft days: same order, numbers, groups (A1, A2 → A), main lifts, RIR targets and estimates. */
export function programDraftDays(days: readonly ProgramDay[]): CleanDraft["days"] {
  return byPosition(days).map((day) => ({
    name: day.name_en,
    est_minutes: day.est_minutes,
    exercises: byPosition(day.exercises).map((x: DayExercise) => ({
      exercise_id: x.exercise_id,
      sets: x.sets,
      reps_min: x.reps_min,
      reps_max: x.reps_max,
      is_time: x.is_time,
      per_leg: x.per_leg,
      rest_sec: x.rest_sec,
      group: (x.superset_tag ? x.superset_tag[0] : null) as DraftExercise["group"],
      is_main: x.is_main,
      target_rir_min: x.target_rir_min,
      target_rir_max: x.target_rir_max,
    })),
  }));
}

/**
 * The index the new exercise takes in a day: right after `afterId`, or after its whole group when it is in one (never
 * inside his supersets or tri-sets); the end of the day without `afterId`. -1 when `afterId` is not in the day.
 */
export function insertIndex(exercises: readonly DraftExercise[], afterId: string | null | undefined): number {
  if (!afterId) return exercises.length;
  let i = exercises.findIndex((x) => x.exercise_id === afterId);
  if (i < 0) return -1;
  const group = exercises[i].group;
  if (group) while (i + 1 < exercises.length && exercises[i + 1].group === group) i++;
  return i + 1;
}

/** The draft entry of the proposed exercise. */
const entryOf = (x: ProposedExercise): DraftExercise => ({
  exercise_id: x.exercise_id,
  sets: x.sets,
  reps_min: x.reps_min,
  reps_max: x.reps_max,
  is_time: x.is_time,
  per_leg: x.per_leg,
  rest_sec: x.rest_sec,
  group: null,
  is_main: false,
  target_rir_min: x.target_rir_min,
  target_rir_max: x.target_rir_max,
});

/** The days with the exercise inserted at `at` in day `dayIndex`, whose estimate becomes `minutes`. */
function withExercise(days: CleanDraft["days"], dayIndex: number, at: number, entry: DraftExercise, minutes: number): CleanDraft["days"] {
  return days.map((day, i) => (i === dayIndex ? { ...day, est_minutes: minutes, exercises: [...day.exercises.slice(0, at), entry, ...day.exercises.slice(at)] } : day));
}

/**
 * The day's "about N min" with the exercise (Payam, 2026-10-16: one number everywhere), by the Planner's rule
 * (worker/lib/plan.ts planMinutes): the day's own estimate, moved by what the exercise adds with its sets and rest.
 * The card, that day's plan after Only this session (it gets the same rest) and the Whole program draft show it.
 */
export function minutesWith(day: ProgramDay, x: Pick<ProposedExercise, "exercise_id" | "sets" | "reps_min" | "reps_max" | "is_time" | "rest_sec">): number {
  const plan = planFromDay(day, "m", "", seqIds("m"));
  return planMinutes(addItem(plan, x.exercise_id, "", "m-x", { sets: x.sets, reps_min: x.reps_min, reps_max: x.reps_max, is_time: x.is_time, rest_sec: x.rest_sec }), day);
}

/** The active program version (its id and days) as Home and get_program read it. */
function activeProgram(d: CoachData) {
  const info = (d.programs ?? []).find((p) => p.status === "active") ?? null;
  return { id: info?.id ?? d.program.id, name: programName(info, d.program.name), days: info?.days ?? d.program.days };
}

/**
 * Sets, reps and weight as propose_session_additions fills them; rest, target RIR and per-leg from his program entry
 * when the exercise is in his program, else the generator's scheme for the exercise's kind (accessory 90 s, isolation
 * 75 s, core 60 s), with the scheme's RIR target only when his program sets RIR targets.
 */
function proposed(d: CoachData, ex: Exercise, days: readonly ProgramDay[], excludeSessionId?: string): ProposedExercise {
  const numbers = additionNumbers(d, ex, excludeSessionId);
  const entry = programEntry(d, ex.id);
  if (entry) return { exercise_id: ex.id, name: ex.name_en, ...numbers, per_leg: entry.per_leg, rest_sec: entry.rest_sec, target_rir_min: entry.target_rir_min, target_rir_max: entry.target_rir_max };
  const isolation = ex.mechanic === "isolation" || ex.pattern === "isolation";
  const s = scheme(ex.pattern === "core" || looksTimed(ex) ? "core" : isolation ? "isolation" : "accessory", false);
  const usesRir = days.some((day) => day.exercises.some((x) => x.target_rir_min != null));
  return { exercise_id: ex.id, name: ex.name_en, ...numbers, per_leg: false, rest_sec: s.rest, target_rir_min: usesRir ? s.rir[0] : null, target_rir_max: usesRir ? s.rir[1] : null };
}

/** Checks of the program that the change makes no clearer: under or over target is said by the weekly-sets line. */
const SAID_BY_SETS = new Set(["under_target", "over_target"]);

/**
 * Worth knowing (Payam, 2026-10-16): only what this change causes, information only. The weekly sets of every group
 * the exercise changes (biggest change first), against the current target; the day's extra minutes (`minutes`: the
 * day's estimate before and after, by the Planner's rule); every note of the program check that the new program has
 * and the current one does not (the same note with other numbers is not new); and the spacing advice for the groups
 * the change adds to two adjacent days.
 */
export function changeNotes(d: CoachData, before: CleanDraft["days"], after: CleanDraft["days"], dayIndex: number, minutes: [number, number], plannedDates?: ReadonlyMap<number, string>): string[] {
  const was = scoreDraft(d, before, d.today, plannedDates);
  const now = scoreDraft(d, after, d.today, plannedDates);
  const groups = TARGET_GROUPS.filter((g) => round1(now.planned[g]) !== round1(was.planned[g])).sort((a, b) => now.planned[b] - was.planned[b] - (now.planned[a] - was.planned[a]));
  const sets = groups.map((g) => {
    const target = round1(was.targets[g] ?? 0);
    return `${GROUP_NAME[g] ?? g}: ${fmt(now.planned[g])} sets a week with this change (now ${fmt(was.planned[g])}${target ? `; target ${fmt(target)}` : ""}).`;
  });
  const longer = minutes[1] - minutes[0];
  const length = longer > 0 ? [`Day ${dayIndex + 1} gets about ${longer} min longer (about ${minutes[1]} min).`] : [];
  // A note the current program already has (with other numbers) is not caused by the change.
  const key = (i: { code: string; message: string }) => `${i.code}:${i.message.replace(/\d+(\.\d+)?/g, "#")}`;
  const had = new Set(was.issues.map(key));
  const added = now.issues.filter((i) => i.code !== "spacing" && !SAID_BY_SETS.has(i.code) && !had.has(key(i))).map((i) => i.message);
  const spacing = now.spacing.flatMap((f) => {
    const prev = was.spacing.find((w) => w.kind === f.kind && w.pair[0] === f.pair[0] && w.pair[1] === f.pair[1]);
    if (f.kind === "hinge") return prev ? [] : [spacingMessage(f)];
    const groups = f.groups.filter((g) => !prev?.groups.includes(g));
    return groups.length ? [spacingMessage({ ...f, groups })] : [];
  });
  return [...sets, ...length, ...added, ...spacing];
}

/** propose_exercise: checks the day, the exercise and the place, fills the numbers and works out the change's notes. */
export function proposeExercise(d: CoachData, raw: unknown, draftId: string, plannedDates?: ReadonlyMap<number, string>): ToolOutcome {
  const parsed = input.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") };
  const { program_day_id, exercise_id, after_exercise_id, prefer } = parsed.data;
  const program = activeProgram(d);
  const ordered = byPosition(program.days);
  const dayIndex = ordered.findIndex((x) => x.id === program_day_id);
  if (dayIndex < 0) return { ok: false, error: `Unknown program_day_id "${program_day_id}": use a day id of his active program from get_program, or ask him which day he means.` };
  const day = ordered[dayIndex];
  const ex = d.exercises.find((e) => e.id === exercise_id);
  if (!ex || ex.archived_at) return { ok: false, error: `"${exercise_id}" is not in the library: use an id from get_library.` };
  const days = programDraftDays(ordered);
  if (days[dayIndex].exercises.some((x) => x.exercise_id === ex.id)) return { ok: false, error: `${ex.name_en} is already in ${day.name_en}: pick another exercise.` };
  const at = insertIndex(days[dayIndex].exercises, after_exercise_id);
  if (at < 0) return { ok: false, error: `after_exercise_id "${after_exercise_id}" is not in ${day.name_en}: use an exercise id of that day from get_program, or leave it out for the end of the day.` };

  const open = d.sessions.find((s) => s.status === "active" && s.local_date === d.today);
  const exercise = proposed(d, ex, ordered, open?.id);
  const minutes = minutesWith(day, exercise);
  const next = withExercise(days, dayIndex, at, entryOf(exercise), minutes);
  const prev = at > 0 ? days[dayIndex].exercises[at - 1] : null;
  const names = new Map(d.exercises.map((e) => [e.id, e.name_en]));
  const result: ExerciseChange = {
    shown: true,
    draft_id: draftId,
    program_id: program.id,
    prefer: prefer ?? null,
    day: { id: day.id, name: day.name_en, position: dayIndex + 1 },
    exercise,
    after: prev ? { exercise_id: prev.exercise_id, name: names.get(prev.exercise_id) ?? prev.exercise_id } : null,
    notes: changeNotes(d, days, next, dayIndex, [day.est_minutes, minutes], plannedDates),
  };
  return { ok: true, result };
}

/**
 * Whole program: the draft the card describes, built again from the saved tool result: the program version it was
 * proposed for, with the card's exercise and numbers after the same exercise. Null when that is no longer possible
 * (the version, the day or the exercise is gone, or the day already has it).
 */
export function exerciseDraft(d: Pick<CoachData, "exercises" | "program" | "programs">, change: ExerciseChange): CleanDraft | null {
  const info = (d.programs ?? []).find((p) => p.id === change.program_id) ?? null;
  const version = info ?? (d.program.id === change.program_id ? d.program : null);
  if (!version) return null;
  const ordered = byPosition(version.days);
  const dayIndex = ordered.findIndex((x) => x.id === change.day.id);
  const ex = d.exercises.find((e) => e.id === change.exercise.exercise_id);
  if (dayIndex < 0 || !ex || ex.archived_at) return null;
  const days = programDraftDays(ordered);
  if (days[dayIndex].exercises.some((x) => x.exercise_id === ex.id)) return null;
  const at = insertIndex(days[dayIndex].exercises, change.after?.exercise_id);
  if (at < 0) return null;
  return { name: `${programName(info, version.name)} + ${ex.name_en}`, summary_fa: null, days: withExercise(days, dayIndex, at, entryOf(change.exercise), minutesWith(ordered[dayIndex], change.exercise)) };
}

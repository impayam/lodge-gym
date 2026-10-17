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
//
// Replace mode (SPEC-v11 Phase B, Payam 2026-10-17): with replaces_exercise_id the card swaps an exercise of the day
// that is due for a change (the due line's Coach): "Only this session" puts the new one in its place in that day's next
// session, "Whole program" a draft with the new one in its place on every day that has it. The new exercise keeps the
// place's sets, rep range, rest and target RIR; its weight comes from the progression on his last session with it.

import { z } from "zod";
import { scheme } from "../generator/model";
import { looksPerLeg, looksTimed } from "../generator/pick";
import { programName } from "../programRules";
import { addItem, planFromDay, planMinutes, seqIds } from "../plan";
import { groupOf, isTargetGroup, TARGET_GROUPS } from "../muscles";
import { coverRegions, REGION_INFO, type Region } from "../regions";
import { regionCoverage } from "../generator/check";
import { GROUP_NAME } from "../ai/report";
import type { DayExercise, Exercise, ProgramDay } from "../types";
import { scoreDraft, spacingMessage, type CleanDraft, type DraftExercise } from "./draft";
import { additionNumbers, programEntry, type Addition } from "./sessionTools";
import type { CoachData, ToolOutcome } from "./tools";

export const PROPOSE_EXERCISE_TOOL = {
  name: "propose_exercise",
  description:
    'Proposes ONE exercise for one day of his program, when he asks for one more exercise on a day (for example "add one chest exercise on my chest day"), also when it is only for today; or, with replaces_exercise_id, one exercise in place of an exercise of that day (a replacement for an exercise that is due for a change, from suggest_replacements). Give the day (program_day_id from get_program), the exercise (an id from get_library, get_program or suggest_replacements) and, for an addition, the exercise of that day it goes after (after_exercise_id; leave it out to put it at the end of the day; after a member of a superset or tri-set it goes after the whole group). Give no sets, reps or weights: the app fills them with its rules (a replacement keeps the place\'s sets, reps, rest and target RIR). prefer: "session" when he said it is only for today or this session, "program" when he said from now on or for his program; leave it out when he did not say. The app shows one card with the change and two buttons: "Only this session" (in his next session of that day; his program stays as it is) and "Whole program" (a program draft under Me → Program → Drafts for his approval; a replacement takes the place on every day that has the replaced exercise). Nothing changes before he taps. The result gives the numbers and what the change does to his weekly sets and the day\'s length. An id not in the library, an exercise already in that day or a day not in his active program returns an error.',
  input_schema: {
    type: "object",
    properties: {
      program_day_id: { type: "string", description: "A day id of his active program, from get_program." },
      exercise_id: { type: "string", description: "Exercise id from get_library or get_program, exactly as written." },
      after_exercise_id: { type: "string", description: "An exercise id of that day; the new exercise goes after it. Leave it out for the end of the day." },
      replaces_exercise_id: { type: "string", description: "An exercise id of that day that the new exercise replaces (its place, sets and reps). Leave it out to add an exercise." },
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
    replaces_exercise_id: z.string().min(1).optional(),
    prefer: z.enum(["session", "program"]).optional(),
  })
  .strict()
  .refine((v) => !(v.after_exercise_id && v.replaces_exercise_id), "Give after_exercise_id for an addition or replaces_exercise_id for a replacement, not both.");

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
  /** The exercise it goes after (the last member when he named one in a group); null for an empty day or a replacement. */
  after: { exercise_id: string; name: string } | null;
  /** Replace mode: the exercise it takes the place of, and every day of the program that has it. */
  replaces: { exercise_id: string; name: string; days: { id: string; name: string; position: number }[] } | null;
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

/** The days with `oldId` replaced by the proposed exercise everywhere: each place keeps its numbers, groups and role. */
function withReplacement(days: CleanDraft["days"], oldId: string, x: ProposedExercise): CleanDraft["days"] {
  return days.map((day) => ({ ...day, exercises: day.exercises.map((y) => (y.exercise_id === oldId ? { ...y, exercise_id: x.exercise_id, per_leg: x.per_leg, is_time: x.is_time } : y)) }));
}

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
 * and the current one does not (the same note with other numbers is not new; for region coverage, the regions the
 * change leaves without a main-focus exercise); and the spacing advice for the groups
 * the change adds to two adjacent days.
 */
export function changeNotes(
  d: CoachData,
  beforeDays: CleanDraft["days"],
  afterDays: CleanDraft["days"],
  dayIndex: number,
  minutes: [number, number],
  plannedDates?: ReadonlyMap<number, string>,
  replaced?: Exercise
): string[] {
  const was = scoreDraft(d, beforeDays, d.today, plannedDates);
  const now = scoreDraft(d, afterDays, d.today, plannedDates);
  const changed = TARGET_GROUPS.filter((g) => round1(now.planned[g]) !== round1(was.planned[g])).sort((a, b) => now.planned[b] - was.planned[b] - (now.planned[a] - was.planned[a]));
  // A replacement always shows its own muscle group first, changed or not (Payam, PR #25 review).
  const own = replaced ? groupOf(replaced.muscle_primary) : null;
  const groups = own && isTargetGroup(own) ? [own, ...changed.filter((g) => g !== own)] : changed;
  const sets = groups.map((g) => {
    const target = round1(was.targets[g] ?? 0);
    if (round1(now.planned[g]) === round1(was.planned[g])) return `${GROUP_NAME[g] ?? g}: ${fmt(now.planned[g])} sets a week, unchanged${target ? ` (target ${fmt(target)})` : ""}.`;
    return `${GROUP_NAME[g] ?? g}: ${fmt(now.planned[g])} sets a week with this change (now ${fmt(was.planned[g])}${target ? `; target ${fmt(target)}` : ""}).`;
  });
  const longer = minutes[1] - minutes[0];
  const length = longer > 0 ? [`Day ${dayIndex + 1} gets about ${longer} min longer (about ${minutes[1]} min).`] : [];
  // A note the current program already has (with other numbers) is not caused by the change.
  const key = (i: { code: string; message: string }) => `${i.code}:${i.message.replace(/\d+(\.\d+)?/g, "#")}`;
  const had = new Set(was.issues.map(key));
  const added = now.issues.filter((i) => i.code !== "spacing" && i.code !== "coverage" && !SAID_BY_SETS.has(i.code) && !had.has(key(i))).map((i) => i.message);
  // Region coverage (Phase B): only the regions this change leaves without a main-focus exercise.
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  const coveredIn = (days: CleanDraft["days"]) => new Set(regionCoverage(days, ex).filter((c) => c.exercises.length).map((c) => c.region));
  const before = coveredIn(beforeDays);
  const after = coveredIn(afterDays);
  // A replacement first says what happens to the replaced exercise's own main-focus regions: kept by the new
  // exercise, still covered by others, or lost (Payam, PR #25 review: the card shows the region being replaced).
  const ownRegions = replaced ? (coverRegions(replaced.regions).length ? coverRegions(replaced.regions) : replaced.regions.filter((r) => r.emphasis === "primary").map((r) => r.region)) : [];
  const afterRows = regionCoverage(afterDays, ex);
  const name = (id: string) => ex.get(id)?.name_en ?? id;
  const beforeIds = new Set(beforeDays.flatMap((day) => day.exercises.map((x) => x.exercise_id)));
  const regions = ownRegions.map((r: Region) => {
    const by = afterRows.find((c) => c.region === r)?.exercises ?? [];
    const head = `${REGION_INFO[r].label} (main focus of ${replaced!.name_en})`;
    const keeper = by.find((id) => !beforeIds.has(id));
    if (keeper) return `${head}: ${name(keeper)} keeps it as its main focus.`;
    if (by.length) return `${head}: still the main focus of ${by.map(name).join(", ")}.`;
    return `${head}: no main-focus exercise with this change.`;
  });
  const lost = [...before].filter((r) => !after.has(r) && !ownRegions.includes(r)).map((r) => REGION_INFO[r].label);
  const coverage = lost.length ? [`No main-focus exercise with this change for: ${lost.join(", ")}.`] : [];
  const spacing = now.spacing.flatMap((f) => {
    const prev = was.spacing.find((w) => w.kind === f.kind && w.pair[0] === f.pair[0] && w.pair[1] === f.pair[1]);
    if (f.kind === "hinge") return prev ? [] : [spacingMessage(f)];
    const groups = f.groups.filter((g) => !prev?.groups.includes(g));
    return groups.length ? [spacingMessage({ ...f, groups })] : [];
  });
  return [...regions, ...sets, ...length, ...added, ...coverage, ...spacing];
}

/** propose_exercise: checks the day, the exercise and the place, fills the numbers and works out the change's notes. */
export function proposeExercise(d: CoachData, raw: unknown, draftId: string, plannedDates?: ReadonlyMap<number, string>): ToolOutcome {
  const parsed = input.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") };
  const { program_day_id, exercise_id, after_exercise_id, replaces_exercise_id, prefer } = parsed.data;
  const program = activeProgram(d);
  const ordered = byPosition(program.days);
  const dayIndex = ordered.findIndex((x) => x.id === program_day_id);
  if (dayIndex < 0) return { ok: false, error: `Unknown program_day_id "${program_day_id}": use a day id of his active program from get_program, or ask him which day he means.` };
  const day = ordered[dayIndex];
  const ex = d.exercises.find((e) => e.id === exercise_id);
  if (!ex || ex.archived_at) return { ok: false, error: `"${exercise_id}" is not in the library: use an id from get_library.` };
  const days = programDraftDays(ordered);
  if (days[dayIndex].exercises.some((x) => x.exercise_id === ex.id)) return { ok: false, error: `${ex.name_en} is already in ${day.name_en}: pick another exercise.` };
  if (replaces_exercise_id) return proposeReplacement(d, { program, ordered, days, dayIndex, ex, oldId: replaces_exercise_id, prefer: prefer ?? null, draftId, plannedDates });
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
    replaces: null,
    notes: changeNotes(d, days, next, dayIndex, [day.est_minutes, minutes], plannedDates),
  };
  return { ok: true, result };
}

/**
 * Replace mode: the new exercise takes the place of `oldId` in the day (and, for Whole program, on every day that has
 * it). It keeps the place's sets, rep range, rest and target RIR (a timed hold and a rep exercise do not swap numbers:
 * then the app's rules for the new one); the weight comes from the progression on his last session with it.
 */
function proposeReplacement(
  d: CoachData,
  a: { program: { id: string }; ordered: ProgramDay[]; days: CleanDraft["days"]; dayIndex: number; ex: Exercise; oldId: string; prefer: "session" | "program" | null; draftId: string; plannedDates?: ReadonlyMap<number, string> }
): ToolOutcome {
  const day = a.ordered[a.dayIndex];
  const place = day.exercises.find((x) => x.exercise_id === a.oldId);
  const old = d.exercises.find((e) => e.id === a.oldId);
  if (!place || !old) return { ok: false, error: `replaces_exercise_id "${a.oldId}" is not in ${day.name_en}: use an exercise id of that day from get_program.` };
  if (a.ex.id === a.oldId) return { ok: false, error: "The replacement must be another exercise." };
  if (a.ordered.some((x) => x.exercises.some((y) => y.exercise_id === a.ex.id)))
    return { ok: false, error: `${a.ex.name_en} is already in his program: pick another exercise.` };
  const open = d.sessions.find((s) => s.status === "active" && s.local_date === d.today);
  const timed = looksTimed(a.ex);
  const keeps = place.is_time === timed;
  const numbers = additionNumbers(d, a.ex, open?.id, keeps ? place : undefined);
  const exercise: ProposedExercise = {
    exercise_id: a.ex.id,
    name: a.ex.name_en,
    ...numbers,
    per_leg: looksPerLeg(a.ex),
    rest_sec: place.rest_sec,
    target_rir_min: place.target_rir_min,
    target_rir_max: place.target_rir_max,
  };
  const next = withReplacement(a.days, a.oldId, exercise);
  const result: ExerciseChange = {
    shown: true,
    draft_id: a.draftId,
    program_id: a.program.id,
    prefer: a.prefer,
    day: { id: day.id, name: day.name_en, position: a.dayIndex + 1 },
    exercise,
    after: null,
    replaces: {
      exercise_id: old.id,
      name: old.name_en,
      days: a.ordered.flatMap((x, i) => (x.exercises.some((y) => y.exercise_id === old.id) ? [{ id: x.id, name: x.name_en, position: i + 1 }] : [])),
    },
    notes: changeNotes(d, a.days, next, a.dayIndex, [day.est_minutes, day.est_minutes], a.plannedDates, old),
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
  // Replace mode: the version must still have the replaced exercise and not the new one.
  if (change.replaces) {
    const oldId = change.replaces.exercise_id;
    if (!days.some((x) => x.exercises.some((y) => y.exercise_id === oldId)) || days.some((x) => x.exercises.some((y) => y.exercise_id === ex.id))) return null;
    return { name: `${programName(info, version.name)} · ${ex.name_en} for ${change.replaces.name}`, summary_fa: null, days: withReplacement(days, oldId, change.exercise) };
  }
  const at = insertIndex(days[dayIndex].exercises, change.after?.exercise_id);
  if (at < 0) return null;
  return { name: `${programName(info, version.name)} + ${ex.name_en}`, summary_fa: null, days: withExercise(days, dayIndex, at, entryOf(change.exercise), minutesWith(ordered[dayIndex], change.exercise)) };
}

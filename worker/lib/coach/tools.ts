// Coach tools (SPEC-v9 M12 §4, approved by Payam 2026-10-15, with get_recovery and get_training_pattern added at his
// request). All read-only
// and pure: every number comes from the functions the Reports screen, the training overview and the planner advice
// already use (worker/lib/reports.ts, worker/lib/ai/overview.ts, worker/lib/ai/advice.ts), so the coach states the
// same numbers the app shows. Each result is also what the chat draws as a data card (get_program, get_library and
// get_recovery only when the model passes show: true, Payam 2026-10-16). A bad input returns an error the model can
// correct.

import { z } from "zod";
import { countsVolume } from "../category";
import { weekRange } from "../cycle";
import { SEED_PRIORITY } from "../generator/model";
import { isMuscle } from "../muscles";
import { programName, programRules } from "../programRules";
import {
  activeSince,
  bestSet,
  bodyDaily,
  convertWeight,
  firstActivation,
  mainLifts,
  muscleRows,
  muscleTargets,
  plannedSessions,
  programOn,
  setsPerMuscle,
  type BalanceStatus,
  type ReportData,
} from "../reports";
import { addDays, DATE_RE, daysBetween, localHM, weekday } from "../time";
import type { Exercise, Pose, ProgramVersion, WorkoutSession } from "../types";
import { lastHeavyCompound } from "../ai/advice";
import { GROUP_NAME, sessionDay } from "../ai/report";
import { PROPOSE_PROGRAM_TOOL, proposeProgram, type ProposeResult } from "./draft";
import { CALENDAR_TOOLS, plannedThisWeek, runCalendarTool, type CoachCalendar } from "./calendarTools";
import { PROPOSE_SESSION_ADDITIONS_TOOL, proposeSessionAdditions } from "./sessionTools";
import { PROPOSE_EXERCISE_TOOL, proposeExercise } from "./exerciseTool";
import { SUGGEST_REPLACEMENTS_TOOL, regionView, rotationOf, suggestReplacements } from "./rotationTools";
import { blockLetter, currentBlock, regionCoverage } from "../generator";
import { REGIONS, REGION_INFO, isRegion } from "../regions";
import { dueText, type RotationStatus } from "../rotation";

/** Longest date range of one get_sessions, get_volume or get_adherence call (token budget). */
export const MAX_RANGE_DAYS = 92;
/** get_library returns at most this many exercises. */
export const LIBRARY_LIMIT = 60;
/** get_photos returns at most this many photos. */
export const PHOTO_LIMIT = 100;
/** get_prs without an exercise: the latest records over all exercises. */
export const RECORD_LIMIT = 30;

/** The app's data the tools read: the Reports data plus local today, the current instant and the calendar (M13). */
export interface CoachData extends ReportData {
  today: string;
  now: string;
  calendar?: CoachCalendar;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const byTime = (a: WorkoutSession, b: WorkoutSession) => (a.local_date + a.started_at).localeCompare(b.local_date + b.started_at);
const doneSessions = (d: ReportData) => d.sessions.filter((s) => s.status === "done").sort(byTime);

const date = z.string().regex(DATE_RE, "Use a local date, YYYY-MM-DD.");
const range = z
  .object({ from: date, to: date })
  .strict()
  .refine((r) => r.from <= r.to, "from must not be after to.")
  .refine((r) => r.from > r.to || daysBetween(r.from, r.to) < MAX_RANGE_DAYS, `At most ${MAX_RANGE_DAYS} days per call.`);
const weeks = z.number().int().min(1).max(104);

/**
 * The card of get_program, get_library and get_recovery is shown only when he asked to see it (Payam, 2026-10-16):
 * the model passes show: true then. Without it the result is read by the model and no card is drawn.
 */
const SHOW = { type: "boolean", description: 'true only when he asked to see this directly (for example "show me my program"); the app then shows it as a card. Leave it out when you read it for your answer.' } as const;
const show = { show: z.boolean().optional() };

const RANGE_SCHEMA = {
  type: "object",
  properties: {
    from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First local date, YYYY-MM-DD." },
    to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: `Last local date, YYYY-MM-DD; not before from, at most ${MAX_RANGE_DAYS} days after it.` },
  },
  required: ["from", "to"],
  additionalProperties: false,
} as const;

/** The tool definitions sent with every request, in a fixed order (the prompt cache needs the same bytes each time). */
export const COACH_TOOLS = [
  {
    name: "get_sessions",
    description: `Payam's logged sessions between two local dates (inclusive), newest first, with every done set. The open session, if he is training now, is included with status "active". At most ${MAX_RANGE_DAYS} days per call.`,
    input_schema: RANGE_SCHEMA,
  },
  {
    name: "get_e1rm_history",
    description: "Estimated 1RM history of one exercise: the best set of each session day (Epley) over the last N weeks, with the % change from the first to the latest point.",
    input_schema: {
      type: "object",
      properties: {
        exercise_id: { type: "string", description: "Exercise id from get_program, get_sessions or get_library." },
        weeks: { type: "integer", minimum: 1, maximum: 104, description: "How many weeks back from today; default 12." },
      },
      required: ["exercise_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_volume",
    description: `Weekly sets per muscle group (fractional count) against the weekly targets of the program active that week, with the status the Reports screen shows: none, under, on, over or untracked. One row set per week that overlaps the range; the current week is marked partial. At most ${MAX_RANGE_DAYS} days per call.`,
    input_schema: RANGE_SCHEMA,
  },
  {
    name: "get_adherence",
    description: `Planned versus done sessions per week for the weeks that overlap two local dates, and in total. Planned sessions count from the first program activation (or the first week's start, if later), with the days per week of the program active each day. At most ${MAX_RANGE_DAYS} days per call.`,
    input_schema: RANGE_SCHEMA,
  },
  {
    name: "get_prs",
    description: `Personal records by the app's rule: a session's best estimated 1RM for an exercise that beats every earlier session's best. With exercise_id: that exercise's records, newest first, and its best set. Without: the latest ${RECORD_LIMIT} records over all exercises and the best set of each main lift.`,
    input_schema: { type: "object", properties: { exercise_id: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "get_program",
    description:
      "Payam's active program: name, style, days per week, priority muscles, the rules shown on the Program screen, and every day with its exercises, sets, reps, rest, groups and target RIR; for each exercise its main-focus regions and its rotation (training weeks in the program, the weeks it keeps at least and changes by, whether it is due and why); the block it runs in and the regions without a main-focus exercise.",
    input_schema: { type: "object", properties: { show: SHOW }, additionalProperties: false },
  },
  {
    name: "get_library",
    description: `Exercises from the app's library, for choosing exercises or ids for a program, with their region tags (main focus and also trained, with the evidence level). Give at least one filter. At most ${LIBRARY_LIMIT} results, exercises he has done first.`,
    input_schema: {
      type: "object",
      properties: {
        muscle: {
          type: "string",
          enum: ["chest", "back_lats", "back_upper", "quads", "hamstrings", "glutes", "shoulders_front", "shoulders_side", "rear_delts", "biceps", "triceps", "calves", "core", "forearms", "traps", "adductors", "abductors", "lower_back", "neck"],
          description: "Main or secondary muscle.",
        },
        equipment: { type: "string", enum: ["barbell", "dumbbell", "cable", "machine", "bodyweight"] },
        region: { type: "string", enum: [...REGIONS], description: "Only exercises with this region as a main focus (region tags)." },
        query: { type: "string", minLength: 2, description: 'Words in the English name, e.g. "incline press".' },
        show: SHOW,
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_body_weight",
    description: "Body weight over the last N weeks: one value per day (the day's entries averaged), a 7-day moving average, weekly averages and the change.",
    input_schema: { type: "object", properties: { weeks: { type: "integer", minimum: 1, maximum: 104, description: "Default 12." } }, additionalProperties: false },
  },
  {
    name: "get_photos",
    description: "His progress photos (ids, dates and poses only; you cannot see them). To look at photos, ask him to attach them.",
    input_schema: {
      type: "object",
      properties: {
        pose: { type: "string", enum: ["front", "side", "back", "other"] },
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_recovery",
    description: "Recovery for the 48-hour rule (advice for him, never a reason to refuse or remove an exercise), as the planner advice uses it: for each muscle group, his last heavy compound lift (a compound exercise done with load), its date and how many hours ago that session ended. Most recent first.",
    input_schema: { type: "object", properties: { show: SHOW }, additionalProperties: false },
  },
  {
    name: "get_training_pattern",
    description:
      "His usual training weekdays and times from the last 4 weeks of logged sessions (a weekday counts when he trained on it in at least 2 of the 4 weeks), the most days he trained in a row, and the weekday each program day usually falls on; and this week's planned gym sessions from his calendar. Use it when you talk about recovery or spacing between days. When planned_this_week has sessions, use those real dates. Otherwise, when clear is false there is no clear pattern: ask him which days he trains instead of guessing.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  ...CALENDAR_TOOLS,
  SUGGEST_REPLACEMENTS_TOOL,
  PROPOSE_EXERCISE_TOOL,
  PROPOSE_SESSION_ADDITIONS_TOOL,
  PROPOSE_PROGRAM_TOOL,
] as const;

export type CoachToolName = (typeof COACH_TOOLS)[number]["name"];
export const TOOL_NAMES: readonly string[] = COACH_TOOLS.map((t) => t.name);

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

const zodError = (e: z.ZodError) => e.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");

/* ---------------- the read tools ---------------- */

/** The program that holds a day (any version), for the session's program name. */
function programOfDay(d: ReportData, dayId: string): ProgramVersion | null {
  return (d.programs ?? []).find((p) => p.days.some((x) => x.id === dayId)) ?? null;
}

export function getSessions(d: CoachData, from: string, to: string) {
  const unit = d.settings.unit;
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  const list = d.sessions.filter((s) => s.local_date >= from && s.local_date <= to).sort(byTime).reverse();
  return {
    unit,
    from,
    to,
    sessions: list.map((s) => {
      const done = s.sets.filter((x) => x.done);
      const ids = [...new Set(done.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.updated_at.localeCompare(b.updated_at)).map((x) => x.exercise_id))];
      const p = programOfDay(d, s.program_day_id);
      return {
        id: s.id,
        date: s.local_date,
        status: s.status,
        day: sessionDay(d, s.program_day_id)?.name_en ?? s.program_day_id,
        program: p ? programName(p) : null,
        duration_min: s.ended_at ? Math.max(0, Math.round((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 60_000)) : null,
        note: s.note.trim(),
        exercises: ids.map((id) => {
          const sets = done.filter((x) => x.exercise_id === id).sort((a, b) => a.set_index - b.set_index);
          return {
            exercise_id: id,
            name: ex.get(id)?.name_en ?? id,
            is_extra: sets.some((x) => x.is_extra),
            counts_volume: countsVolume(ex.get(id)?.category),
            sets: sets.map((x) => ({
              set: x.set_index + 1,
              weight: x.weight == null ? null : round1(convertWeight(x.weight, s.unit, unit)),
              reps: x.reps,
              seconds: x.seconds,
              rir: x.rir ?? null,
            })),
          };
        }),
      };
    }),
  };
}

export function getE1rmHistory(d: CoachData, exerciseId: string, weeksBack: number): ToolOutcome {
  const e = d.exercises.find((x) => x.id === exerciseId);
  if (!e) return { ok: false, error: `Unknown exercise_id "${exerciseId}". Use an id from get_program, get_sessions or get_library.` };
  const unit = d.settings.unit;
  const from = addDays(d.today, -7 * weeksBack + 1);
  const byDay = new Map<string, { date: string; weight: number; reps: number; e1rm: number }>();
  for (const s of doneSessions(d).filter((x) => x.local_date >= from && x.local_date <= d.today)) {
    const b = bestSet(s, exerciseId, unit);
    const prev = byDay.get(s.local_date);
    if (b && (!prev || b.e1rm > prev.e1rm)) byDay.set(s.local_date, { date: s.local_date, ...b });
  }
  const points = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const first = points[0]?.e1rm ?? null;
  const latest = points.at(-1)?.e1rm ?? null;
  return {
    ok: true,
    result: {
      unit,
      exercise_id: e.id,
      name: e.name_en,
      from,
      to: d.today,
      points,
      first_e1rm: first,
      latest_e1rm: latest,
      best_e1rm: points.length ? Math.max(...points.map((p) => p.e1rm)) : null,
      change_pct: points.length >= 2 && first ? round1((((latest ?? 0) - first) / first) * 100) : null,
      rotation: rotationView(rotationOf(d).find((s) => s.exercise_id === e.id)),
    },
  };
}

/** An exercise's rotation as the tools give it (Phase B); null when it is not in his active program. */
const rotationView = (s: RotationStatus | undefined) =>
  s ? { weeks: s.weeks, since: s.since, keeps_at_least: s.min, changes_by: s.max, weeks_until_changes_by: Math.max(0, s.max - s.weeks), stalled: s.stalled, due: s.due, reason: s.due ? dueText(s) : null } : null;

/** The weeks (by the settings' week start) that overlap [from, to], none after today's week. */
function weeksOver(d: CoachData, from: string, to: string) {
  const out: { start: string; end: string }[] = [];
  const last = to < d.today ? to : d.today;
  for (let w = weekRange(from, d.settings.week_start); w.start <= last; w = weekRange(addDays(w.start, 7), d.settings.week_start)) out.push(w);
  return out;
}

/** The same rows as the Reports screen's "Sets this week vs target" (muscleRows → balanceStatus), per week. */
export function getVolume(d: CoachData, from: string, to: string) {
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  const done = doneSessions(d);
  return {
    weeks: weeksOver(d, from, to).map((w) => {
      const scored = programOn(d, w.end);
      const rows = muscleRows(setsPerMuscle(done.filter((s) => s.local_date >= w.start && s.local_date <= w.end), ex), muscleTargets({ program: scored.program, exercises: d.exercises }));
      return {
        start: w.start,
        end: w.end,
        partial: d.today <= w.end,
        program: programName(programInfoOf(d, scored.program.id), scored.program.name),
        groups: rows.map((r) => ({ group: r.muscle, name: GROUP_NAME[r.muscle] ?? r.muscle, direct_sets: r.sets, fractional_sets: round1(r.fractional), target: r.target == null ? null : round1(r.target), status: r.status as BalanceStatus })),
      };
    }),
  };
}

const programInfoOf = (d: ReportData, id: string) => (d.programs ?? []).find((p) => p.id === id) ?? null;

/** Planned versus done, the training overview's way (worker/lib/ai/overview.ts, option A, whole sessions). */
export function getAdherence(d: CoachData, from: string, to: string) {
  const list = weeksOver(d, from, to);
  const done = doneSessions(d);
  const start = list[0]?.start ?? from;
  const end = list.at(-1)?.end ?? to;
  const first = firstActivation(d);
  const since = first && first > start ? first : start;
  let planned = 0;
  const weekRows = list.map((w) => {
    const p = w.end < since ? 0 : plannedSessions(d, w.start > since ? w.start : since, w.end);
    planned += p;
    return { start: w.start, end: w.end, partial: d.today <= w.end, done: done.filter((s) => s.local_date >= w.start && s.local_date <= w.end).length, planned: Math.round(p) };
  });
  const doneTotal = done.filter((s) => s.local_date >= since && s.local_date <= end).length;
  const plannedTotal = Math.round(planned);
  return {
    from,
    to,
    since,
    sessions_done: doneTotal,
    sessions_planned: plannedTotal,
    adherence_pct: plannedTotal ? Math.min(100, Math.round((doneTotal / plannedTotal) * 100)) : null,
    weeks: weekRows,
  };
}

/** Records: a session's best e1RM for an exercise that beats every earlier session's best (Reports' rule). */
export function getPrs(d: CoachData, exerciseId?: string): ToolOutcome {
  const unit = d.settings.unit;
  const names = new Map(d.exercises.map((e) => [e.id, e.name_en]));
  if (exerciseId && !names.has(exerciseId)) return { ok: false, error: `Unknown exercise_id "${exerciseId}".` };
  const done = doneSessions(d);
  const ids = exerciseId ? [exerciseId] : [...new Set(done.flatMap((s) => s.sets.map((x) => x.exercise_id)))];
  type Rec = { date: string; exercise_id: string; name: string; weight: number; reps: number; e1rm: number; previous_e1rm: number };
  const records: Rec[] = [];
  const best = new Map<string, { exercise_id: string; name: string; date: string; weight: number; reps: number; e1rm: number }>();
  for (const id of ids) {
    let top: number | null = null;
    for (const s of done) {
      const b = bestSet(s, id, unit);
      if (!b) continue;
      if (top != null && b.e1rm > top) records.push({ date: s.local_date, exercise_id: id, name: names.get(id) ?? id, weight: b.weight, reps: b.reps, e1rm: b.e1rm, previous_e1rm: top });
      if (top == null || b.e1rm > top) {
        top = b.e1rm;
        best.set(id, { exercise_id: id, name: names.get(id) ?? id, date: s.local_date, weight: b.weight, reps: b.reps, e1rm: b.e1rm });
      }
    }
  }
  records.sort((a, b) => b.date.localeCompare(a.date) || b.e1rm - a.e1rm);
  const bestIds = exerciseId ? [exerciseId] : mainLifts(d);
  return {
    ok: true,
    result: { unit, records: exerciseId ? records : records.slice(0, RECORD_LIMIT), best: bestIds.flatMap((id) => (best.has(id) ? [best.get(id)!] : [])) },
  };
}

export function getProgram(d: CoachData) {
  const info = (d.programs ?? []).find((p) => p.status === "active") ?? null;
  const days = info?.days ?? d.program.days;
  const style = info?.style ?? "seed_full_body";
  const perWeek = info?.days_per_week ?? days.length;
  const names = new Map(d.exercises.map((e) => [e.id, e.name_en]));
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  const rotation = new Map(rotationOf(d).map((s) => [s.exercise_id, s]));
  const block = currentBlock(d.programs ?? []);
  const missing = regionCoverage(days, ex)
    .filter((c) => !c.exercises.length)
    .map((c) => REGION_INFO[c.region].label);
  return {
    id: info?.id ?? d.program.id,
    name: programName(info, d.program.name),
    style,
    days_per_week: perWeek,
    active_since: activeSince(d, d.today),
    priority_muscles: info?.params?.priority_muscles ?? [...SEED_PRIORITY],
    rules: programRules(info?.style ?? null, perWeek, days.some((x) => x.exercises.some((e) => e.superset_tag)), style === "strength"),
    days: days.map((day) => ({
      day_id: day.id,
      name: day.name_en,
      est_minutes: day.est_minutes,
      exercises: [...day.exercises]
        .sort((a, b) => a.position - b.position)
        .map((x) => ({
          exercise_id: x.exercise_id,
          name: names.get(x.exercise_id) ?? x.exercise_id,
          is_main: x.is_main,
          sets: x.sets,
          reps_min: x.reps_min,
          reps_max: x.reps_max,
          is_time: x.is_time,
          per_leg: x.per_leg,
          rest_sec: x.rest_sec,
          group: x.superset_tag ? x.superset_tag[0] : null,
          target_rir: x.target_rir_min == null || x.target_rir_max == null ? null : { min: x.target_rir_min, max: x.target_rir_max },
          main_focus: ex.get(x.exercise_id) ? regionView(ex.get(x.exercise_id)!, "primary").map((r) => r.label) : [],
          rotation: rotationView(rotation.get(x.exercise_id)),
        })),
    })),
    block: { block, letter: blockLetter(block) },
    regions_without_main_focus: missing,
  };
}

const libraryInput = z
  .object({
    muscle: z.string().refine(isMuscle, "Unknown muscle.").optional(),
    equipment: z.enum(["barbell", "dumbbell", "cable", "machine", "bodyweight"]).optional(),
    region: z.string().refine(isRegion, "Unknown region.").optional(),
    query: z.string().trim().min(2).optional(),
    ...show,
  })
  .strict()
  .refine((f) => f.muscle || f.equipment || f.region || f.query, "Give at least one filter: muscle, equipment, region or query.");

export function getLibrary(d: CoachData, f: z.infer<typeof libraryInput>) {
  const doneIds = new Set(doneSessions(d).flatMap((s) => s.sets.filter((x) => x.done).map((x) => x.exercise_id)));
  const words = f.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const hits = d.exercises
    .filter((e) => !e.archived_at)
    .filter((e) => !f.muscle || e.muscle_primary === f.muscle || e.muscles_secondary.includes(f.muscle))
    .filter((e) => !f.equipment || e.equipment === f.equipment)
    .filter((e) => !f.region || e.regions.some((r) => r.region === f.region && r.emphasis === "primary"))
    .filter((e) => words.every((w) => e.name_en.toLowerCase().includes(w)))
    .sort((a, b) => Number(doneIds.has(b.id)) - Number(doneIds.has(a.id)) || a.name_en.localeCompare(b.name_en));
  const list = hits.slice(0, LIBRARY_LIMIT);
  return {
    total: hits.length,
    returned: list.length,
    exercises: list.map((e: Exercise) => ({
      id: e.id,
      name: e.name_en,
      equipment: e.equipment,
      primary: e.muscle_primary,
      secondary: e.muscles_secondary,
      pattern: e.pattern,
      category: e.category,
      counts_volume: countsVolume(e.category),
      done_before: doneIds.has(e.id),
      main_focus: regionView(e, "primary"),
      also_trained: regionView(e, "secondary"),
    })),
  };
}

/** Body weight like the Reports and Me charts: the day's entries averaged, a 7-day moving average, weekly averages. */
export function getBodyWeight(d: CoachData, weeksBack: number) {
  const unit = d.settings.unit;
  const from = addDays(d.today, -7 * weeksBack + 1);
  const daily = [...bodyDaily(d, unit)];
  const inRange = daily.filter(([k]) => k >= from && k <= d.today);
  const days = inRange.map(([day, value]) => ({ date: day, value, ma7: round1(mean(daily.filter(([k]) => k >= addDays(day, -6) && k <= day).map(([, v]) => v))!) }));
  const weekAvg = new Map<string, number[]>();
  for (const [day, v] of inRange) {
    const w = weekRange(day, d.settings.week_start).start;
    weekAvg.set(w, [...(weekAvg.get(w) ?? []), v]);
  }
  const first = days[0] ?? null;
  const latest = days.at(-1) ?? null;
  return {
    unit,
    from,
    to: d.today,
    days,
    weeks: [...weekAvg].sort(([a], [b]) => a.localeCompare(b)).map(([start, vs]) => ({ start, avg: round1(mean(vs)!) })),
    first: first ? { date: first.date, value: first.value } : null,
    latest: latest ? { date: latest.date, value: latest.value } : null,
    change: first && latest && days.length >= 2 ? round1(latest.value - first.value) : null,
  };
}

const photosInput = z.object({ pose: z.enum(["front", "side", "back", "other"]).optional(), from: date.optional(), to: date.optional() }).strict();

export function getPhotos(d: CoachData, f: { pose?: Pose; from?: string; to?: string }) {
  const sessions = new Map(d.sessions.map((s) => [s.id, s]));
  const hits = d.photos
    .filter((p) => (!f.pose || p.pose === f.pose) && (!f.from || p.local_date >= f.from) && (!f.to || p.local_date <= f.to))
    .sort((a, b) => (b.local_date + b.created_at).localeCompare(a.local_date + a.created_at));
  return {
    total: hits.length,
    photos: hits.slice(0, PHOTO_LIMIT).map((p) => {
      const s = p.session_id ? sessions.get(p.session_id) : null;
      return { id: p.id, date: p.local_date, pose: p.pose, after_session: s ? (sessionDay(d, s.program_day_id)?.name_en ?? s.program_day_id) : null };
    }),
  };
}

/** The planner advice's recovery list (worker/lib/ai/advice.ts lastHeavyCompound), from every done session. */
export function getRecovery(d: CoachData) {
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  return { now: d.now, rule: "Advice, not a ban: a muscle group should get 48 hours between heavy compound lifts.", groups: lastHeavyCompound(doneSessions(d), ex, d.now) };
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;
/** Days of logged sessions the pattern reads (Payam, 2026-10-15): the last 4 weeks. */
export const PATTERN_DAYS = 28;

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const toHM = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const at = (sorted: number[], p: number) => sorted[Math.round(p * (sorted.length - 1))];

/**
 * His usual training days and times (Payam, 2026-10-15), for recovery and spacing: a draft has no weekdays, so the
 * coach reads his real pattern, and asks him when there is none. Planned dates (calendar, M13) will replace this.
 * A weekday is usual when he trained on it in at least 2 of the 4 weeks; the pattern is clear with 4 or more sessions,
 * at least 75 % of them on usual days. The usual time is the median start to the median end (rounded to 30 minutes),
 * given only when half his sessions start within 2 hours of each other.
 */
export function getTrainingPattern(d: CoachData) {
  const from = addDays(d.today, -(PATTERN_DAYS - 1));
  const list = doneSessions(d).filter((s) => s.local_date >= from && s.local_date <= d.today);
  const tz = d.settings.timezone;
  const weeks = new Map<number, Set<number>>();
  const counts = new Map<number, number>();
  for (const s of list) {
    const w = weekday(s.local_date);
    if (!weeks.has(w)) weeks.set(w, new Set());
    weeks.get(w)!.add(Math.floor(daysBetween(from, s.local_date) / 7));
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const usual = MON_FIRST.filter((w) => (weeks.get(w)?.size ?? 0) >= 2);
  const onUsual = list.filter((s) => (usual as readonly number[]).includes(weekday(s.local_date))).length;
  const clear = list.length >= 4 && usual.length > 0 && onUsual / list.length >= 0.75;

  const starts = list.map((s) => toMin(localHM(tz, s.started_at))).sort((a, b) => a - b);
  const ends = list.flatMap((s) => (s.ended_at ? [toMin(localHM(tz, s.ended_at))] : [])).sort((a, b) => a - b);
  const steady = starts.length >= 3 && ends.length > 0 && at(starts, 0.75) - at(starts, 0.25) <= 120;
  const usualTime = steady ? { from: toHM(Math.floor(at(starts, 0.5) / 30) * 30), to: toHM(Math.ceil(at(ends, 0.5) / 30) * 30) } : null;

  const dates = [...new Set(list.map((s) => s.local_date))].sort();
  let run = 0;
  let maxRun = 0;
  dates.forEach((x, i) => {
    run = i > 0 && daysBetween(dates[i - 1], x) === 1 ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  });

  const byProgramDay = new Map<string, Map<number, number>>();
  for (const s of list) {
    const m = byProgramDay.get(s.program_day_id) ?? new Map<number, number>();
    m.set(weekday(s.local_date), (m.get(weekday(s.local_date)) ?? 0) + 1);
    byProgramDay.set(s.program_day_id, m);
  }
  const programDays = [...byProgramDay].flatMap(([id, m]) => {
    const [w, n] = [...m].sort((a, b) => b[1] - a[1])[0];
    return n >= 2 ? [{ day: sessionDay(d, id)?.name_en ?? id, usual_weekday: WEEKDAY[w], times: n }] : [];
  });

  const names = usual.map((w) => WEEKDAY[w]).join(", ");
  // SPEC-v10 §10: planned dates replace the pattern for spacing when this week has any.
  const planned = plannedThisWeek(d);
  const plannedLine = planned.length ? `Planned this week: ${planned.map((p) => `${p.weekday} ${p.start} ${p.day}`).join(", ")}` : "";
  return {
    from,
    to: d.today,
    sessions: list.length,
    weekdays: MON_FIRST.filter((w) => counts.has(w)).map((w) => ({ day: WEEKDAY[w], weeks: weeks.get(w)!.size, sessions: counts.get(w)! })),
    usual_days: usual.map((w) => WEEKDAY[w]),
    usual_time: usualTime,
    max_days_in_a_row: maxRun,
    program_days: programDays,
    clear,
    planned_this_week: planned.map(({ position: _p, ...rest }) => rest),
    source: planned.length ? "calendar" : "pattern",
    summary: plannedLine || (clear ? `${names}, ${usualTime ? `usually ${usualTime.from}–${usualTime.to}` : "at varying times"}` : `No clear pattern in the last 4 weeks (${list.length} ${list.length === 1 ? "session" : "sessions"}).`),
  };
}

/** This week's planned dates by program day position (Day 1 = 1), for the draft's spacing advice (SPEC-v10 §10). */
export function plannedPositions(d: CoachData): Map<number, string> {
  return new Map(plannedThisWeek(d).flatMap((p) => (p.position ? [[p.position, p.date] as [number, string]] : [])));
}

/* ---------------- dispatch ---------------- */

const weeksInput = (key: "weeks") => z.object({ [key]: weeks.optional() }).strict();

/**
 * Runs one tool call. `propose` handles propose_program and `draftId` gives propose_exercise its draft id (ids come
 * from the caller); every other tool is read-only.
 * Never throws for a bad input: the model gets the problem back as an error result.
 */
export function runTool(
  d: CoachData,
  name: string,
  input: unknown,
  propose: (draftInput: unknown) => ProposeResult = (i) => proposeProgram(d, i, "", undefined, plannedPositions(d)),
  draftId: () => string = () => ""
): ToolOutcome {
  const parse = <T>(schema: z.ZodType<T>, f: (v: T) => ToolOutcome): ToolOutcome => {
    const r = schema.safeParse(input ?? {});
    return r.success ? f(r.data) : { ok: false, error: zodError(r.error) };
  };
  switch (name) {
    case "get_sessions":
      return parse(range, (r) => ({ ok: true, result: getSessions(d, r.from, r.to) }));
    case "get_e1rm_history":
      return parse(z.object({ exercise_id: z.string().min(1), weeks: weeks.optional() }).strict(), (r) => getE1rmHistory(d, r.exercise_id, r.weeks ?? 12));
    case "get_volume":
      return parse(range, (r) => ({ ok: true, result: getVolume(d, r.from, r.to) }));
    case "get_adherence":
      return parse(range, (r) => ({ ok: true, result: getAdherence(d, r.from, r.to) }));
    case "get_prs":
      return parse(z.object({ exercise_id: z.string().min(1).optional() }).strict(), (r) => getPrs(d, r.exercise_id));
    case "get_program":
      return parse(z.object(show).strict(), () => ({ ok: true, result: getProgram(d) }));
    case "get_library":
      return parse(libraryInput, (f) => ({ ok: true, result: getLibrary(d, f) }));
    case "get_body_weight":
      return parse(weeksInput("weeks"), (r) => ({ ok: true, result: getBodyWeight(d, (r as { weeks?: number }).weeks ?? 12) }));
    case "get_photos":
      return parse(photosInput, (f) => ({ ok: true, result: getPhotos(d, f) }));
    case "get_recovery":
      return parse(z.object(show).strict(), () => ({ ok: true, result: getRecovery(d) }));
    case "get_training_pattern":
      return parse(z.object({}).strict(), () => ({ ok: true, result: getTrainingPattern(d) }));
    case "suggest_replacements":
      return suggestReplacements(d, input);
    case "propose_exercise":
      return proposeExercise(d, input, draftId(), plannedPositions(d));
    case "propose_session_additions":
      return proposeSessionAdditions(d, input);
    case "propose_program": {
      const r = propose(input);
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
    }
    default:
      return runCalendarTool(d, name, input) ?? { ok: false, error: `Unknown tool "${name}".` };
  }
}

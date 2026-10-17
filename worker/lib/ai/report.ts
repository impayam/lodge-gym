// AI session report (SPEC-v3 M9a), the pure part: the input the model reads, built server-side from the training data
// only (no photos, no personal data beyond training), the system prompt, and the output schema the reply must match.
// Since 2026-10-16 it is the one "After-session report" (Payam): today on top, then "Where you are" in 2–4 lines from
// the training overview's consistency and main-lift facts (where_you_are), and one motivational line that differs from
// the latest ones (recent_motivation); the overview is no longer written after each session. The volume rows are the
// app's own, never the model's.
// Weights stay in the session's unit; earlier sessions are converted to it. Volume uses the muscle map's rules: each
// done set counts 1 for its primary muscle's group and 0.5 for each other group, at most once per group, and only
// strength work counts (setContribution, countsVolume).

import { goalFacts, type GoalFacts } from "../bodyPace";
import { z } from "zod";
import { countsVolume } from "../category";
import { weekRange } from "../cycle";
import { liveItems, groupLabels, type SessionPlan } from "../plan";
import { suggest, type Suggestion } from "../progression";
import { balanceStatus, convertWeight, epley, muscleTargets, programOn, setsPerMuscle, type BalanceStatus, type ReportData } from "../reports";
import { REPORT_GROUPS, isTargetGroup } from "../muscles";
import { addDays, localHM } from "../time";
import type { DayExercise, Exercise, ProgramDay, SetEntry, Unit, WorkoutSession } from "../types";
import { onlySupplied, suppliedNumbers } from "./numbers";
import type { WhereYouAre } from "./overview";

export const GROUP_NAME: Readonly<Record<string, string>> = {
  chest: "Chest",
  back: "Back",
  quads: "Quads",
  hamstrings_glutes: "Hamstrings & glutes",
  shoulders: "Shoulders",
  rear_delts: "Rear delts",
  calves: "Calves",
  core: "Core",
  biceps: "Biceps",
  triceps: "Triceps",
  traps: "Traps",
  forearms: "Forearms",
  lower_back: "Lower back",
  adductors: "Adductors",
  abductors: "Abductors",
  neck: "Neck",
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A done set as the model reads it (weights in the session unit). */
interface SetIn {
  weight: number | null;
  reps: number | null;
  seconds: number | null;
  rir: string | null;
}

export interface ReportExercise {
  exercise_id: string;
  name: string;
  category: string | null;
  /** False for stretching, plyometrics, cardio, strongman and uncategorised work: listed, but 0 volume. */
  counts_volume: boolean;
  primary_muscle: string;
  secondary_muscles: string[];
  /** Added during the session (is_extra), not in the day's plan. */
  is_extra: boolean;
  /** Superset / tri-set label (A1, A2…) when grouped. */
  group: string | null;
  planned: { sets: number; reps: string | null; seconds: number | null; per_leg: boolean; target_rir: string | null } | null;
  done_sets: SetIn[];
  /** Planned sets (or logged sets) that were not done. */
  not_done_sets: number;
  best_e1rm_today: number | null;
  previous_same_day: { date: string; sets: SetIn[]; best_e1rm: number | null } | null;
  /** The app's own progression for next time (SPEC §7 + RIR rules), from today's sets. */
  app_next_time: NextTime | null;
}

/**
 * Next time for one exercise, computed by the app's progression function (worker/lib/progression.ts `suggest`) from
 * today's sets; the model never sets these numbers, it may only add a note (Payam, 2026-10-13).
 */
export interface NextTime {
  kind: "weight" | "bodyweight" | "time";
  /** Weight to use (weight kind), or the top added load for bodyweight work; null when there is none. */
  weight: number | null;
  unit: Unit;
  /** Target time (timed work). */
  seconds: number | null;
  /** Target reps. */
  reps: string | null;
  /** up: one increment; up2: double increment (RIR 3+ on every planned set); same: as today. */
  change: "up" | "up2" | "same";
  /** The increment applied, in `unit` (0 when the same). */
  step: number;
}

export interface VolumeIn {
  key: string;
  group: string;
  today: number;
  week: number;
  target: number | null;
  status: BalanceStatus;
}

export interface ReportInput {
  session: {
    date: string;
    program_day: string;
    start: string;
    end: string | null;
    duration_min: number | null;
    unit: Unit;
    note: string;
  };
  exercises: ReportExercise[];
  missed: { exercises_not_done: string[]; partly_done: { name: string; planned_sets: number; done_sets: number }[] };
  prs_today: { name: string; weight: number; reps: number; e1rm: number; previous_best_e1rm: number }[];
  week_so_far: { start: string; end: string; sessions_done: number; sessions_planned: number; volume: VolumeIn[] };
  watch: { hr_avg: number | null; hr_max: number | null; active_kcal: number | null } | null;
  body_weight: { unit: Unit; today: number | null; weekly_avg_last_4_weeks: { week_start: string; avg: number | null }[] } | null;
  /** "Where you are": consistency and main-lift trends up to the session's date; added by the job (worker/aiReports.ts). */
  where_you_are?: WhereYouAre | null;
  /** The motivational lines of the latest earlier reports, newest first, so this one says something new; added by the job. */
  recent_motivation?: string[];
  /** SPEC-v12 M15: his goal and the body weight's pace against it (null: no goal set; absent in data without goals). */
  goal?: GoalFacts | null;
}

const rirText = (r: number | null | undefined) => (r == null ? null : r >= 3 ? "3+" : String(r));
const rangeText = (min: number | null, max: number | null) => (min == null && max == null ? null : min === max || max == null ? String(min ?? max) : min == null ? String(max) : `${min}–${max}`);
const order = (s: Pick<WorkoutSession, "local_date" | "started_at">) => s.local_date + s.started_at;
const minutes = (a: string, b: string | null) => (b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000)) : null);

/** The program day of a session, in the active program or an archived version. */
export function sessionDay(d: ReportData, dayId: string): ProgramDay | null {
  return d.program.days.find((x) => x.id === dayId) ?? (d.programs ?? []).flatMap((p) => p.days).find((x) => x.id === dayId) ?? null;
}

/** Best Epley e1RM among sets, converted to `unit`. */
function bestE1rm(sets: SetEntry[], from: Unit, unit: Unit): number | null {
  let best: number | null = null;
  for (const x of sets) {
    if (!x.done || x.weight == null || x.reps == null || x.weight <= 0 || x.reps <= 0) continue;
    const e = epley(convertWeight(x.weight, from, unit), x.reps);
    if (best == null || e > best) best = e;
  }
  return best == null ? null : round1(best);
}

const setIn = (x: SetEntry, from: Unit, unit: Unit): SetIn => ({
  weight: x.weight == null ? null : round1(convertWeight(x.weight, from, unit)),
  reps: x.reps,
  seconds: x.seconds,
  rir: rirText(x.rir),
});

/** The app's suggestion as numbers; null for exercises it has none for (extras, nothing logged). */
export function nextTime(s: Suggestion, reps: string | null, unit: Unit): NextTime | null {
  switch (s.kind) {
    case "weight":
      return { kind: "weight", weight: s.weight, unit: s.unit, seconds: null, reps, change: s.allHit ? (s.easy ? "up2" : "up") : "same", step: round1(s.weight - s.lastTop) };
    case "bodyweight":
      return { kind: "bodyweight", weight: s.weight, unit: s.unit, seconds: null, reps, change: s.allHit ? "up" : "same", step: 0 };
    case "time":
      return { kind: "time", weight: null, unit, seconds: s.seconds, reps: null, change: s.allHit ? (s.easy ? "up2" : "up") : "same", step: 0 };
    default:
      return null;
  }
}

/**
 * The model's input for one done session. The planned exercises are the session's plan (SPEC-v3 M9c) when it followed
 * one, otherwise the program day's; extras and exercises without a plan entry are listed after them.
 */
export function buildReportInput(d: ReportData, sessionId: string, plan: SessionPlan | null): ReportInput {
  const s = d.sessions.find((x) => x.id === sessionId);
  if (!s) throw new Error(`session ${sessionId} not found`);
  const tz = d.settings.timezone;
  const unit = s.unit;
  const ex = new Map<string, Exercise>(d.exercises.map((e) => [e.id, e]));
  const day = sessionDay(d, s.program_day_id);
  const done = d.sessions.filter((x) => x.status === "done");
  const before = done.filter((x) => x.id !== s.id && order(x) < order(s));

  // Planned exercises: the plan's live items, or the day's exercises.
  interface Planned {
    exercise_id: string;
    sets: number;
    reps_min: number | null;
    reps_max: number | null;
    is_time: boolean;
    per_leg: boolean;
    target_rir_min: number | null;
    target_rir_max: number | null;
    group: string | null;
  }
  let planned: Planned[];
  if (plan && plan.id === s.id) {
    const labels = groupLabels(plan);
    planned = liveItems(plan).map((it) => ({ ...it, group: labels.get(it.id) ?? null }));
  } else {
    planned = [...(day?.exercises ?? [])].sort((a, b) => a.position - b.position).map((x) => ({ ...x, group: x.superset_tag }));
  }
  const plannedIds = new Set(planned.map((p) => p.exercise_id));
  const setsOf = (id: string) => s.sets.filter((x) => x.exercise_id === id).sort((a, b) => a.set_index - b.set_index);
  const logged = [...new Set(s.sets.map((x) => x.exercise_id))].filter((id) => !plannedIds.has(id));
  const ids = [...planned.map((p) => p.exercise_id), ...logged];

  // The previous session of the same program day (another version of the day keeps its name).
  const sameDay = [...before]
    .reverse()
    .find((x) => x.program_day_id === s.program_day_id || (day && sessionDay(d, x.program_day_id)?.name_en === day.name_en));

  const exercises: ReportExercise[] = ids.map((id) => {
    const e = ex.get(id);
    const p = planned.find((x) => x.exercise_id === id) ?? null;
    const mine = setsOf(id);
    const doneSets = mine.filter((x) => x.done);
    const isExtra = mine.some((x) => x.is_extra) || !p;
    const prevSets = sameDay ? sameDay.sets.filter((x) => x.exercise_id === id && x.done).sort((a, b) => a.set_index - b.set_index) : [];
    let next: NextTime | null = null;
    if (p && e && doneSets.length) {
      const plan = { sets: p.sets, reps_max: p.reps_max ?? 0, is_time: p.is_time };
      next = nextTime(suggest(plan, e, { session_id: s.id, local_date: s.local_date, unit, sets: mine }), p.is_time ? null : rangeText(p.reps_min, p.reps_max), unit);
    }
    return {
      exercise_id: id,
      name: e?.name_en ?? id,
      category: e?.category ?? null,
      counts_volume: countsVolume(e?.category),
      primary_muscle: e?.muscle_primary ?? "",
      secondary_muscles: e?.muscles_secondary ?? [],
      is_extra: isExtra,
      group: p?.group ?? null,
      planned: p
        ? {
            sets: p.sets,
            reps: p.is_time ? null : rangeText(p.reps_min, p.reps_max),
            seconds: p.is_time ? p.reps_max : null,
            per_leg: p.per_leg,
            target_rir: rangeText(p.target_rir_min, p.target_rir_max),
          }
        : null,
      done_sets: doneSets.map((x) => setIn(x, unit, unit)),
      not_done_sets: p ? Math.max(0, p.sets - doneSets.length) : mine.length - doneSets.length,
      best_e1rm_today: bestE1rm(mine, unit, unit),
      previous_same_day: sameDay && prevSets.length ? { date: sameDay.local_date, sets: prevSets.map((x) => setIn(x, sameDay.unit, unit)), best_e1rm: bestE1rm(prevSets, sameDay.unit, unit) } : null,
      app_next_time: next,
    };
  });

  const missed = {
    exercises_not_done: exercises.filter((x) => x.planned && !x.done_sets.length).map((x) => x.name),
    partly_done: exercises
      .filter((x) => x.planned && x.done_sets.length && x.not_done_sets > 0)
      .map((x) => ({ name: x.name, planned_sets: x.planned!.sets, done_sets: x.done_sets.length })),
  };

  // Records: today's best e1RM above every earlier session's best (an earlier best is needed to beat).
  const prs_today = exercises
    .filter((x) => x.best_e1rm_today != null)
    .flatMap((x) => {
      let prev: number | null = null;
      for (const b of before) {
        const v = bestE1rm(b.sets.filter((y) => y.exercise_id === x.exercise_id), b.unit, unit);
        if (v != null && (prev == null || v > prev)) prev = v;
      }
      if (prev == null || x.best_e1rm_today! <= prev) return [];
      const top = s.sets
        .filter((y) => y.exercise_id === x.exercise_id && y.done && y.weight && y.reps && y.weight > 0 && y.reps > 0)
        .reduce((a, b) => (epley(b.weight!, b.reps!) > epley(a.weight!, a.reps!) ? b : a));
      return [{ name: x.name, weight: top.weight!, reps: top.reps!, e1rm: x.best_e1rm_today!, previous_best_e1rm: prev }];
    });

  // Week so far: this session and the earlier ones of its week.
  const range = weekRange(s.local_date, d.settings.week_start);
  const week = done.filter((x) => x.local_date >= range.start && x.local_date <= range.end && order(x) <= order(s));
  const scored = programOn(d, range.end);
  const targets = muscleTargets({ program: scored.program, exercises: d.exercises });
  const today = setsPerMuscle([{ ...s, status: "done" }], ex);
  const weekSets = setsPerMuscle(week.some((x) => x.id === s.id) ? week : [...week, { ...s, status: "done" }], ex);
  const volume: VolumeIn[] = REPORT_GROUPS.filter((g) => isTargetGroup(g) || today[g].fractional || weekSets[g].fractional).map((g) => {
    const target = g in targets ? round1(targets[g]) : null;
    const w = round1(weekSets[g].fractional);
    return {
      key: g,
      group: GROUP_NAME[g] ?? g,
      today: round1(today[g].fractional),
      week: w,
      target,
      status: target == null ? (w ? "untracked" : "none") : balanceStatus(w, target),
    };
  });

  // Apple Watch: the per-session sample stats if present, otherwise the matched watch workouts.
  const rows = d.watch.filter((w) => w.matched_session_id === s.id);
  const chosen = rows.some((w) => w.kind === "session") ? rows.filter((w) => w.kind === "session") : rows;
  const nums = (xs: (number | null)[]) => xs.filter((v): v is number => v != null);
  const hrAvg = nums(chosen.map((w) => w.hr_avg));
  const hrMax = nums(chosen.map((w) => w.hr_max));
  const kcal = nums(chosen.map((w) => w.active_kcal));
  const watch = chosen.length
    ? {
        hr_avg: hrAvg.length ? Math.round(hrAvg.reduce((a, b) => a + b, 0) / hrAvg.length) : null,
        hr_max: hrMax.length ? Math.max(...hrMax) : null,
        active_kcal: kcal.length ? Math.round(kcal.reduce((a, b) => a + b, 0)) : null,
      }
    : null;

  // Body weight in the settings unit: today's entry and the weekly averages of the last 4 weeks.
  const bodyUnit = d.settings.unit;
  const mass = d.body.filter((m) => m.kind === "body_mass");
  const avg = (vals: number[]) => (vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null);
  const valueOn = (from: string, to: string) => avg(mass.filter((m) => m.local_date >= from && m.local_date <= to).map((m) => convertWeight(m.value, m.unit ?? bodyUnit, bodyUnit)));
  const weeks = [3, 2, 1, 0].map((k) => weekRange(addDays(range.start, -7 * k), d.settings.week_start));
  const trend = weeks.map((w) => ({ week_start: w.start, avg: valueOn(w.start, w.end) }));
  const bodyToday = valueOn(s.local_date, s.local_date);
  const body_weight = bodyToday != null || trend.some((t) => t.avg != null) ? { unit: bodyUnit, today: bodyToday, weekly_avg_last_4_weeks: trend } : null;

  return {
    session: {
      date: s.local_date,
      program_day: day?.name_en ?? s.program_day_id,
      start: localHM(tz, s.started_at),
      end: s.ended_at ? localHM(tz, s.ended_at) : null,
      duration_min: minutes(s.started_at, s.ended_at),
      unit,
      note: s.note.trim(),
    },
    exercises,
    missed,
    prs_today,
    week_so_far: { start: range.start, end: range.end, sessions_done: week.length + (week.some((x) => x.id === s.id) ? 0 : 1), sessions_planned: scored.days_per_week, volume },
    watch,
    body_weight,
    ...(d.goals === undefined ? {} : { goal: goalFacts(d, s.local_date) }),
  };
}

/* ---------------- model output ---------------- */

const fa = (max: number, what: string) => z.string().min(1).max(max).describe(what);

export const ReportOutput = z.object({
  summary_fa: fa(1500, "2–4 sentences in Persian: how the session went, honestly."),
  // List lengths are not enforced by the API; normalizeReport keeps the first LIST_MAX items.
  highlights: z.array(fa(400, "Persian")).describe("PRs and progress against the previous session of the same day, in Persian. At most 5; empty when there is none."),
  extras_note_fa: fa(800, "Persian").nullable().describe("What the added (extra) exercises contributed, in Persian; null when there were none."),
  missed_note_fa: fa(800, "Persian").nullable().describe("What was skipped and its effect on the week, in Persian; null when nothing was skipped."),
  next_time: z
    .array(
      z.object({
        exercise_id: z.string().max(100).describe("An exercise that has app_next_time, exactly as given"),
        note_fa: fa(300, "One short Persian sentence, with no numbers."),
      })
    )
    .describe("A short Persian note per exercise with app_next_time. No weights, reps, seconds or set counts: the app shows its own numbers next to the note."),
  warnings: z.array(fa(400, "Persian")).describe("Only real issues, in Persian: a big drop in performance, pain in the note, very many RIR 0 sets. At most 3; usually empty."),
  where_fa: z
    .array(fa(300, "Persian"))
    .describe("Where you are: 2–4 short Persian lines from where_you_are only (consistency, main-lift trends). No tables, no repeat of today's numbers. Empty when where_you_are is null."),
  motivation_fa: fa(200, "One short Persian motivational sentence that ends the report, different from every line in recent_motivation."),
});
export type ReportOutput = z.infer<typeof ReportOutput>;

/** A "Next time" row as stored and shown: the app's numbers and the model's note (dropped if it has any number). */
export type NextTimeRow = NextTime & { exercise_id: string; name: string; note_fa: string | null };

/**
 * The report as stored and shown: the volume rows are the input's own (every group of the week so far; the screen
 * shows the groups trained today in a table and the rest in one line), and "Next time" the app's progression, never
 * the model's numbers.
 */
export type SessionReport = Omit<ReportOutput, "next_time" | "where_fa" | "motivation_fa"> & {
  /** Reports written before 2026-10-16 hold the rows the model copied: the groups trained that day and the targeted ones. */
  volume: { group: string; today: number; week: number; target: number | null; status: BalanceStatus }[];
  next_time: NextTimeRow[];
  /** After-session reports only (2026-10-16); older session reports have none. */
  where_fa?: string[];
  /** "Where you are" lines left out because they had a number the app did not supply. */
  where_dropped?: number;
  /** The closing motivational line (Payam, 2026-10-16); null when it had a number the app did not supply. */
  motivation_fa?: string | null;
};

/** GET /api/sessions/:id/report: the latest row of session_reports. */
export interface ReportView {
  id: string;
  created_at: string;
  model: string;
  status: "ok" | "error";
  report: SessionReport | null;
  /** missing | auth | limit | rate | network | api | invalid | refusal (worker/ai.ts). */
  error_code: string | null;
  error: string | null;
  /** Estimated cost of the call from its token counts (null for a model without a known price). */
  cost_usd: number | null;
}

export interface ReportResponse {
  report: ReportView | null;
  /** A report is queued (waiting for its timing rule) or being written. */
  pending: boolean;
  /** When the queued report will be written (UTC ISO); null when none is queued. */
  due_at: string | null;
  session_status: string;
}

/** Items kept per list of the report. */
export const LIST_MAX = { highlights: 8, warnings: 6, where: 4 } as const;

/** Latin, Persian and Arabic-Indic digits: a note with any of them is not shown (the numbers are the app's). */
const DIGITS = /[0-9\u06F0-\u06F9\u0660-\u0669]/;

/**
 * Keeps the model's prose and adds the app's numbers: the volume rows come from the input (the model writes none), and
 * "Next time" from the app's progression. Prose with a number the app did not supply is left out. Over-long lists are
 * cut to LIST_MAX.
 */
export function normalizeReport(out: ReportOutput, input: ReportInput): SessionReport {
  // "Where you are" uses only where_you_are's numbers (as the overview did); a line with any other number is left out.
  const supplied = suppliedNumbers(input.where_you_are ?? {});
  const where = (out.where_fa ?? []).map((t) => t.trim()).filter(Boolean);
  const whereKept = where.filter((t) => onlySupplied(t, supplied));
  // The motivational line may use the input's numbers (not those of earlier lines); prefer none.
  const motivation = out.motivation_fa?.trim() || null;
  const motivationKept = motivation && onlySupplied(motivation, suppliedNumbers({ ...input, recent_motivation: [] })) ? motivation : null;
  const volume = input.week_so_far.volume.map((v) => ({ group: v.group, today: v.today, week: v.week, target: v.target, status: v.status }));
  return {
    ...out,
    highlights: out.highlights.slice(0, LIST_MAX.highlights),
    next_time: input.exercises
      .filter((x) => x.app_next_time)
      .map((x) => {
        const note = out.next_time.find((n) => n.exercise_id === x.exercise_id)?.note_fa.trim() ?? null;
        return { exercise_id: x.exercise_id, name: x.name, ...x.app_next_time!, note_fa: note && !DIGITS.test(note) ? note : null };
      }),
    warnings: out.warnings.slice(0, LIST_MAX.warnings),
    volume,
    where_fa: whereKept.slice(0, LIST_MAX.where),
    where_dropped: where.length - whereKept.length,
    motivation_fa: motivationKept,
  };
}

export const REPORT_SYSTEM = `You write the after-session training report for one finished gym session of Payam, for the GYM time app. It is the only report after a session: first today, then where his training stands.

Rules:
- Write every text field in Persian (Farsi). Exercise names may stay in English.
- Be honest and concise. Praise only what the numbers show; say plainly when something went worse.
- Use only the numbers in the input. Never invent sets, weights, reps, dates, heart rate or body weight. If something is missing, leave it out.

Today:
- summary_fa: 2–4 sentences on how this session went.
- highlights: today's records (prs_today) and progress against the previous session of the same day.
- Volume: week_so_far.volume has each group's sets today and this week against its target. The app shows it itself (a table of the groups trained today and one line for the rest of the week), so do not list it; mention a group in the prose only when it matters, with its exact numbers. Volume counts each set 1 for its primary group and 0.5 for each other group, at most once per group per set; only strength work counts.
- Exercises with counts_volume false (stretching, plyometrics, cardio, strongman) are listed where relevant but marked as not counted in volume («در حجم شمرده نمی‌شود»).
- Extra exercises (is_extra true) were added during the session; say what they contributed in extras_note_fa (null if there were none).
- Missed exercises and sets: say in missed_note_fa what was skipped and what it means for the week's targets (null if nothing was skipped).
- Next time: the app sets every weight, rep and time for next session with its progression rules (all planned sets at the top of the rep range → +5 lb upper body, +10 lb lower body, +5 lb per dumbbell; kg: +2.5, +5, +2 per dumbbell; RIR 3+ on every planned set → twice that; otherwise the same weight) and shows them itself (app_next_time). In next_time write only a short Persian note per exercise that has app_next_time (keep the weight and aim for every rep, or move up as the app shows), with no numbers at all. Never suggest a weight anywhere in the report. Extra exercises have no progression target.
- Warnings only for real issues: a big drop in performance, pain in the note, or a very high number of RIR 0 sets. Usually there are none.

Goal:
- goal is his training goal and body goal (null: none set). Judge the session against it: Growth wants near-failure sets in the rep ranges, Strength heavy main lifts, Endurance high reps with short rest, Power fast main lifts. goal.pace is the body weight's pace against his body goal: in a Cut, losing weight on pace is progress, not a problem. A body goal never changes the lifting.

Where you are (where_fa):
- 2–4 short lines on where his training stands, from where_you_are only: consistency (sessions done against sessions planned, week by week in weeks and in totals, which count from totals.since) and the main lifts' estimated 1RM trend (lifts[].change_pct, stalls, drops).
- One idea per line. No tables, and do not repeat today's numbers: today's part above already has them.
- Numbers: write only numbers that appear in where_you_are, exactly or rounded (a change_pct of 3.8 may be written as 4%). Prefer words to numbers. The app removes any line with another number.
- When where_you_are is null, where_fa is an empty list.

Motivation (motivation_fa):
- One short Persian sentence that ends the report: encouraging and specific to this session or this week (the effort, a record, showing up, the next session).
- Vary it: never repeat or closely rephrase a line in recent_motivation, and take a different angle from them.
- Sincere, not exaggerated; no emoji. Numbers only from the input, and preferably none.

Always:
- No medical advice. If the note mentions pain or injury, suggest rest or seeing a professional, nothing more.
- Never suggest a deload, a light week or reducing volume, unless Payam's note says he is tired. This is his stated preference.`;

// AI session report (SPEC-v3 M9a), the pure part: the input the model reads, built server-side from the training data
// only (no photos, no personal data beyond training), the system prompt, and the output schema the reply must match.
// Weights stay in the session's unit; earlier sessions are converted to it. Volume uses the muscle map's rules: each
// done set counts 1 for its primary muscle's group and 0.5 for each other group, at most once per group, and only
// strength work counts (setContribution, countsVolume).

import { z } from "zod";
import { countsVolume } from "../category";
import { weekRange } from "../cycle";
import { liveItems, groupLabels, type SessionPlan } from "../plan";
import { suggest, type Suggestion } from "../progression";
import { balanceStatus, convertWeight, epley, muscleTargets, programOn, setsPerMuscle, type BalanceStatus, type ReportData } from "../reports";
import { REPORT_GROUPS, isTargetGroup } from "../muscles";
import { addDays, localHM } from "../time";
import type { DayExercise, Exercise, ProgramDay, SetEntry, Unit, WorkoutSession } from "../types";

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
  app_next_time: string | null;
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

function nextTimeText(s: Suggestion, plan: Pick<DayExercise, "reps_max" | "is_time">): string | null {
  switch (s.kind) {
    case "weight":
      return s.allHit
        ? `${s.weight} ${s.unit} (all planned sets reached ${plan.reps_max} reps${s.easy ? " at RIR 3+: double increment" : ": one increment"})`
        : `${s.weight} ${s.unit}, same weight (not every planned set reached ${plan.reps_max} reps)`;
    case "bodyweight":
      return s.allHit ? `bodyweight: add reps or load (all planned sets reached ${plan.reps_max} reps)` : `bodyweight: same, aim for ${plan.reps_max} reps on every set`;
    case "time":
      return s.allHit ? `${s.seconds} s (every planned set reached ${plan.reps_max} s)` : `${s.seconds} s, same as today`;
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
    let next: string | null = null;
    if (p && e && doneSets.length) {
      const plan = { sets: p.sets, reps_max: p.reps_max ?? 0, is_time: p.is_time };
      next = nextTimeText(suggest(plan, e, { session_id: s.id, local_date: s.local_date, unit, sets: mine }), plan);
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
  };
}

/* ---------------- model output ---------------- */

const fa = (max: number, what: string) => z.string().min(1).max(max).describe(what);

export const ReportOutput = z.object({
  summary_fa: fa(1500, "2–4 sentences in Persian: how the session went, honestly."),
  // List lengths are not enforced by the API; normalizeReport keeps the first LIST_MAX items.
  highlights: z.array(fa(400, "Persian")).describe("PRs and progress against the previous session of the same day, in Persian. At most 5; empty when there is none."),
  volume: z
    .array(
      z.object({
        group: z.string().max(40).describe("The group name exactly as given in week_so_far.volume[].group"),
        today: z.number(),
        week: z.number(),
        target: z.number().nullable(),
        // The API does not enforce enums in this schema; the shown status always comes from the input (normalizeReport).
        status: z.string().max(20).describe("under | on | over | untracked | none, as given"),
      })
    )
    .describe("The groups trained today and the targeted groups, copied from week_so_far.volume without changing any number."),
  extras_note_fa: fa(800, "Persian").nullable().describe("What the added (extra) exercises contributed, in Persian; null when there were none."),
  missed_note_fa: fa(800, "Persian").nullable().describe("What was skipped and its effect on the week, in Persian; null when nothing was skipped."),
  next_time: z.array(fa(400, "Persian")).describe("Concrete suggestions per exercise for next session, in Persian, following app_next_time. At most 8."),
  warnings: z.array(fa(400, "Persian")).describe("Only real issues, in Persian: a big drop in performance, pain in the note, very many RIR 0 sets. At most 3; usually empty."),
});
export type ReportOutput = z.infer<typeof ReportOutput>;

/** The report as stored and shown: the volume table always carries the input's own numbers and status. */
export type SessionReport = Omit<ReportOutput, "volume"> & { volume: { group: string; today: number; week: number; target: number | null; status: BalanceStatus }[] };

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
}

export interface ReportResponse {
  report: ReportView | null;
  /** A report is being written (queued or running). */
  pending: boolean;
  session_status: string;
}

/** Items kept per list of the report. */
export const LIST_MAX = { highlights: 8, next_time: 12, warnings: 6 } as const;

/**
 * Keeps the model's prose and makes its volume table exact: rows for unknown groups are dropped and every number comes
 * from the input (the model is told to copy them; this guarantees it). Rows the model left out are not added. Over-long
 * lists are cut to LIST_MAX.
 */
export function normalizeReport(out: ReportOutput, input: ReportInput): SessionReport {
  const byName = new Map(input.week_so_far.volume.map((v) => [v.group.toLowerCase(), v]));
  const seen = new Set<string>();
  const volume = out.volume.flatMap((r) => {
    const v = byName.get(r.group.trim().toLowerCase());
    if (!v || seen.has(v.key)) return [];
    seen.add(v.key);
    return [{ group: v.group, today: v.today, week: v.week, target: v.target, status: v.status }];
  });
  return {
    ...out,
    highlights: out.highlights.slice(0, LIST_MAX.highlights),
    next_time: out.next_time.slice(0, LIST_MAX.next_time),
    warnings: out.warnings.slice(0, LIST_MAX.warnings),
    volume,
  };
}

export const REPORT_SYSTEM = `You write a short training report for one finished gym session of Payam, for the Lodge Gym app.

Rules:
- Write every text field in Persian (Farsi). Exercise names may stay in English.
- Be honest and concise. Praise only what the numbers show; say plainly when something went worse.
- Use only the numbers in the input. Never invent sets, weights, reps, dates, heart rate or body weight. If something is missing, leave it out.
- The volume table: copy the rows of week_so_far.volume for the groups trained today and every group that has a target, with the exact numbers given. Volume counts each set 1 for its primary group and 0.5 for each other group, at most once per group per set; only strength work counts.
- Exercises with counts_volume false (stretching, plyometrics, cardio, strongman) are listed where relevant but marked as not counted in volume («در حجم شمرده نمی‌شود»).
- Extra exercises (is_extra true) were added during the session; say what they contributed in extras_note_fa (null if there were none).
- Missed exercises and sets: say in missed_note_fa what was skipped and what it means for the week's targets (null if nothing was skipped).
- Next time: suggest weights and reps only by the app's progression rules, which app_next_time already applies: all planned sets at the top of the rep range → +5 lb upper body, +10 lb lower body, +5 lb per dumbbell (kg: +2.5, +5, +2 per dumbbell); RIR 3+ on every planned set → twice that; otherwise the same weight. Extra exercises have no progression target.
- No medical advice. If the note mentions pain or injury, suggest rest or seeing a professional, nothing more.
- Never suggest a deload, a light week or reducing volume, unless Payam's note says he is tired. This is his stated preference.
- Warnings only for real issues: a big drop in performance, pain in the note, or a very high number of RIR 0 sets. Usually there are none.`;

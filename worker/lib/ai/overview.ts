// Training overview (SPEC-v7 M9d), the pure part: the model's input over the window (this week and the previous 4,
// approved 2026-10-13), built from raw training data only (sets, weights, reps, RIR, e1RM history, volume against the
// targets, session notes), never from the text of AI reports or earlier overviews, so mistakes do not compound. Every
// number the overview shows comes from here (e1RM, % change, volume, counts); the model only phrases them, and its prose
// with a number this input does not contain is dropped.

import { z } from "zod";
import { countsVolume } from "../category";
import { weekRange } from "../cycle";
import { toLatinDigits } from "../digits";
import { liveItems, type SessionPlan } from "../plan";
import { activeSince, balanceStatus, bestSet, convertWeight, epley, firstActivation, mainLifts, muscleTargets, plannedSessions, programOn, setsPerMuscle, type BalanceStatus, type ReportData } from "../reports";
import { TARGET_GROUPS } from "../muscles";
import { addDays } from "../time";
import type { Exercise, SetEntry, Unit, WorkoutSession } from "../types";
import { GROUP_NAME, sessionDay } from "./report";

/** This week and the previous 4 (approved 2026-10-13). */
export const OVERVIEW_WEEKS = 5;
/** An exercise has stalled when its last STALL_EXPOSURES sessions did not beat its best before them. */
export const STALL_EXPOSURES = 3;
/** A drop of this many percent from the window's best e1RM is a warning. */
export const DROP_PCT = 10;

const round1 = (n: number) => Math.round(n * 10) / 10;
const order = (s: Pick<WorkoutSession, "local_date" | "started_at">) => s.local_date + s.started_at;

export interface OverviewWeek {
  start: string;
  end: string;
  this_week: boolean;
  sessions_done: number;
  sessions_planned: number;
  volume: { group: string; sets: number; target: number; status: BalanceStatus }[];
}

export interface LiftTrend {
  exercise_id: string;
  name: string;
  /** Best set of each session in the window that had the lift (e1RM, Epley), in the settings unit. */
  points: { date: string; weight: number; reps: number; e1rm: number }[];
  first_e1rm: number | null;
  latest_e1rm: number | null;
  /** % change from the first to the latest point in the window; null with fewer than two points. */
  change_pct: number | null;
}

export interface OverviewInput {
  window: { start: string; end: string; today: string; weeks: number; unit: Unit };
  /** `started`: the local date the active program was (last) activated. */
  program: { name: string; style: string | null; days_per_week: number; started: string | null };
  weeks: OverviewWeek[];
  /** Done and planned sessions from `since`: the first program activation or the window's start, whichever is later. */
  totals: { since: string; sessions_done: number; sessions_planned: number };
  sessions: {
    date: string;
    day: string;
    duration_min: number | null;
    unit: Unit;
    note: string;
    exercises: { name: string; counts_volume: boolean; sets: string[] }[];
  }[];
  lifts: LiftTrend[];
  stalls: { exercise_id: string; name: string; exposures: number; best_e1rm: number; last_e1rm: number }[];
  drops: { exercise_id: string; name: string; best_e1rm: number; latest_e1rm: number; change_pct: number }[];
  skipped: { name: string; day: string; skipped: number; of: number }[];
}

/** A done set as compact text: "135×5 RIR 2", "45 s", "×8" (bodyweight). */
function setText(x: SetEntry, unit: Unit): string {
  const rir = x.rir == null ? "" : ` RIR ${x.rir >= 3 ? "3+" : x.rir}`;
  if (x.seconds != null && x.reps == null) return `${x.seconds} s${rir}`;
  const w = x.weight == null ? "" : `${round1(x.weight)}`;
  return `${w}×${x.reps ?? "–"}${rir}${w ? ` ${unit}` : ""}`;
}

/** Best e1RM of one exercise in one session, in `unit`. */
function e1rmIn(s: WorkoutSession, exerciseId: string, unit: Unit): number | null {
  let best: number | null = null;
  for (const x of s.sets) {
    if (x.exercise_id !== exerciseId || !x.done || x.weight == null || x.reps == null || x.weight <= 0 || x.reps <= 0) continue;
    const e = epley(convertWeight(x.weight, s.unit, unit), x.reps);
    if (best == null || e > best) best = e;
  }
  return best == null ? null : round1(best);
}

/**
 * The model's input for the overview on local `today`. `plans` are the session plans (SPEC-v3 M9c), so skipped
 * exercises are counted against what was planned for each session.
 */
export function buildOverviewInput(d: ReportData, plans: SessionPlan[], today: string, style: string | null): OverviewInput {
  const unit = d.settings.unit;
  const ex = new Map<string, Exercise>(d.exercises.map((e) => [e.id, e]));
  const name = (id: string) => ex.get(id)?.name_en ?? id;
  const thisWeek = weekRange(today, d.settings.week_start);
  const start = addDays(thisWeek.start, -7 * (OVERVIEW_WEEKS - 1));
  const end = today;
  const done = d.sessions.filter((s) => s.status === "done").sort((a, b) => order(a).localeCompare(order(b)));
  const inWindow = done.filter((s) => s.local_date >= start && s.local_date <= end);
  const dayName = (id: string) => sessionDay(d, id)?.name_en ?? id;
  // Planned sessions count from the first program activation, or the window's start if later; each day plans the days
  // of the program active that day, so switching programs or re-activating one never resets the count (Payam,
  // 2026-10-14, option A). Weeks before it plan none; the week it started plans only its days since then.
  const started = activeSince(d, today);
  const first = firstActivation(d);
  const since = first && first > start ? first : start;

  const weeks: OverviewWeek[] = [];
  let planned = 0;
  for (let k = OVERVIEW_WEEKS - 1; k >= 0; k--) {
    const w = weekRange(addDays(thisWeek.start, -7 * k), d.settings.week_start);
    const list = inWindow.filter((s) => s.local_date >= w.start && s.local_date <= w.end);
    const scored = programOn(d, w.end);
    const targets = muscleTargets({ program: scored.program, exercises: d.exercises });
    const sets = setsPerMuscle(list, ex);
    const p = w.end < since ? 0 : plannedSessions(d, w.start > since ? w.start : since, w.end);
    planned += p;
    weeks.push({
      start: w.start,
      end: w.end,
      this_week: k === 0,
      sessions_done: list.length,
      // Whole sessions (Payam, 2026-10-13): "5 of 13", not "5 of 12.6".
      sessions_planned: Math.round(p),
      volume: TARGET_GROUPS.map((g) => ({ group: GROUP_NAME[g], sets: round1(sets[g].fractional), target: round1(targets[g] ?? 0), status: balanceStatus(sets[g].fractional, targets[g] ?? 0) })),
    });
  }

  const sessions = inWindow.map((s) => {
    const ids = [...new Set(s.sets.filter((x) => x.done).map((x) => x.exercise_id))];
    return {
      date: s.local_date,
      day: dayName(s.program_day_id),
      duration_min: s.ended_at ? Math.max(0, Math.round((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 60_000)) : null,
      unit: s.unit,
      note: s.note.trim(),
      exercises: ids.map((id) => ({
        name: name(id),
        counts_volume: countsVolume(ex.get(id)?.category),
        sets: s.sets
          .filter((x) => x.exercise_id === id && x.done)
          .sort((a, b) => a.set_index - b.set_index)
          .map((x) => setText(x, s.unit)),
      })),
    };
  });

  // Main lifts of the program active at the window's end: e1RM per session, and the change over the window.
  const lifts: LiftTrend[] = mainLifts(programOn(d, end)).flatMap((id) => {
    const points = inWindow.flatMap((s) => {
      const b = bestSet(s, id, unit);
      return b ? [{ date: s.local_date, weight: b.weight, reps: b.reps, e1rm: b.e1rm }] : [];
    });
    if (!points.length) return [];
    const first = points[0].e1rm;
    const latest = points[points.length - 1].e1rm;
    return [{ exercise_id: id, name: name(id), points, first_e1rm: first, latest_e1rm: latest, change_pct: points.length >= 2 && first ? round1(((latest - first) / first) * 100) : null }];
  });

  // Stalls and drops of every strength exercise trained in the window, from its whole history.
  const trained = [...new Set(inWindow.flatMap((s) => s.sets.filter((x) => x.done).map((x) => x.exercise_id)))].filter((id) => countsVolume(ex.get(id)?.category));
  const stalls: OverviewInput["stalls"] = [];
  const drops: OverviewInput["drops"] = [];
  for (const id of trained) {
    const exposures = done.flatMap((s) => {
      const e = e1rmIn(s, id, unit);
      return e == null ? [] : [{ date: s.local_date, e1rm: e }];
    });
    if (exposures.length > STALL_EXPOSURES) {
      const last = exposures.slice(-STALL_EXPOSURES);
      const bestBefore = Math.max(...exposures.slice(0, -STALL_EXPOSURES).map((p) => p.e1rm));
      if (last[last.length - 1].date >= start && Math.max(...last.map((p) => p.e1rm)) <= bestBefore)
        stalls.push({ exercise_id: id, name: name(id), exposures: STALL_EXPOSURES, best_e1rm: bestBefore, last_e1rm: last[last.length - 1].e1rm });
    }
    const windowed = exposures.filter((p) => p.date >= start);
    if (windowed.length >= 2) {
      const latest = windowed[windowed.length - 1].e1rm;
      const best = Math.max(...windowed.slice(0, -1).map((p) => p.e1rm));
      const pct = round1(((latest - best) / best) * 100);
      if (pct <= -DROP_PCT) drops.push({ exercise_id: id, name: name(id), best_e1rm: best, latest_e1rm: latest, change_pct: pct });
    }
  }

  // Skipped: planned exercises (the session's plan, or its day) with no done set, counted per exercise and day.
  const planOf = new Map(plans.map((p) => [p.id, p]));
  const skippedMap = new Map<string, { name: string; day: string; skipped: number; of: number }>();
  for (const s of inWindow) {
    const plan = planOf.get(s.id);
    const planned = plan ? liveItems(plan).map((it) => it.exercise_id) : (sessionDay(d, s.program_day_id)?.exercises ?? []).map((x) => x.exercise_id);
    const day = dayName(s.program_day_id);
    for (const id of planned) {
      const key = `${id}|${day}`;
      const row = skippedMap.get(key) ?? { name: name(id), day, skipped: 0, of: 0 };
      row.of++;
      if (!s.sets.some((x) => x.exercise_id === id && x.done)) row.skipped++;
      skippedMap.set(key, row);
    }
  }
  const skipped = [...skippedMap.values()].filter((r) => r.skipped > 0).sort((a, b) => b.skipped - a.skipped || a.name.localeCompare(b.name));

  const program = programOn(d, end);
  return {
    window: { start, end, today, weeks: OVERVIEW_WEEKS, unit },
    program: { name: program.program.name, style, days_per_week: program.days_per_week, started },
    weeks,
    totals: { since, sessions_done: inWindow.filter((s) => s.local_date >= since).length, sessions_planned: Math.round(planned) },
    sessions,
    lifts,
    stalls,
    drops,
    skipped,
  };
}

/* ---------------- numbers ---------------- */

const normal = (text: string) => toLatinDigits(text).replace(/٫/g, ".").replace(/(\d),(?=\d{3}\b)/g, "$1");

/** Every number in a text: Latin, Persian and Arabic-Indic digits, "." or "٫" decimals; signs are ignored. */
export function numbersIn(text: string): number[] {
  return [...normal(text).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

/** The numbers written as a percentage ("4%", "۴٪", "۴ درصد"). */
export function percentsIn(text: string): number[] {
  return [...normal(text).matchAll(/(\d+(?:\.\d+)?)\s*(?:%|٪|درصد)/g)].map((m) => Number(m[1]));
}

export interface Supplied {
  /** Every number in the input, as given and rounded the ways prose rounds them. */
  all: Set<number>;
  /** The percentages the app computed (fields named *_pct). */
  pct: Set<number>;
}

/** The numbers the app supplied in the input. */
export function suppliedNumbers(input: unknown): Supplied {
  const all = new Set<number>();
  const pct = new Set<number>();
  const add = (set: Set<number>, n: number) => {
    const a = Math.abs(n);
    set.add(a);
    set.add(Math.round(a));
    set.add(round1(a));
  };
  const walk = (v: unknown, key: string) => {
    if (typeof v === "number") {
      add(all, v);
      if (key.endsWith("_pct")) add(pct, v);
    } else if (typeof v === "string") numbersIn(v).forEach((x) => add(all, x));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  walk(input, "");
  return { all, pct };
}

/** Whether every number in `text` is one the app supplied, and every percentage one the app computed. */
export const onlySupplied = (text: string, s: Supplied) => numbersIn(text).every((n) => s.all.has(n)) && percentsIn(text).every((n) => s.pct.has(n));

/* ---------------- model output ---------------- */

const fa = (max: number, what: string) => z.string().min(1).max(max).describe(what);

export const OverviewOutput = z.object({
  summary_fa: fa(2000, "3–5 sentences in Persian: how training is going."),
  trends: z.array(fa(400, "Persian")).describe("Main lifts' e1RM direction over the window, from lifts (numbers as given). At most 5."),
  volume_fa: fa(1200, "Persian").nullable().describe("Which groups are on, under or over target this week and over the window."),
  consistency_fa: fa(1200, "Persian").nullable().describe("Sessions per week against the program's days, and any pattern of skipped exercises."),
  focus_next: z.array(fa(400, "Persian")).describe("1–3 concrete priorities for the coming sessions."),
  warnings: z.array(fa(400, "Persian")).describe("Only real issues: stalls, drops, pain in a note. Usually empty. At most 3."),
});
export type OverviewOutput = z.infer<typeof OverviewOutput>;

/** Items kept per list. */
export const OVERVIEW_LIST_MAX = { trends: 5, focus_next: 3, warnings: 3 } as const;

/** The overview as stored and shown: the model's prose that uses only the app's numbers, and the app's lift table. */
export interface TrainingOverview {
  summary_fa: string;
  trends: string[];
  volume_fa: string | null;
  consistency_fa: string | null;
  focus_next: string[];
  warnings: string[];
  /** The app's numbers for the main lifts over the window, in `unit`. */
  lifts: { exercise_id: string; name: string; latest_e1rm: number | null; change_pct: number | null; sessions: number }[];
  unit: string;
  /** Prose items dropped because they had numbers the app did not supply. */
  dropped: number;
}

/** A reply whose summary has a number the app did not supply is invalid (retried once, then an error). */
export function checkOverview(out: OverviewOutput, input: OverviewInput): string | null {
  return onlySupplied(out.summary_fa, suppliedNumbers(input)) ? null : "The summary has numbers the app did not supply.";
}

/** Keeps the prose that uses only the app's numbers (anything else is dropped) and adds the app's lift table. */
export function normalizeOverview(out: OverviewOutput, input: OverviewInput): TrainingOverview {
  const supplied = suppliedNumbers(input);
  let dropped = 0;
  const keep = (t: string | null): string | null => {
    if (t == null) return null;
    if (onlySupplied(t, supplied)) return t.trim();
    dropped++;
    return null;
  };
  const list = (xs: string[], max: number) => xs.map(keep).filter((x): x is string => x != null).slice(0, max);
  return {
    summary_fa: out.summary_fa.trim(),
    trends: list(out.trends, OVERVIEW_LIST_MAX.trends),
    volume_fa: keep(out.volume_fa),
    consistency_fa: keep(out.consistency_fa),
    focus_next: list(out.focus_next, OVERVIEW_LIST_MAX.focus_next),
    warnings: list(out.warnings, OVERVIEW_LIST_MAX.warnings),
    lifts: input.lifts.map((l) => ({ exercise_id: l.exercise_id, name: l.name, latest_e1rm: l.latest_e1rm, change_pct: l.change_pct, sessions: l.points.length })),
    unit: input.window.unit,
    dropped,
  };
}

/* ---------------- API ---------------- */

export interface OverviewView {
  id: string;
  created_at: string;
  model: string;
  window_start: string;
  window_end: string;
  /** The finished session that triggered it (day and date); null for a manual Regenerate. */
  trigger: { session_id: string; program_day_id: string; local_date: string } | null;
  overview: TrainingOverview;
}

export interface OverviewResponse {
  overview: OverviewView | null;
  /** The latest attempt, when it failed after the overview shown (the "Update failed — Retry" note). */
  failed: { created_at: string; error_code: string | null } | null;
  /** An overview is being written (queued or running). */
  pending: boolean;
}

export interface SessionReportItem {
  session_id: string;
  local_date: string;
  program_day_id: string;
  created_at: string;
  status: "ok" | "error";
  summary_fa: string | null;
  error_code: string | null;
}

export const OVERVIEW_SYSTEM = `You write a short overview of Payam's recent gym training for the Lodge Gym app. The window is this week and the previous 4 weeks; this week is marked this_week.

Rules:
- Write every text field in Persian (Farsi). Exercise names may stay in English.
- Be honest and concise: summary_fa is 3–5 sentences.
- Use only the input, which is raw training data computed by the app: sets, weights, reps, RIR, e1RM per session, volume against the weekly targets, sessions per week, skipped exercises, session notes. Never invent data.
- Numbers: write only numbers that appear in the input, exactly or rounded (for example a change_pct of 3.8 may be written as 4%). Prefer words over numbers. Any sentence with another number is removed by the app.
- trends: one item per main lift in lifts that has a change_pct (direction and size over the window).
- volume_fa: groups on, under or over target this week (weeks with this_week true) and over the window. Chest is Payam's priority.
- consistency_fa: sessions done per week against sessions_planned, and any pattern in skipped. Planned sessions count from totals.since (the first program activation or the window's start, whichever is later), each day with the program active that day: weeks before it plan none, and totals compare the sessions done and planned since totals.since.
- focus_next: 1–3 concrete priorities for the coming sessions, for strength and balance.
- warnings: only real issues: stalls, drops, pain or injury in a note. Usually none.
- Never suggest a deload, a light week or less volume, unless a session note says he is tired. This is his stated preference.
- No medical advice; if a note mentions pain, suggest rest or seeing a professional, nothing more.`;

// Weekly / monthly reports (SPEC §10) and the Progress page. Pure functions over the full data set.
// Weights are stored in the unit they were entered in (session unit) and converted only here, to the
// settings unit.

import type { Goals } from "./goals";
import type { BodyMeasurement } from "./measurements";
import { addDays, localDate } from "./time";
import { countsVolume } from "./category";
import { groupOf, REPORT_GROUPS, setContribution, TARGET_GROUPS } from "./muscles";
import { weekRange } from "./cycle";
import { DIRECT_GROUPS } from "./generator/blocks";
import type { BodyMetric, Exercise, HealthWorkout, Photo, Pose, Program, ProgramVersion, Settings, Unit, WorkoutSession } from "./types";

export const LB_PER_KG = 2.20462262;

/** Epley estimated one-rep max: w × (1 + reps / 30). */
export function epley(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}

export function convertWeight(v: number, from: string | null | undefined, to: Unit): number {
  if (!from || from === to) return v;
  if (from === "kg" && to === "lb") return v * LB_PER_KG;
  if (from === "lb" && to === "kg") return v / LB_PER_KG;
  return v;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pctChange = (from: number | null, to: number | null) => (from && to != null ? round1(((to - from) / from) * 100) : null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** SPEC §10 muscle groups with a weekly program target, in order. */
export const MUSCLES = TARGET_GROUPS;

export interface ReportData {
  settings: Settings;
  program: Program;
  exercises: Exercise[];
  sessions: WorkoutSession[];
  watch: HealthWorkout[];
  body: BodyMetric[];
  photos: Photo[];
  /** Every program with its days and activations (SPEC-v2 §8.6). Without it, every week is scored against `program`. */
  programs?: ProgramVersion[];
  /** SPEC-v12 M15: the goal (settings keys) and the body sizes, for Profile, the Coach and the AI reports. */
  goals?: Goals | null;
  measurements?: BodyMeasurement[];
}

/** A program and the sessions per week it plans. */
export interface ScoredProgram {
  program: Program;
  days_per_week: number;
}

/**
 * The program active on local `date` (SPEC-v2 §8.6): past weeks stay scored against the program that was active then.
 * An activation counts from the local date it started; dates before the first activation belong to the first program.
 */
export function programOn(d: ReportData, date: string): ScoredProgram {
  const acts = (d.programs ?? [])
    .flatMap((p) => p.activations.map((a) => ({ p, started_at: a.started_at, from: localDate(d.settings.timezone, a.started_at) })))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  const hit = [...acts].reverse().find((a) => a.from <= date) ?? acts[0];
  if (!hit) return { program: d.program, days_per_week: d.program.days.length };
  return { program: hit.p, days_per_week: hit.p.days_per_week ?? hit.p.days.length };
}

/** Day names of every program, so sessions of archived programs keep their day name. */
function dayNames(d: ReportData): Map<string, string> {
  return new Map([...(d.programs ?? []).flatMap((p) => p.days), ...d.program.days].map((x) => [x.id, x.name_en]));
}

/** The local date the program active on `date` was (last) activated; null when no activation started by then. */
export function activeSince(d: ReportData, date: string): string | null {
  const starts = (d.programs ?? []).flatMap((p) => p.activations.map((a) => localDate(d.settings.timezone, a.started_at))).filter((f) => f <= date);
  return starts.length ? starts.sort().at(-1)! : null;
}

/** The local date the first program was first activated: planned sessions count from here (SPEC-v7 M9d option A). */
export function firstActivation(d: ReportData): string | null {
  const starts = (d.programs ?? []).flatMap((p) => p.activations.map((a) => localDate(d.settings.timezone, a.started_at)));
  return starts.length ? starts.sort()[0] : null;
}

/** Planned sessions over [from, to]: each day adds the weekly days of the program active then, divided by 7. */
export function plannedSessions(d: ReportData, from: string, to: string): number {
  let n = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) n += programOn(d, day).days_per_week / 7;
  return n;
}

export interface SetResult {
  weight: number;
  reps: number;
  e1rm: number;
}

interface Ctx {
  unit: Unit;
  ex: Map<string, Exercise>;
  done: WorkoutSession[];
}

function ctx(d: ReportData): Ctx {
  const done = d.sessions
    .filter((s) => s.status === "done")
    .sort((a, b) => (a.local_date + a.started_at).localeCompare(b.local_date + b.started_at));
  return { unit: d.settings.unit, ex: new Map(d.exercises.map((e) => [e.id, e])), done };
}

const inRange = (date: string, r: { start: string; end: string }) => date >= r.start && date <= r.end;

/** Main lifts (the day's main exercise of each program day) plus the overhead press. */
export function mainLifts(d: Pick<ReportData, "program">): string[] {
  const ids = [...new Set(d.program.days.flatMap((day) => day.exercises.filter((e) => e.is_main).map((e) => e.exercise_id)))];
  if (!ids.includes("ohp")) ids.push("ohp");
  return ids;
}

/**
 * Weekly target per muscle group: the program's own fractional volume (SPEC-v2 §7.4, decided 2026-10-12). Each planned
 * set counts 1 for its primary group and 0.5 for each secondary group, the same way done sets are counted, so following
 * the program exactly is on target for every group. Only strength work counts (SPEC-v2 §7.4, `countsVolume`).
 */
export function muscleTargets(d: Pick<ReportData, "program" | "exercises">): Record<string, number> {
  const exMap = new Map(d.exercises.map((e) => [e.id, e]));
  const t: Record<string, number> = Object.fromEntries(MUSCLES.map((m) => [m, 0]));
  for (const day of d.program.days) for (const de of day.exercises) {
    const e = exMap.get(de.exercise_id);
    if (!e || !countsVolume(e.category)) continue;
    for (const [g, w] of setContribution(e.muscle_primary, e.muscles_secondary)) if (g in t) t[g] += w * de.sets;
  }
  return t;
}

/**
 * Weekly direct-set targets for forearms and neck (SPEC-v11 Phase B, approved 2026-10-17): the sets the program plans
 * for exercises whose primary muscle is forearms or neck. Direct, not fractional: rows, pulls and curls count half a set
 * for the forearms, which would always read as over. Only a group the program trains directly gets a target.
 */
export function directTargets(d: Pick<ReportData, "program" | "exercises">): Record<string, number> {
  const exMap = new Map(d.exercises.map((e) => [e.id, e]));
  const t: Record<string, number> = {};
  for (const day of d.program.days) for (const de of day.exercises) {
    const e = exMap.get(de.exercise_id);
    if (!e || !countsVolume(e.category)) continue;
    const g = groupOf(e.muscle_primary);
    if (g && (DIRECT_GROUPS as readonly string[]).includes(g)) t[g] = (t[g] ?? 0) + de.sets;
  }
  return t;
}

/** Best set (highest Epley 1RM) of an exercise in a session, in the report unit. */
export function bestSet(s: WorkoutSession, exerciseId: string, unit: Unit): SetResult | null {
  let best: SetResult | null = null;
  for (const x of s.sets) {
    if (x.exercise_id !== exerciseId || x.weight == null || x.reps == null || x.weight <= 0 || x.reps <= 0) continue;
    const w = convertWeight(x.weight, s.unit, unit);
    const e = epley(w, x.reps);
    if (!best || e > best.e1rm) best = { weight: round1(w), reps: x.reps, e1rm: round1(e) };
  }
  return best;
}

/** A main lift's estimated 1RM over a window (SPEC-v7 M9d; the after-session report's "Where you are", Step 3). */
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

/** Each lift's best set per session in `sessions` (done ones in the window, oldest first); lifts never done are left out. */
export function liftTrends(sessions: WorkoutSession[], ids: string[], name: (id: string) => string, unit: Unit): LiftTrend[] {
  return ids.flatMap((id) => {
    const points = sessions.flatMap((s) => {
      const b = bestSet(s, id, unit);
      return b ? [{ date: s.local_date, weight: b.weight, reps: b.reps, e1rm: b.e1rm }] : [];
    });
    if (!points.length) return [];
    const first = points[0].e1rm;
    const latest = points[points.length - 1].e1rm;
    return [{ exercise_id: id, name: name(id), points, first_e1rm: first, latest_e1rm: latest, change_pct: points.length >= 2 && first ? round1(((latest - first) / first) * 100) : null }];
  });
}

export function bestIn(sessions: WorkoutSession[], exerciseId: string, unit: Unit): SetResult | null {
  let best: SetResult | null = null;
  for (const s of sessions) {
    const b = bestSet(s, exerciseId, unit);
    if (b && (!best || b.e1rm > best.e1rm)) best = b;
  }
  return best;
}

export interface GroupSets {
  /** Done sets whose primary muscle is in the group. */
  direct: number;
  /** SPEC-v2 §7.4 fractional count: 1 per set for the primary muscle's group, 0.5 for each secondary muscle's group. */
  fractional: number;
}

/**
 * Done sets per report group, direct and fractional. Planned and extra exercises count alike; stretching,
 * plyometrics, cardio and strongman sets count 0 (SPEC-v2 §7.4, `countsVolume`).
 */
export function setsPerMuscle(sessions: WorkoutSession[], ex: Map<string, Exercise>): Record<string, GroupSets> {
  const out: Record<string, GroupSets> = Object.fromEntries(REPORT_GROUPS.map((m) => [m, { direct: 0, fractional: 0 }]));
  for (const s of sessions) for (const x of s.sets) {
    if (!x.done) continue;
    const e = ex.get(x.exercise_id);
    if (!e || !countsVolume(e.category)) continue;
    const primary = groupOf(e.muscle_primary);
    for (const [g, w] of setContribution(e.muscle_primary, e.muscles_secondary)) {
      out[g].fractional += w;
      if (g === primary) out[g].direct += 1;
    }
  }
  return out;
}

/** Volume (weight × reps, report unit) of done sets per primary muscle; only strength work counts (SPEC-v2 §7.4). */
export function volumePerMuscle(sessions: WorkoutSession[], ex: Map<string, Exercise>, unit: Unit): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(MUSCLES.map((m) => [m, 0]));
  for (const s of sessions) for (const x of s.sets) {
    if (!x.done || x.weight == null || x.reps == null || x.weight <= 0 || x.reps <= 0) continue;
    const e = ex.get(x.exercise_id);
    if (!e || !countsVolume(e.category)) continue;
    const g = groupOf(e.muscle_primary);
    if (g && g in out) out[g] += convertWeight(x.weight, s.unit, unit) * x.reps;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
  return out;
}

const totalVolume = (sessions: WorkoutSession[], ex: Map<string, Exercise>, unit: Unit) =>
  Object.values(volumePerMuscle(sessions, ex, unit)).reduce((a, b) => a + b, 0);

const minutes = (s: WorkoutSession) => (s.ended_at ? Math.max(0, Math.round((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 60_000)) : null);

/** One watch record per session: the per-session sample stats if present, else the watch workouts. */
function watchForSession(d: ReportData, sessionId: string): { kcal: number | null; hr: number | null } | null {
  const rows = d.watch.filter((w) => w.matched_session_id === sessionId);
  if (!rows.length) return null;
  const chosen = rows.some((w) => w.kind === "session") ? rows.filter((w) => w.kind === "session") : rows;
  const kcal = chosen.map((w) => w.active_kcal).filter((v): v is number => v != null);
  const hr = chosen.map((w) => w.hr_avg).filter((v): v is number => v != null);
  return { kcal: kcal.length ? kcal.reduce((a, b) => a + b, 0) : null, hr: mean(hr) };
}

/** Daily body-mass values (all sources averaged per day) in the report unit. */
export function bodyDaily(d: Pick<ReportData, "body">, unit: Unit): Map<string, number> {
  const byDay = new Map<string, number[]>();
  for (const m of d.body) {
    if (m.kind !== "body_mass") continue;
    byDay.set(m.local_date, [...(byDay.get(m.local_date) ?? []), convertWeight(m.value, m.unit ?? unit, unit)]);
  }
  return new Map([...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, round1(mean(v)!)]));
}

const nameOf = (c: Ctx, id: string) => ({ exercise_id: id, name_fa: c.ex.get(id)?.name_fa ?? id, name_en: c.ex.get(id)?.name_en ?? id });

/**
 * Records of a period: each exercise logged in `list` whose best set (Epley) beats its best in `before`. A record needs
 * an earlier best to beat, so an exercise's first time never counts.
 */
function recordsIn(c: Ctx, list: WorkoutSession[], before: WorkoutSession[]) {
  const ids = [...new Set(list.flatMap((s) => s.sets.map((x) => x.exercise_id)))];
  return ids
    .map((id) => ({ id, best: bestIn(list, id, c.unit), previous: bestIn(before, id, c.unit) }))
    .filter((x) => x.best && x.previous && x.best.e1rm > x.previous.e1rm)
    .map((x) => ({ ...nameOf(c, x.id), ...x.best!, previous_e1rm: x.previous!.e1rm }));
}

/** Record moments in [from, to]: each session in which an exercise beat its best of every earlier session. */
function recordEvents(c: Ctx, from: string, to: string): number {
  const best = new Map<string, number>();
  let n = 0;
  for (const s of c.done) {
    const ids = [...new Set(s.sets.map((x) => x.exercise_id))];
    for (const id of ids) {
      const b = bestSet(s, id, c.unit);
      if (!b) continue;
      const before = best.get(id);
      if (before != null && b.e1rm > before && s.local_date >= from && s.local_date <= to) n++;
      if (before == null || b.e1rm > before) best.set(id, b.e1rm);
    }
  }
  return n;
}

/* ---------------- weekly ---------------- */

export function weeklyReport(d: ReportData, anyDateInWeek: string) {
  const c = ctx(d);
  const range = weekRange(anyDateInWeek, d.settings.week_start);
  const prevRange = weekRange(addDays(range.start, -7), d.settings.week_start);
  const week = c.done.filter((s) => inRange(s.local_date, range));
  const prev = c.done.filter((s) => inRange(s.local_date, prevRange));
  const before = c.done.filter((s) => s.local_date < range.start);
  // The week is scored against the program active at its end (the current program for the current week).
  const scored = programOn(d, range.end);
  const targets = muscleTargets({ program: scored.program, exercises: d.exercises });
  const direct = directTargets({ program: scored.program, exercises: d.exercises });
  const sets = setsPerMuscle(week, c.ex);
  const dayName = dayNames(d);

  const lifts = mainLifts(scored).map((id) => {
    const best = bestIn(week, id, c.unit);
    const prevBest = bestIn(prev, id, c.unit);
    return { ...nameOf(c, id), best, prev_e1rm: prevBest?.e1rm ?? null, change_pct: pctChange(prevBest?.e1rm ?? null, best?.e1rm ?? null) };
  });

  const prs = recordsIn(c, week, before);

  const watchRows = week.map((s) => watchForSession(d, s.id));
  const kcal = watchRows.map((w) => w?.kcal).filter((v): v is number => v != null);
  const hrs = watchRows.map((w) => w?.hr).filter((v): v is number => v != null);
  const matched = watchRows.filter(Boolean).length;

  const daily = bodyDaily(d, c.unit);
  const avgIn = (r: { start: string; end: string }) => mean([...daily].filter(([k]) => inRange(k, r)).map(([, v]) => v));
  const bodyAvg = avgIn(range);
  const bodyPrev = avgIn(prevRange);

  const mins = week.map(minutes).filter((v): v is number => v != null);
  return {
    range,
    unit: c.unit,
    sessions: {
      done: week.length,
      target: scored.days_per_week,
      program: { id: scored.program.id, name: scored.program.name },
      days: week.map((s) => ({ date: s.local_date, day_id: s.program_day_id, name_en: dayName.get(s.program_day_id) ?? s.program_day_id })),
      total_minutes: mins.reduce((a, b) => a + b, 0),
    },
    muscles: muscleRows(sets, targets, direct),
    lifts,
    prs,
    watch: { active_kcal: kcal.length ? round1(kcal.reduce((a, b) => a + b, 0)) : null, hr_avg: hrs.length ? round1(mean(hrs)!) : null, matched, unmatched: week.length - matched },
    body: {
      avg: bodyAvg != null ? round1(bodyAvg) : null,
      prev_avg: bodyPrev != null ? round1(bodyPrev) : null,
      change: bodyAvg != null && bodyPrev != null ? round1(bodyAvg - bodyPrev) : null,
    },
    notes: week.filter((s) => s.note.trim()).map((s) => ({ date: s.local_date, name_en: dayName.get(s.program_day_id) ?? s.program_day_id, note: s.note.trim() })),
  };
}

/* ---------------- monthly ---------------- */

export interface MonthRange {
  key: string;
  start: string;
  end: string;
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Gregorian calendar month range for "YYYY-MM". */
export function monthRange(key: string): MonthRange {
  const [y, m] = key.split("-").map(Number);
  const start = ymd(y, m, 1);
  const next = m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1);
  return { key, start, end: addDays(next, -1) };
}

export function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/**
 * `today` (the local date) ends the current month's average week; a past month counts all its days.
 */
export function monthlyReport(d: ReportData, key: string, today: string = monthRange(key).end) {
  const c = ctx(d);
  const range = monthRange(key);
  const prevRange = monthRange(shiftMonth(key, -1));
  const month = c.done.filter((s) => inRange(s.local_date, range));
  const prevMonth = c.done.filter((s) => inRange(s.local_date, prevRange));
  // Groups on target (Reports, 2026-10-16): the month's average week against the program's weekly target.
  const last = today < range.end ? today : range.end;
  const days = Math.max(1, Math.round((Date.parse(`${last}T12:00:00Z`) - Date.parse(`${range.start}T12:00:00Z`)) / 86_400_000) + 1);
  const monthSets = setsPerMuscle(month, c.ex);
  const avgWeek = Object.fromEntries(Object.entries(monthSets).map(([g, v]) => [g, { direct: round1((v.direct * 7) / days), fractional: round1((v.fractional * 7) / days) }]));
  const monthProgram = { program: programOn(d, range.end).program, exercises: d.exercises };
  const targets = muscleTargets(monthProgram);
  const direct = directTargets(monthProgram);

  const weeks: { start: string; end: string; sessions: number }[] = [];
  for (let w = weekRange(range.start, d.settings.week_start); w.start <= range.end; w = weekRange(addDays(w.start, 7), d.settings.week_start)) {
    weeks.push({ ...w, sessions: month.filter((s) => inRange(s.local_date, w)).length });
  }
  const target = round1(plannedSessions(d, range.start, range.end));

  const e1rm = mainLifts(programOn(d, range.end)).map((id) => ({
    ...nameOf(c, id),
    points: month
      .map((s) => ({ date: s.local_date, best: bestSet(s, id, c.unit) }))
      .filter((p) => p.best)
      .map((p) => ({ date: p.date, e1rm: p.best!.e1rm, weight: p.best!.weight, reps: p.best!.reps })),
  }));

  const cur = volumePerMuscle(month, c.ex, c.unit);
  const prev = volumePerMuscle(prevMonth, c.ex, c.unit);

  const daily = bodyDaily(d, c.unit);
  const bodyPoints = [...daily]
    .filter(([k]) => inRange(k, range))
    .map(([date, value]) => {
      const window = [...daily].filter(([k]) => k >= addDays(date, -6) && k <= date).map(([, v]) => v);
      return { date, value, ma7: round1(mean(window)!) };
    });

  const photos = (["front", "side", "back", "other"] as Pose[])
    .map((pose) => {
      const list = d.photos.filter((p) => p.pose === pose && inRange(p.local_date, range)).sort((a, b) => (a.local_date + a.created_at).localeCompare(b.local_date + b.created_at));
      return list.length >= 2 ? { pose, first: list[0], last: list[list.length - 1] } : null;
    })
    .filter(Boolean);

  const mins = month.map(minutes).filter((v): v is number => v != null);
  const kcal = month.map((s) => watchForSession(d, s.id)?.kcal).filter((v): v is number => v != null);
  return {
    range,
    unit: c.unit,
    sessions: month.length,
    target,
    adherence_pct: target ? Math.min(100, Math.round((month.length / target) * 100)) : 0,
    weeks,
    e1rm,
    volume: MUSCLES.map((m) => ({ muscle: m, current: cur[m] ?? 0, previous: prev[m] ?? 0 })),
    body: bodyPoints,
    photos,
    avg_minutes: mins.length ? Math.round(mean(mins)!) : null,
    avg_active_kcal: kcal.length ? Math.round(mean(kcal)!) : null,
    /** Records this month, by the weekly report's rule. */
    prs: recordsIn(c, month, c.done.filter((s) => s.local_date < range.start)),
    /** Each group's average week this month (sets × 7 / days counted) against its weekly target. */
    muscles: muscleRows(avgWeek, targets, direct),
  };
}

/* ---------------- progress page ---------------- */

export type BalanceStatus = "none" | "under" | "on" | "over" | "untracked";

/** Under below 80 % of the weekly target, over above 120 %, on target in between. */
export interface MuscleRow {
  muscle: string;
  /** Direct sets (primary muscle). */
  sets: number;
  /** Fractional sets (SPEC-v2 §7.4); the balance thresholds apply to this number. */
  fractional: number;
  /** Weekly program target; null for muscles the program sets no target for. */
  target: number | null;
  status: BalanceStatus;
  /** "direct" for forearms and neck with a direct-set target: the target and the status use the direct sets. */
  basis?: "direct";
}

/**
 * Every report group: the targeted ones in SPEC §10 order, then the ones without a target. Forearms and neck get a
 * direct-set target when the program trains them directly (`directTargets`).
 */
export function muscleRows(sets: Record<string, GroupSets>, targets: Record<string, number>, direct: Record<string, number> = {}): MuscleRow[] {
  return REPORT_GROUPS.map((m) => {
    const v = sets[m] ?? { direct: 0, fractional: 0 };
    if (direct[m]) return { muscle: m, sets: v.direct, fractional: v.fractional, target: direct[m], status: balanceStatus(v.direct, direct[m]), basis: "direct" };
    const t = m in targets ? targets[m] : null;
    return { muscle: m, sets: v.direct, fractional: v.fractional, target: t, status: t === null ? (v.fractional ? "untracked" : "none") : balanceStatus(v.fractional, t) };
  });
}

export function balanceStatus(sets: number, target: number): BalanceStatus {
  if (!target) return sets ? "over" : "none";
  if (sets === 0) return "none";
  const r = sets / target;
  return r < 0.8 ? "under" : r > 1.2 ? "over" : "on";
}

function period(d: ReportData, c: Ctx, from: string, to: string) {
  const list = c.done.filter((s) => s.local_date >= from && s.local_date <= to);
  const lifts = mainLifts(d).map((id) => {
    const withLift = list.filter((s) => bestSet(s, id, c.unit));
    const first = withLift[0];
    const last = withLift[withLift.length - 1];
    const f = first ? { date: first.local_date, ...bestSet(first, id, c.unit)! } : null;
    const l = last ? { date: last.local_date, ...bestSet(last, id, c.unit)! } : null;
    return { ...nameOf(c, id), first: f, current: l, change_pct: pctChange(f?.e1rm ?? null, l?.e1rm ?? null) };
  });
  const weeks: { start: string; volume: number; sessions: number }[] = [];
  for (let w = weekRange(from, d.settings.week_start); w.start <= to; w = weekRange(addDays(w.start, 7), d.settings.week_start)) {
    const inWeek = list.filter((s) => inRange(s.local_date, w));
    weeks.push({ start: w.start, volume: totalVolume(inWeek, c.ex, c.unit), sessions: inWeek.length });
  }
  const daily = [...bodyDaily(d, c.unit)].filter(([k]) => k >= from && k <= to);
  const bFirst = daily[0] ?? null;
  const bLast = daily[daily.length - 1] ?? null;
  const target = plannedSessions(d, from, to);
  return {
    from,
    to,
    lifts,
    volume_weeks: weeks,
    body: {
      first: bFirst ? { date: bFirst[0], value: bFirst[1] } : null,
      current: bLast ? { date: bLast[0], value: bLast[1] } : null,
      change: bFirst && bLast ? round1(bLast[1] - bFirst[1]) : null,
    },
    sessions: list.length,
    adherence_pct: target ? Math.min(100, Math.round((list.length / target) * 100)) : 0,
    /** Record moments in the period: sessions in which an exercise beat its best of every earlier session. */
    records: recordEvents(c, from, to),
  };
}

export function progressReport(d: ReportData, today: string) {
  const c = ctx(d);
  const first = c.done[0]?.local_date ?? today;
  const current = { program: programOn(d, today).program, exercises: d.exercises };
  const targets = muscleTargets(current);
  const week = weekRange(today, d.settings.week_start);
  const sets = setsPerMuscle(c.done.filter((s) => inRange(s.local_date, week)), c.ex);
  return {
    unit: c.unit,
    since: period(d, c, first, today),
    last4: period(d, c, addDays(today, -27), today),
    balance: {
      week,
      muscles: muscleRows(sets, targets, directTargets(current)),
    },
  };
}

/* ---------------- CSV ---------------- */

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Raw sets of done sessions in [from, to] (weights as entered, with the session unit). */
export function setsCsv(d: ReportData, from: string, to: string): string {
  const c = ctx(d);
  const dayName = dayNames(d);
  const rows = [["date", "day", "exercise", "exercise_fa", "set", "weight", "unit", "reps", "seconds", "rir", "done"]];
  for (const s of c.done.filter((x) => x.local_date >= from && x.local_date <= to)) {
    for (const x of [...s.sets].sort((a, b) => a.exercise_id.localeCompare(b.exercise_id) || a.set_index - b.set_index)) {
      const e = c.ex.get(x.exercise_id);
      rows.push([s.local_date, dayName.get(s.program_day_id) ?? s.program_day_id, e?.name_en ?? x.exercise_id, e?.name_fa ?? "", String(x.set_index + 1), x.weight == null ? "" : String(x.weight), s.unit, x.reps == null ? "" : String(x.reps), x.seconds == null ? "" : String(x.seconds), x.rir == null ? "" : x.rir === 3 ? "3+" : String(x.rir), x.done ? "1" : "0"]);
    }
  }
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}


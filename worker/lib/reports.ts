// Weekly / monthly reports (SPEC §10) and the «پیشرفت» page. Pure functions over the full data set.
// Weights are stored in the unit they were entered in (session unit) and converted only here, to the
// settings unit.

import { gregorianToJalali, jalaliToGregorian, ymd } from "./jalali";
import { addDays, daysBetween } from "./time";
import { weekRange } from "./cycle";
import type { BodyMetric, Exercise, HealthWorkout, Photo, Pose, Program, Settings, Unit, WorkoutSession } from "./types";

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

/** SPEC §10 order of muscle groups. */
export const MUSCLES = ["chest", "back", "quads", "hamstrings_glutes", "shoulders", "rear_delts", "calves", "core", "biceps", "triceps"] as const;

export interface ReportData {
  settings: Settings;
  program: Program;
  exercises: Exercise[];
  sessions: WorkoutSession[];
  watch: HealthWorkout[];
  body: BodyMetric[];
  photos: Photo[];
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

/** Main lifts (the day's «اصلی» exercise of each program day) plus the overhead press. */
export function mainLifts(d: ReportData): string[] {
  const ids = d.program.days.flatMap((day) => day.exercises.filter((e) => e.is_main).map((e) => e.exercise_id));
  if (!ids.includes("ohp")) ids.push("ohp");
  return ids;
}

/** Program sets per muscle group per week (the SPEC §10 targets come out of the program). */
export function muscleTargets(d: ReportData): Record<string, number> {
  const exMap = new Map(d.exercises.map((e) => [e.id, e]));
  const t: Record<string, number> = Object.fromEntries(MUSCLES.map((m) => [m, 0]));
  for (const day of d.program.days) for (const de of day.exercises) {
    const m = exMap.get(de.exercise_id)?.muscle_primary;
    if (m) t[m] = (t[m] ?? 0) + de.sets;
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

function bestIn(sessions: WorkoutSession[], exerciseId: string, unit: Unit): SetResult | null {
  let best: SetResult | null = null;
  for (const s of sessions) {
    const b = bestSet(s, exerciseId, unit);
    if (b && (!best || b.e1rm > best.e1rm)) best = b;
  }
  return best;
}

/** Done sets per primary muscle (primary muscle only). */
export function setsPerMuscle(sessions: WorkoutSession[], ex: Map<string, Exercise>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(MUSCLES.map((m) => [m, 0]));
  for (const s of sessions) for (const x of s.sets) {
    if (!x.done) continue;
    const m = ex.get(x.exercise_id)?.muscle_primary;
    if (m) out[m] = (out[m] ?? 0) + 1;
  }
  return out;
}

/** Volume (weight × reps, report unit) of done sets per primary muscle. */
export function volumePerMuscle(sessions: WorkoutSession[], ex: Map<string, Exercise>, unit: Unit): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(MUSCLES.map((m) => [m, 0]));
  for (const s of sessions) for (const x of s.sets) {
    if (!x.done || x.weight == null || x.reps == null || x.weight <= 0 || x.reps <= 0) continue;
    const m = ex.get(x.exercise_id)?.muscle_primary;
    if (m) out[m] = (out[m] ?? 0) + convertWeight(x.weight, s.unit, unit) * x.reps;
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
function bodyDaily(d: ReportData, unit: Unit): Map<string, number> {
  const byDay = new Map<string, number[]>();
  for (const m of d.body) {
    if (m.kind !== "body_mass") continue;
    byDay.set(m.local_date, [...(byDay.get(m.local_date) ?? []), convertWeight(m.value, m.unit ?? unit, unit)]);
  }
  return new Map([...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, round1(mean(v)!)]));
}

const nameOf = (c: Ctx, id: string) => ({ exercise_id: id, name_fa: c.ex.get(id)?.name_fa ?? id, name_en: c.ex.get(id)?.name_en ?? id });

/* ---------------- weekly ---------------- */

export function weeklyReport(d: ReportData, anyDateInWeek: string) {
  const c = ctx(d);
  const range = weekRange(anyDateInWeek, d.settings.week_start);
  const prevRange = weekRange(addDays(range.start, -7), d.settings.week_start);
  const week = c.done.filter((s) => inRange(s.local_date, range));
  const prev = c.done.filter((s) => inRange(s.local_date, prevRange));
  const before = c.done.filter((s) => s.local_date < range.start);
  const targets = muscleTargets(d);
  const sets = setsPerMuscle(week, c.ex);
  const dayName = new Map([...d.program.days].map((x) => [x.id, x.name_fa]));

  const lifts = mainLifts(d).map((id) => {
    const best = bestIn(week, id, c.unit);
    const prevBest = bestIn(prev, id, c.unit);
    return { ...nameOf(c, id), best, prev_e1rm: prevBest?.e1rm ?? null, change_pct: pctChange(prevBest?.e1rm ?? null, best?.e1rm ?? null) };
  });

  const loggedIds = [...new Set(week.flatMap((s) => s.sets.map((x) => x.exercise_id)))];
  const prs = loggedIds
    .map((id) => ({ id, best: bestIn(week, id, c.unit), previous: bestIn(before, id, c.unit) }))
    // A record needs an earlier best to beat.
    .filter((x) => x.best && x.previous && x.best.e1rm > x.previous.e1rm)
    .map((x) => ({ ...nameOf(c, x.id), ...x.best!, previous_e1rm: x.previous!.e1rm }));

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
      target: 4,
      days: week.map((s) => ({ date: s.local_date, day_id: s.program_day_id, name_fa: dayName.get(s.program_day_id) ?? s.program_day_id })),
      total_minutes: mins.reduce((a, b) => a + b, 0),
    },
    muscles: MUSCLES.map((m) => ({ muscle: m, sets: sets[m] ?? 0, target: targets[m] ?? 0 })),
    lifts,
    prs,
    watch: { active_kcal: kcal.length ? round1(kcal.reduce((a, b) => a + b, 0)) : null, hr_avg: hrs.length ? round1(mean(hrs)!) : null, matched, unmatched: week.length - matched },
    body: {
      avg: bodyAvg != null ? round1(bodyAvg) : null,
      prev_avg: bodyPrev != null ? round1(bodyPrev) : null,
      change: bodyAvg != null && bodyPrev != null ? round1(bodyAvg - bodyPrev) : null,
    },
    notes: week.filter((s) => s.note.trim()).map((s) => ({ date: s.local_date, name_fa: dayName.get(s.program_day_id) ?? s.program_day_id, note: s.note.trim() })),
  };
}

/* ---------------- monthly ---------------- */

export interface MonthRange {
  key: string;
  calendar: "gregorian" | "jalali";
  start: string;
  end: string;
}

/** Month range for "YYYY-MM" in the given calendar (Jalali keys look like 1405-07). */
export function monthRange(key: string, calendar: "gregorian" | "jalali"): MonthRange {
  const [y, m] = key.split("-").map(Number);
  if (calendar === "jalali") {
    const start = ymd(...jalaliToGregorian(y, m, 1));
    const next = m === 12 ? ymd(...jalaliToGregorian(y + 1, 1, 1)) : ymd(...jalaliToGregorian(y, m + 1, 1));
    return { key, calendar, start, end: addDays(next, -1) };
  }
  const start = ymd(y, m, 1);
  const next = m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1);
  return { key, calendar, start, end: addDays(next, -1) };
}

export function monthKeyOf(date: string, calendar: "gregorian" | "jalali"): string {
  const [y, m, d] = date.split("-").map(Number);
  if (calendar === "jalali") {
    const [jy, jm] = gregorianToJalali(y, m, d);
    return `${jy}-${String(jm).padStart(2, "0")}`;
  }
  return date.slice(0, 7);
}

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

export function monthlyReport(d: ReportData, key: string) {
  const c = ctx(d);
  const cal = d.settings.month_calendar;
  const range = monthRange(key, cal);
  const prevRange = monthRange(shiftMonth(key, -1), cal);
  const month = c.done.filter((s) => inRange(s.local_date, range));
  const prevMonth = c.done.filter((s) => inRange(s.local_date, prevRange));
  const days = daysBetween(range.start, range.end) + 1;

  const weeks: { start: string; end: string; sessions: number }[] = [];
  for (let w = weekRange(range.start, d.settings.week_start); w.start <= range.end; w = weekRange(addDays(w.start, 7), d.settings.week_start)) {
    weeks.push({ ...w, sessions: month.filter((s) => inRange(s.local_date, w)).length });
  }
  const target = round1((4 * days) / 7);

  const e1rm = mainLifts(d).map((id) => ({
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
  };
}

/* ---------------- progress page ---------------- */

export type BalanceStatus = "none" | "under" | "on" | "over";

/** Under below 80 % of the weekly target, over above 120 %, on target in between. */
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
  const days = daysBetween(from, to) + 1;
  const target = (4 * days) / 7;
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
  };
}

export function progressReport(d: ReportData, today: string) {
  const c = ctx(d);
  const first = c.done[0]?.local_date ?? today;
  const targets = muscleTargets(d);
  const week = weekRange(today, d.settings.week_start);
  const sets = setsPerMuscle(c.done.filter((s) => inRange(s.local_date, week)), c.ex);
  return {
    unit: c.unit,
    since: period(d, c, first, today),
    last4: period(d, c, addDays(today, -27), today),
    balance: {
      week,
      muscles: MUSCLES.map((m) => ({ muscle: m, sets: sets[m] ?? 0, target: targets[m] ?? 0, status: balanceStatus(sets[m] ?? 0, targets[m] ?? 0) })),
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
  const dayName = new Map(d.program.days.map((x) => [x.id, x.name_en]));
  const rows = [["date", "day", "exercise", "exercise_fa", "set", "weight", "unit", "reps", "seconds", "rir", "done"]];
  for (const s of c.done.filter((x) => x.local_date >= from && x.local_date <= to)) {
    for (const x of [...s.sets].sort((a, b) => a.exercise_id.localeCompare(b.exercise_id) || a.set_index - b.set_index)) {
      const e = c.ex.get(x.exercise_id);
      rows.push([s.local_date, dayName.get(s.program_day_id) ?? s.program_day_id, e?.name_en ?? x.exercise_id, e?.name_fa ?? "", String(x.set_index + 1), x.weight == null ? "" : String(x.weight), s.unit, x.reps == null ? "" : String(x.reps), x.seconds == null ? "" : String(x.seconds), x.rir == null ? "" : x.rir === 3 ? "3+" : String(x.rir), x.done ? "1" : "0"]);
    }
  }
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}


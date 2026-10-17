// Profile numbers (SPEC-v12 M15 §3, §5; normalization and pace approved by Payam 2026-10-17). Pure: the after-session
// line, the Living Diamond's four corners now and four weeks ago, and the body goal line. Every number comes from the
// app's own report math (worker/lib/reports.ts: Epley best sets, fractional sets, daily body weight).
//
// Corners (each 0–1, 1 = a full corner; the diamond draws a floor so the shape stays visible):
// - Strength: S = sum over the main lifts of the best estimated 1RM in the last 28 days (a lift not done in the window
//   keeps its baseline value); full = +10 % over the baseline.
// - Growth: ½ × the share of the 30 regions with a done main-focus set this week + ½ × the size score (the mean 8-week
//   change of arm, chest, shoulders and thigh ÷ 1.0 cm, clamped); with fewer than two size entries, the regions alone.
// - Endurance: for every non-main exercise with a set of 12+ reps in the last 28 days, the best reps at its latest
//   working weight ÷ the best reps the first time that weight was used (an earlier session); the median gain ÷ 25 %.
// - Power: no number from sets and weights yet: always shown, as 0 and "No data" (Payam: a manual jump log later).
// Baseline: the goal's set date when at least two weeks of training precede it, otherwise the first 14 days of data.

import { GROUP_NAME } from "./ai/report";
import { weekRange } from "./cycle";
import { bodyLine, type BodyLine } from "./bodyPace";
import { BODY_GOAL_NAME, trainingLabel, type Goals } from "./goals";
import { SIZE_FIELDS, SIZE_NAME, sizeChange, type BodyMeasurement, type SizeField } from "./measurements";
import { groupOf } from "./muscles";
import { REGIONS, REGION_INFO, coverRegions, type Region } from "./regions";
import { bestSet, convertWeight, epley, mainLifts, type ReportData } from "./reports";
import { addDays, localDate, weekday } from "./time";
import type { Exercise, Unit, WorkoutSession } from "./types";

export const STRENGTH_FULL = 0.1;
export const ENDURANCE_FULL = 0.25;
export const SIZE_FULL_CM = 1.0;
export const ENDURANCE_MIN_REPS = 12;
/** The size fields of the Growth score. */
export const GROWTH_SIZES: readonly SizeField[] = ["arm", "chest", "shoulders", "thigh"];
const WINDOW = 28;
const BASELINE_DAYS = 14;
const SIZE_WEEKS = 8;
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface ProfileData extends ReportData {
  goals: Goals | null;
  measurements: BodyMeasurement[];
}

export type Corner = "strength" | "growth" | "endurance" | "power";

export interface CornerValue {
  /** 0–1; 1 is a full corner. 0 also when there is no data. */
  value: number;
  /** The number shown on the corner (always shown, even 0). */
  label: string;
  /** False when nothing could be measured (the label then reads 0 and the panel says why). */
  has_data: boolean;
}

export interface StrengthLift {
  exercise_id: string;
  name: string;
  /** Best e1RM in the window (the baseline when not done in it), in his unit. */
  e1rm: number | null;
  baseline: number | null;
  /** Change against the baseline, in %. */
  change_pct: number | null;
  /** Not done in the last 28 days: its baseline is kept. */
  kept: boolean;
}

export interface EnduranceRow {
  exercise_id: string;
  name: string;
  weight: number;
  first_reps: number;
  best_reps: number;
  first_date: string;
  gain_pct: number;
}

export interface Diamond {
  corners: Record<Corner, CornerValue>;
  /** The same four numbers as of 28 days ago (the dashed ghost). */
  ghost: Record<Corner, number>;
  baseline: { from: string; to: string; kind: "goal" | "first_data" } | null;
  strength: StrengthLift[];
  growth: { regions_done: number; regions_total: number; missing: string[]; sizes: { field: SizeField; name: string; change: number }[]; uses_sizes: boolean };
  endurance: EnduranceRow[];
}

export interface Profile {
  today: string;
  goals: Goals | null;
  goal_label: string | null;
  after_session: string;
  diamond: Diamond;
  body: BodyLine | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const order = (s: WorkoutSession) => s.local_date + s.started_at;
const doneSessions = (d: ReportData) => d.sessions.filter((s) => s.status === "done").sort((a, b) => order(a).localeCompare(order(b)));
const inWindow = (ss: WorkoutSession[], from: string, to: string) => ss.filter((s) => s.local_date >= from && s.local_date <= to);
const signedPct = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(round1(n))} %`;

function bestE1rm(ss: WorkoutSession[], id: string, unit: Unit): number | null {
  let best: number | null = null;
  for (const s of ss) {
    const b = bestSet(s, id, unit);
    if (b && (best === null || b.e1rm > best)) best = b.e1rm;
  }
  return best;
}

/** The baseline window: the 28 days up to the goal's set date when two weeks of training precede it, else the first 14 days of data. */
export function baselineWindow(done: WorkoutSession[], goals: Goals | null, timezone: string): Diamond["baseline"] {
  if (!done.length) return null;
  const first = done[0].local_date;
  if (goals) {
    const set = localDate(timezone, goals.set_at);
    if (first <= addDays(set, -BASELINE_DAYS)) return { from: addDays(set, -(WINDOW - 1)), to: set, kind: "goal" };
  }
  return { from: first, to: addDays(first, BASELINE_DAYS - 1), kind: "first_data" };
}

function strengthAt(d: ProfileData, done: WorkoutSession[], base: Diamond["baseline"], asOf: string): { value: number; pct: number | null; lifts: StrengthLift[] } {
  const unit = d.settings.unit;
  const names = new Map(d.exercises.map((e) => [e.id, e.name_en]));
  const window = inWindow(done, addDays(asOf, -(WINDOW - 1)), asOf);
  const baseSessions = base ? inWindow(done, base.from, base.to) : [];
  const lifts = mainLifts(d).map((id): StrengthLift => {
    const baseline = bestE1rm(baseSessions, id, unit);
    const now = bestE1rm(window, id, unit);
    const e1rm = now ?? baseline;
    return { exercise_id: id, name: names.get(id) ?? id, e1rm, baseline, change_pct: baseline && e1rm ? round1((e1rm / baseline - 1) * 100) : null, kept: now === null && baseline !== null };
  });
  const scored = lifts.filter((l) => l.baseline !== null && l.e1rm !== null);
  if (!scored.length || asOf < (base?.to ?? asOf)) return { value: 0, pct: scored.length ? 0 : null, lifts };
  const s0 = scored.reduce((a, l) => a + l.baseline!, 0);
  const s = scored.reduce((a, l) => a + l.e1rm!, 0);
  const pct = s / s0 - 1;
  return { value: clamp01(pct / STRENGTH_FULL), pct: round1(pct * 100), lifts };
}

/** Regions with a done set this week of an exercise whose main-focus tags cover them. */
export function regionsDone(sessions: WorkoutSession[], ex: ReadonlyMap<string, Exercise>): Set<Region> {
  const out = new Set<Region>();
  for (const s of sessions)
    for (const x of s.sets) {
      if (!x.done) continue;
      const e = ex.get(x.exercise_id);
      if (e) for (const r of coverRegions(e.regions ?? [])) out.add(r);
    }
  return out;
}

function growthAt(d: ProfileData, done: WorkoutSession[], ex: ReadonlyMap<string, Exercise>, asOf: string) {
  const week = weekRange(asOf, d.settings.week_start);
  const regions = regionsDone(inWindow(done, week.start, asOf), ex);
  const share = regions.size / REGIONS.length;
  const live = d.measurements.filter((m) => !m.deleted_at && m.local_date <= asOf);
  const sizes = GROWTH_SIZES.flatMap((f) => {
    const c = sizeChange(live, f, addDays(asOf, -(SIZE_WEEKS * 7 - 1)), asOf);
    return c === null ? [] : [{ field: f, name: SIZE_NAME[f], change: c }];
  });
  const usesSizes = live.length >= 2 && sizes.length > 0;
  const sizeScore = usesSizes ? clamp01(sizes.reduce((a, s) => a + s.change, 0) / sizes.length / SIZE_FULL_CM) : 0;
  const value = usesSizes ? share / 2 + sizeScore / 2 : share;
  return { value, regions, sizes, usesSizes };
}

function enduranceAt(d: ProfileData, done: WorkoutSession[], asOf: string): { value: number | null; rows: EnduranceRow[] } {
  const unit = d.settings.unit;
  const main = new Set(mainLifts(d));
  const names = new Map(d.exercises.map((e) => [e.id, e.name_en]));
  const upTo = done.filter((s) => s.local_date <= asOf);
  const window = inWindow(upTo, addDays(asOf, -(WINDOW - 1)), asOf);
  const w = (s: WorkoutSession, x: { weight: number | null }) => round1(x.weight != null && x.weight > 0 ? convertWeight(x.weight, s.unit, unit) : 0);
  const ids = [...new Set(window.flatMap((s) => s.sets.filter((x) => x.done && (x.reps ?? 0) >= ENDURANCE_MIN_REPS && !main.has(x.exercise_id)).map((x) => x.exercise_id)))];
  const rows: EnduranceRow[] = [];
  for (const id of ids) {
    const latest = [...window].reverse().find((s) => s.sets.some((x) => x.done && x.exercise_id === id && (x.reps ?? 0) >= ENDURANCE_MIN_REPS))!;
    const weight = Math.max(...latest.sets.filter((x) => x.done && x.exercise_id === id && (x.reps ?? 0) >= ENDURANCE_MIN_REPS).map((x) => w(latest, x)));
    const at = (s: WorkoutSession) => s.sets.filter((x) => x.done && x.exercise_id === id && x.reps != null && x.reps > 0 && w(s, x) === weight).map((x) => x.reps!);
    const first = upTo.find((s) => at(s).length);
    if (!first || first.id === latest.id) continue;
    const firstReps = Math.max(...at(first));
    const bestReps = Math.max(...window.filter((s) => s.id !== first.id).flatMap(at));
    if (!Number.isFinite(bestReps)) continue;
    rows.push({ exercise_id: id, name: names.get(id) ?? id, weight, first_reps: firstReps, best_reps: bestReps, first_date: first.local_date, gain_pct: round1((bestReps / firstReps - 1) * 100) });
  }
  const m = median(rows.map((r) => r.gain_pct / 100));
  return { value: m === null ? null : clamp01(m / ENDURANCE_FULL), rows: rows.sort((a, b) => b.gain_pct - a.gain_pct) };
}

export function diamond(d: ProfileData, today: string): Diamond {
  const done = doneSessions(d);
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  const base = baselineWindow(done, d.goals, d.settings.timezone);
  const ago = addDays(today, -WINDOW);
  const s = strengthAt(d, done, base, today);
  const g = growthAt(d, done, ex, today);
  const e = enduranceAt(d, done, today);
  const sGhost = strengthAt(d, done, base, ago);
  const gGhost = growthAt(d, done, ex, ago);
  const eGhost = enduranceAt(d, done, ago);
  const missing = REGIONS.filter((r) => !g.regions.has(r)).map((r) => REGION_INFO[r].label);
  return {
    corners: {
      strength: { value: s.value, label: s.pct === null ? "0 %" : signedPct(s.pct), has_data: s.pct !== null },
      growth: { value: g.value, label: `${Math.round(g.value * 100)} %`, has_data: done.length > 0 },
      endurance: { value: e.value ?? 0, label: e.value === null ? "0 %" : signedPct(median(e.rows.map((r) => r.gain_pct))!), has_data: e.value !== null },
      power: { value: 0, label: "0", has_data: false },
    },
    ghost: { strength: sGhost.value, growth: gGhost.value, endurance: eGhost.value ?? 0, power: 0 },
    baseline: base,
    strength: s.lifts,
    growth: { regions_done: g.regions.size, regions_total: REGIONS.length, missing, sizes: g.sizes, uses_sizes: g.usesSizes },
    endurance: e.rows,
  };
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The line at the top of Profile, from the last done session (no AI). */
export function afterSessionLine(d: ProfileData, today: string): string {
  const done = doneSessions(d);
  const last = done.at(-1);
  if (!last) return "Your first session lights up the body.";
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  const unit = d.settings.unit;
  const groups: string[] = [];
  for (const x of last.sets) {
    if (!x.done) continue;
    const g = groupOf(ex.get(x.exercise_id)?.muscle_primary);
    const name = g ? GROUP_NAME[g] : null;
    if (name && !groups.includes(name)) groups.push(name);
  }
  const before = done.filter((s) => s.id !== last.id && order(s) < order(last));
  const records = [...new Set(last.sets.filter((x) => x.done).map((x) => x.exercise_id))].flatMap((id) => {
    const b = bestSet(last, id, unit);
    const prev = bestE1rm(before, id, unit);
    return b && prev !== null && b.e1rm > prev ? [`${ex.get(id)?.name_en ?? id} ${Math.round(b.e1rm)} ${unit}`] : [];
  });
  const week = weekRange(today, d.settings.week_start);
  const regions = regionsDone(inWindow(done, week.start, today), ex).size;
  const when = last.local_date === today ? "After today" : `After ${WEEKDAY[weekday(last.local_date)]}'s session`;
  const lit = groups.length ? `${list(groups.map((g, i) => (i ? g.toLowerCase() : g)))} lit up.` : "No sets were done.";
  const rec = records.length ? ` New best estimated 1RM: ${list(records)}.` : "";
  return `${when}: ${lit}${rec} ${regions} of ${REGIONS.length} regions trained this week.`;
}

export function profile(d: ProfileData, today: string): Profile {
  return {
    today,
    goals: d.goals,
    goal_label: d.goals ? `${trainingLabel(d.goals.training)} · ${BODY_GOAL_NAME[d.goals.body]}` : null,
    after_session: afterSessionLine(d, today),
    diamond: diamond(d, today),
    body: bodyLine(d, today),
  };
}

export { bodyLine, epley, SIZE_FIELDS, type BodyLine };

// The training calendar on the device (SPEC-v10 M13): the Home week strip, the Calendar's week grid and list, and the
// month strip, all from local data (works offline). Free slots come from the shared finder (worker/lib/calendar.ts),
// the same function the Worker and the coach use. Pure, unit-tested.

import {
  findFreeSlots,
  hm,
  planStates,
  sessionBlock,
  weekDates,
  type CalendarSettings,
  type FinderResult,
  type FreeSlot,
  type GymPlan,
  type PlanStatus,
  type SessionBlock,
  type UpcomingDay,
  type WorkShift,
} from "../../../worker/lib/calendar";
import { weekRange } from "../../../worker/lib/cycle";
import { addDays, daysBetween } from "../../../worker/lib/time";
import type { ProgramDay, WeekStart, WorkoutSession } from "../../../worker/lib/types";

/** The first date of the week holding `date`, by the week start in Settings. */
export const weekStartOf = (date: string, weekStart: WeekStart) => weekRange(date, weekStart).start;

/** The program days from the next one on, in program order (Day 3, Day 4, Day 1, …): what the next plans train. */
export function upcomingDays(days: readonly Pick<ProgramDay, "id" | "name_en" | "position" | "est_minutes">[], nextId: string): UpcomingDay[] {
  const order = [...days].sort((a, b) => a.position - b.position);
  const i = Math.max(0, order.findIndex((d) => d.id === nextId));
  return [...order.slice(i), ...order.slice(0, i)].map((d) => ({ id: d.id, name: d.name_en, minutes: d.est_minutes }));
}

export interface CalendarSource {
  shifts: readonly WorkShift[];
  plans: readonly GymPlan[];
  sessions: readonly WorkoutSession[];
  settings: CalendarSettings;
  tz: string;
  today: string;
  /** Now, as an ISO instant (an open session runs until now). */
  now: string;
}

/** A plan as the calendar shows it: its state with the sessions on this device. */
export interface ShownPlan extends GymPlan {
  state: Exclude<PlanStatus, "cancelled">;
}

export interface CalendarDay {
  date: string;
  today: boolean;
  shifts: WorkShift[];
  /** Planned and missed plans; a done plan shows as its session. */
  plans: ShownPlan[];
  sessions: SessionBlock[];
  free: FreeSlot[];
}

/** Session blocks for the logged sessions on this device (done and open). */
export const sessionBlocks = (src: Pick<CalendarSource, "sessions" | "tz" | "now">): SessionBlock[] => src.sessions.map((s) => sessionBlock(s, src.tz, src.now));

/** Every plan's state, cancelled ones left out. */
export function shownPlans(src: CalendarSource, blocks: readonly SessionBlock[] = sessionBlocks(src)): ShownPlan[] {
  const states = planStates(src.plans, blocks, src.today);
  const out: ShownPlan[] = [];
  for (const p of src.plans) {
    const state = states.get(p.id) ?? p.status;
    if (state !== "cancelled") out.push({ ...p, state });
  }
  return out;
}

const byStart = <T extends { start_min: number }>(a: T, b: T) => a.start_min - b.start_min;

export interface FinderOptions {
  upcoming: UpcomingDay[];
  days_per_week: number;
  /** Local minutes now. */
  now_min: number;
}

/**
 * One week of the calendar: per day its shifts, open plans (planned or missed), logged sessions and, when `finder`
 * is given, the free slots of the shared finder.
 */
export function calendarWeek(src: CalendarSource, start: string, finder: FinderOptions | null): { days: CalendarDay[]; finder: FinderResult | null } {
  const week = weekDates(start);
  const blocks = sessionBlocks(src);
  const plans = shownPlans(src, blocks);
  let result: FinderResult | null = null;
  if (finder) {
    // The days around the week count for the two-days-in-a-row rule.
    const near = (d: string) => d >= addDays(start, -2) && d <= addDays(start, 8);
    result = findFreeSlots({
      week,
      today: src.today,
      now_min: finder.now_min,
      shifts: src.shifts.filter((x) => near(x.date)),
      plans: plans.filter((p) => near(p.date)).map((p) => ({ ...p, status: p.state })),
      sessions: blocks.filter((b) => near(b.date)),
      settings: src.settings,
      upcoming: finder.upcoming,
      days_per_week: finder.days_per_week,
    });
  }
  const days = week.map((date) => ({
    date,
    today: date === src.today,
    shifts: src.shifts.filter((x) => x.date === date).sort(byStart),
    plans: plans.filter((p) => p.date === date && p.state !== "done").sort(byStart),
    sessions: blocks.filter((b) => b.date === date).sort(byStart),
    // On the grid every free time has the next session's length (a pre-selected slot's own day may be longer).
    free: result ? result.slots.filter((x) => x.date === date).map((x) => ({ ...x, end_min: x.start_min + result!.length_min })) : [],
  }));
  return { days, finder: result };
}

/** What a day chip marks: a session done that day, else a planned or missed plan. */
export type DayMark = "done" | "planned" | "missed" | null;

export interface DayChip {
  date: string;
  today: boolean;
  shift: boolean;
  mark: DayMark;
}

/** The day chips of a date range (the Home week strip, the month strip): a bar for a shift, a dot for training. */
export function dayChips(src: CalendarSource, dates: readonly string[]): DayChip[] {
  const blocks = sessionBlocks(src);
  const plans = shownPlans(src, blocks);
  const done = new Set([...blocks.filter((b) => b.status === "done").map((b) => b.date), ...plans.filter((p) => p.state === "done").map((p) => p.date)]);
  const shifts = new Set(src.shifts.map((x) => x.date));
  return dates.map((date) => {
    const open = plans.filter((p) => p.date === date && p.state !== "done");
    const mark: DayMark = done.has(date) ? "done" : open.some((p) => p.state === "planned") ? "planned" : open.length ? "missed" : null;
    return { date, today: date === src.today, shift: shifts.has(date), mark };
  });
}

/** The next planned gym session from now on (today's counts until it ends), if any. */
export function nextPlan(src: CalendarSource, nowMin: number): ShownPlan | null {
  const open = shownPlans(src).filter((p) => p.state === "planned" && (p.date > src.today || (p.date === src.today && p.end_min > nowMin)));
  return open.sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min)[0] ?? null;
}

/** Today's planned gym session that has not ended yet (the Home hero card shows its time). */
export function todayPlan(src: CalendarSource, nowMin: number): ShownPlan | null {
  const p = nextPlan(src, nowMin);
  return p && p.date === src.today ? p : null;
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
const weekdayShort = fmt({ weekday: "short" });
const weekdayLong = fmt({ weekday: "long" });
const monthDay = fmt({ month: "short", day: "numeric" });
const atNoon = (date: string) => new Date(`${date}T12:00:00Z`);

/** "Thu" */
export const weekdayName = (date: string) => weekdayShort.format(atNoon(date));
/** "Thursday" (accessible labels). */
export const weekdayFull = (date: string) => weekdayLong.format(atNoon(date));
/** "22" */
export const dayNumber = (date: string) => String(Number(date.slice(8)));

/** "Today", the weekday within the next six days ("Thu"), else "Mon, Oct 26". */
export function whenLabel(date: string, today: string): string {
  const ahead = daysBetween(today, date);
  if (ahead === 0) return "Today";
  if (ahead > 0 && ahead < 7) return weekdayName(date);
  return `${weekdayName(date)}, ${monthDay.format(atNoon(date))}`;
}

/** "Oct 19 – 25", or "Sep 28 – Oct 4" across a month; the year when it is not this year's. */
export function weekLabel(start: string, today: string): string {
  const end = addDays(start, 6);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const label = `${monthDay.format(atNoon(start))} – ${sameMonth ? dayNumber(end) : monthDay.format(atNoon(end))}`;
  return end.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${end.slice(0, 4)}`;
}

/** "17:30–18:30" */
export const timeRange = (r: { start_min: number; end_min: number }) => `${hm(r.start_min)}–${hm(r.end_min)}`;

/** The Home strip's line under the chips: the next planned session, or none planned this week. */
export function nextLine(plan: ShownPlan | null, dayName: (id: string) => string, today: string): string {
  if (!plan) return "No gym time planned this week";
  return `Next: ${whenLabel(plan.date, today)} ${hm(plan.start_min)} · ${dayName(plan.program_day_id)}`;
}

/** Accessible names of the calendar blocks (SPEC-v10 §7), e.g. "Work, Tuesday 07:00–15:30". */
export const blockLabel = {
  shift: (x: WorkShift) => `Work, ${weekdayFull(x.date)} ${timeRange(x)}${x.note ? `, ${x.note}` : ""}`,
  plan: (p: ShownPlan, name: string) => `${p.state === "missed" ? "Missed" : "Planned"}: ${name}, ${weekdayFull(p.date)} ${timeRange(p)}`,
  session: (b: SessionBlock, name: string) => `${b.status === "active" ? "In progress" : "Done"}: ${name}, ${weekdayFull(b.date)} ${timeRange(b)}`,
  free: (x: FreeSlot) => `Free time, ${weekdayFull(x.date)} ${timeRange(x)}`,
};

/** The week grid's axis (04:00–24:00) as hour labels, and a block's place on it in pixels at `hourPx` an hour. */
export function gridPlace(r: { start_min: number; end_min: number }, axisStart: number, axisEnd: number, hourPx: number): { top: number; height: number } {
  const start = Math.max(axisStart, Math.min(axisEnd, r.start_min));
  const end = Math.max(start, Math.min(axisEnd, r.end_min));
  return { top: ((start - axisStart) / 60) * hourPx, height: ((end - start) / 60) * hourPx };
}

/** The dates of the month holding `date`. */
export function monthDates(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const out: string[] = [];
  for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The program days the next plans train, in program order: after the last open plan's day when gym sessions are
 * planned from today on (the plans keep the order), else from the next day on Home.
 */
export function upcomingFor(
  days: readonly Pick<ProgramDay, "id" | "name_en" | "position" | "est_minutes">[],
  nextId: string,
  plans: readonly Pick<GymPlan, "date" | "start_min" | "program_day_id" | "status" | "session_id">[],
  today: string
): UpcomingDay[] {
  const open = plans
    .filter((p) => p.status === "planned" && !p.session_id && p.date >= today && days.some((d) => d.id === p.program_day_id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
  const last = open[open.length - 1];
  if (!last) return upcomingDays(days, nextId);
  const after = upcomingDays(days, last.program_day_id);
  return [...after.slice(1), after[0]];
}

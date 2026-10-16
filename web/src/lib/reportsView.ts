// Reports screen logic (SPEC-v8 §6.03, Payam 2026-10-14): what the Week / Month / All switch covers, the consistency
// calendar (trained days and each week's done / target; the program has no fixed weekdays, so no "missed" days are
// drawn), and the tiles' changes. Pure, unit-tested.

import { addDays } from "../../../worker/lib/time";

export type Period = "week" | "month" | "all";

/** The estimated-1RM chart's first date: 8 weeks to the selected week's end, 6 months to the month's end, or all. */
export function chartFrom(period: Period, end: string, firstSession: string | null): string {
  if (period === "week") return addDays(end, -55);
  if (period === "month") {
    const [y, m] = end.split("-").map(Number);
    const i = y * 12 + (m - 1) - 5;
    return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;
  }
  return firstSession ?? end;
}

/**
 * The chart's window in words, after the unit, saying what the chart shows (Payam, 2026-10-16): "8 weeks" or "6 months"
 * when the sessions reach back to the window's start (`from`), otherwise (and always for All) "since" the first date
 * drawn, e.g. "since Sep 7". `first` is the first done session; `since` is the first drawn date, already formatted.
 */
export function chartWindow(period: Period, from: string, first: string | null, since: string): string {
  if (period !== "all" && (first === null || first <= from)) return period === "week" ? "8 weeks" : "6 months";
  return `since ${since}`;
}

export interface CalendarWeek {
  start: string;
  days: { date: string; trained: boolean; future: boolean }[];
  /** Done sessions in the week (two on one day count twice). */
  done: number;
}

/**
 * Consistency rows from week starts (each 7 days): which days had a done session, and how many sessions the week had.
 * Days after `today` are marked future.
 */
export function calendarWeeks(doneDates: readonly string[], starts: readonly string[], today: string): CalendarWeek[] {
  const perDay = new Map<string, number>();
  for (const d of doneDates) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  return starts.map((start) => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      return { date, trained: perDay.has(date), future: date > today };
    });
    return { start, days, done: days.reduce((n, d) => n + (perDay.get(d.date) ?? 0), 0) };
  });
}

/** Week starts shown for a period: the 5 weeks ending with the selected week; the weeks touching the month; every week since the first session. */
export function calendarStarts(period: Period, weekStart: string, range: { start: string; end: string }, firstWeekStart: string | null): string[] {
  const out: string[] = [];
  if (period === "week") {
    for (let i = 4; i >= 0; i--) out.push(addDays(weekStart, -7 * i));
    return out;
  }
  // Month: weekStart is the week holding the month's first day; All: the week of the first session.
  let w = period === "month" ? weekStart : (firstWeekStart ?? weekStart);
  const last = range.end;
  while (w <= last) {
    out.push(w);
    w = addDays(w, 7);
  }
  return out;
}

/** Percent change from the first to the last value, one decimal; null when either is missing or the first is 0. */
export function changePct(first: number | null | undefined, last: number | null | undefined): number | null {
  if (first == null || last == null || first === 0) return null;
  return Math.round(((last - first) / first) * 1000) / 10;
}

/** The bars' scale: 0–20 sets (the design), wider when a value or target is above 20. */
export function barScale(values: readonly number[]): number {
  return Math.max(20, ...values);
}

/**
 * The after-session report's one line for the groups not trained that day (Payam, 2026-10-16): how many are under
 * their weekly target, not trained yet this week, over it and on it, naming all but the ones on target. Groups without
 * a target are left out; null when nothing is left to say.
 */
export function restOfWeek(rows: readonly { group: string; today: number; target: number | null; status: string }[]): string | null {
  const rest = rows.filter((r) => r.today === 0 && r.target != null);
  const named = (status: string) => rest.filter((r) => r.status === status).map((r) => r.group);
  const parts = [
    { names: named("under"), text: "under target" },
    { names: named("none"), text: "not trained yet" },
    { names: named("over"), text: "over target" },
  ]
    .filter((x) => x.names.length)
    .map((x) => ({ n: x.names.length, text: `${x.text} (${x.names.join(", ")})` }));
  const on = named("on").length;
  if (on) parts.push({ n: on, text: "on target" });
  if (!parts.length) return null;
  const text = parts.map((x, i) => (i === 0 ? `${x.n} ${x.n === 1 ? "group" : "groups"} ${x.text}` : `${x.n} ${x.text}`));
  return `Rest of the week: ${text.join(", ")}.`;
}

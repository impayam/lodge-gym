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

/** The chart's window in words, after the unit: "8 weeks", "6 months", "since Sep 27". */
export function chartWindow(period: Period, since: string): string {
  return period === "week" ? "8 weeks" : period === "month" ? "6 months" : `since ${since}`;
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

/** "+5.6%", "−2%", "0%", or "–" without a value. */
export function signedPct(n: number | null): string {
  if (n == null) return "–";
  const abs = Math.abs(n);
  const text = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${text}%`;
}

/** The bars' scale: 0–20 sets (the design), wider when a value or target is above 20. */
export function barScale(values: readonly number[]): number {
  return Math.max(20, ...values);
}

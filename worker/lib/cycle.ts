// Program cycle (SPEC §6/§7): next day in D1 → D2 → D3 → D4 → D1, rest advice, and week boundaries.

import { addDays, weekday } from "./time";
import type { WeekStart } from "./types";

export interface CycleSession {
  program_day_id: string;
  local_date: string;
  started_at: string;
  status: "active" | "done";
}

/** Latest done session first. */
export function sortDoneDesc<T extends CycleSession>(sessions: T[]): T[] {
  return sessions
    .filter((s) => s.status === "done")
    .sort((a, b) => (b.local_date + b.started_at).localeCompare(a.local_date + a.started_at));
}

export interface NextDay {
  dayId: string;
  /** Last done session in the cycle, if any. */
  last: CycleSession | null;
  /** True when the last done session was not part of the active program. */
  programChanged: boolean;
}

export function nextDay(order: string[], sessions: CycleSession[]): NextDay {
  const last = sortDoneDesc(sessions)[0] ?? null;
  if (!last) return { dayId: order[0], last: null, programChanged: false };
  const i = order.indexOf(last.program_day_id);
  if (i < 0) return { dayId: order[0], last, programChanged: true };
  return { dayId: order[(i + 1) % order.length], last, programChanged: false };
}

/** Rule: no more than two training days in a row. True when yesterday and the day before were both training days. */
export function restAdvised(today: string, sessions: CycleSession[]): boolean {
  const dates = new Set(sessions.filter((s) => s.status === "done").map((s) => s.local_date));
  return dates.has(addDays(today, -1)) && dates.has(addDays(today, -2));
}

const START_DOW: Record<WeekStart, number> = { sun: 0, mon: 1, sat: 6 };

/** Inclusive [start, end] local dates of the week containing `date`. */
export function weekRange(date: string, weekStart: WeekStart): { start: string; end: string } {
  const back = (weekday(date) - START_DOW[weekStart] + 7) % 7;
  const start = addDays(date, -back);
  return { start, end: addDays(start, 6) };
}

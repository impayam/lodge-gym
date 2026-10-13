// Program cycle (SPEC §6/§7): next day in D1 → D2 → D3 → D4 → D1, rest advice, and week boundaries.

import { addDays, weekday } from "./time";
import type { ProgramInfo, WeekStart } from "./types";

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

/**
 * @param alias day ids of earlier versions of the active program → its day at the same position, so the cycle goes on
 *   after "Apply to program" (SPEC-v3 M9c) instead of starting again at Day 1.
 */
export function nextDay(order: string[], sessions: CycleSession[], alias: ReadonlyMap<string, string> = new Map()): NextDay {
  const last = sortDoneDesc(sessions)[0] ?? null;
  if (!last) return { dayId: order[0], last: null, programChanged: false };
  const i = order.indexOf(alias.get(last.program_day_id) ?? last.program_day_id);
  if (i < 0) return { dayId: order[0], last, programChanged: true };
  return { dayId: order[(i + 1) % order.length], last, programChanged: false };
}

/**
 * Day aliases for nextDay: when the active program is a version made by "Apply to program" (generated_by "session"),
 * the days of the versions it came from (each one the program active just before, back to the first that was not
 * made from a session) map to the active day at the same position. A switch to a different program has no aliases.
 */
export function versionAliases(programs: ProgramInfo[], days: { id: string; program_id: string; position: number }[], activeDays: { id: string; position: number }[]): Map<string, string> {
  const out = new Map<string, string>();
  const byPos = new Map(activeDays.map((d) => [d.position, d.id]));
  let cur = programs.find((p) => p.status === "active");
  const seen = new Set<string>();
  while (cur && cur.generated_by === "session" && !seen.has(cur.id)) {
    seen.add(cur.id);
    const start = cur.activations[0]?.started_at;
    const prev = programs.find((p) => p.id !== cur!.id && p.activations.some((a) => a.ended_at === start));
    if (!prev) break;
    for (const d of days) if (d.program_id === prev.id && byPos.has(d.position)) out.set(d.id, byPos.get(d.position)!);
    cur = prev;
  }
  return out;
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

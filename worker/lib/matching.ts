// Watch workout ↔ workout session matching (SPEC §9.1): a session whose [started_at, ended_at] overlaps the
// watch workout, or whose start is within ±90 minutes on the same local date.

import { localDate } from "./time";

export interface MatchSession {
  id: string;
  local_date: string;
  started_at: string;
  ended_at: string | null;
}

export interface MatchWorkout {
  started_at: string;
  ended_at: string | null;
}

const WINDOW = 90 * 60_000;
/** An active session without an end time is treated as running until now, at most 4 hours. */
const OPEN_SESSION_MAX = 4 * 3600_000;

export function matchSession(w: MatchWorkout, sessions: MatchSession[], tz: string, now: number = Date.now()): string | null {
  const ws = Date.parse(w.started_at);
  const we = w.ended_at ? Date.parse(w.ended_at) : ws;
  const wDate = localDate(tz, w.started_at);
  let best: { id: string; overlap: number; gap: number } | null = null;
  for (const s of sessions) {
    const ss = Date.parse(s.started_at);
    const se = s.ended_at ? Date.parse(s.ended_at) : Math.max(ss, Math.min(now, ss + OPEN_SESSION_MAX));
    const overlap = Math.min(we, se) - Math.max(ws, ss);
    const gap = Math.abs(ss - ws);
    const ok = overlap > 0 || (s.local_date === wDate && gap <= WINDOW);
    if (!ok) continue;
    const cand = { id: s.id, overlap: Math.max(0, overlap), gap };
    if (!best || cand.overlap > best.overlap || (cand.overlap === best.overlap && cand.gap < best.gap)) best = cand;
  }
  return best?.id ?? null;
}

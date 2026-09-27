// Watch stats for a workout session from Health samples (Heart Rate, Active Energy): the samples whose
// start lies inside [started_at, ended_at] (until now for an active session). Duration comes from the session.

import type { TimedValue } from "./shortcuts";

export interface SessionWindow {
  started_at: string;
  ended_at: string | null;
}

export interface WatchStats {
  hr_avg: number | null;
  hr_max: number | null;
  hr_count: number;
  active_kcal: number | null;
  energy_count: number;
  duration_sec: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function sessionEnd(s: SessionWindow, now: number): number {
  return s.ended_at ? Date.parse(s.ended_at) : Math.max(Date.parse(s.started_at), now);
}

export function sessionWatchStats(s: SessionWindow, hr: TimedValue[], energy: TimedValue[], now: number = Date.now()): WatchStats {
  const a = Date.parse(s.started_at);
  const b = sessionEnd(s, now);
  const inside = (x: TimedValue) => x.t >= a && x.t <= b;
  const h = hr.filter(inside).map((x) => x.v);
  const e = energy.filter(inside).map((x) => x.v);
  return {
    hr_avg: h.length ? round1(h.reduce((x, y) => x + y, 0) / h.length) : null,
    hr_max: h.length ? Math.max(...h) : null,
    hr_count: h.length,
    active_kcal: e.length ? round1(e.reduce((x, y) => x + y, 0)) : null,
    energy_count: e.length,
    duration_sec: s.ended_at ? Math.round((Date.parse(s.ended_at) - a) / 1000) : null,
  };
}

// The body goal line (SPEC-v12 M15 §3.1, §5; pace approved by Payam 2026-10-17). Pure: the latest 7-day average body
// weight, its change since the goal was set (at most 8 weeks back) and the four-week pace against the body goal. Used
// by Profile, the Coach (get_body) and the AI reports' goal line.

import { BODY_GOAL_BADGE, BODY_GOAL_NAME, TRAINING_GOAL_NAME, paceSentence, paceStatus, type Goals, type PaceStatus } from "./goals";
import { bodyDaily, type ReportData } from "./reports";
import { addDays, localDate } from "./time";
import type { Unit } from "./types";

const round1 = (n: number) => Math.round(n * 10) / 10;
const WINDOW = 28;
const SINCE_WEEKS = 8;

export interface BodyLine {
  badge: string;
  goal: string;
  unit: Unit;
  /** The latest 7-day average body weight, in his unit. */
  avg7: number | null;
  /** Change of the 7-day average since the goal was set (at most 8 weeks back), in his unit. */
  change: number | null;
  since: string | null;
  /** Weekly change as % of body weight (four-week trend). */
  rate_pct: number | null;
  status: PaceStatus;
  sentence: string;
}

/** The 7-day average body weight ending on `date` (kg or his unit); null without an entry in those days. */
function avg7(daily: ReadonlyMap<string, number>, date: string): number | null {
  const vs = [...daily].filter(([k]) => k >= addDays(date, -6) && k <= date).map(([, v]) => v);
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
}

export function bodyLine(d: Pick<ReportData, "body" | "settings"> & { goals?: Goals | null }, today: string): BodyLine | null {
  if (!d.goals) return null;
  const body = d.goals.body;
  const unit = d.settings.unit;
  const kg = bodyDaily(d, "kg");
  const own = bodyDaily(d, unit);
  const nowKg = avg7(kg, today);
  const pastKg = avg7(kg, addDays(today, -WINDOW));
  const changeKg = nowKg !== null && pastKg !== null ? nowKg - pastKg : null;
  const rate = changeKg !== null && nowKg ? changeKg / 4 / nowKg : null;
  const status = paceStatus(body, rate, changeKg);
  const set = localDate(d.settings.timezone, d.goals.set_at);
  const since = set > addDays(today, -SINCE_WEEKS * 7) ? set : addDays(today, -SINCE_WEEKS * 7);
  const now = avg7(own, today);
  const then = avg7(own, since);
  return {
    badge: BODY_GOAL_BADGE[body],
    goal: BODY_GOAL_NAME[body],
    unit,
    avg7: now === null ? null : round1(now),
    change: now !== null && then !== null && since < today ? round1(now - then) : null,
    since,
    rate_pct: rate === null ? null : Math.round(rate * 1000) / 10,
    status,
    sentence: paceSentence(body, status),
  };
}


/** The goal line of the AI reports (weekly overview, after-session report): words only, no numbers. */
export interface GoalFacts {
  training: string;
  body: string;
  pace: PaceStatus;
}

export function goalFacts(d: Pick<ReportData, "body" | "settings"> & { goals?: Goals | null }, today: string): GoalFacts | null {
  if (!d.goals) return null;
  return { training: d.goals.training.map((g) => TRAINING_GOAL_NAME[g]).join(" + "), body: BODY_GOAL_NAME[d.goals.body], pace: bodyLine(d, today)!.status };
}

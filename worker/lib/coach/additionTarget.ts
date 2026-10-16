// Where the coach's exercises for a session go (Payam, 2026-10-16), pure and shared by the coach tool and the card:
// chosen by date, always confirmed by his tap, and Change offers the other choices.
//   1. a session open today → that session (the items become "Added today" extras);
//   2. else today: the day he named, else today's planned gym session's day → that day's plan in the planner, so they
//      are in the session when he taps Start at the gym (nothing is started by the coach);
//   3. else the nearest upcoming planned gym session (calendar) → that day's plan in the planner, the same way;
//   4. with nothing planned: Home's next program day, today (as 2).
// A session left open from an earlier day is never a target: the app closes it after its day ends.

import { hm } from "../calendar";
import { addDays } from "../time";

export interface TargetSession {
  id: string;
  local_date: string;
  started_at: string;
  status: "active" | "done";
  program_day_id: string;
}

export interface TargetPlan {
  id: string;
  date: string;
  start_min: number;
  program_day_id: string;
  status: string;
}

export type AdditionTarget =
  | { kind: "open_session"; date: string; day_id: string; session_id: string }
  | { kind: "today"; date: string; day_id: string; gym_plan_id: string | null; start_min: number | null }
  | { kind: "planned"; date: string; day_id: string; gym_plan_id: string; start_min: number };

/** Upcoming planned sessions offered under Change: the next ones within two weeks. */
export const UPCOMING_DAYS = 14;
export const UPCOMING_MAX = 6;

export interface TargetInput {
  today: string;
  sessions: TargetSession[];
  plans: TargetPlan[];
  /** The active program's days in order. */
  dayIds: string[];
  /** Home's next program day. */
  nextDayId: string;
  /** The day he said he trains today (a day of the active program), if any. */
  named?: string | null;
}

/** The default target and every choice Change offers (the default first among them). */
export function additionTargets(x: TargetInput): { target: AdditionTarget; choices: AdditionTarget[] } {
  const open =
    x.sessions
      .filter((s) => s.status === "active" && s.local_date === x.today)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
  const planned = x.plans.filter((p) => p.status === "planned").sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
  const todayPlans = planned.filter((p) => p.date === x.today);
  const upcoming = planned.filter((p) => p.date > x.today && p.date <= addDays(x.today, UPCOMING_DAYS)).slice(0, UPCOMING_MAX);
  const named = x.named && x.dayIds.includes(x.named) ? x.named : null;

  const today = (dayId: string): AdditionTarget => {
    const p = todayPlans.find((q) => q.program_day_id === dayId) ?? null;
    return { kind: "today", date: x.today, day_id: dayId, gym_plan_id: p?.id ?? null, start_min: p?.start_min ?? null };
  };
  const ahead = upcoming.map((p): AdditionTarget => ({ kind: "planned", date: p.date, day_id: p.program_day_id, gym_plan_id: p.id, start_min: p.start_min }));

  let target: AdditionTarget;
  if (open) target = { kind: "open_session", date: open.local_date, day_id: open.program_day_id, session_id: open.id };
  else if (named) target = today(named);
  else if (todayPlans.length && x.dayIds.includes(todayPlans[0].program_day_id)) target = today(todayPlans[0].program_day_id);
  else if (ahead.length) target = ahead[0];
  else target = today(x.dayIds.includes(x.nextDayId) ? x.nextDayId : x.dayIds[0]);

  // Today: the open session, or any program day started now; then the planned sessions ahead.
  const todays = open ? [target] : x.dayIds.map(today);
  const choices = [...todays, ...ahead];
  const key = targetKey(target);
  return { target, choices: [target, ...choices.filter((c) => targetKey(c) !== key)] };
}

/** One string per target, for choosing among them. */
export const targetKey = (t: AdditionTarget): string =>
  t.kind === "open_session" ? `open:${t.session_id}` : t.kind === "today" ? `today:${t.day_id}` : `planned:${t.gym_plan_id}`;

/** "today", "tomorrow" or "Sat, Oct 24" for a local date. */
function dayWord(date: string, today: string): string {
  if (date === today) return "today";
  if (date === addDays(today, 1)) return "tomorrow";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

/** The card's heading for a target: "today's session: Day 3 · Back", "today's Day 3 · Back", "tomorrow 08:00 · Day 4 · Deadlift". */
export function targetLabel(t: AdditionTarget, day: string, today: string): string {
  if (t.kind === "open_session") return `today's session: ${day}`;
  if (t.kind === "today") return `today's ${day}${t.start_min != null ? ` (${hm(t.start_min)})` : ""}`;
  return `${dayWord(t.date, today)} ${hm(t.start_min)} · ${day}`;
}

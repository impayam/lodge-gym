// Training calendar (SPEC-v10 M13): work shifts, planned gym sessions, plan ↔ session linking and the free-slot
// finder. Pure and shared: the Calendar screen (offline, on local data), the Worker and the coach's find_free_slots
// tool all call the same functions, so the model never computes a time itself.
//
// Times are local: a date (YYYY-MM-DD in the settings time zone) and minutes from midnight (0–1440), same day only.

import { addDays, daysBetween, localDate, localHM, weekday } from "./time";
import type { WorkoutSession } from "./types";

export interface WorkShift {
  id: string;
  date: string;
  start_min: number;
  end_min: number;
  note: string;
  created_at: string;
  updated_at: string;
}

export type PlanSource = "manual" | "finder" | "coach";
export type PlanStatus = "planned" | "done" | "missed" | "cancelled";

export interface GymPlan {
  id: string;
  date: string;
  start_min: number;
  end_min: number;
  program_day_id: string;
  source: PlanSource;
  session_id: string | null;
  status: PlanStatus;
  reminder_at: string | null;
  created_at: string;
  updated_at: string;
}

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export interface MinuteRange {
  start_min: number;
  end_min: number;
}

/** A preferred time window (e.g. weekday evenings); slots inside one are ranked first. */
export interface PreferredWindow extends MinuteRange {
  days: WeekdayKey[];
}

export interface CalendarSettings {
  /** Opening hours per weekday; null = closed that day. */
  gym_hours: Record<WeekdayKey, MinuteRange | null>;
  /** Travel to the gym and back, each way. */
  travel_buffer_min: number;
  /** Free time after a shift ends before he can leave for the gym. */
  after_shift_gap_min: number;
  preferred_windows: PreferredWindow[];
  /** Reminder push this many minutes before a planned session. */
  reminder_minutes: number;
}

/** Payam's gym and the approved defaults (SPEC-v10, 2026-10-15). All editable in Settings. */
export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  gym_hours: {
    mon: { start_min: 240, end_min: 1440 },
    tue: { start_min: 240, end_min: 1440 },
    wed: { start_min: 240, end_min: 1440 },
    thu: { start_min: 240, end_min: 1440 },
    fri: { start_min: 240, end_min: 1440 },
    sat: { start_min: 300, end_min: 1320 },
    sun: { start_min: 420, end_min: 960 },
  },
  travel_buffer_min: 20,
  after_shift_gap_min: 30,
  preferred_windows: [],
  reminder_minutes: 60,
};

/** The week view's time axis: the gym's widest hours. */
export const DAY_START_MIN = 240;
export const DAY_END_MIN = 1440;
/** Slot starts are rounded up to this many minutes. */
export const SLOT_STEP_MIN = 15;

export const weekdayKey = (date: string): WeekdayKey => WEEKDAY_KEYS[weekday(date)];

/** "HH:MM" for minutes from midnight; 1440 reads "24:00". */
export function hm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Minutes from midnight for "HH:MM" ("24:00" allowed). */
export function toMin(text: string): number {
  const [h, m] = text.split(":").map(Number);
  return h * 60 + m;
}

/** The seven dates of a week starting at `start`. */
export const weekDates = (start: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(start, i));

/** A logged session on the calendar: its local date and minutes (an open session runs until now; never past 24:00). */
export interface SessionBlock extends MinuteRange {
  id: string;
  date: string;
  program_day_id: string;
  status: WorkoutSession["status"];
}

export function sessionBlock(s: Pick<WorkoutSession, "id" | "local_date" | "started_at" | "ended_at" | "program_day_id" | "status">, tz: string, now: string): SessionBlock {
  const start = toMin(localHM(tz, s.started_at));
  const endAt = s.ended_at ?? now;
  const sameDay = localDate(tz, endAt) === s.local_date;
  const end = sameDay ? Math.max(start + 1, toMin(localHM(tz, endAt))) : DAY_END_MIN;
  return { id: s.id, date: s.local_date, program_day_id: s.program_day_id, status: s.status, start_min: start, end_min: Math.min(DAY_END_MIN, end) };
}

/**
 * The plan a session of that date belongs to: the open plan (not yet linked) whose start is closest to the session's
 * start (SPEC-v10 §4). The log wins: a different program day still marks the plan done.
 */
export function planForSession(plans: readonly GymPlan[], session: Pick<SessionBlock, "date" | "start_min">): GymPlan | null {
  const open = plans.filter((p) => p.date === session.date && p.session_id === null && (p.status === "planned" || p.status === "missed"));
  if (!open.length) return null;
  return open.reduce((best, p) => (Math.abs(p.start_min - session.start_min) < Math.abs(best.start_min - session.start_min) ? p : best));
}

/** What a plan shows: done when a session is linked, missed once its day has ended with no session, else its status. */
export function planState(plan: GymPlan, sessionDates: ReadonlySet<string>, today: string): PlanStatus {
  if (plan.session_id || plan.status === "done") return "done";
  if (plan.status === "cancelled") return "cancelled";
  if (plan.date < today && !sessionDates.has(plan.date)) return "missed";
  return plan.status === "missed" && sessionDates.has(plan.date) ? "done" : plan.status;
}

/**
 * Every plan's state with the sessions on this device: a session not linked yet (still in the outbox, or logged
 * before the plan was synced) links its date's closest open plan, as the server does when the session arrives.
 */
export function planStates(plans: readonly GymPlan[], sessions: readonly SessionBlock[], today: string): Map<string, PlanStatus> {
  const linked = new Set(plans.filter((p) => p.session_id).map((p) => p.session_id));
  const work = plans.map((p) => ({ ...p }));
  for (const s of [...sessions].sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min)) {
    if (linked.has(s.id)) continue;
    const p = planForSession(work, s);
    if (!p) continue;
    p.session_id = s.id;
    linked.add(s.id);
  }
  const dates = new Set(sessions.map((s) => s.date));
  return new Map(work.map((p) => [p.id, planState(p, dates, today)]));
}

export interface UpcomingDay {
  id: string;
  name: string;
  minutes: number;
}

export interface FreeSlot extends MinuteRange {
  date: string;
  /** Leave home / back home, with the travel buffer each way. */
  leave_min: number;
  back_min: number;
  preferred: boolean;
  /** Pre-selected by the ranking (up to the sessions still needed this week). */
  selected: boolean;
  /** The program day this slot gets when the selected slots are added in date order; null when not selected. */
  program_day_id: string | null;
}

export interface FinderInput {
  /** The seven dates of the week. */
  week: string[];
  today: string;
  /** Local minutes now (slots on today start no earlier than now plus the travel buffer). */
  now_min: number;
  shifts: readonly Pick<WorkShift, "date" | "start_min" | "end_min">[];
  plans: readonly Pick<GymPlan, "date" | "start_min" | "end_min" | "status">[];
  sessions: readonly Pick<SessionBlock, "date" | "start_min" | "end_min">[];
  settings: CalendarSettings;
  /** The next program days in order (the first is the next one to train). */
  upcoming: UpcomingDay[];
  days_per_week: number;
}

export interface FinderResult {
  slots: FreeSlot[];
  /** Sessions still needed this week: days per week minus sessions done or planned this week. */
  need: number;
  /** The session length used: the next program day's estimated minutes. */
  length_min: number;
}

const roundUp = (m: number) => Math.ceil(m / SLOT_STEP_MIN) * SLOT_STEP_MIN;
const active = (p: Pick<GymPlan, "status">) => p.status === "planned" || p.status === "done";

/**
 * Free slots for one week (SPEC-v10 §3). A slot is valid when the session (the next program day's estimated minutes)
 * plus the travel buffer before and after fits inside the gym's hours for that weekday (finished, travel included,
 * before closing), overlaps no shift (nor the gap after one), plan or logged session, keeps at most two training
 * days in a row, and is not in the past. Days that already have a plan or a session get no slot (one per day).
 * Ranking: preferred window first, then spread across the week, then earlier in the day; up to `need` are selected.
 */
export function findFreeSlots(input: FinderInput): FinderResult {
  const { week, today, settings: s } = input;
  const travel = s.travel_buffer_min;
  const length = input.upcoming[0]?.minutes ?? 60;
  const busyDates = new Set([...input.plans.filter(active).map((p) => p.date), ...input.sessions.map((x) => x.date)]);
  const weekSet = new Set(week);
  const doneOrPlanned = [...busyDates].filter((d) => weekSet.has(d)).length;
  const need = Math.max(0, input.days_per_week - doneOrPlanned);

  /** Busy minutes of a date: shifts with the gap after them, plans and sessions with travel around them. */
  const busy = (date: string): MinuteRange[] => [
    ...input.shifts.filter((x) => x.date === date).map((x) => ({ start_min: x.start_min, end_min: x.end_min + s.after_shift_gap_min })),
    ...input.plans.filter((p) => p.date === date && active(p)).map((p) => ({ start_min: p.start_min - travel, end_min: p.end_min + travel })),
    ...input.sessions.filter((x) => x.date === date).map((x) => ({ start_min: x.start_min - travel, end_min: x.end_min + travel })),
  ];

  /** Whether a session of `len` minutes starting at `start` fits on `date`. */
  const fits = (date: string, start: number, len: number): boolean => {
    const hours = s.gym_hours[weekdayKey(date)];
    if (!hours || start < hours.start_min || start + len + travel > hours.end_min) return false;
    if (date === today && start - travel < input.now_min) return false;
    return busy(date).every((b) => start + len + travel <= b.start_min || start - travel >= b.end_min);
  };

  /** Training on `date` would make three training days in a row with the days in `training`. */
  const threeInARow = (training: ReadonlySet<string>, date: string) => {
    const t = (n: number) => training.has(addDays(date, n));
    return (t(-2) && t(-1)) || (t(-1) && t(1)) || (t(1) && t(2));
  };

  const slots: FreeSlot[] = [];
  for (const date of week) {
    if (date < today || busyDates.has(date) || threeInARow(busyDates, date)) continue;
    const hours = s.gym_hours[weekdayKey(date)];
    if (!hours) continue;
    // Free gaps of the day between busy intervals; the earliest start in each gap, and the earliest start inside
    // each preferred window, are the candidates.
    const blocks = busy(date).sort((a, b) => a.start_min - b.start_min);
    const edges = [0, ...blocks.map((b) => b.end_min)];
    const starts = new Set<number>();
    for (const edge of edges) {
      let start = roundUp(Math.max(edge + travel, hours.start_min, date === today ? input.now_min + travel : 0));
      if (fits(date, start, length)) starts.add(start);
      for (const w of s.preferred_windows.filter((x) => x.days.includes(weekdayKey(date)))) {
        start = roundUp(Math.max(edge + travel, hours.start_min, w.start_min, date === today ? input.now_min + travel : 0));
        if (start + length <= w.end_min && fits(date, start, length)) starts.add(start);
      }
    }
    for (const start of [...starts].sort((a, b) => a - b)) {
      const preferred = s.preferred_windows.some((w) => w.days.includes(weekdayKey(date)) && start >= w.start_min && start + length <= w.end_min);
      slots.push({ date, start_min: start, end_min: start + length, leave_min: start - travel, back_min: start + length + travel, preferred, selected: false, program_day_id: null });
    }
  }

  // Pre-selection: one per day, at most two training days in a row (with the days already trained or planned,
  // including the days around the week), spread across the week, preferred and earlier first.
  const training = new Set(busyDates);
  const trainedNear = (date: string) => [...training].filter((d) => Math.abs(daysBetween(date, d)) <= 3);
  const picked: FreeSlot[] = [];
  while (picked.length < need) {
    const pool = slots.filter((x) => !training.has(x.date) && !threeInARow(training, x.date));
    if (!pool.length) break;
    const distance = (x: FreeSlot) => Math.min(7, ...trainedNear(x.date).map((d) => Math.abs(daysBetween(x.date, d))));
    const best = pool.reduce((a, b) => {
      if (a.preferred !== b.preferred) return a.preferred ? a : b;
      if (distance(a) !== distance(b)) return distance(a) > distance(b) ? a : b;
      if (a.start_min !== b.start_min) return a.start_min < b.start_min ? a : b;
      return a.date <= b.date ? a : b;
    });
    picked.push(best);
    training.add(best.date);
  }
  // The selected slots get the program days in date order; a longer day must still fit its slot.
  picked.sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
  let next = 0;
  for (const slot of picked) {
    const day = input.upcoming[next % Math.max(1, input.upcoming.length)];
    if (!day || !fits(slot.date, slot.start_min, day.minutes)) continue;
    slot.selected = true;
    slot.program_day_id = day.id;
    slot.end_min = slot.start_min + day.minutes;
    slot.back_min = slot.end_min + travel;
    next++;
  }
  return { slots, need, length_min: length };
}

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
  /** When he gets up: a suggestion never starts before this plus the travel. */
  wake_time_min: number;
  /** The earliest suggested start. */
  earliest_start_min: number;
  /** The session ends at least this long before a shift starts. */
  before_shift_gap_min: number;
  /** Rest after a shift before he leaves for the gym, and after a long shift. */
  after_shift_gap_min: number;
  long_shift_gap_min: number;
  /** A shift this long or longer is a long shift (more rest after it; the slot before it ranks first). */
  long_shift_min: number;
  preferred_windows: PreferredWindow[];
  /** Reminder push this many minutes before a planned session. */
  reminder_minutes: number;
}

/**
 * Payam's gym and the defaults he set (SPEC-v10, 2026-10-15): they work untouched; every one is editable in Settings.
 * Wake 07:00, earliest suggestion 08:00, the session ends 60 min before a shift, 30 min rest after a shift and 90 min
 * after a long one (8 h or more), 20 min travel each way, reminder 60 min before.
 */
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
  wake_time_min: 420,
  earliest_start_min: 480,
  before_shift_gap_min: 60,
  after_shift_gap_min: 30,
  long_shift_gap_min: 90,
  long_shift_min: 480,
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

/** The reminder push (SPEC-v10 §1): "Gym in 1 hour: Day 3 · Back, 17:30". */
export function reminderText(reminderMinutes: number, dayName: string, startMin: number): string {
  const h = Math.floor(reminderMinutes / 60);
  const m = reminderMinutes % 60;
  const span = h && m ? `${h} h ${m} min` : h ? `${h} hour${h > 1 ? "s" : ""}` : `${m} min`;
  return `Gym in ${span}: ${dayName}, ${hm(startMin)}`;
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

/** The program days from the next one on, in program order (Day 3, Day 4, Day 1, …): what the next plans train. */
export function upcomingDays(days: readonly { id: string; name_en: string; position: number; est_minutes: number }[], nextId: string): UpcomingDay[] {
  const order = [...days].sort((a, b) => a.position - b.position);
  const i = Math.max(0, order.findIndex((d) => d.id === nextId));
  return [...order.slice(i), ...order.slice(0, i)].map((d) => ({ id: d.id, name: d.name_en, minutes: d.est_minutes }));
}

/**
 * The program days the next plans train, in program order: after the last open plan's day when gym sessions are
 * planned from today on (the plans keep the order), else from the next day on Home.
 */
export function upcomingFor(
  days: readonly { id: string; name_en: string; position: number; est_minutes: number }[],
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

export interface FreeSlot extends MinuteRange {
  date: string;
  /** Leave home / back home, with the travel buffer each way. */
  leave_min: number;
  back_min: number;
  /** Inside a preferred window. */
  preferred: boolean;
  /** The start of that day's next shift when the slot comes before it, else null. */
  before_shift_at: number | null;
  /** The end of the shift the slot follows that day, else null. */
  after_shift_at: number | null;
  /** That day's shifts include a long one (8 h or more by default). */
  long_shift_day: boolean;
  /**
   * Training days in a row with this one (with the days done or planned, and the pre-selected ones). Three or more is
   * shown as a neutral note; it only lowers the rank, never hides the slot.
   */
  streak: number;
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
  /** One suggestion per day, best first. */
  slots: FreeSlot[];
  /** Sessions still needed this week: days per week minus days with a session done or planned this week. */
  need: number;
  /** The session length used: the next program day's estimated minutes. */
  length_min: number;
}

const roundUp = (m: number) => Math.ceil(m / SLOT_STEP_MIN) * SLOT_STEP_MIN;
const active = (p: Pick<GymPlan, "status">) => p.status === "planned" || p.status === "done";

/** Training days in a row through `date` with the days in `training` (the date itself counted). */
export function streakWith(training: ReadonlySet<string>, date: string): number {
  let n = 1;
  for (let d = addDays(date, -1); training.has(d); d = addDays(d, -1)) n++;
  for (let d = addDays(date, 1); training.has(d); d = addDays(d, 1)) n++;
  return n;
}

/** Rest after a shift: longer after a long shift. */
const restAfter = (s: CalendarSettings, shift: MinuteRange) => (shift.end_min - shift.start_min >= s.long_shift_min ? s.long_shift_gap_min : s.after_shift_gap_min);

/**
 * The gym suggestions for one week (SPEC-v10 §3 as changed by Payam on 2026-10-15): he enters his shifts, the app picks
 * the time. A start fits when the session (the program day's estimated minutes) plus the travel each way lies inside the
 * gym's hours, starts no earlier than the earliest start (and wake-up plus travel), ends at least the set time before a
 * shift, leaves after the rest that follows a shift (longer after a long shift), and is not in the past. Nothing else
 * is a filter: training days in a row only lower the rank.
 *
 * Per day the best fitting start wins: on a long-shift day the slot before the shift, else a preferred window, else the
 * earliest. Days that already have a session done or planned get none (one a day). Across the week the days are ranked
 * greedily: preferred first, then not a third training day in a row, then the farthest from training days within three
 * days, then the earlier start and date; the first `need` are pre-selected and get the next program days in date order.
 */
export function findFreeSlots(input: FinderInput): FinderResult {
  const { week, today, settings: s } = input;
  const travel = s.travel_buffer_min;
  const length = input.upcoming[0]?.minutes ?? 60;
  const busyDates = new Set([...input.plans.filter(active).map((p) => p.date), ...input.sessions.map((x) => x.date)]);
  const weekSet = new Set(week);
  const doneOrPlanned = [...busyDates].filter((d) => weekSet.has(d)).length;
  const need = Math.max(0, input.days_per_week - doneOrPlanned);
  const earliest = Math.max(s.earliest_start_min, s.wake_time_min + travel);
  const beforeGap = Math.max(s.before_shift_gap_min, travel);

  const shiftsOn = (date: string) => input.shifts.filter((x) => x.date === date).sort((a, b) => a.start_min - b.start_min);
  const fits = (date: string, start: number, len: number): boolean => {
    const hours = s.gym_hours[weekdayKey(date)];
    if (!hours || start < hours.start_min || start + len + travel > hours.end_min) return false;
    if (start < earliest || (date === today && start - travel < input.now_min)) return false;
    return shiftsOn(date).every((x) => start + len + beforeGap <= x.start_min || start - travel >= x.end_min + restAfter(s, x));
  };
  const windowsOn = (date: string) => s.preferred_windows.filter((w) => w.days.includes(weekdayKey(date)));

  /** The day's best start for a session of `len` minutes, or null when nothing fits. */
  const bestOn = (date: string, len: number): FreeSlot | null => {
    const hours = s.gym_hours[weekdayKey(date)];
    if (!hours) return null;
    const shifts = shiftsOn(date);
    const longDay = shifts.some((x) => x.end_min - x.start_min >= s.long_shift_min);
    const floor = Math.max(hours.start_min, earliest, date === today ? input.now_min + travel : 0);
    // The earliest start after each free edge (the day's start, each shift's end plus rest and travel), and the
    // earliest start inside each preferred window after it.
    const edges = [floor, ...shifts.map((x) => x.end_min + restAfter(s, x) + travel)];
    const starts = new Set<number>();
    for (const edge of edges) {
      const start = roundUp(Math.max(edge, floor));
      if (fits(date, start, len)) starts.add(start);
      for (const w of windowsOn(date)) {
        const ws = roundUp(Math.max(edge, floor, w.start_min));
        if (ws + len <= w.end_min && fits(date, ws, len)) starts.add(ws);
      }
    }
    const slots = [...starts].map((start): FreeSlot => {
      const next = shifts.find((x) => x.start_min >= start + len);
      const prev = [...shifts].reverse().find((x) => x.end_min <= start);
      return {
        date,
        start_min: start,
        end_min: start + len,
        leave_min: start - travel,
        back_min: start + len + travel,
        preferred: windowsOn(date).some((w) => start >= w.start_min && start + len <= w.end_min),
        before_shift_at: next ? next.start_min : null,
        after_shift_at: prev ? prev.end_min : null,
        long_shift_day: longDay,
        streak: 1,
        selected: false,
        program_day_id: null,
      };
    });
    const key = (x: FreeSlot) => [longDay && x.before_shift_at !== null ? 0 : 1, x.preferred ? 0 : 1, x.start_min];
    return slots.sort((a, b) => {
      const [ka, kb] = [key(a), key(b)];
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    })[0] ?? null;
  };

  const days = week.filter((d) => d >= today && !busyDates.has(d)).flatMap((d) => bestOn(d, length) ?? []);

  // Rank greedily: each pick counts as training for the ones after it, so the week spreads out. Only training within
  // three days counts as near (Monday and Sunday are a week apart, but next Monday is close to Sunday again).
  const training = new Set(busyDates);
  const distance = (x: FreeSlot) => Math.min(7, ...[...training].map((d) => Math.abs(daysBetween(x.date, d))).filter((n) => n <= 3));
  const ranked: FreeSlot[] = [];
  const pool = [...days];
  while (pool.length) {
    const key = (x: FreeSlot) => [x.preferred ? 0 : 1, streakWith(training, x.date) >= 3 ? 1 : 0, -distance(x), x.start_min, daysBetween(week[0], x.date)];
    let best = 0;
    for (let i = 1; i < pool.length; i++) {
      const [a, b] = [key(pool[i]), key(pool[best])];
      const k = a.findIndex((v, j) => v !== b[j]);
      if (k >= 0 && a[k] < b[k]) best = i;
    }
    const [pick] = pool.splice(best, 1);
    ranked.push(pick);
    if (ranked.length <= need) training.add(pick.date);
  }

  // The pre-selected ones get the next program days in date order (a longer day takes that day's best start for it).
  const picked = new Set(ranked.slice(0, need).map((x) => x.date));
  let next = 0;
  const byDate = ranked.filter((x) => picked.has(x.date)).sort((a, b) => a.date.localeCompare(b.date));
  const assigned = new Map<string, FreeSlot>();
  for (const x of byDate) {
    const day = input.upcoming[next % Math.max(1, input.upcoming.length)];
    next++;
    const refit = day && day.minutes !== length ? bestOn(x.date, day.minutes) : null;
    const base = refit ?? x;
    const len = day?.minutes ?? length;
    assigned.set(x.date, { ...base, end_min: base.start_min + len, back_min: base.start_min + len + travel, selected: true, program_day_id: day?.id ?? null });
  }
  const chosen = new Set([...busyDates, ...picked]);
  return {
    slots: ranked.map((x) => {
      const y = assigned.get(x.date) ?? x;
      return { ...y, streak: streakWith(chosen, y.date) };
    }),
    need,
    length_min: length,
  };
}

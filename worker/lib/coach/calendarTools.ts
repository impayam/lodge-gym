// The coach's calendar tools (SPEC-v10 M13 §6, with Payam's change of 2026-10-15). The coach reads shifts, plans and
// the free-slot finder's suggestions, and proposes a schedule made only of the finder's times: it never computes a
// time itself. Nothing is saved until Payam taps Add to calendar; every rule is advice (no day or time is refused).

import { z } from "zod";
import {
  DEFAULT_CALENDAR_SETTINGS,
  findFreeSlots,
  hm,
  planStates,
  sessionBlock,
  streakWith,
  toMin,
  upcomingFor,
  weekDates,
  type CalendarSettings,
  type FinderResult,
  type GymPlan,
  type WorkShift,
} from "../calendar";
import { nextDay, versionAliases, weekRange } from "../cycle";
import { programOn, type ReportData } from "../reports";
import { DATE_RE, daysBetween, localHM, weekday } from "../time";

/** Longest range of one get_calendar call. */
export const MAX_CALENDAR_DAYS = 31;

/** Shifts, planned gym sessions and the calendar settings, as the app has them. */
export interface CoachCalendar {
  shifts: WorkShift[];
  plans: GymPlan[];
  settings: CalendarSettings;
}

export interface CalendarToolData extends ReportData {
  today: string;
  now: string;
  calendar?: CoachCalendar;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const dayLabel = (date: string) => WEEKDAY[weekday(date)];

export const CALENDAR_TOOLS = [
  {
    name: "get_calendar",
    description: `His work shifts, planned gym sessions (with status: planned, done, missed) and logged sessions between two local dates (YYYY-MM-DD), at most ${MAX_CALENDAR_DAYS} days. Times are local HH:MM.`,
    input_schema: {
      type: "object",
      properties: { from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "find_free_slots",
    description:
      "The app's gym suggestions for the week holding week_start (local date): one per day, best first, from his shifts, the gym's hours and his settings (finish 60 min before a shift, rest after a shift, longer after a long one, earliest start). The first `need` are pre-selected with the program days they get. streak counts training days in a row: a third day in a row is only a neutral note, never a reason to refuse. These are the only times you may propose.",
    input_schema: {
      type: "object",
      properties: { week_start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
      required: ["week_start"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_schedule",
    description:
      "Shows him a schedule card (one row per session: day, time, program day, your reason) with Add to calendar and Change. Each session must be a slot from find_free_slots for that week (same date and start), otherwise it is dropped and reported back. Nothing is saved until he taps Add to calendar. Give each a short reason in Persian.",
    input_schema: {
      type: "object",
      properties: {
        sessions: {
          type: "array",
          minItems: 1,
          maxItems: 7,
          items: {
            type: "object",
            properties: {
              date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              start: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
              program_day_id: { type: "string" },
              reason_fa: { type: "string" },
            },
            required: ["date", "start", "reason_fa"],
            additionalProperties: false,
          },
        },
      },
      required: ["sessions"],
      additionalProperties: false,
    },
  },
] as const;

export type CalendarToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

const date = z.string().regex(DATE_RE, "Use a local date, YYYY-MM-DD.");
const calendarRange = z
  .object({ from: date, to: date })
  .strict()
  .refine((r) => r.from <= r.to, "from must not be after to.")
  .refine((r) => r.from > r.to || daysBetween(r.from, r.to) < MAX_CALENDAR_DAYS, `At most ${MAX_CALENDAR_DAYS} days per call.`);
const scheduleInput = z
  .object({
    sessions: z
      .array(z.object({ date, start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM."), program_day_id: z.string().max(64).optional(), reason_fa: z.string().max(300) }).strict())
      .min(1)
      .max(7),
  })
  .strict();

const calendarOf = (d: CalendarToolData): CoachCalendar => d.calendar ?? { shifts: [], plans: [], settings: DEFAULT_CALENDAR_SETTINGS };
const blocks = (d: CalendarToolData) => d.sessions.map((s) => sessionBlock(s, d.settings.timezone, d.now));
const dayName = (d: ReportData, id: string) => d.program.days.find((x) => x.id === id)?.name_en ?? (d.programs ?? []).flatMap((p) => p.days).find((x) => x.id === id)?.name_en ?? id;

/** The program days the next plans train, in order: Home's next day, after the plans already made. */
export function upcomingOf(d: CalendarToolData) {
  const days = d.program.days;
  const all = (d.programs ?? []).flatMap((p) => p.days.map((x) => ({ id: x.id, program_id: p.id, position: x.position })));
  const next = nextDay(
    days.map((x) => x.id),
    d.sessions,
    versionAliases(d.programs ?? [], all, days)
  ).dayId;
  return upcomingFor(days, next, d.calendar?.plans ?? [], d.today);
}

/** The finder for the week holding `date` (weeks start as in Settings). */
export function finderFor(d: CalendarToolData, date: string): { start: string; result: FinderResult } | null {
  if (!d.calendar) return null;
  const start = weekRange(date, d.settings.week_start).start;
  const result = findFreeSlots({
    week: weekDates(start),
    today: d.today,
    now_min: toMin(localHM(d.settings.timezone, d.now)),
    shifts: d.calendar.shifts,
    plans: d.calendar.plans,
    sessions: blocks(d),
    settings: d.calendar.settings,
    upcoming: upcomingOf(d),
    days_per_week: programOn(d, d.today).days_per_week,
  });
  return { start, result };
}

export function getCalendar(d: CalendarToolData, from: string, to: string) {
  const cal = calendarOf(d);
  const sb = blocks(d);
  const states = planStates(cal.plans, sb, d.today);
  const inRange = (x: { date: string }) => x.date >= from && x.date <= to;
  return {
    from,
    to,
    shifts: cal.shifts.filter(inRange).map((x) => ({ date: x.date, weekday: dayLabel(x.date), start: hm(x.start_min), end: hm(x.end_min), note: x.note })),
    plans: cal.plans
      .filter((p) => inRange(p) && states.get(p.id) !== "cancelled")
      .map((p) => ({ date: p.date, weekday: dayLabel(p.date), start: hm(p.start_min), end: hm(p.end_min), day: dayName(d, p.program_day_id), status: states.get(p.id) ?? p.status, source: p.source })),
    sessions: sb.filter(inRange).map((b) => ({ date: b.date, weekday: dayLabel(b.date), start: hm(b.start_min), end: hm(b.end_min), day: dayName(d, b.program_day_id), status: b.status })),
  };
}

export function findSlots(d: CalendarToolData, weekStart: string): CalendarToolOutcome {
  const f = finderFor(d, weekStart);
  if (!f) return { ok: false, error: "The calendar is not available." };
  return {
    ok: true,
    result: {
      week_start: f.start,
      week_end: weekDates(f.start)[6],
      need: f.result.need,
      days_per_week: programOn(d, d.today).days_per_week,
      slots: f.result.slots.map((x) => ({
        date: x.date,
        weekday: dayLabel(x.date),
        start: hm(x.start_min),
        end: hm(x.end_min),
        leave: hm(x.leave_min),
        back: hm(x.back_min),
        selected: x.selected,
        program_day_id: x.program_day_id,
        day: x.program_day_id ? dayName(d, x.program_day_id) : null,
        preferred: x.preferred,
        before_shift_at: x.before_shift_at === null ? null : hm(x.before_shift_at),
        after_shift_at: x.after_shift_at === null ? null : hm(x.after_shift_at),
        long_shift_day: x.long_shift_day,
        days_in_a_row: x.streak,
      })),
    },
  };
}

/**
 * The schedule card: the coach's picks, each checked against the finder's slots for its week (same date and start);
 * anything else is dropped and reported. A program day he names is kept; else the finder's day, else the next ones.
 */
export function proposeSchedule(d: CalendarToolData, input: unknown): CalendarToolOutcome {
  const parsed = scheduleInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") };
  if (!d.calendar) return { ok: false, error: "The calendar is not available." };
  const weeks = new Map<string, ReturnType<typeof finderFor>>();
  const dropped: { date: string; start: string; reason: string }[] = [];
  const kept: { date: string; start_min: number; program_day_id: string | null; reason_fa: string; finder_day: string | null }[] = [];
  for (const s of parsed.data.sessions) {
    const wk = weekRange(s.date, d.settings.week_start).start;
    if (!weeks.has(wk)) weeks.set(wk, finderFor(d, s.date));
    const slot = weeks.get(wk)?.result.slots.find((x) => x.date === s.date && x.start_min === toMin(s.start));
    if (!slot) {
      dropped.push({ date: s.date, start: s.start, reason: "not a find_free_slots time for that week" });
      continue;
    }
    if (kept.some((k) => k.date === s.date)) {
      dropped.push({ date: s.date, start: s.start, reason: "a second session on the same day" });
      continue;
    }
    const known = s.program_day_id && d.program.days.some((x) => x.id === s.program_day_id) ? s.program_day_id : null;
    kept.push({ date: s.date, start_min: slot.start_min, program_day_id: known, reason_fa: s.reason_fa.trim(), finder_day: slot.program_day_id });
  }
  if (!kept.length) return { ok: false, error: `None of these times is a find_free_slots time (dropped: ${dropped.map((x) => `${x.date} ${x.start}`).join(", ")}). Call find_free_slots and use its times.` };
  // Program days: his choice, else the finder's, else the next in order (date order).
  const order = upcomingOf(d);
  let next = 0;
  const sessions = kept
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((k) => {
      const id = k.program_day_id ?? k.finder_day ?? order[next++ % Math.max(1, order.length)]?.id ?? d.program.days[0].id;
      const minutes = d.program.days.find((x) => x.id === id)?.est_minutes ?? 60;
      return { date: k.date, weekday: dayLabel(k.date), start: hm(k.start_min), end: hm(Math.min(1440, k.start_min + minutes)), program_day_id: id, day: dayName(d, id), reason_fa: k.reason_fa };
    });
  const training = new Set([...d.calendar.plans.filter((p) => p.status === "planned" || p.status === "done").map((p) => p.date), ...d.sessions.map((s) => s.local_date), ...sessions.map((s) => s.date)]);
  return {
    ok: true,
    result: {
      shown: true,
      week_start: weekRange(sessions[0].date, d.settings.week_start).start,
      sessions: sessions.map((s) => ({ ...s, days_in_a_row: streakWith(training, s.date) })),
      dropped,
    },
  };
}

/**
 * This week's planned gym sessions (SPEC-v10 §10): when there are any, the coach's spacing reads these dates instead of
 * the 4-week pattern. Position = the program day's place (Day 1 = 1).
 */
export function plannedThisWeek(d: CalendarToolData): { date: string; weekday: string; start: string; day: string; position: number | null }[] {
  if (!d.calendar) return [];
  const { start, end } = weekRange(d.today, d.settings.week_start);
  const states = planStates(d.calendar.plans, blocks(d), d.today);
  return d.calendar.plans
    .filter((p) => p.date >= start && p.date <= end && (states.get(p.id) === "planned" || states.get(p.id) === "done"))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min)
    .map((p) => ({ date: p.date, weekday: dayLabel(p.date), start: hm(p.start_min), day: dayName(d, p.program_day_id), position: d.program.days.find((x) => x.id === p.program_day_id)?.position ?? null }));
}

export function runCalendarTool(d: CalendarToolData, name: string, input: unknown): CalendarToolOutcome | null {
  switch (name) {
    case "get_calendar": {
      const r = calendarRange.safeParse(input ?? {});
      return r.success ? { ok: true, result: getCalendar(d, r.data.from, r.data.to) } : { ok: false, error: r.error.issues.map((i) => i.message).join("; ") };
    }
    case "find_free_slots": {
      const r = z.object({ week_start: date }).strict().safeParse(input ?? {});
      return r.success ? findSlots(d, r.data.week_start) : { ok: false, error: r.error.issues.map((i) => i.message).join("; ") };
    }
    case "propose_schedule":
      return proposeSchedule(d, input);
    default:
      return null;
  }
}

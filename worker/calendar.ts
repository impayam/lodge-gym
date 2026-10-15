// Training calendar on the Worker (SPEC-v10 M13): reading shifts and planned gym sessions (with the bootstrap, for
// the offline Home strip and Calendar screen), the calendar settings with their approved defaults, and marking a
// plan missed once its day has ended with no session.

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, Env } from "./env";
import { fail, nowISO } from "./http";
import { DEFAULT_CALENDAR_SETTINGS, WEEKDAY_KEYS, type CalendarSettings, type GymPlan, type WorkShift } from "./lib/calendar";
import { DATE_RE, daysBetween, localDate } from "./lib/time";
import { readSettings } from "./data";

const minutes = z.number().int().min(0).max(1440);
const range = z.object({ start_min: minutes, end_min: minutes }).refine((r) => r.end_min > r.start_min, "end after start");
const gymHoursSchema = z.object(Object.fromEntries(WEEKDAY_KEYS.map((k) => [k, range.nullable()])) as Record<(typeof WEEKDAY_KEYS)[number], z.ZodNullable<typeof range>>);
const windowsSchema = z.array(z.object({ days: z.array(z.enum(WEEKDAY_KEYS)).min(1), start_min: minutes, end_min: minutes }).refine((w) => w.end_min > w.start_min)).max(14);
const count = (max: number) => z.coerce.number().int().min(0).max(max);

/** The calendar settings: the settings rows Payam changed, the approved defaults for the rest. */
export async function readCalendarSettings(env: Env): Promise<CalendarSettings> {
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('gym_hours', 'travel_buffer_min', 'after_shift_gap_min', 'preferred_windows', 'reminder_minutes')").all<{ key: string; value: string }>();
  const map = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  const json = (text: string | undefined) => {
    try {
      return text === undefined ? undefined : (JSON.parse(text) as unknown);
    } catch {
      return undefined;
    }
  };
  const d = DEFAULT_CALENDAR_SETTINGS;
  const pick = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const r = schema.safeParse(value);
    return value !== undefined && r.success ? r.data : fallback;
  };
  return {
    gym_hours: pick(gymHoursSchema, json(map.gym_hours), d.gym_hours),
    travel_buffer_min: pick(count(120), map.travel_buffer_min, d.travel_buffer_min),
    after_shift_gap_min: pick(count(240), map.after_shift_gap_min, d.after_shift_gap_min),
    preferred_windows: pick(windowsSchema, json(map.preferred_windows), d.preferred_windows),
    reminder_minutes: pick(count(24 * 60), map.reminder_minutes, d.reminder_minutes),
  };
}

/** A plan whose day has ended with no session becomes missed (SPEC-v10 §4). */
export async function markMissed(env: Env, today: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE gym_plans SET status = 'missed', updated_at = ?
       WHERE status = 'planned' AND session_id IS NULL AND date < ?
         AND NOT EXISTS (SELECT 1 FROM workout_sessions w WHERE w.local_date = gym_plans.date)`
  )
    .bind(nowISO(), today)
    .run();
}

export async function readShifts(env: Env, from: string, to = "9999-12-31"): Promise<WorkShift[]> {
  return (await env.DB.prepare("SELECT * FROM work_shifts WHERE date >= ? AND date <= ? ORDER BY date, start_min").bind(from, to).all<WorkShift>()).results;
}

export async function readGymPlans(env: Env, from: string, to = "9999-12-31"): Promise<GymPlan[]> {
  return (await env.DB.prepare("SELECT * FROM gym_plans WHERE date >= ? AND date <= ? ORDER BY date, start_min").bind(from, to).all<GymPlan>()).results;
}

export interface CalendarData {
  shifts: WorkShift[];
  plans: GymPlan[];
  settings: CalendarSettings;
}

/** The calendar for the bootstrap: from `from` on (all future shifts and plans), with the settings. */
export async function readCalendar(env: Env, today: string, from: string, to?: string): Promise<CalendarData> {
  await markMissed(env, today);
  const [shifts, plans, settings] = await Promise.all([readShifts(env, from, to), readGymPlans(env, from, to), readCalendarSettings(env)]);
  return { shifts, plans, settings };
}

export const calendarRoutes = new Hono<AppBindings>();

/** Shifts and plans of a range (weeks older than the bootstrap's 60 days), at most 92 days. */
calendarRoutes.get("/", async (c) => {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from || daysBetween(from, to) > 92) return fail(c, 400, "invalid_input", "Use from and to dates, at most 92 days apart.");
  const settings = await readSettings(c.env);
  return c.json(await readCalendar(c.env, localDate(settings.timezone), from, to));
});

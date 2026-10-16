// Training calendar on the Worker (SPEC-v10 M13): shifts and planned gym sessions (read with the bootstrap for the
// offline Home strip and Calendar, written through the outbox), the calendar settings with Payam's defaults, plans
// linked to the session of their day, marked missed once their day has ended with no session, and their reminders.

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, Env } from "./env";
import { fail, nowISO, readJson } from "./http";
import {
  DEFAULT_CALENDAR_SETTINGS,
  hm,
  planForSession,
  reminderText,
  toMin,
  WEEKDAY_KEYS,
  type CalendarSettings,
  type GymPlan,
  type WorkShift,
} from "./lib/calendar";
import { DATE_RE, daysBetween, localDate, localHM, zonedToUtcISO } from "./lib/time";
import { ID_RE } from "./lib/ulid";
import { readSettings } from "./data";
import { setReminder } from "./push";

const minutes = z.number().int().min(0).max(1440);
const range = z.object({ start_min: minutes, end_min: minutes }).refine((r) => r.end_min > r.start_min, "end after start");
const gymHoursSchema = z.object(Object.fromEntries(WEEKDAY_KEYS.map((k) => [k, range.nullable()])) as Record<(typeof WEEKDAY_KEYS)[number], z.ZodNullable<typeof range>>);
const windowsSchema = z
  .array(z.object({ days: z.array(z.enum(WEEKDAY_KEYS)).min(1).max(7), start_min: minutes, end_min: minutes }).refine((w) => w.end_min > w.start_min, "end after start"))
  .max(14);
const count = (min: number, max: number) => z.number().int().min(min).max(max);

/** Every calendar setting with its bounds; a settings row holds its JSON value. */
export const calendarSettingsSchema = z.object({
  gym_hours: gymHoursSchema,
  travel_buffer_min: count(0, 120),
  wake_time_min: count(0, 1439),
  earliest_start_min: count(0, 1439),
  before_shift_gap_min: count(0, 240),
  after_shift_gap_min: count(0, 240),
  long_shift_gap_min: count(0, 480),
  long_shift_min: count(60, 1440),
  preferred_windows: windowsSchema,
  /** 0 = no reminder. */
  reminder_minutes: count(0, 1440),
}) satisfies z.ZodType<CalendarSettings>;
const SETTING_KEYS = Object.keys(calendarSettingsSchema.shape) as (keyof CalendarSettings)[];

/** The calendar settings: the rows Payam changed, the built-in defaults for the rest (and for any malformed row). */
export async function readCalendarSettings(env: Env): Promise<CalendarSettings> {
  const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${SETTING_KEYS.map(() => "?").join(", ")})`)
    .bind(...SETTING_KEYS)
    .all<{ key: string; value: string }>();
  const out: CalendarSettings = structuredClone(DEFAULT_CALENDAR_SETTINGS);
  for (const { key, value } of rows.results) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    const field = calendarSettingsSchema.shape[key as keyof CalendarSettings];
    const r = field?.safeParse(parsed);
    if (r?.success) (out as unknown as Record<string, unknown>)[key] = r.data;
  }
  return out;
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

/* ---------------- reminders ---------------- */

/** When a plan's reminder goes out: its start minus the reminder minutes, or null (off, or already past). */
export function reminderAt(plan: Pick<GymPlan, "date" | "start_min">, reminderMinutes: number, tz: string, now = Date.now()): string | null {
  if (reminderMinutes <= 0) return null;
  const at = Date.parse(zonedToUtcISO(plan.date, hm(plan.start_min), tz)) - reminderMinutes * 60_000;
  return at > now ? new Date(at).toISOString() : null;
}

const dayName = async (env: Env, id: string) =>
  (await env.DB.prepare("SELECT name_en FROM program_days WHERE id = ?").bind(id).first<{ name_en: string }>())?.name_en ?? "Gym session";

/**
 * Sets a plan's reminder from its time and the settings: stored in reminder_at and queued in the push object (which
 * sends it at that moment). A plan that is done, missed or deleted has none.
 */
export async function syncReminder(env: Env, planId: string, origin: string, ctx?: { settings: CalendarSettings; tz: string }): Promise<void> {
  const plan = await env.DB.prepare("SELECT * FROM gym_plans WHERE id = ?").bind(planId).first<GymPlan>();
  const settings = ctx?.settings ?? (await readCalendarSettings(env));
  const tz = ctx?.tz ?? (await readSettings(env)).timezone;
  const at = plan && plan.status === "planned" && !plan.session_id ? reminderAt(plan, settings.reminder_minutes, tz) : null;
  if (plan && plan.reminder_at !== at) await env.DB.prepare("UPDATE gym_plans SET reminder_at = ? WHERE id = ?").bind(at, planId).run();
  await setReminder(env, planId, at && plan ? { at: Date.parse(at), title: reminderText(settings.reminder_minutes, await dayName(env, plan.program_day_id), plan.start_min), body: "" } : null, origin);
}

/** Every open plan from today on, after the reminder minutes or the time zone changed. */
export async function syncAllReminders(env: Env, origin: string): Promise<void> {
  const [settings, s] = await Promise.all([readCalendarSettings(env), readSettings(env)]);
  const ids = await env.DB.prepare("SELECT id FROM gym_plans WHERE date >= ? AND status = 'planned' AND session_id IS NULL").bind(localDate(s.timezone)).all<{ id: string }>();
  for (const { id } of ids.results) await syncReminder(env, id, origin, { settings, tz: s.timezone });
}

/* ---------------- plans and sessions ---------------- */

/**
 * A session saved on the server takes the plan of its date (the open plan closest to its start, SPEC-v10 §4; the log
 * wins: a different program day still makes the plan done). A session moved to another date leaves its old plan.
 */
export async function linkSession(env: Env, s: { id: string; local_date: string; started_at: string }, origin: string): Promise<void> {
  const db = env.DB;
  const linked = await db.prepare("SELECT id, date FROM gym_plans WHERE session_id = ?").bind(s.id).first<{ id: string; date: string }>();
  if (linked && linked.date === s.local_date) return;
  if (linked) {
    await db.prepare("UPDATE gym_plans SET session_id = NULL, status = 'planned', updated_at = ? WHERE id = ?").bind(nowISO(), linked.id).run();
    await syncReminder(env, linked.id, origin);
  }
  const tz = (await readSettings(env)).timezone;
  const open = (await db.prepare("SELECT * FROM gym_plans WHERE date = ? AND session_id IS NULL AND status IN ('planned', 'missed')").bind(s.local_date).all<GymPlan>()).results;
  const plan = planForSession(open, { date: s.local_date, start_min: toMin(localHM(tz, s.started_at)) });
  if (!plan) return;
  await db.prepare("UPDATE gym_plans SET session_id = ?, status = 'done', reminder_at = NULL, updated_at = ? WHERE id = ?").bind(s.id, nowISO(), plan.id).run();
  await setReminder(env, plan.id, null, origin);
}

/** Before a session is deleted: its plan goes back to planned (missed again once read, when its day has ended). */
export const unlinkSessionStmt = (env: Env, sessionId: string) =>
  env.DB.prepare("UPDATE gym_plans SET session_id = NULL, status = 'planned', updated_at = ? WHERE session_id = ?").bind(nowISO(), sessionId);

/* ---------------- routes ---------------- */

const iso = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)) && /T/.test(s), "iso");
const id = z.string().regex(ID_RE);
const timed = { date: z.string().regex(DATE_RE), start_min: count(0, 1439), end_min: count(1, 1440) };
const shiftSchema = z.object({ id, ...timed, note: z.string().max(200), created_at: iso, updated_at: iso }).refine((x) => x.end_min > x.start_min, "end after start");
const planSchema = z
  .object({ id, ...timed, program_day_id: id, source: z.enum(["manual", "finder", "coach"]), created_at: iso, updated_at: iso })
  .refine((x) => x.end_min > x.start_min, "end after start");

export const calendarRoutes = new Hono<AppBindings>();

/** Shifts and plans of a range (weeks older than the bootstrap's 60 days), at most 92 days. */
calendarRoutes.get("/", async (c) => {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from || daysBetween(from, to) > 92) return fail(c, 400, "invalid_input", "Use from and to dates, at most 92 days apart.");
  const settings = await readSettings(c.env);
  return c.json(await readCalendar(c.env, localDate(settings.timezone), from, to));
});

/** A shift, created or changed (the outbox replays it: the newest write wins). */
calendarRoutes.put("/shifts/:id", async (c) => {
  const doc = await readJson(c, shiftSchema);
  if (doc.id !== c.req.param("id")) return fail(c, 400, "id_mismatch", "The shift id does not match the URL.");
  const db = c.env.DB;
  const existing = await db.prepare("SELECT * FROM work_shifts WHERE id = ?").bind(doc.id).first<WorkShift>();
  if (existing && Date.parse(existing.updated_at) > Date.parse(doc.updated_at)) return c.json({ ok: true, applied: false, shift: existing });
  await db
    .prepare(
      `INSERT INTO work_shifts (id, date, start_min, end_min, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET date = excluded.date, start_min = excluded.start_min, end_min = excluded.end_min,
         note = excluded.note, updated_at = excluded.updated_at`
    )
    .bind(doc.id, doc.date, doc.start_min, doc.end_min, doc.note, doc.created_at, doc.updated_at)
    .run();
  return c.json({ ok: true, applied: true, shift: await db.prepare("SELECT * FROM work_shifts WHERE id = ?").bind(doc.id).first<WorkShift>() });
});

calendarRoutes.delete("/shifts/:id", async (c) => {
  const sid = c.req.param("id");
  if (!ID_RE.test(sid)) return fail(c, 400, "invalid_input", "The shift id is not valid.");
  await c.env.DB.prepare("DELETE FROM work_shifts WHERE id = ?").bind(sid).run();
  return c.json({ ok: true });
});

/**
 * A planned gym session, created, moved or changed (any day and time: nothing blocks it). The server keeps its link to
 * a session (and links one of that date when there is one), sets its status, and moves or sets its reminder.
 */
calendarRoutes.put("/plans/:id", async (c) => {
  const doc = await readJson(c, planSchema);
  if (doc.id !== c.req.param("id")) return fail(c, 400, "id_mismatch", "The plan id does not match the URL.");
  const db = c.env.DB;
  if (!(await db.prepare("SELECT id FROM program_days WHERE id = ?").bind(doc.program_day_id).first())) return fail(c, 400, "unknown_day", "Program day not found.");
  const existing = await db.prepare("SELECT * FROM gym_plans WHERE id = ?").bind(doc.id).first<GymPlan>();
  if (existing && Date.parse(existing.updated_at) > Date.parse(doc.updated_at)) return c.json({ ok: true, applied: false, plan: existing });
  // A plan moved to another day leaves the session it was linked to.
  const keep = existing?.session_id && existing.date === doc.date ? existing.session_id : null;
  await db
    .prepare(
      `INSERT INTO gym_plans (id, date, start_min, end_min, program_day_id, source, session_id, status, reminder_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (id) DO UPDATE SET date = excluded.date, start_min = excluded.start_min, end_min = excluded.end_min,
         program_day_id = excluded.program_day_id, source = excluded.source, session_id = excluded.session_id,
         status = excluded.status, updated_at = excluded.updated_at`
    )
    .bind(doc.id, doc.date, doc.start_min, doc.end_min, doc.program_day_id, doc.source, keep, keep ? "done" : "planned", doc.created_at, doc.updated_at)
    .run();
  const origin = new URL(c.req.url).origin;
  if (!keep) {
    // Planned on a day already trained: that session's plan is this one.
    const tz = (await readSettings(c.env)).timezone;
    const s = await db
      .prepare("SELECT id, started_at FROM workout_sessions WHERE local_date = ? AND id NOT IN (SELECT session_id FROM gym_plans WHERE session_id IS NOT NULL) ORDER BY started_at")
      .bind(doc.date)
      .all<{ id: string; started_at: string }>();
    const near = s.results.map((x) => ({ ...x, d: Math.abs(toMin(localHM(tz, x.started_at)) - doc.start_min) })).sort((a, b) => a.d - b.d)[0];
    if (near) await db.prepare("UPDATE gym_plans SET session_id = ?, status = 'done' WHERE id = ?").bind(near.id, doc.id).run();
    else await markMissed(c.env, localDate(tz));
  }
  await syncReminder(c.env, doc.id, origin);
  return c.json({ ok: true, applied: true, plan: await db.prepare("SELECT * FROM gym_plans WHERE id = ?").bind(doc.id).first<GymPlan>() });
});

/** Deleting a plan is a real delete (it is a plan, not history); its reminder is cancelled. */
calendarRoutes.delete("/plans/:id", async (c) => {
  const pid = c.req.param("id");
  if (!ID_RE.test(pid)) return fail(c, 400, "invalid_input", "The plan id is not valid.");
  await c.env.DB.prepare("DELETE FROM gym_plans WHERE id = ?").bind(pid).run();
  await setReminder(c.env, pid, null, new URL(c.req.url).origin);
  return c.json({ ok: true });
});

/** The calendar settings Payam changed (any subset); a changed reminder time moves every open plan's reminder. */
calendarRoutes.put("/settings", async (c) => {
  const body = await readJson(c, calendarSettingsSchema.partial());
  const entries = Object.entries(body).filter(([, v]) => v !== undefined);
  if (entries.length)
    await c.env.DB.batch(entries.map(([k, v]) => c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(k, JSON.stringify(v))));
  if (body.reminder_minutes !== undefined) await syncAllReminders(c.env, new URL(c.req.url).origin);
  return c.json({ ok: true, settings: await readCalendarSettings(c.env) });
});

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings, type GymPlan, type WorkShift } from "../../worker/lib/calendar";
import { addDays, localDate } from "../../worker/lib/time";
import type { Bootstrap } from "../../worker/lib/types";
import { Client, resetAuth, setupOwner } from "./helpers";

// SPEC-v10 M13: the calendar tables (migration 0012), their bootstrap and range reads, the settings with their approved
// defaults, and plans marked missed once their day has ended with no session.
let client: Client;
let today: string;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.130"));
  const tz = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'").first<{ value: string }>())?.value ?? "America/Denver";
  today = localDate(tz);
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM gym_plans"),
    env.DB.prepare("DELETE FROM work_shifts"),
    env.DB.prepare("DELETE FROM settings WHERE key IN ('gym_hours', 'travel_buffer_min', 'after_shift_gap_min', 'preferred_windows', 'reminder_minutes')"),
  ]);
});

const NOW = "2026-10-15T12:00:00.000Z";
const addShift = (id: string, date: string, start: number, end: number, note = "") =>
  env.DB.prepare("INSERT INTO work_shifts (id, date, start_min, end_min, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, date, start, end, note, NOW, NOW).run();
const addPlan = (id: string, date: string, start: number, more: { session_id?: string | null; status?: string } = {}) =>
  env.DB.prepare("INSERT INTO gym_plans (id, date, start_min, end_min, program_day_id, source, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'D1', 'manual', ?, ?, ?, ?)")
    .bind(id, date, start, start + 60, more.session_id ?? null, more.status ?? "planned", NOW, NOW)
    .run();
const bootstrap = async () => (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;

describe("migration 0012", () => {
  it("keeps shifts and plans on one day: end after start, never after midnight", async () => {
    await expect(addShift("bad1", today, 1200, 1500)).rejects.toThrow(/CHECK/);
    await expect(addShift("bad2", today, 600, 600)).rejects.toThrow(/CHECK/);
    await expect(addShift("bad3", today, -10, 60)).rejects.toThrow(/CHECK/);
    await expect(addPlan("bad4", today, 1400)).rejects.toThrow(/CHECK/);
    await addShift("ok", today, 1080, 1440);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM work_shifts").first<{ n: number }>())!.n).toBe(1);
  });

  it("allows only the known plan sources and statuses, and one plan per session", async () => {
    const insert = (id: string, source: string, status: string) =>
      env.DB.prepare("INSERT INTO gym_plans (id, date, start_min, end_min, program_day_id, source, status, created_at, updated_at) VALUES (?, ?, 600, 660, 'D1', ?, ?, ?, ?)").bind(id, today, source, status, NOW, NOW).run();
    await expect(insert("s1", "google", "planned")).rejects.toThrow(/CHECK/);
    await expect(insert("s2", "coach", "skipped")).rejects.toThrow(/CHECK/);
    for (const [i, src] of ["manual", "finder", "coach"].entries()) await insert(`ok${i}`, src, "planned");
    const sid = "01JCALSESSION000000000000A";
    await env.DB.prepare("INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, created_at, updated_at, source) VALUES (?, 'D1', ?, ?, ?, 'done', 'lb', ?, ?, 'app')")
      .bind(sid, today, NOW, NOW, NOW, NOW)
      .run();
    await addPlan("linked1", today, 700, { session_id: sid, status: "done" });
    await expect(addPlan("linked2", today, 800, { session_id: sid, status: "done" })).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare("DELETE FROM gym_plans WHERE session_id = ?").bind(sid).run();
    await env.DB.prepare("DELETE FROM workout_sessions WHERE id = ?").bind(sid).run();
  });
});

describe("GET /api/bootstrap: calendar", () => {
  it("comes with the approved defaults until a setting is changed", async () => {
    const b = await bootstrap();
    expect(b.calendar).toEqual({ shifts: [], plans: [], settings: DEFAULT_CALENDAR_SETTINGS });
    expect(b.calendar!.settings.gym_hours.sat).toEqual({ start_min: 300, end_min: 1320 });
    expect(b.calendar!.settings.gym_hours.sun).toEqual({ start_min: 420, end_min: 960 });
  });

  it("reads changed settings rows; a malformed one keeps its default", async () => {
    const hours: CalendarSettings["gym_hours"] = { ...DEFAULT_CALENDAR_SETTINGS.gym_hours, sun: null };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('travel_buffer_min', '25')"),
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('gym_hours', ?)").bind(JSON.stringify(hours)),
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('reminder_minutes', 'soon')"),
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('preferred_windows', ?)").bind(JSON.stringify([{ days: ["mon"], start_min: 1080, end_min: 1020 }])),
    ]);
    const s = (await bootstrap()).calendar!.settings;
    expect(s.travel_buffer_min).toBe(25);
    expect(s.gym_hours.sun).toBeNull();
    expect(s.reminder_minutes).toBe(60);
    expect(s.preferred_windows).toEqual([]);
    expect(s.after_shift_gap_min).toBe(30);
  });

  it("holds shifts and plans from 60 days back on, and future ones", async () => {
    await addShift("old", addDays(today, -61), 420, 930);
    await addShift("w1", addDays(today, -3), 420, 930, "Store");
    await addShift("w2", addDays(today, 20), 600, 1200);
    await addPlan("p1", addDays(today, 2), 1050);
    const c = (await bootstrap()).calendar!;
    expect(c.shifts.map((x: WorkShift) => x.id)).toEqual(["w1", "w2"]);
    expect(c.shifts[0]).toMatchObject({ start_min: 420, end_min: 930, note: "Store" });
    expect(c.plans.map((p: GymPlan) => [p.id, p.status, p.source])).toEqual([["p1", "planned", "manual"]]);
  });

  it("marks a plan missed once its day has ended with no session; a session that day keeps it", async () => {
    const yesterday = addDays(today, -1);
    const before = addDays(today, -2);
    const sid = "01JCALSESSION000000000000B";
    await env.DB.prepare("INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, created_at, updated_at, source) VALUES (?, 'D2', ?, ?, ?, 'done', 'lb', ?, ?, 'app')")
      .bind(sid, before, NOW, NOW, NOW, NOW)
      .run();
    await addPlan("m1", yesterday, 1020);
    await addPlan("m2", before, 1020);
    await addPlan("m3", today, 0);
    const plans = Object.fromEntries((await bootstrap()).calendar!.plans.map((p: GymPlan) => [p.id, p.status]));
    expect(plans).toEqual({ m1: "missed", m2: "planned", m3: "planned" });
    await env.DB.prepare("DELETE FROM workout_sessions WHERE id = ?").bind(sid).run();
  });
});

describe("GET /api/calendar", () => {
  it("reads a range of at most 92 days", async () => {
    await addShift("a", "2026-01-05", 420, 930);
    await addShift("b", "2026-01-12", 420, 930);
    await addPlan("c", "2026-01-06", 1050, { status: "missed" });
    const r = await client.fetch("/api/calendar?from=2026-01-05&to=2026-01-11");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { shifts: WorkShift[]; plans: GymPlan[]; settings: CalendarSettings };
    expect(body.shifts.map((x) => x.id)).toEqual(["a"]);
    expect(body.plans.map((p) => p.id)).toEqual(["c"]);
    expect(body.settings).toEqual(DEFAULT_CALENDAR_SETTINGS);
  });

  it("refuses a bad or too long range", async () => {
    for (const q of ["", "?from=2026-01-05", "?from=2026-01-11&to=2026-01-05", "?from=2026-01-01&to=2026-04-15", "?from=2026-13-01&to=2026-13-02"]) {
      const r = await client.fetch(`/api/calendar${q}`);
      expect(r.status, q).toBe(400);
    }
  });

  it("needs a signed-in owner", async () => {
    expect((await new Client("192.0.2.131").fetch("/api/calendar?from=2026-01-05&to=2026-01-11")).status).toBe(401);
  });
});

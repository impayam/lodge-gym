import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings, type GymPlan, type WorkShift } from "../../worker/lib/calendar";
import { addDays, localDate, zonedToUtcISO } from "../../worker/lib/time";
import type { RestPush } from "../../worker/push";
import { fakeSubscription } from "../fixtures/push-client";
import type { Bootstrap } from "../../worker/lib/types";
import { Client, resetAuth, setupOwner } from "./helpers";

// SPEC-v10 M13: the calendar tables (migration 0012), their bootstrap and range reads, the settings with their approved
// defaults, and plans marked missed once their day has ended with no session.
let client: Client;
let today: string;
let tz: string;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.130"));
  tz = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'").first<{ value: string }>())?.value ?? "America/Denver";
  today = localDate(tz);
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM gym_plans"),
    env.DB.prepare("DELETE FROM work_shifts"),
    env.DB.prepare(
      "DELETE FROM settings WHERE key IN ('gym_hours', 'travel_buffer_min', 'wake_time_min', 'earliest_start_min', 'before_shift_gap_min', 'after_shift_gap_min', 'long_shift_gap_min', 'long_shift_min', 'preferred_windows', 'reminder_minutes')"
    ),
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

/* ---------------- writes (SPEC-v10 M13: the outbox replays them; the newest write wins) ---------------- */

const push = () => env.REST_PUSH.get(env.REST_PUSH.idFromName("owner"));
const reminders = () => runInDurableObject(push(), (obj) => (obj as unknown as RestPush).reminderList());
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const putShift = (x: Partial<WorkShift> & { id: string }) =>
  client.fetch(`/api/calendar/shifts/${x.id}`, { method: "PUT", json: { date: today, start_min: 420, end_min: 930, note: "", created_at: later(0), updated_at: later(0), ...x } });
const putPlan = (x: Partial<GymPlan> & { id: string }) =>
  client.fetch(`/api/calendar/plans/${x.id}`, {
    method: "PUT",
    json: { date: addDays(today, 3), start_min: 1050, end_min: 1110, program_day_id: "D3", source: "manual", created_at: later(0), updated_at: later(0), ...x },
  });
const planRow = (id: string) => env.DB.prepare("SELECT * FROM gym_plans WHERE id = ?").bind(id).first<GymPlan>();
const putSession = (id: string, date: string, start: string, end: string, day = "D1") => {
  const at = later(0);
  return client.fetch(`/api/sessions/${id}`, {
    method: "PUT",
    json: { id, program_day_id: day, local_date: date, started_at: zonedToUtcISO(date, start, tz), ended_at: zonedToUtcISO(date, end, tz), status: "done", unit: "lb", note: "", created_at: at, updated_at: at, source: "import", sets: [] },
  });
};

describe("PUT / DELETE /api/calendar/shifts/:id", () => {
  it("creates and changes a shift; an older replay does not overwrite a newer one; delete is a real delete", async () => {
    let r = await putShift({ id: "sh1", note: "Store", updated_at: later(0) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { shift: WorkShift }).shift).toMatchObject({ id: "sh1", date: today, start_min: 420, end_min: 930, note: "Store" });
    r = await putShift({ id: "sh1", start_min: 480, updated_at: later(5_000) });
    expect(((await r.json()) as { applied: boolean }).applied).toBe(true);
    r = await putShift({ id: "sh1", start_min: 300, updated_at: later(-60_000) });
    expect(await r.json()).toMatchObject({ applied: false, shift: { start_min: 480 } });
    expect((await client.fetch("/api/calendar/shifts/sh1", { method: "DELETE" })).status).toBe(200);
    expect((await client.fetch("/api/calendar/shifts/sh1", { method: "DELETE" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM work_shifts").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("refuses a shift that ends before it starts or after midnight, and an id that does not match", async () => {
    expect((await putShift({ id: "sh2", start_min: 900, end_min: 900 })).status).toBe(400);
    expect((await putShift({ id: "sh2", start_min: 1200, end_min: 1500 })).status).toBe(400);
    expect((await client.fetch("/api/calendar/shifts/other", { method: "PUT", json: { id: "sh2", date: today, start_min: 1, end_min: 2, note: "", created_at: later(0), updated_at: later(0) } })).status).toBe(400);
  });
});

describe("PUT / DELETE /api/calendar/plans/:id and reminders", () => {
  it("a plan on any day and time is saved as planned with its reminder 60 min before; moving it moves the reminder", async () => {
    const date = addDays(today, 3);
    const r = await putPlan({ id: "pl1", date, start_min: 1050, end_min: 1110 });
    expect(r.status).toBe(200);
    const plan = ((await r.json()) as { plan: GymPlan }).plan;
    expect(plan).toMatchObject({ id: "pl1", status: "planned", session_id: null, source: "manual" });
    const at = Date.parse(zonedToUtcISO(date, "17:30", tz)) - 3_600_000;
    expect(plan.reminder_at).toBe(new Date(at).toISOString());
    expect((await reminders()).pl1).toEqual({ at, title: "Gym in 1 hour: Day 3 · Back, 17:30", body: "" });

    await putPlan({ id: "pl1", date, start_min: 1110, end_min: 1170, updated_at: later(5_000) });
    expect((await reminders()).pl1.at).toBe(at + 3_600_000);
    expect((await reminders()).pl1.title).toBe("Gym in 1 hour: Day 3 · Back, 18:30");

    // Seven days in a row is fine: nothing blocks a plan.
    for (let i = 0; i < 7; i++) expect((await putPlan({ id: `row${i}`, date: addDays(today, 10 + i) })).status).toBe(200);

    expect((await client.fetch("/api/calendar/plans/pl1", { method: "DELETE" })).status).toBe(200);
    expect(await planRow("pl1")).toBeNull();
    expect((await reminders()).pl1).toBeUndefined();
    for (let i = 0; i < 7; i++) await client.fetch(`/api/calendar/plans/row${i}`, { method: "DELETE" });
  });

  it("the reminder goes out as a push at its time", async () => {
    const live = await fakeSubscription("https://web.push.apple.com/QCal");
    await client.post("/api/push/subscribe", live.sub);
    await putPlan({ id: "pl2", date: addDays(today, 1), start_min: 600, end_min: 660, program_day_id: "D1" });
    const sent: Uint8Array[] = [];
    await runInDurableObject(push(), async (obj, state) => {
      (obj as unknown as RestPush).pushFetch = async (input, init) => {
        sent.push(new Uint8Array(await new Request(input, init).arrayBuffer()));
        return new Response(null, { status: 201 });
      };
      expect(await state.storage.getAlarm()).toBe((await (obj as unknown as RestPush).reminderList()).pl2.at);
    });
    expect(await runDurableObjectAlarm(push())).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(await live.decrypt(sent[0]))).toEqual({ title: "Gym in 1 hour: Day 1 · Chest, 10:00", body: "", tag: "gym-pl2" });
    expect((await reminders()).pl2).toBeUndefined();
    await client.post("/api/push/unsubscribe", { endpoint: live.sub.endpoint });
  });

  it("a plan for a day already past with no session is missed; one on a day trained is linked and done", async () => {
    await putPlan({ id: "pl3", date: addDays(today, -2), start_min: 1020, end_min: 1080 });
    expect(await planRow("pl3")).toMatchObject({ status: "missed", reminder_at: null });
    expect((await putSession("01JCALSESS0000000000000LNK", addDays(today, -4), "12:00", "13:00")).status).toBe(200);
    await putPlan({ id: "pl4", date: addDays(today, -4), start_min: 1020, end_min: 1080 });
    expect(await planRow("pl4")).toMatchObject({ status: "done", session_id: "01JCALSESS0000000000000LNK", reminder_at: null });
    await env.DB.prepare("DELETE FROM gym_plans").run();
    await client.fetch("/api/sessions/01JCALSESS0000000000000LNK", { method: "DELETE" });
  });

  it("refuses an unknown program day and a bad time", async () => {
    expect((await putPlan({ id: "pl5", program_day_id: "NOPE" })).status).toBe(400);
    expect((await putPlan({ id: "pl5", start_min: 1400, end_min: 1460 })).status).toBe(400);
  });
});

describe("plans and logged sessions", () => {
  it("a session links its date's open plan closest to its start (the log wins); deleting it sets the plan back", async () => {
    const date = addDays(today, -1);
    for (const [id, start] of [
      ["early", 360],
      ["late", 1050],
    ] as const)
      await env.DB.prepare("INSERT INTO gym_plans (id, date, start_min, end_min, program_day_id, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'D3', 'finder', 'planned', ?, ?)")
        .bind(id, date, start, start + 60, NOW, NOW)
        .run();
    // Day 2 trained at 16:40, though Day 3 was planned: the 17:30 plan is done.
    expect((await putSession("01JCALSESS0000000000000AAA", date, "16:40", "17:45", "D2")).status).toBe(200);
    expect(await planRow("late")).toMatchObject({ status: "done", session_id: "01JCALSESS0000000000000AAA" });
    expect(await planRow("early")).toMatchObject({ status: "planned", session_id: null });
    // Saved again (an edit): still the same plan.
    await putSession("01JCALSESS0000000000000AAA", date, "16:40", "17:50", "D2");
    expect((await planRow("late"))!.session_id).toBe("01JCALSESS0000000000000AAA");

    expect((await client.fetch("/api/sessions/01JCALSESS0000000000000AAA", { method: "DELETE" })).status).toBe(200);
    expect(await planRow("late")).toMatchObject({ status: "planned", session_id: null });
    // Read again after its day: both are missed.
    const plans = Object.fromEntries((await bootstrap()).calendar!.plans.map((p: GymPlan) => [p.id, p.status]));
    expect(plans).toMatchObject({ early: "missed", late: "missed" });
  });
});

describe("PUT /api/calendar/settings", () => {
  it("saves any subset; a new reminder time moves every open plan's reminder; bad values are refused", async () => {
    await putPlan({ id: "pl6", date: addDays(today, 2), start_min: 1050, end_min: 1110 });
    const r = await client.fetch("/api/calendar/settings", { method: "PUT", json: { reminder_minutes: 30, wake_time_min: 360 } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { settings: CalendarSettings };
    expect(body.settings).toMatchObject({ reminder_minutes: 30, wake_time_min: 360, earliest_start_min: 480 });
    expect((await reminders()).pl6.title).toBe("Gym in 30 min: Day 3 · Back, 17:30");
    expect((await planRow("pl6"))!.reminder_at).toBe(new Date(Date.parse(zonedToUtcISO(addDays(today, 2), "17:30", tz)) - 1_800_000).toISOString());
    // 0 = no reminder.
    await client.fetch("/api/calendar/settings", { method: "PUT", json: { reminder_minutes: 0 } });
    expect((await reminders()).pl6).toBeUndefined();
    for (const bad of [{ travel_buffer_min: -5 }, { long_shift_min: 10 }, { gym_hours: { ...DEFAULT_CALENDAR_SETTINGS.gym_hours, mon: { start_min: 600, end_min: 500 } } }, { preferred_windows: [{ days: [], start_min: 0, end_min: 60 }] }])
      expect((await client.fetch("/api/calendar/settings", { method: "PUT", json: bad })).status, JSON.stringify(bad)).toBe(400);
    await client.fetch("/api/calendar/plans/pl6", { method: "DELETE" });
  });
});

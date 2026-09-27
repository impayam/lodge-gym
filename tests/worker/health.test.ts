import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Bootstrap, HealthWorkout, WorkoutSession } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import ios17 from "../fixtures/shortcuts/ios17-en-us-default.json";
import ios18 from "../fixtures/shortcuts/ios18-iso8601.json";
import persian from "../fixtures/shortcuts/persian-locale.json";
import samplesEnUs from "../fixtures/shortcuts/samples-en-us-default.json";
import samples7 from "../fixtures/shortcuts/samples-7days-arrays.json";
import samplesIso from "../fixtures/shortcuts/samples-iso8601.json";
import samplesPersian from "../fixtures/shortcuts/samples-persian.json";
import sevenDays from "../fixtures/shortcuts/seven-days-arrays.json";
import { Client, ORIGIN, resetAuth, setupOwner } from "./helpers";

let client: Client;
let token: string;

beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.70"));
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM health_workouts"),
    env.DB.prepare("DELETE FROM set_entries"),
    env.DB.prepare("DELETE FROM workout_sessions"),
    env.DB.prepare("DELETE FROM api_tokens"),
    env.DB.prepare("DELETE FROM settings WHERE key LIKE 'health_%'"),
  ]);
  const r = (await (await client.post("/api/tokens", { label: "iPhone" })).json()) as { token: string };
  token = r.token;
});

/** Posts like iOS Shortcuts: no Origin, no cookie, bearer token. */
function shortcut(body: string, contentType = "application/json", auth: string | null = `Bearer ${token}`) {
  const headers = new Headers({ "Content-Type": contentType });
  if (auth) headers.set("Authorization", auth);
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(`${ORIGIN}/api/health/raw`, { method: "POST", headers, body }));
}

function session(over: Partial<WorkoutSession> = {}): WorkoutSession {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    program_day_id: "D1",
    local_date: "2026-09-28",
    started_at: "2026-09-28T23:00:00.000Z",
    ended_at: "2026-09-29T00:00:00.000Z",
    status: "done",
    unit: "lb",
    note: "",
    created_at: now,
    updated_at: now,
    source: "app",
    sets: [],
    ...over,
  };
}
const putSession = (s: WorkoutSession) => client.fetch(`/api/sessions/${s.id}`, { method: "PUT", json: s });
type Row = HealthWorkout & { raw: string; external_key: string };
/** Watch workouts from the legacy workout fields. */
const rows = async () => (await env.DB.prepare("SELECT * FROM health_workouts WHERE external_key NOT LIKE 'session:%' ORDER BY started_at").all<Row>()).results;
/** Per-session rows computed from Heart Rate / Active Energy samples. */
const sessionRows = async () => (await env.DB.prepare("SELECT * FROM health_workouts WHERE external_key LIKE 'session:%' ORDER BY started_at").all<Row>()).results;

describe("shortcut tokens", () => {
  it("creates (shown once, stored hashed), lists and revokes", async () => {
    expect(token).toMatch(/^lgt_[A-Za-z0-9_-]{43}$/);
    const stored = await env.DB.prepare("SELECT token_hash, scope FROM api_tokens").first<{ token_hash: string; scope: string }>();
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.token_hash).not.toContain(token);
    expect(stored!.scope).toBe("health:write");
    const list = (await (await client.fetch("/api/tokens")).json()) as { tokens: { id: string; label: string; token?: string }[] };
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0].label).toBe("iPhone");
    expect(list.tokens[0].token).toBeUndefined();
    expect((await client.fetch(`/api/tokens/${list.tokens[0].id}`, { method: "DELETE" })).status).toBe(200);
    expect((await shortcut(JSON.stringify(ios18))).status).toBe(401);
    expect(((await (await client.fetch("/api/tokens")).json()) as { tokens: unknown[] }).tokens).toHaveLength(0);
  });

  it("token management needs a session", async () => {
    expect((await new Client("192.0.2.71").fetch("/api/tokens")).status).toBe(401);
  });
});

describe("POST /api/health/raw with Heart Rate + Active Energy samples", () => {
  it("computes avg/max HR and active kcal inside each session; duration comes from the session", async () => {
    const s = session();
    const other = session({ local_date: "2026-09-27", started_at: "2026-09-27T23:00:00.000Z", ended_at: "2026-09-28T00:00:00.000Z" });
    await putSession(s);
    await putSession(other);
    const res = await shortcut(JSON.stringify(samplesIso));
    const body = (await res.json()) as { sessions: number; hr_samples: number; energy_samples: number; stored: number; message: string };
    expect(body).toMatchObject({ sessions: 1, hr_samples: 6, energy_samples: 6, stored: 0 });
    expect(body.message).toBe("Lodge Gym: داده‌ی ساعت برای ۱ جلسه ثبت شد.");
    const [r] = await sessionRows();
    expect(r).toMatchObject({ matched_session_id: s.id, hr_avg: 142.5, hr_max: 160, active_kcal: 40.5, duration_sec: 3600, started_at: s.started_at, ended_at: s.ended_at });
    expect(r.external_key).toBe(`session:${s.id}`);
    expect(await rows()).toEqual([]);
  });

  it("is idempotent on re-send and across date/locale variants", async () => {
    const s = session();
    await putSession(s);
    for (const p of [samplesIso, samplesIso, samplesEnUs, samplesPersian]) expect((await shortcut(JSON.stringify(p))).status).toBe(200);
    const all = await sessionRows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ hr_avg: 142.5, hr_max: 160, active_kcal: 40.5 });
  });

  it("a later partial window never replaces more complete data", async () => {
    const s = session();
    await putSession(s);
    await shortcut(JSON.stringify(samplesIso));
    // Only the last heart-rate and energy samples (the 6-hour window cut the session).
    await shortcut(JSON.stringify({ hr: "150 count/min", hr_time: "2026-09-28T17:55:00-06:00", energy: "9.1 kcal", energy_time: "2026-09-28T17:59:00-06:00" }));
    expect((await sessionRows())[0]).toMatchObject({ hr_avg: 142.5, active_kcal: 40.5 });
    // A payload with more samples does replace it.
    const more = {
      hr: [...samplesIso.hr.split("\n"), "170 count/min"],
      hr_time: [...samplesIso.hr_time.split("\n"), "2026-09-28T17:58:00-06:00"],
      energy: samplesIso.energy,
      energy_time: samplesIso.energy_time,
    };
    await shortcut(JSON.stringify(more));
    expect((await sessionRows())[0]).toMatchObject({ hr_avg: 148, hr_max: 170, active_kcal: 40.5 });
  });

  it("an active session uses samples until now and fills in as it continues", async () => {
    const start = new Date(Date.now() - 40 * 60_000);
    const s = session({ local_date: new Date().toISOString().slice(0, 10), started_at: start.toISOString(), ended_at: null, status: "active" });
    await putSession(s);
    const at = (min: number) => new Date(start.getTime() + min * 60_000).toISOString();
    await shortcut(JSON.stringify({ hr: "120\n130", hr_time: `${at(5)}\n${at(15)}`, energy: "10 kcal", energy_time: at(10) }));
    expect((await sessionRows())[0]).toMatchObject({ hr_avg: 125, hr_max: 130, active_kcal: 10, duration_sec: null, ended_at: null });
    await shortcut(JSON.stringify({ hr: "120\n130\n150", hr_time: `${at(5)}\n${at(15)}\n${at(30)}`, energy: "10 kcal\n12 kcal", energy_time: `${at(10)}\n${at(25)}` }));
    expect((await sessionRows())[0]).toMatchObject({ hr_avg: 133.3, hr_max: 150, active_kcal: 22 });
  });

  it("a 7-day sync fills every session in range and ignores samples between sessions", async () => {
    const a = session({ local_date: "2026-09-22", started_at: "2026-09-22T13:30:00.000Z", ended_at: "2026-09-22T14:30:00.000Z" });
    const b = session();
    await putSession(a);
    await putSession(b);
    const body = (await (await shortcut(JSON.stringify(samples7))).json()) as { sessions: number };
    expect(body.sessions).toBe(2);
    const all = await sessionRows();
    expect(all.map((r) => [r.matched_session_id, r.hr_avg, r.hr_max, r.active_kcal])).toEqual([
      [a.id, 120, 130, 50.5],
      [b.id, 145, 150, 3.2],
    ]);
  });

  it("samples without a session in the app are reported, not stored", async () => {
    const body = (await (await shortcut(JSON.stringify(samplesIso))).json()) as { sessions: number; message: string };
    expect(body.sessions).toBe(0);
    expect(body.message).toContain("جلسه‌ای در برنامه ثبت نشده");
    expect(await sessionRows()).toEqual([]);
  });

  it("bootstrap and status carry the session stats; deleting the session removes them", async () => {
    const start = new Date(Date.now() - 3 * 3600_000);
    const s = session({ local_date: new Date().toISOString().slice(0, 10), started_at: start.toISOString(), ended_at: new Date(start.getTime() + 3600_000).toISOString() });
    await putSession(s);
    await shortcut(JSON.stringify({ hr: "140\n150", hr_time: `${new Date(start.getTime() + 600_000).toISOString()}\n${new Date(start.getTime() + 1200_000).toISOString()}`, energy: "80 kcal", energy_time: new Date(start.getTime() + 900_000).toISOString() }));
    const b = (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
    expect(b.watch.find((w) => w.matched_session_id === s.id)).toMatchObject({ kind: "session", hr_avg: 145, active_kcal: 80 });
    const st = (await (await client.fetch("/api/health/status")).json()) as { workouts: HealthWorkout[]; last_result: { sessions: number } };
    expect(st.workouts[0]).toMatchObject({ kind: "session", matched_session_id: s.id });
    expect(st.last_result.sessions).toBe(1);
    await client.fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
    expect(await sessionRows()).toEqual([]);
  });
});

describe("POST /api/health/raw (legacy workout fields)", () => {
  it("rejects missing and wrong tokens; a session cookie is not enough", async () => {
    expect((await shortcut(JSON.stringify(ios18), "application/json", null)).status).toBe(401);
    expect((await shortcut(JSON.stringify(ios18), "application/json", "Bearer lgt_nope")).status).toBe(401);
    const withCookie = await client.fetch("/api/health/raw", { method: "POST", json: ios18 });
    expect(withCookie.status).toBe(401);
  });

  it("stores, computes and matches the workout to the session; answers with a Persian message", async () => {
    const s = session();
    await putSession(s);
    const res = await shortcut(JSON.stringify(ios18));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; stored: number; matched: number; message: string };
    expect(body).toMatchObject({ ok: true, stored: 1, matched: 1 });
    expect(body.message).toContain("۱ تمرین دریافت شد، ۱ مورد به جلسه وصل شد");
    const [w] = await rows();
    expect(w).toMatchObject({
      activity_type: "Traditional Strength Training",
      started_at: "2026-09-28T23:05:12.000Z",
      ended_at: "2026-09-29T00:02:40.000Z",
      duration_sec: 3448,
      active_kcal: 312,
      hr_avg: 129.7,
      hr_max: 161,
      matched_session_id: s.id,
    });
    expect(w.external_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent across repeated runs and iOS/locale variants of the same workout", async () => {
    await shortcut(JSON.stringify(ios18));
    await shortcut(JSON.stringify(ios18));
    expect(await rows()).toHaveLength(1);
    // The en-US and Persian payloads describe a workout starting at 17:05:00 (not :12), so it is a distinct start.
    await shortcut(JSON.stringify(ios17));
    await shortcut(JSON.stringify(persian));
    expect(await rows()).toHaveLength(2);
  });

  it("accepts the 7-day manual sync and keeps unmatched workouts", async () => {
    const s = session({ local_date: "2026-09-22", started_at: "2026-09-22T13:20:00.000Z", ended_at: "2026-09-22T14:20:00.000Z" });
    await putSession(s);
    const r = (await (await shortcut(JSON.stringify(sevenDays))).json()) as { stored: number; matched: number };
    expect(r).toMatchObject({ stored: 3, matched: 1 });
    const all = await rows();
    expect(all.map((w) => [w.activity_type, w.matched_session_id])).toEqual([
      ["Traditional Strength Training", s.id],
      ["Walking", null],
      ["Functional Strength Training", null],
    ]);
  });

  it("accepts form bodies (Shortcuts 'Form' request body) and plain text", async () => {
    const form = new URLSearchParams({
      workouts: "Traditional Strength Training",
      workout_start: "2026-09-28T17:05:00-06:00",
      workout_end: "2026-09-28T18:00:00-06:00",
      hr: "120\n130",
      hr_time: "2026-09-28T17:10:00-06:00\n2026-09-28T17:20:00-06:00",
    });
    const r1 = (await (await shortcut(form.toString(), "application/x-www-form-urlencoded")).json()) as { stored: number };
    expect(r1.stored).toBe(1);
    expect((await rows())[0]).toMatchObject({ duration_sec: 3300, hr_avg: 125, hr_max: 130 });
    const r2 = (await (await shortcut("Walking | 9/27/26, 8:00 AM – 9/27/26, 8:30 AM | 95 kcal", "text/plain")).json()) as { stored: number };
    expect(r2.stored).toBe(1);
  });

  it("records the last received time and summary even when nothing parses", async () => {
    const res = await shortcut("{}");
    expect(await res.json()).toMatchObject({ ok: true, stored: 0, matched: 0 });
    const status = (await (await client.fetch("/api/health/status")).json()) as { last_received_at: string; last_result: { stored: number } };
    expect(Date.now() - Date.parse(status.last_received_at)).toBeLessThan(60_000);
    expect(status.last_result.stored).toBe(0);
  });
});

describe("matching after the fact and manual attach", () => {
  it("a session synced later picks up the watch workout", async () => {
    await shortcut(JSON.stringify(ios18));
    expect((await rows())[0].matched_session_id).toBeNull();
    const s = session();
    await putSession(s);
    expect((await rows())[0].matched_session_id).toBe(s.id);
  });

  it("bootstrap includes watch data for recent sessions", async () => {
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;
    const start = new Date(Date.now() - 2 * 3600_000);
    const s = session({ local_date: local, started_at: start.toISOString(), ended_at: new Date(start.getTime() + 3600_000).toISOString() });
    await putSession(s);
    await shortcut(JSON.stringify({ workouts: "Traditional Strength Training", workout_start: start.toISOString(), workout_end: new Date(start.getTime() + 3000_000).toISOString(), workout_energy: "250 kcal" }));
    const b = (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
    expect(b.watch.find((w) => w.matched_session_id === s.id)).toMatchObject({ active_kcal: 250, duration_sec: 3000 });
  });

  it("unmatched workouts can be attached manually; status lists the last 10", async () => {
    await shortcut(JSON.stringify(sevenDays));
    const s = session({ local_date: "2026-09-24", started_at: "2026-09-24T21:00:00.000Z", ended_at: "2026-09-24T22:00:00.000Z" });
    await putSession(s);
    const status = (await (await client.fetch("/api/health/status")).json()) as { workouts: HealthWorkout[] };
    expect(status.workouts).toHaveLength(3);
    expect(status.workouts[0].started_at > status.workouts[2].started_at).toBe(true);
    const walk = status.workouts.find((w) => w.activity_type === "Walking")!;
    expect(walk.matched_session_id).toBeNull();
    const res = await client.fetch(`/api/health/workouts/${walk.id}/match`, { method: "PUT", json: { session_id: s.id } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workout: HealthWorkout }).workout.matched_session_id).toBe(s.id);
    expect((await client.fetch(`/api/health/workouts/${walk.id}/match`, { method: "PUT", json: { session_id: "NOPE" } })).status).toBe(404);
    expect((await client.fetch(`/api/health/workouts/NOPE/match`, { method: "PUT", json: { session_id: s.id } })).status).toBe(404);
    // Deleting the session releases the match.
    await client.fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
    expect((await env.DB.prepare("SELECT matched_session_id FROM health_workouts WHERE id = ?").bind(walk.id).first<{ matched_session_id: string | null }>())!.matched_session_id).toBeNull();
  });
});

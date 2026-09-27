import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Bootstrap, HealthWorkout, WorkoutSession } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import ios17 from "../fixtures/shortcuts/ios17-en-us-default.json";
import ios18 from "../fixtures/shortcuts/ios18-iso8601.json";
import persian from "../fixtures/shortcuts/persian-locale.json";
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
const rows = async () => (await env.DB.prepare("SELECT * FROM health_workouts ORDER BY started_at").all<HealthWorkout & { raw: string; external_key: string }>()).results;

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

describe("POST /api/health/raw", () => {
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
    expect(body.message).toContain("۱ تمرین دریافت شد");
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

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Bootstrap, WorkoutSession } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import { Client, resetAuth, setupOwner } from "./helpers";

let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.50"));
});

function makeSession(over: Partial<WorkoutSession> = {}): WorkoutSession {
  const now = new Date().toISOString();
  const id = ulid();
  return {
    id,
    program_day_id: "D1",
    local_date: "2026-09-27",
    started_at: "2026-09-27T23:00:00.000Z",
    ended_at: null,
    status: "active",
    unit: "lb",
    note: "",
    created_at: now,
    updated_at: now,
    source: "app",
    sets: [0, 1, 2, 3].map((i) => ({
      id: ulid(),
      exercise_id: "bench",
      set_index: i,
      weight: 135,
      reps: 5,
      seconds: null,
      done: true,
      updated_at: now,
    })),
    ...over,
  };
}

const put = (s: WorkoutSession) => client.fetch(`/api/sessions/${s.id}`, { method: "PUT", json: s });
const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

describe("bootstrap", () => {
  it("returns settings, the seeded program and exercises", async () => {
    const res = await client.fetch("/api/bootstrap");
    expect(res.status).toBe(200);
    const b = (await res.json()) as Bootstrap;
    expect(b.settings).toEqual({ unit: "lb", week_start: "mon", relock_minutes: 0, timezone: "America/Denver" });
    expect(b.program.days.map((d) => d.id)).toEqual(["D1", "D2", "D3", "D4"]);
    expect(b.program.days.map((d) => d.name_fa)).toEqual(["روز ۱ – سینه", "روز ۲ – پا", "روز ۳ – پشت", "روز ۴ – ددلیفت"]);
    expect(b.program.days.map((d) => d.exercises.length)).toEqual([6, 6, 6, 7]);
    expect(b.program.days.map((d) => d.exercises.find((e) => e.is_main)?.exercise_id)).toEqual(["bench", "squat", "cs_row", "deadlift"]);
    const d3 = b.program.days[2].exercises;
    expect(d3.find((e) => e.exercise_id === "pullup")).toMatchObject({ reps_min: 6, reps_max: 8, rest_sec: 120 });
    expect(d3.find((e) => e.exercise_id === "bulgarian")).toMatchObject({ per_leg: true });
    expect(b.program.days[1].exercises.find((e) => e.exercise_id === "plank")).toMatchObject({ is_time: true, reps_max: 45, superset_tag: "A2" });
    expect(b.program.days[3].exercises.map((e) => e.superset_tag)).toEqual([null, null, null, "A1", "A2", "B1", "B2"]);
    expect(b.other_days.map((d) => d.name_fa)).toEqual(["بالاتنه A", "پایین‌تنه A", "بالاتنه B", "پایین‌تنه B"]);
    const ex = Object.fromEntries(b.exercises.map((e) => [e.id, e]));
    for (const legacy of ["row", "lunge", "dips", "rope_pushdown"]) expect(ex[legacy]).toBeTruthy();
    expect(ex.bench.cue_fa).toContain("حرکت اصلی امروز");
    expect(ex.bench).toMatchObject({ equipment: "barbell", is_lower: false, muscle_primary: "chest" });
    expect(ex.squat.is_lower).toBe(true);
  });

  it("program sets per muscle group match the weekly targets in SPEC §10", async () => {
    const b = (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
    const ex = Object.fromEntries(b.exercises.map((e) => [e.id, e]));
    const totals: Record<string, number> = {};
    for (const d of b.program.days) for (const de of d.exercises) totals[ex[de.exercise_id].muscle_primary] = (totals[ex[de.exercise_id].muscle_primary] ?? 0) + de.sets;
    expect(totals).toEqual({ chest: 13, back: 13, quads: 10, hamstrings_glutes: 9, shoulders: 9, rear_delts: 6, calves: 6, core: 6, biceps: 3, triceps: 3 });
  });
});

describe("PUT /sessions/:id", () => {
  it("is an idempotent upsert keyed by client ids", async () => {
    const s = makeSession();
    expect((await put(s)).status).toBe(200);
    expect((await put(s)).status).toBe(200);
    expect((await put(s)).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM workout_sessions WHERE id = ?", s.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM set_entries WHERE session_id = ?", s.id)).toBe(4);
  });

  it("replaces the whole document (removed sets are deleted)", async () => {
    const s = makeSession();
    await put(s);
    const later = new Date(Date.now() + 1000).toISOString();
    const next = { ...s, updated_at: later, status: "done" as const, ended_at: later, note: "خوب بود", sets: s.sets.slice(0, 2) };
    expect(await (await put(next)).json()).toMatchObject({ ok: true, applied: true });
    expect(await count("SELECT COUNT(*) AS n FROM set_entries WHERE session_id = ?", s.id)).toBe(2);
    const row = await env.DB.prepare("SELECT status, note FROM workout_sessions WHERE id = ?").bind(s.id).first();
    expect(row).toEqual({ status: "done", note: "خوب بود" });
  });

  it("last writer wins on updated_at", async () => {
    const s = makeSession({ updated_at: "2026-09-27T23:30:00.000Z", note: "new" });
    await put(s);
    const stale = { ...s, updated_at: "2026-09-27T23:10:00.000Z", note: "old", sets: [] };
    const body = (await (await put(stale)).json()) as { applied: boolean; session: WorkoutSession };
    expect(body.applied).toBe(false);
    expect(body.session.note).toBe("new");
    expect(body.session.sets).toHaveLength(4);
    expect(await count("SELECT COUNT(*) AS n FROM set_entries WHERE session_id = ?", s.id)).toBe(4);
  });

  it("stores nulls, negatives, decimals and timed sets", async () => {
    const now = new Date().toISOString();
    const s = makeSession({
      program_day_id: "D3",
      sets: [
        { id: ulid(), exercise_id: "pullup", set_index: 0, weight: -40, reps: 7, seconds: null, done: true, updated_at: now },
        { id: ulid(), exercise_id: "incline_db", set_index: 0, weight: 22.5, reps: null, seconds: null, done: false, updated_at: now },
        { id: ulid(), exercise_id: "plank", set_index: 0, weight: null, reps: null, seconds: 45, done: true, updated_at: now },
      ],
    });
    await put(s);
    const res = (await (await client.fetch("/api/sessions?from=2026-09-27&to=2026-09-27")).json()) as { sessions: WorkoutSession[] };
    const got = res.sessions.find((x) => x.id === s.id)!;
    const by = Object.fromEntries(got.sets.map((x) => [x.exercise_id, x]));
    expect(by.pullup).toMatchObject({ weight: -40, reps: 7, done: true });
    expect(by.incline_db).toMatchObject({ weight: 22.5, reps: null, done: false });
    expect(by.plank).toMatchObject({ weight: null, seconds: 45 });
  });

  it("validates input with Persian errors", async () => {
    const s = makeSession();
    const bad = await client.fetch(`/api/sessions/${s.id}`, { method: "PUT", json: { ...s, status: "paused" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message_fa: string } }).error.message_fa).toMatch(/[؀-ۿ]/);
    expect((await client.fetch(`/api/sessions/OTHER`, { method: "PUT", json: s })).status).toBe(400);
    expect((await put({ ...s, program_day_id: "D9" })).status).toBe(400);
    expect((await put({ ...s, sets: [{ ...s.sets[0], exercise_id: "nope" }] })).status).toBe(400);
    expect((await put({ ...s, local_date: "2026-13-01" })).status).toBe(400);
  });

  it("refuses set ids owned by another session", async () => {
    const a = makeSession();
    await put(a);
    const b = makeSession({ sets: [a.sets[0]] });
    expect((await put(b)).status).toBe(409);
  });

  it("requires a session", async () => {
    const s = makeSession();
    const anon = new Client("192.0.2.99");
    expect((await anon.fetch(`/api/sessions/${s.id}`, { method: "PUT", json: s })).status).toBe(401);
  });
});

describe("GET and DELETE", () => {
  it("lists by local date range and deletes", async () => {
    const a = makeSession({ local_date: "2026-08-01", started_at: "2026-08-01T23:00:00.000Z" });
    const b = makeSession({ local_date: "2026-08-03", started_at: "2026-08-03T23:00:00.000Z" });
    await put(a);
    await put(b);
    const res = (await (await client.fetch("/api/sessions?from=2026-08-01&to=2026-08-02")).json()) as { sessions: WorkoutSession[] };
    expect(res.sessions.map((s) => s.id)).toEqual([a.id]);
    expect(res.sessions[0].sets).toHaveLength(4);
    expect((await client.fetch("/api/sessions?from=bad")).status).toBe(400);
    expect((await client.fetch(`/api/sessions/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM workout_sessions WHERE id = ?", a.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM set_entries WHERE session_id = ?", a.id)).toBe(0);
    // Deleting twice is fine (outbox retries).
    expect((await client.fetch(`/api/sessions/${a.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("bootstrap includes the last 60 days of sessions", async () => {
    const recent = makeSession({ local_date: new Date().toISOString().slice(0, 10) });
    const old = makeSession({ local_date: "2025-01-01", started_at: "2025-01-01T23:00:00.000Z" });
    await put(recent);
    await put(old);
    const b = (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
    const ids = b.sessions.map((s) => s.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
  });
});

describe("settings", () => {
  it("updates and validates settings", async () => {
    const res = await client.fetch("/api/settings", { method: "PUT", json: { unit: "kg", week_start: "sat", relock_minutes: 5 } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { settings: unknown }).settings).toEqual({ unit: "kg", week_start: "sat", relock_minutes: 5, timezone: "America/Denver" });
    expect((await client.fetch("/api/settings", { method: "PUT", json: { timezone: "Mars/Base" } })).status).toBe(400);
    expect((await client.fetch("/api/settings", { method: "PUT", json: { unit: "st" } })).status).toBe(400);
    await client.fetch("/api/settings", { method: "PUT", json: { unit: "lb", week_start: "mon", relock_minutes: 0 } });
  });
});

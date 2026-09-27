import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkoutSession } from "../../worker/lib/types";
import { Client, resetAuth, setupOwner } from "./helpers";

let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.90"));
  await env.DB.batch([env.DB.prepare("DELETE FROM set_entries"), env.DB.prepare("DELETE FROM workout_sessions"), env.DB.prepare("DELETE FROM body_metrics")]);
  const mk = (id: string, date: string, weight: number): WorkoutSession => ({
    id, program_day_id: "D1", local_date: date, started_at: `${date}T23:00:00.000Z`, ended_at: `${date}T23:50:00.000Z`, status: "done", unit: "lb", note: "",
    created_at: `${date}T23:00:00.000Z`, updated_at: `${date}T23:50:00.000Z`, source: "app",
    sets: [0, 1, 2, 3].map((i) => ({ id: `${id}-${i}`, exercise_id: "bench", set_index: i, weight, reps: 5, seconds: null, done: true, rir: null, updated_at: `${date}T23:10:00.000Z` })),
  });
  await client.fetch("/api/sessions/R1", { method: "PUT", json: mk("R1", "2026-09-15", 130) });
  await client.fetch("/api/sessions/R2", { method: "PUT", json: mk("R2", "2026-09-22", 135) });
  await client.fetch("/api/body-mass/2026-09-22", { method: "PUT", json: { value: 180, unit: "lb" } });
});

describe("report endpoints", () => {
  it("weekly JSON", async () => {
    const r = (await (await client.fetch("/api/reports/week?start=2026-09-23")).json()) as { range: unknown; sessions: { done: number }; lifts: { exercise_id: string; best: { e1rm: number }; change_pct: number }[]; prs: unknown[] };
    expect(r.range).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(r.sessions.done).toBe(1);
    expect(r.lifts.find((l) => l.exercise_id === "bench")).toMatchObject({ best: { e1rm: 157.5 }, change_pct: 3.8 });
    expect(r.prs).toHaveLength(1);
  });
  it("weekly CSV", async () => {
    const res = await client.fetch("/api/reports/week?start=2026-09-23&format=csv");
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="lodge-gym-week-2026-09-21.csv"');
    const text = await res.text();
    expect(text.trim().split("\r\n")).toHaveLength(5);
  });
  it("monthly JSON and CSV, Jalali month keys", async () => {
    const m = (await (await client.fetch("/api/reports/month?month=2026-09")).json()) as { sessions: number; body: unknown[] };
    expect(m.sessions).toBe(2);
    expect(m.body).toEqual([{ date: "2026-09-22", value: 180, ma7: 180 }]);
    await client.fetch("/api/settings", { method: "PUT", json: { month_calendar: "jalali" } });
    const j = (await (await client.fetch("/api/reports/month?month=1405-06")).json()) as { range: { start: string; end: string }; sessions: number };
    expect(j.range).toMatchObject({ start: "2026-08-23", end: "2026-09-22" });
    expect(j.sessions).toBe(2);
    const csv = await client.fetch("/api/reports/month?month=1405-06&format=csv");
    expect(csv.headers.get("Content-Disposition")).toContain("lodge-gym-month-1405-06.csv");
    await client.fetch("/api/settings", { method: "PUT", json: { month_calendar: "gregorian" } });
  });
  it("progress page", async () => {
    const p = (await (await client.fetch("/api/reports/progress")).json()) as { since: { sessions: number; lifts: { exercise_id: string; change_pct: number }[] }; balance: { muscles: unknown[] } };
    expect(p.since.sessions).toBe(2);
    expect(p.since.lifts.find((l) => l.exercise_id === "bench")!.change_pct).toBe(3.8);
    expect(p.balance.muscles).toHaveLength(10);
  });
  it("validates parameters and needs a session", async () => {
    expect((await client.fetch("/api/reports/week?start=bad")).status).toBe(400);
    expect((await client.fetch("/api/reports/month?month=2026-13")).status).toBe(400);
    expect((await new Client("192.0.2.91").fetch("/api/reports/progress")).status).toBe(401);
  });
});

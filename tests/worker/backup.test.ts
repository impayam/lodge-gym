import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../worker/index";
import { BACKUP_PREFIX, runBackup } from "../../worker/backup";
import type { WorkoutSession } from "../../worker/lib/types";
import { Client, resetAuth, setupOwner } from "./helpers";

let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.95"));
  const s: WorkoutSession = {
    id: "BK1", program_day_id: "D1", local_date: "2026-09-21", started_at: "2026-09-21T23:00:00.000Z", ended_at: "2026-09-22T00:00:00.000Z", status: "done", unit: "lb", note: "یادداشت",
    created_at: "2026-09-21T23:00:00.000Z", updated_at: "2026-09-21T23:00:00.000Z", source: "app",
    sets: [{ id: "BK1-0", exercise_id: "bench", set_index: 0, weight: 135, reps: 5, seconds: null, done: true, rir: 1, updated_at: "2026-09-21T23:10:00.000Z" }],
  };
  await client.fetch("/api/sessions/BK1", { method: "PUT", json: s });
});

const listBackups = async () => (await env.PHOTOS.list({ prefix: BACKUP_PREFIX })).objects.map((o) => o.key).sort();

describe("export and weekly backup", () => {
  it("GET /api/export returns the full JSON as a download", async () => {
    const res = await client.fetch("/api/export");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="lodge-gym-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const data = (await res.json()) as { app: string; sessions: WorkoutSession[]; settings: unknown; health_workouts: unknown[]; body_metrics: unknown[]; photos: unknown[] };
    expect(data.app).toBe("lodge-gym");
    const s = data.sessions.find((x) => x.id === "BK1")!;
    expect(s.note).toBe("یادداشت");
    expect(s.sets[0]).toMatchObject({ weight: 135, reps: 5, rir: 1 });
    for (const k of ["settings", "health_workouts", "body_metrics", "photos"] as const) expect(data[k]).toBeDefined();
  });

  it("the cron handler writes a backup to R2 and keeps the newest 12", async () => {
    for (let i = 1; i <= 13; i++) await env.PHOTOS.put(`${BACKUP_PREFIX}lodge-gym-2025-01-${String(i).padStart(2, "0")}.json`, "{}");
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "17 10 * * 1", scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    const keys = await listBackups();
    expect(keys).toHaveLength(12);
    expect(keys).not.toContain(`${BACKUP_PREFIX}lodge-gym-2025-01-01.json`);
    expect(keys).not.toContain(`${BACKUP_PREFIX}lodge-gym-2025-01-02.json`);
    const newest = keys[keys.length - 1];
    expect(newest).toMatch(/^backups\/lodge-gym-20\d\d-\d\d-\d\d\.json$/);
    const obj = await env.PHOTOS.get(newest);
    const data = (await obj!.json()) as { sessions: { id: string }[] };
    expect(data.sessions.map((s) => s.id)).toContain("BK1");
    // Running twice on the same day overwrites that day's file.
    const r = await runBackup(env);
    expect(r.key).toBe(newest);
    expect(await listBackups()).toHaveLength(12);
  });

  it("lists backups and downloads the latest", async () => {
    const list = (await (await client.fetch("/api/backups")).json()) as { backups: { name: string }[] };
    expect(list.backups).toHaveLength(12);
    expect(list.backups[0].name > list.backups[11].name).toBe(true);
    const latest = await client.fetch("/api/backups/latest");
    expect(latest.headers.get("Content-Disposition")).toBe(`attachment; filename="${list.backups[0].name}"`);
    expect(((await latest.json()) as { app: string }).app).toBe("lodge-gym");
  });

  it("needs a session", async () => {
    expect((await new Client("192.0.2.96").fetch("/api/export")).status).toBe(401);
    expect((await new Client("192.0.2.96").fetch("/api/backups/latest")).status).toBe(401);
  });
});

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Goals } from "../../worker/lib/goals";
import type { BodyMeasurement } from "../../worker/lib/measurements";
import type { Profile } from "../../worker/lib/profile";
import type { Bootstrap } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import { Client, resetAuth, setupOwner } from "./helpers";

// SPEC-v12 M15 §2.1 and §4 (approved 2026-10-17): the goal as three settings keys through PUT /api/settings, body sizes
// in body_measurements (migration 0014) through PUT / DELETE /api/body/measurements/:id, both in the bootstrap, and
// GET /api/profile.
let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.90"));
});
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM body_measurements"), env.DB.prepare("DELETE FROM settings WHERE key LIKE 'goal_%'")]);
});

const put = (path: string, json: unknown) => client.fetch(path, { method: "PUT", json });
const boot = async () => (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;

function size(over: Partial<BodyMeasurement> = {}): Omit<BodyMeasurement, "deleted_at"> {
  const now = new Date().toISOString();
  return { id: ulid(), local_date: "2026-10-10", arm_cm: 38, chest_cm: null, waist_cm: 84, hips_cm: null, thigh_cm: null, calf_cm: null, neck_cm: null, shoulders_cm: null, note: "", created_at: now, updated_at: now, ...over };
}

describe("goals", () => {
  it("are saved as three settings keys; the bootstrap carries them; saving changes no program", async () => {
    expect((await boot()).goals).toBeNull();
    const programs = await env.DB.prepare("SELECT COUNT(*) AS n FROM programs").first<{ n: number }>();
    const res = await put("/api/settings", { goal_training: ["growth", "strength"], goal_body: "gain" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { goals: Goals };
    expect(body.goals).toMatchObject({ training: ["growth", "strength"], body: "gain" });
    expect(body.goals.set_at).toMatch(/T/);
    const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'goal_%' ORDER BY key").all<{ key: string; value: string }>();
    expect(rows.results.map((r) => r.key)).toEqual(["goal_body", "goal_set_at", "goal_training"]);
    expect(JSON.parse(rows.results[2].value)).toEqual(["growth", "strength"]);
    expect((await boot()).goals).toEqual(body.goals);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM programs").first<{ n: number }>()).toEqual(programs);
  });

  it("keep the phone's save time from the outbox", async () => {
    await put("/api/settings", { goal_training: ["endurance"], goal_body: "cut", goal_set_at: "2026-10-01T10:00:00.000Z" });
    expect((await boot()).goals).toEqual({ training: ["endurance"], body: "cut", set_at: "2026-10-01T10:00:00.000Z" });
  });

  it("refuse three goals, a duplicate, an unknown goal, or a training goal without a body goal", async () => {
    for (const bad of [
      { goal_training: ["growth", "strength", "power"], goal_body: "gain" },
      { goal_training: ["growth", "growth"], goal_body: "gain" },
      { goal_training: ["speed"], goal_body: "gain" },
      { goal_training: [], goal_body: "gain" },
      { goal_training: ["growth"], goal_body: "bulk" },
      { goal_training: ["growth"] },
    ])
      expect((await put("/api/settings", bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await boot()).goals).toBeNull();
  });
});

describe("body sizes", () => {
  it("upsert by client id, any subset of fields; the bootstrap lists them oldest first", async () => {
    const a = size({ local_date: "2026-10-01", waist_cm: null });
    const b = size({ local_date: "2026-10-12", arm_cm: 38.5 });
    expect((await put(`/api/body/measurements/${b.id}`, b)).status).toBe(200);
    expect((await put(`/api/body/measurements/${a.id}`, a)).status).toBe(200);
    // The same entry again (an outbox retry) changes nothing.
    expect((await put(`/api/body/measurements/${a.id}`, a)).status).toBe(200);
    const list = (await boot()).measurements!;
    expect(list.map((m) => [m.local_date, m.arm_cm, m.waist_cm])).toEqual([
      ["2026-10-01", 38, null],
      ["2026-10-12", 38.5, 84],
    ]);
    const got = (await (await client.fetch("/api/body/measurements")).json()) as { measurements: BodyMeasurement[] };
    expect(got.measurements).toHaveLength(2);
  });

  it("an older copy never replaces a newer one", async () => {
    const m = size();
    await put(`/api/body/measurements/${m.id}`, { ...m, arm_cm: 39, updated_at: "2026-10-12T10:00:00.000Z" });
    await put(`/api/body/measurements/${m.id}`, { ...m, arm_cm: 37, updated_at: "2026-10-11T10:00:00.000Z" });
    expect((await boot()).measurements!.map((x) => x.arm_cm)).toEqual([39]);
  });

  it("delete softly; a deleted entry stays deleted when an old edit arrives; deleting twice is fine", async () => {
    const m = size();
    await put(`/api/body/measurements/${m.id}`, m);
    expect((await client.fetch(`/api/body/measurements/${m.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await client.fetch(`/api/body/measurements/${m.id}`, { method: "DELETE" })).status).toBe(200);
    await put(`/api/body/measurements/${m.id}`, { ...m, arm_cm: 40, updated_at: new Date(Date.now() + 60_000).toISOString() });
    expect((await boot()).measurements).toEqual([]);
    expect(await env.DB.prepare("SELECT deleted_at IS NOT NULL AS gone, arm_cm FROM body_measurements WHERE id = ?").bind(m.id).first()).toEqual({ gone: 1, arm_cm: 38 });
  });

  it("refuse an empty entry, a size out of 10–300 cm, a bad date or a mismatched id", async () => {
    const m = size();
    const nulls = { arm_cm: null, chest_cm: null, waist_cm: null, hips_cm: null, thigh_cm: null, calf_cm: null, neck_cm: null, shoulders_cm: null };
    expect((await put(`/api/body/measurements/${m.id}`, { ...m, ...nulls })).status).toBe(400);
    expect((await put(`/api/body/measurements/${m.id}`, { ...m, arm_cm: 4 })).status).toBe(400);
    expect((await put(`/api/body/measurements/${m.id}`, { ...m, chest_cm: 400 })).status).toBe(400);
    expect((await put(`/api/body/measurements/${m.id}`, { ...m, local_date: "2026-13-01" })).status).toBe(400);
    expect((await put(`/api/body/measurements/${ulid()}`, m)).status).toBe(400);
    expect((await put(`/api/body/measurements/${m.id}`, { ...m, extra: 1 })).status).toBe(400);
    expect((await boot()).measurements).toEqual([]);
  });

  it("the table refuses a size of 0 or less (CHECK)", async () => {
    await expect(env.DB.prepare("INSERT INTO body_measurements (id, local_date, arm_cm, created_at, updated_at) VALUES ('x', '2026-10-01', 0, 'a', 'a')").run()).rejects.toThrow();
  });
});

describe("GET /api/profile", () => {
  it("before anything: the first-session line, the empty corners, Power 0 with no data, no body line", async () => {
    const p = (await (await client.fetch("/api/profile")).json()) as Profile;
    expect(p.goals).toBeNull();
    expect(p.body).toBeNull();
    expect(p.diamond.corners.power).toEqual({ value: 0, label: "0", has_data: false });
    expect(Object.keys(p.diamond.corners)).toEqual(["strength", "growth", "endurance", "power"]);
    expect(p.diamond.growth.regions_total).toBe(30);
  });

  it("with a goal: its label and the body line with the pace", async () => {
    await put("/api/settings", { goal_training: ["strength", "growth"], goal_body: "maintain" });
    const p = (await (await client.fetch("/api/profile")).json()) as Profile;
    expect(p.goal_label).toBe("Strength + Growth · Maintain");
    expect(p.body).toMatchObject({ badge: "HOLD", goal: "Maintain" });
  });
});

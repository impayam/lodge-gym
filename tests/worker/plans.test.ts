import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { addItem, groupItems, liveItems, moveItem, planFromDay, removeItem, replaceItem, seqIds, type SessionPlan } from "../../worker/lib/plan";
import type { Bootstrap, ProgramVersion, WorkoutSession } from "../../worker/lib/types";
import { localDate } from "../../worker/lib/time";
import { ulid } from "../../worker/lib/ulid";
import { Client, resetAuth, setupOwner } from "./helpers";

// SPEC-v3 M9c: the planner API (data option A, migration 0008). Planned sessions live in planned_sessions; a started
// plan's workout session has the same id; nothing is deleted.
let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.90"));
});

const create = async (id: string, program_day_id: string, extra: object = {}) => {
  const res = await client.post("/api/sessions/plan", { id, program_day_id, ...extra });
  return { res, plan: res.ok ? ((await res.json()) as { plan: SessionPlan }).plan : null };
};
const putItems = (p: SessionPlan, status = p.status) =>
  client.fetch(`/api/sessions/${p.id}/plan-items`, { method: "PUT", json: { status, updated_at: p.updated_at, items: p.items } });
const bootstrap = async () => (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
const tick = (p: SessionPlan) => new Date(Date.parse(p.updated_at) + 1000).toISOString();
/** A new plan for the day: an open plan left by an earlier test is discarded first. */
async function freshPlan(day: string): Promise<SessionPlan> {
  const id = ulid();
  const { plan } = await create(id, day);
  if (plan!.id === id) return plan!;
  expect((await putItems({ ...plan!, updated_at: tick(plan!) }, "discarded")).status).toBe(200);
  return (await create(id, day)).plan!;
}

describe("POST /api/sessions/plan", () => {
  it("creates a planned session from the program day, with item ids <plan id>-1…", async () => {
    const id = ulid();
    const { res, plan } = await create(id, "D1");
    expect(res.status).toBe(200);
    expect(plan).toMatchObject({ id, program_day_id: "D1", status: "planned", started_at: null });
    expect(liveItems(plan!).map((it) => it.exercise_id)).toEqual(["bench", "incline_db", "rdl", "cable_row", "lateral", "facepull"]);
    expect(liveItems(plan!).map((it) => it.id)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `${id}-${n}`));
    expect(liveItems(plan!).map((it) => it.group_tag)).toEqual([null, null, null, null, "A", "A"]);
    // The workout_sessions table is untouched until the plan starts.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM workout_sessions WHERE id = ?").bind(id).first<{ n: number }>())!.n).toBe(0);
  });

  it("keeps one open plan per program day: a second create returns the first plan", async () => {
    const first = (await create(ulid(), "D2")).plan!;
    const again = await create(ulid(), "D2");
    expect(again.plan!.id).toBe(first.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM planned_sessions WHERE program_day_id = 'D2' AND status = 'planned'").first<{ n: number }>())!.n).toBe(1);
  });

  it("rejects unknown days", async () => {
    expect((await create(ulid(), "nope")).res.status).toBe(400);
  });
});

describe("PUT /api/sessions/:id/plan-items", () => {
  it("stores replace, delete and reorder; removed items stay with removed_at", async () => {
    let p = await freshPlan("D3");
    const now = tick(p);
    p = replaceItem(p, liveItems(p)[1].id, "dips", now);
    p = removeItem(p, liveItems(p)[2].id, now);
    p = moveItem(p, liveItems(p)[0].id, 1, now);
    const res = await putItems(p);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: true });
    const stored = (await bootstrap()).plans.find((x) => x.id === p.id)!;
    expect(liveItems(stored).map((it) => it.exercise_id)).toEqual(liveItems(p).map((it) => it.exercise_id));
    expect(liveItems(stored)[0]).toMatchObject({ exercise_id: "dips", origin: "replaced", replaced_exercise_id: "pullup" });
    expect(stored.items.filter((it) => it.removed_at)).toHaveLength(1);
    expect(stored.items).toHaveLength(6);
  });

  it("is idempotent and last-writer-wins: an older list does not overwrite a newer one", async () => {
    let p = await freshPlan("D4");
    const newer = addItem(p, "dips", tick(p), ulid());
    expect((await putItems(newer)).status).toBe(200);
    expect((await putItems(newer)).status).toBe(200);
    const stale = await putItems(p);
    expect(await stale.json()).toMatchObject({ applied: false });
    p = (await bootstrap()).plans.find((x) => x.id === p.id)!;
    expect(liveItems(p).at(-1)!.exercise_id).toBe("dips");
  });

  it("a plan edited offline before it reached the server keeps the edits (older than the server's fresh copy)", async () => {
    const day = (await bootstrap()).program.days.find((d) => d.id === "D3")!;
    const id = ulid();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const offline = removeItem(planFromDay(day, id, past, seqIds(id)), `${id}-3`, past);
    // An open D3 plan from an earlier test would be returned instead: discard it first.
    const open = (await bootstrap()).plans.find((x) => x.program_day_id === "D3" && x.status === "planned");
    if (open) await putItems({ ...open, updated_at: tick(open) }, "discarded");
    expect((await create(id, "D3")).plan!.id).toBe(id);
    const res = await putItems(offline);
    expect(await res.json()).toMatchObject({ applied: true });
    const stored = (await bootstrap()).plans.find((x) => x.id === id)!;
    expect(liveItems(stored).map((it) => it.exercise_id)).toEqual(liveItems(offline).map((it) => it.exercise_id));
    // From then on the last writer wins: the same old list again is refused.
    const again = await putItems({ ...offline, updated_at: new Date(Date.now() - 7_200_000).toISOString() });
    expect(await again.json()).toMatchObject({ applied: false });
  });

  it("refuses broken lists: gaps, groups of one or four, unknown exercises", async () => {
    const p = (await create(ulid(), "D1")).plan!;
    const t = tick(p);
    const gap = { ...p, updated_at: t, items: p.items.map((it, i) => (i === 0 ? { ...it, position: 9 } : it)) };
    expect((await putItems(gap)).status).toBe(400);
    const single = { ...p, updated_at: t, items: p.items.map((it, i) => (i === 4 ? { ...it, group_tag: null } : it)) };
    expect((await putItems(single)).status).toBe(400);
    const four = { ...p, updated_at: t, items: p.items.map((it, i) => (i >= 2 ? { ...it, group_tag: "A" } : it)) };
    expect((await putItems(four)).status).toBe(400);
    const unknown = { ...p, updated_at: t, items: p.items.map((it, i) => (i === 0 ? { ...it, exercise_id: "no_such" } : it)) };
    expect((await putItems(unknown)).status).toBe(400);
  });

  it("any 2–3 exercises can be grouped, three chest exercises included", async () => {
    let p = await freshPlan("D1");
    const t = tick(p);
    p = addItem(p, "fly", t, ulid());
    const chest = liveItems(p).filter((it) => ["bench", "incline_db", "fly"].includes(it.exercise_id)).map((it) => it.id);
    p = groupItems(p, chest, t);
    const res = await putItems(p);
    expect(res.status).toBe(200);
    const stored = (await bootstrap()).plans.find((x) => x.id === p.id)!;
    expect(liveItems(stored).slice(0, 3).map((it) => [it.exercise_id, it.group_tag])).toEqual([
      ["bench", "A"],
      ["incline_db", "A"],
      ["fly", "A"],
    ]);
  });

  it("discard closes the plan for good; the day can be planned again", async () => {
    const p = await freshPlan("D4");
    expect((await putItems({ ...p, updated_at: tick(p) }, "discarded")).status).toBe(200);
    expect((await bootstrap()).plans.some((x) => x.id === p.id)).toBe(false);
    expect((await env.DB.prepare("SELECT status FROM planned_sessions WHERE id = ?").bind(p.id).first<{ status: string }>())!.status).toBe("discarded");
    const next = (await create(ulid(), "D4")).plan!;
    expect(next.id).not.toBe(p.id);
    expect((await putItems({ ...p, updated_at: tick(p) }, "planned")).status).toBe(409);
  });
});

describe("start", () => {
  it("marks the plan started; the session with the same id carries the plan's exercises; reports count it only then", async () => {
    let p = await freshPlan("D2");
    p = replaceItem(p, liveItems(p)[0].id, "leg_press", tick(p));
    expect((await putItems(p)).status).toBe(200);
    const today = localDate("America/Denver");
    const week = async () => ((await (await client.fetch(`/api/reports/week?start=${today}`)).json()) as { sessions: { done: number } }).sessions;
    const before = await week();
    const started = new Date().toISOString();
    const res = await client.post(`/api/sessions/${p.id}/start`, { started_at: started });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plan: SessionPlan }).plan).toMatchObject({ status: "started", started_at: started });
    // Starting twice changes nothing.
    expect((await client.post(`/api/sessions/${p.id}/start`, { started_at: new Date(Date.parse(started) + 3_600_000).toISOString() })).status).toBe(200);
    const s: WorkoutSession = {
      id: p.id,
      program_day_id: "D2",
      local_date: today,
      started_at: started,
      ended_at: null,
      status: "done",
      unit: "lb",
      note: "",
      created_at: started,
      updated_at: started,
      source: "app",
      sets: liveItems(p).flatMap((it) =>
        Array.from({ length: it.sets }, (_, i) => ({ id: ulid(), exercise_id: it.exercise_id, set_index: i, weight: 50, reps: 10, seconds: null, done: true, updated_at: started }))
      ),
    };
    expect((await client.fetch(`/api/sessions/${s.id}`, { method: "PUT", json: s })).status).toBe(200);
    const b = await bootstrap();
    expect(b.plans.find((x) => x.id === p.id)).toMatchObject({ status: "started", started_at: started });
    expect(b.sessions.find((x) => x.id === p.id)!.sets[0]).toBeTruthy();
    expect((await week()).done).toBe(before.done + 1);
  });
});

describe("start, then edits in the session", () => {
  it("the phone's start stamp stands: its edits made right after starting are applied, not taken as stale", async () => {
    let p = await freshPlan("D3");
    const started = new Date(Date.now() - 60_000).toISOString();
    expect((await client.post(`/api/sessions/${p.id}/start`, { started_at: started })).status).toBe(200);
    p = { ...p, status: "started", started_at: started, updated_at: started };
    expect(await (await putItems(p)).json()).toMatchObject({ applied: true });
    const moved = moveItem(p, liveItems(p)[0].id, 1, new Date(Date.parse(started) + 5_000).toISOString());
    expect(await (await putItems(moved)).json()).toMatchObject({ applied: true });
    // No workout session yet, so the bootstrap leaves this started plan out; the export has every plan.
    const stored = ((await (await client.fetch("/api/export")).json()) as { plans: SessionPlan[] }).plans.find((x) => x.id === p.id)!;
    expect(stored).toMatchObject({ status: "started", started_at: started });
    expect(liveItems(stored).map((it) => it.exercise_id)).toEqual(liveItems(moved).map((it) => it.exercise_id));
  });
});

describe("apply to program", () => {
  it("makes a new version with the plan's day (groups as superset tags); the old program is archived, not deleted", async () => {
    let p = await freshPlan("D1");
    const t = tick(p);
    p = replaceItem(p, liveItems(p)[1].id, "incline_bb", t);
    p = groupItems(p, [liveItems(p)[2].id, liveItems(p)[3].id], t);
    expect((await putItems(p)).status).toBe(200);
    const before = await bootstrap();
    const res = await client.post(`/api/sessions/${p.id}/apply-to-program`, {});
    expect(res.status).toBe(200);
    const { program_id } = (await res.json()) as { program_id: string };
    const after = await bootstrap();
    expect(after.program.id).toBe(program_id);
    const info = after.programs.find((x) => x.id === program_id)!;
    expect(info).toMatchObject({ status: "active", generated_by: "session", style: "seed_full_body" });
    expect(after.programs.find((x) => x.id === before.program.id)).toMatchObject({ status: "archived" });
    const d1 = after.program.days[0].exercises;
    expect(d1.map((x) => x.exercise_id)).toEqual(liveItems(p).map((it) => it.exercise_id));
    expect(d1.map((x) => x.superset_tag)).toEqual([null, null, "A1", "A2", "B1", "B2"]);
    expect(d1[0]).toMatchObject({ exercise_id: "bench", is_main: true, sets: 4, reps_max: 5 });
    // The other days are copies; the old days stay for history.
    expect(after.program.days.slice(1).map((d) => d.exercises.map((x) => x.exercise_id))).toEqual(before.program.days.slice(1).map((d) => d.exercises.map((x) => x.exercise_id)));
    expect(after.other_days.map((d) => d.id)).toEqual(expect.arrayContaining(["D1", "D2", "D3", "D4"]));
    // The open plan moved to the new version's day and now matches it.
    const moved = after.plans.find((x) => x.id === p.id)!;
    expect(moved).toMatchObject({ status: "planned", program_day_id: after.program.days[0].id });
    expect(liveItems(moved).every((it) => it.origin === "program" && it.replaced_exercise_id === null)).toBe(true);
    expect(moved.items.filter((it) => it.removed_at)).toHaveLength(p.items.filter((it) => it.removed_at).length);
    const versions = (await (await client.fetch("/api/programs")).json()) as { programs: ProgramVersion[] };
    expect(versions.programs.find((x) => x.id === before.program.id)!.days[0].exercises.map((x) => x.exercise_id)).toEqual(before.program.days[0].exercises.map((x) => x.exercise_id));
  });
});

describe("backup", () => {
  it("exports the plans with their items, removed and discarded ones included", async () => {
    const res = await client.fetch("/api/export");
    const data = (await res.json()) as { plans: SessionPlan[] };
    expect(data.plans.length).toBeGreaterThan(0);
    expect(data.plans.some((p) => p.status === "discarded")).toBe(true);
    expect(data.plans.some((p) => p.items.some((it) => it.removed_at))).toBe(true);
  });
});

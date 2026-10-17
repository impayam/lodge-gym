import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import program from "../../seed/program.json";
import equipmentReview from "../../seed/library/fedb-equipment.json";
import manual from "../../seed/library/manual.json";
import patterns from "../../seed/library/fedb-patterns.json";
import seedMatches from "../../seed/library/seed-matches.json";
import sample from "../fixtures/library/fedb-sample.json";
import { buildLibrary, librarySql, type EquipmentReview, type FedbExercise, type ManualExercise, type PatternFile, type SeedMatch } from "../../worker/lib/library";
import type { CheckResult, GeneratorInput, Proposal } from "../../worker/lib/generator";
import type { Bootstrap, ProgramInfo, ProgramVersion, WorkoutSession } from "../../worker/lib/types";
import { addDays, localDate } from "../../worker/lib/time";
import { weekRange } from "../../worker/lib/cycle";
import { ulid } from "../../worker/lib/ulid";
import { Client, resetAuth, setupOwner } from "./helpers";

const seedPrimary = Object.fromEntries(program.exercises.map((e) => [e.id, e.muscle_primary]));
const lib = buildLibrary(sample as FedbExercise[], patterns as PatternFile, seedMatches as SeedMatch[], manual as ManualExercise[], seedPrimary, equipmentReview as EquipmentReview);

let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.80"));
  await env.DB.batch(librarySql(lib.rows, lib.seedUpdates).map((s) => env.DB.prepare(s)));
});

const inputs = (over: Partial<GeneratorInput> = {}): GeneratorInput => ({
  days_per_week: 3,
  style: "full_body",
  priority_muscles: ["chest"],
  avoid: [],
  equipment: "full_gym",
  seed: 7,
  ...over,
});
const generate = async (over: Partial<GeneratorInput> = {}) => {
  const res = await client.post("/api/programs/generate", inputs(over));
  expect(res.status).toBe(200);
  return ((await res.json()) as { proposal: Proposal }).proposal;
};
const draftOf = (id: string, p: Proposal) => ({
  id,
  params: p.params,
  days: p.days.map((d) => ({ exercises: d.exercises.map((x) => ({ exercise_id: x.exercise_id, slot: x.slot, sets: x.sets, per_leg: x.per_leg, is_time: x.is_time, superset_tag: x.superset_tag })) })),
});
const bootstrap = async () => (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
const programs = async () => ((await (await client.fetch("/api/programs")).json()) as { programs: ProgramVersion[] }).programs;
const session = (day: string, date: string, weight: number): WorkoutSession => ({
  id: ulid(),
  program_day_id: day,
  local_date: date,
  started_at: `${date}T15:00:00.000Z`,
  ended_at: `${date}T16:00:00.000Z`,
  status: "done",
  unit: "lb",
  note: "",
  created_at: `${date}T15:00:00.000Z`,
  updated_at: `${date}T16:00:00.000Z`,
  source: "app",
  sets: [0, 1, 2, 3].map((i) => ({ id: ulid(), exercise_id: "bench", set_index: i, weight, reps: 5, seconds: null, done: true, rir: 2, updated_at: `${date}T16:00:00.000Z` })),
});

describe("programs after migration 0006 and the seed", () => {
  it("the seed program is active with one activation; upper/lower is archived", async () => {
    const boot = await bootstrap();
    expect(boot.program.id).toBe("fullbody4");
    const byId = new Map(boot.programs.map((p) => [p.id, p]));
    expect(byId.get("fullbody4")).toMatchObject({ status: "active", style: "seed_full_body", days_per_week: 4, generated_by: "seed", activations: [{ id: "act-fullbody4-seed", ended_at: null }] });
    expect(byId.get("upperlower")).toMatchObject({ status: "archived", style: "seed_upper_lower", activations: [] });
  });
  it("the seed program started on Sep 27 in Payam's time zone, not the evening before (migration 0007)", async () => {
    const seed = (await bootstrap()).programs.find((p) => p.id === "fullbody4")!.activations[0];
    expect(seed.started_at).toBe("2026-09-27T06:00:00.000Z");
    expect(localDate("America/Denver", seed.started_at)).toBe("2026-09-27");
    // Re-running 0007 changes nothing; a start the app has already moved is never touched.
    const sql = "UPDATE program_activations SET started_at = '2026-09-27T06:00:00.000Z' WHERE id = 'act-fullbody4-seed' AND started_at = '2026-09-27T00:00:00.000Z'";
    expect((await env.DB.prepare(sql).run()).meta.changes).toBe(0);
  });
});

describe("generate, save a draft, approve, re-activate (SPEC-v2 §8.6)", () => {
  it("generate validates its inputs and stores nothing", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM programs").first<{ n: number }>();
    const p = await generate();
    expect(p.name).toBe("Full body · 3 days");
    expect(p.days).toHaveLength(3);
    expect(p.check.violations).toEqual([]);
    expect(p.days[0].exercises[0]).toMatchObject({ slot: "main", target_rir_min: 1, target_rir_max: 3 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM programs").first<{ n: number }>())?.n).toBe(before?.n);
    expect((await client.post("/api/programs/generate", inputs({ style: "ppl", days_per_week: 4 }))).status).toBe(400);
    expect((await client.post("/api/programs/generate", { ...inputs(), equipment: "bodyweight" })).status).toBe(400);
    expect((await client.post("/api/programs/generate", inputs({ style: "strength", equipment: "dumbbells" }))).status).toBe(400);
  });

  it("a draft breaking a hard rule saves but cannot be approved", async () => {
    const p = await generate();
    const id = ulid();
    const broken = draftOf(id, p);
    // Without any hinge the week breaks the "at least one hinge" rule.
    for (const d of broken.days) d.exercises = d.exercises.filter((x) => !["deadlift", "rdl"].includes(x.exercise_id));
    const res = await client.post("/api/programs", broken);
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { program: ProgramVersion; check: CheckResult };
    expect(saved.program.status).toBe("draft");
    expect(saved.check.violations.map((v) => v.code)).toContain("no_hinge");
    const approve = await client.post(`/api/programs/${id}/approve`);
    expect(approve.status).toBe(422);
    expect(((await approve.json()) as { error: { code: string } }).error.code).toBe("rules_broken");
    expect((await bootstrap()).program.id).toBe("fullbody4");
  });

  it("re-saving a draft with fewer days removes the extra day", async () => {
    const id = ulid();
    const four = await generate({ days_per_week: 4, style: "full_body" });
    expect((await client.post("/api/programs", draftOf(id, four))).status).toBe(200);
    const three = await generate({ days_per_week: 3, style: "full_body" });
    const res = await client.post("/api/programs", draftOf(id, three));
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as { program: ProgramVersion }).program;
    expect(saved.days.map((d) => d.id)).toEqual([`${id}-d1`, `${id}-d2`, `${id}-d3`]);
    expect(saved.days.map((d) => d.name_en)).toEqual(three.days.map((d) => d.name_en));
    expect(saved).toMatchObject({ status: "draft", days_per_week: 3, name: "Full body · 3 days" });
  });

  it("rejects unknown exercises and a day count the style does not have", async () => {
    const p = await generate();
    const bad = draftOf(ulid(), p);
    bad.days[0].exercises[0].exercise_id = "no-such-exercise";
    expect((await client.post("/api/programs", bad)).status).toBe(400);
    const short = draftOf(ulid(), p);
    short.days.pop();
    expect((await client.post("/api/programs", short)).status).toBe(400);
  });

  it("approve: the draft becomes active, the old program is archived, history and progression stay", async () => {
    // A past session under the seed program, scored against it later.
    const today = localDate((await bootstrap()).settings.timezone);
    const pastWeek = weekRange(addDays(today, -14), (await bootstrap()).settings.week_start);
    const old = session("D1", pastWeek.start, 135);
    expect((await client.fetch(`/api/sessions/${old.id}`, { method: "PUT", json: old })).status).toBe(200);

    const p = await generate();
    const id = ulid();
    const draft = draftOf(id, p);
    // Edit: swap a secondary for another library exercise of the same pattern and primary muscle, and change sets.
    const used = new Set(draft.days.flatMap((d) => d.exercises.map((x) => x.exercise_id)));
    const sec = draft.days[0].exercises.find((x) => x.slot === "secondary")!;
    const swap = (
      await env.DB.prepare(
        `SELECT b.id FROM exercises a JOIN exercises b ON b.pattern = a.pattern AND b.muscle_primary = a.muscle_primary AND b.id <> a.id
         WHERE a.id = ? AND b.archived_at IS NULL AND b.category IN ('strength', 'powerlifting') ORDER BY b.id`
      ).bind(sec.exercise_id).all<{ id: string }>()
    ).results.find((r) => !used.has(r.id))!;
    expect(swap).toBeDefined();
    sec.exercise_id = swap.id;
    const iso = draft.days.flatMap((d) => d.exercises).find((x) => x.slot === "isolation" && x.sets === 3);
    if (iso) iso.sets = 2;
    const saved = await client.post("/api/programs", draft);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { check: CheckResult }).check.violations).toEqual([]);
    // Saving again replaces the draft.
    expect((await client.post("/api/programs", draft)).status).toBe(200);
    expect((await programs()).filter((x) => x.id === id)).toHaveLength(1);

    const res = await client.post(`/api/programs/${id}/approve`);
    expect(res.status).toBe(200);
    const boot = await bootstrap();
    expect(boot.program.id).toBe(id);
    expect(boot.program.days.map((d) => d.id)).toEqual([`${id}-d1`, `${id}-d2`, `${id}-d3`]);
    // Bench stays a main lift with the same exercise id, so its progression continues from 135 lb.
    expect(boot.program.days[1].exercises[0]).toMatchObject({ exercise_id: "bench", is_main: true, slot: "main", target_rir_min: 1, target_rir_max: 3 });
    const byId = new Map(boot.programs.map((x) => [x.id, x]));
    expect(byId.get(id)).toMatchObject({ status: "active", generated_by: "generator", style: "full_body", days_per_week: 3 });
    expect(byId.get(id)!.approved_at).not.toBeNull();
    expect(byId.get(id)!.activations).toHaveLength(1);
    expect(byId.get("fullbody4")!.status).toBe("archived");
    expect(byId.get("fullbody4")!.activations[0].ended_at).not.toBeNull();
    // Old sessions keep their day name through the archived program's days.
    expect(boot.other_days.find((d) => d.id === "D1")).toMatchObject({ program_id: "fullbody4", name_en: "Day 1 · Chest" });
    expect(boot.sessions.find((s) => s.id === old.id)?.sets.map((x) => x.weight)).toEqual([135, 135, 135, 135]);

    // An approved program never changes and cannot be approved twice.
    expect((await client.post("/api/programs", draft)).status).toBe(409);
    expect((await client.post(`/api/programs/${id}/approve`)).status).toBe(409);

    // Reports: the past week is scored against the seed program (4 sessions), this week against the new one (3).
    const past = (await (await client.fetch(`/api/reports/week?start=${pastWeek.start}`)).json()) as { sessions: { target: number; program: { id: string } } };
    expect(past.sessions).toMatchObject({ target: 4, program: { id: "fullbody4" } });
    const now = (await (await client.fetch(`/api/reports/week?start=${today}`)).json()) as { sessions: { target: number; program: { id: string } }; muscles: { muscle: string; target: number | null }[] };
    expect(now.sessions).toMatchObject({ target: 3, program: { id } });

    // The export carries every program, so a backup keeps the days its sessions refer to.
    const exported = (await (await client.fetch("/api/export")).json()) as { programs: ProgramVersion[] };
    expect(exported.programs.map((x) => x.id)).toEqual(expect.arrayContaining([id, "fullbody4", "upperlower"]));
  });

  it("running the seed again leaves the approved generated program active (insert-only seed)", async () => {
    const before = await bootstrap();
    const lines = env.TEST_SEED_SQL.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
    const res = await env.DB.batch(lines.map((l) => env.DB.prepare(l)));
    expect(res.reduce((n, r) => n + r.meta.changes, 0)).toBe(0);
    const after = await bootstrap();
    expect(after.program.id).toBe(before.program.id);
    expect(after.program.id).not.toBe("fullbody4");
    expect(after.programs).toEqual(before.programs);
  });

  it("re-activates an archived program with a fresh activation; drafts and active programs cannot be", async () => {
    const current = (await bootstrap()).program.id;
    const res = await client.post("/api/programs/fullbody4/activate");
    expect(res.status).toBe(200);
    const list = ((await res.json()) as { programs: ProgramInfo[] }).programs;
    const byId = new Map(list.map((x) => [x.id, x]));
    expect(byId.get("fullbody4")!.status).toBe("active");
    expect(byId.get("fullbody4")!.activations).toHaveLength(2);
    expect(byId.get("fullbody4")!.activations[1].ended_at).toBeNull();
    expect(byId.get(current)!.status).toBe("archived");
    expect(byId.get(current)!.activations[0].ended_at).not.toBeNull();
    expect((await bootstrap()).program.id).toBe("fullbody4");
    expect((await client.post("/api/programs/fullbody4/activate")).status).toBe(409);
    const draft = list.find((x) => x.status === "draft")!;
    expect((await client.post(`/api/programs/${draft.id}/activate`)).status).toBe(409);
    expect((await client.post("/api/programs/nope/activate")).status).toBe(404);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM program_activations WHERE ended_at IS NULL").first<{ n: number }>();
    expect(open?.n).toBe(1);
    const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM programs WHERE active = 1").first<{ n: number }>();
    expect(active?.n).toBe(1);
  });

  it("needs a session", async () => {
    expect((await new Client("192.0.2.81").post("/api/programs/generate", inputs())).status).toBe(401);
  });
});

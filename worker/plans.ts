// Session planner API (SPEC-v3 M9c, data option A: tables planned_sessions and session_plan_items, migration 0008).
//   POST /api/sessions/plan                    create or get the open plan of a program day (or a started plan by id)
//   PUT  /api/sessions/:id/plan-items          the full ordered item list (idempotent); also discards a planned plan
//   POST /api/sessions/:id/start               the plan was started: its workout session has the same id
//   POST /api/sessions/:id/apply-to-program    a new program version with this day changed (M8 versioning)
// Nothing is ever deleted: removed items keep removed_at, discarded plans keep status 'discarded'.

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, Env } from "./env";
import { fail, nowISO, readJson } from "./http";
import { readProgram, readProgramInfos, readProgramVersions } from "./data";
import { groupLabels, liveItems, planBlocks, planFromDay, seqIds, type PlanItem, type SessionPlan } from "./lib/plan";
import type { ProgramDay } from "./lib/types";
import { ID_RE, ulid } from "./lib/ulid";

const id = z.string().regex(ID_RE);
const iso = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)) && /T/.test(s), "iso");
const reps = z.number().int().min(0).max(999).nullable();
const rest = z.number().int().min(0).max(600).nullable();

const itemSchema = z.object({
  id,
  exercise_id: id,
  position: z.number().int().min(0).max(99),
  sets: z.number().int().min(1).max(10),
  reps_min: reps,
  reps_max: reps,
  per_leg: z.boolean(),
  is_time: z.boolean(),
  rest_sec: rest,
  target_rir_min: z.number().int().min(0).max(5).nullable(),
  target_rir_max: z.number().int().min(0).max(5).nullable(),
  origin: z.enum(["program", "added", "replaced", "ai"]),
  replaced_exercise_id: id.nullable(),
  group_tag: z.string().regex(/^[A-Z]$/).nullable(),
  group_rest_sec: rest,
  removed_at: iso.nullable(),
  created_at: iso,
  updated_at: iso,
});

const createSchema = z.object({
  id,
  program_day_id: id,
  /** A plan made for a session already running (reordered or grouped during the session) is created as started. */
  status: z.enum(["planned", "started"]).default("planned"),
  started_at: iso.nullable().default(null),
});

const itemsSchema = z.object({
  status: z.enum(["planned", "started", "discarded"]),
  updated_at: iso,
  items: z.array(itemSchema).max(60),
});

const startSchema = z.object({ started_at: iso });

type PlanRow = Omit<SessionPlan, "items">;
type ItemRow = Omit<PlanItem, "per_leg" | "is_time"> & { session_id: string; per_leg: number; is_time: number };

const mapItem = (r: ItemRow): PlanItem => ({
  id: r.id,
  exercise_id: r.exercise_id,
  position: r.position,
  sets: r.sets,
  reps_min: r.reps_min,
  reps_max: r.reps_max,
  per_leg: r.per_leg === 1,
  is_time: r.is_time === 1,
  rest_sec: r.rest_sec,
  target_rir_min: r.target_rir_min,
  target_rir_max: r.target_rir_max,
  origin: r.origin,
  replaced_exercise_id: r.replaced_exercise_id,
  group_tag: r.group_tag,
  group_rest_sec: r.group_rest_sec,
  removed_at: r.removed_at,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** Plans with their items; `where` filters planned_sessions (aliased p). */
async function readPlansWhere(env: Env, where: string, ...binds: unknown[]): Promise<SessionPlan[]> {
  const [plans, items] = await env.DB.batch<PlanRow | ItemRow>([
    env.DB.prepare(`SELECT p.* FROM planned_sessions p WHERE ${where} ORDER BY p.created_at, p.id`).bind(...binds),
    env.DB.prepare(`SELECT i.* FROM session_plan_items i JOIN planned_sessions p ON p.id = i.session_id WHERE ${where} ORDER BY i.session_id, i.position`).bind(...binds),
  ]);
  const byPlan = new Map<string, PlanItem[]>();
  for (const r of items.results as ItemRow[]) byPlan.set(r.session_id, [...(byPlan.get(r.session_id) ?? []), mapItem(r)]);
  return (plans.results as PlanRow[]).map((p) => ({ ...p, items: byPlan.get(p.id) ?? [] }));
}

/** Plans the phone needs: every open plan, and the plans of the sessions in the bootstrap window. */
export const readPlans = (env: Env, from: string, to: string) =>
  readPlansWhere(env, "p.status = 'planned' OR p.id IN (SELECT id FROM workout_sessions WHERE local_date BETWEEN ? AND ?)", from, to);

export const readAllPlans = (env: Env) => readPlansWhere(env, "1 = 1");

const readPlan = async (env: Env, planId: string) => (await readPlansWhere(env, "p.id = ?", planId))[0] ?? null;

const insertItem = (env: Env, planId: string, it: PlanItem) =>
  env.DB.prepare(
    `INSERT INTO session_plan_items (id, session_id, exercise_id, position, sets, reps_min, reps_max, per_leg, is_time, rest_sec, target_rir_min, target_rir_max,
       origin, replaced_exercise_id, group_tag, group_rest_sec, removed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET exercise_id = excluded.exercise_id, position = excluded.position, sets = excluded.sets,
       reps_min = excluded.reps_min, reps_max = excluded.reps_max, per_leg = excluded.per_leg, is_time = excluded.is_time,
       rest_sec = excluded.rest_sec, target_rir_min = excluded.target_rir_min, target_rir_max = excluded.target_rir_max,
       origin = excluded.origin, replaced_exercise_id = excluded.replaced_exercise_id, group_tag = excluded.group_tag,
       group_rest_sec = excluded.group_rest_sec, removed_at = excluded.removed_at, updated_at = excluded.updated_at
     WHERE session_plan_items.session_id = excluded.session_id`
  ).bind(
    it.id,
    planId,
    it.exercise_id,
    it.position,
    it.sets,
    it.reps_min,
    it.reps_max,
    it.per_leg ? 1 : 0,
    it.is_time ? 1 : 0,
    it.rest_sec,
    it.target_rir_min,
    it.target_rir_max,
    it.origin,
    it.replaced_exercise_id,
    it.group_tag,
    it.group_rest_sec,
    it.removed_at,
    it.created_at,
    it.updated_at
  );

async function dayOf(env: Env, dayId: string): Promise<{ day: ProgramDay; active: boolean } | null> {
  const { program } = await readProgram(env);
  const day = program.days.find((d) => d.id === dayId);
  if (day) return { day, active: true };
  for (const p of await readProgramVersions(env)) {
    const d = p.days.find((x) => x.id === dayId);
    if (d) return { day: d, active: false };
  }
  return null;
}

/** Live items must sit at positions 0…n-1 and groups must be 2–3 adjacent members. */
function checkItems(items: PlanItem[]): string | null {
  const live = liveItems({ items });
  if (live.some((it, i) => it.position !== i)) return "Item positions must run 0, 1, 2… without gaps.";
  const tags = new Set<string>();
  for (const b of planBlocks({ items })) {
    if (!b.tag) continue;
    if (tags.has(b.tag)) return "A group's members must be next to each other.";
    tags.add(b.tag);
    if (b.items.length < 2 || b.items.length > 3) return "A group has 2 or 3 exercises.";
  }
  return null;
}

export const planRoutes = new Hono<AppBindings>();

/**
 * Creates or gets a plan. A planned plan is the one open plan of its program day: if the day already has one (made on
 * another device), that plan is returned and the phone continues with it. A started plan is created under its own id.
 */
planRoutes.post("/plan", async (c) => {
  const body = await readJson(c, createSchema);
  const existing = await readPlan(c.env, body.id);
  if (existing) return c.json({ plan: existing });
  const found = await dayOf(c.env, body.program_day_id);
  if (!found) return fail(c, 400, "unknown_day", "Program day not found.");
  if (body.status === "planned") {
    if (!found.active) return fail(c, 409, "not_active_day", "Only a day of the active program can be planned.");
    const open = (await readPlansWhere(c.env, "p.program_day_id = ? AND p.status = 'planned'", body.program_day_id))[0];
    if (open) return c.json({ plan: open });
  }
  const now = nowISO();
  const plan = planFromDay(found.day, body.id, now, seqIds(body.id));
  const stmts = [
    c.env.DB.prepare(
      "INSERT INTO planned_sessions (id, program_day_id, status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING"
    ).bind(body.id, body.program_day_id, body.status, body.status === "started" ? body.started_at ?? now : null, now, now),
    ...plan.items.map((it) => insertItem(c.env, body.id, it)),
  ];
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    // Two phones planning the same day at once: the unique index keeps one open plan; return it.
    const open = (await readPlansWhere(c.env, "p.program_day_id = ? AND p.status = 'planned'", body.program_day_id))[0];
    if (open) return c.json({ plan: open });
    throw e;
  }
  return c.json({ plan: await readPlan(c.env, body.id) });
});

/**
 * The full ordered item list, removed items included (idempotent upsert by item id; an item missing from the list is
 * marked removed). Last writer wins on updated_at. A planned plan can be discarded here; a started plan stays started.
 */
planRoutes.put("/:id/plan-items", async (c) => {
  const planId = c.req.param("id");
  if (!ID_RE.test(planId)) return fail(c, 400, "invalid_input", "The plan id is not valid.");
  const body = await readJson(c, itemsSchema);
  const plan = await readPlan(c.env, planId);
  if (!plan) return fail(c, 404, "not_found", "Plan not found.");
  if (Date.parse(plan.updated_at) > Date.parse(body.updated_at)) return c.json({ ok: true, applied: false, plan });
  const ids = new Set(body.items.map((it) => it.id));
  if (ids.size !== body.items.length) return fail(c, 400, "invalid_input", "Duplicate item ids.");
  const bad = checkItems(body.items);
  if (bad) return fail(c, 400, "invalid_plan", bad);
  const exIds = [...new Set(body.items.flatMap((it) => [it.exercise_id, ...(it.replaced_exercise_id ? [it.replaced_exercise_id] : [])]))];
  if (exIds.length) {
    const found = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM exercises WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(exIds)).first<{ n: number }>();
    if ((found?.n ?? 0) !== exIds.length) return fail(c, 400, "unknown_exercise", "Unknown exercise in the plan.");
  }
  // Item ids belong to one plan.
  const clash = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM session_plan_items WHERE session_id <> ? AND id IN (SELECT value FROM json_each(?))")
    .bind(planId, JSON.stringify([...ids]))
    .first<{ n: number }>();
  if (clash?.n) return fail(c, 409, "item_conflict", "An item id belongs to another plan.");
  let status = plan.status;
  if (body.status === "discarded" && plan.status === "planned") status = "discarded";
  else if (body.status === "planned" && plan.status === "discarded") return fail(c, 409, "plan_discarded", "This plan was discarded.");
  const now = nowISO();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE planned_sessions SET status = ?, updated_at = ? WHERE id = ?").bind(status, body.updated_at, planId),
    c.env.DB.prepare("UPDATE session_plan_items SET removed_at = ?, updated_at = ? WHERE session_id = ? AND removed_at IS NULL AND id NOT IN (SELECT value FROM json_each(?))").bind(
      now,
      now,
      planId,
      JSON.stringify([...ids])
    ),
    ...body.items.map((it) => insertItem(c.env, planId, it)),
  ]);
  return c.json({ ok: true, applied: true, plan: await readPlan(c.env, planId) });
});

/** The plan was started at the gym: the workout session with the same id holds the sets. Idempotent. */
planRoutes.post("/:id/start", async (c) => {
  const planId = c.req.param("id");
  if (!ID_RE.test(planId)) return fail(c, 400, "invalid_input", "The plan id is not valid.");
  const body = await readJson(c, startSchema);
  const plan = await readPlan(c.env, planId);
  if (!plan) return fail(c, 404, "not_found", "Plan not found.");
  if (plan.status === "discarded") return fail(c, 409, "plan_discarded", "This plan was discarded.");
  if (plan.status === "planned")
    await c.env.DB.prepare("UPDATE planned_sessions SET status = 'started', started_at = ?, updated_at = ? WHERE id = ? AND status = 'planned'")
      .bind(body.started_at, nowISO(), planId)
      .run();
  return c.json({ ok: true, plan: await readPlan(c.env, planId) });
});

/**
 * "Apply to program": a new version of the active program with this plan's day as planned (groups kept as superset
 * tags). The new version becomes active and the old one is archived (M8 versioning); nothing is deleted.
 */
planRoutes.post("/:id/apply-to-program", async (c) => {
  const planId = c.req.param("id");
  if (!ID_RE.test(planId)) return fail(c, 400, "invalid_input", "The plan id is not valid.");
  const plan = await readPlan(c.env, planId);
  if (!plan) return fail(c, 404, "not_found", "Plan not found.");
  const [active] = await readProgramVersions(c.env, [(await readProgramInfos(c.env)).find((p) => p.status === "active")?.id ?? ""]);
  const day = active?.days.find((d) => d.id === plan.program_day_id);
  if (!active || !day) return fail(c, 409, "not_active_day", "This plan's day is not in the active program any more.");
  const live = liveItems(plan);
  if (!live.length) return fail(c, 400, "invalid_plan", "The plan has no exercises.");
  const labels = groupLabels(plan);
  const now = nowISO();
  const newId = ulid();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO programs (id, name, active, created_at, style, days_per_week, params, generated_by, approved_at) VALUES (?, ?, 0, ?, ?, ?, ?, 'session', ?)`
    ).bind(newId, active.name, now, active.style, active.days_per_week, active.params ? JSON.stringify(active.params) : null, now),
  ];
  for (const d of active.days) {
    const dayId = `${newId}-d${d.position}`;
    stmts.push(
      c.env.DB.prepare("INSERT INTO program_days (id, program_id, position, name_fa, name_en, focus_fa, est_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
        dayId,
        newId,
        d.position,
        d.name_fa,
        d.name_en,
        d.focus_fa,
        d.est_minutes
      )
    );
    const rows =
      d.id === day.id
        ? live.map((it, k) => {
            // The program slot this item stands in (the same exercise, or the one it replaced) keeps its Main flag and slot.
            const slot = d.exercises.find((x) => x.exercise_id === (it.replaced_exercise_id ?? it.exercise_id));
            return {
              exercise_id: it.exercise_id,
              position: k + 1,
              sets: it.sets,
              reps_min: it.reps_min ?? 0,
              reps_max: it.reps_max ?? 0,
              per_leg: it.per_leg,
              is_time: it.is_time,
              rest_sec: it.rest_sec ?? 90,
              superset_tag: labels.get(it.id) ?? null,
              is_main: it.origin !== "added" && (slot?.is_main ?? false),
              target_rir_min: it.target_rir_min,
              target_rir_max: it.target_rir_max,
              slot: it.origin !== "added" ? (slot?.slot ?? null) : null,
            };
          })
        : d.exercises;
    rows.forEach((x, k) =>
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO day_exercises (id, day_id, exercise_id, position, sets, reps_min, reps_max, per_leg, is_time, rest_sec, superset_tag, is_main, target_rir_min, target_rir_max, slot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(`${dayId}-${k + 1}`, dayId, x.exercise_id, x.position, x.sets, x.reps_min, x.reps_max, x.per_leg ? 1 : 0, x.is_time ? 1 : 0, x.rest_sec, x.superset_tag, x.is_main ? 1 : 0, x.target_rir_min, x.target_rir_max, x.slot)
      )
    );
  }
  // M8 switch: close the old activation, archive the old program, activate the new version.
  stmts.push(
    c.env.DB.prepare("UPDATE program_activations SET ended_at = ? WHERE ended_at IS NULL").bind(now),
    c.env.DB.prepare("UPDATE programs SET active = 0, archived_at = ? WHERE active = 1").bind(now),
    c.env.DB.prepare("UPDATE programs SET active = 1 WHERE id = ?").bind(newId),
    c.env.DB.prepare("INSERT INTO program_activations (id, program_id, started_at) VALUES (?, ?, ?)").bind(ulid(), newId, now)
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, program_id: newId, programs: await readProgramInfos(c.env) });
});

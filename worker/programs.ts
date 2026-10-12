// Training styles and the program generator (SPEC-v2 M8, §8.6–§8.7): generate a proposal (stores nothing), save an
// edited proposal as a draft, approve a draft (it becomes the active program; the old one is archived), re-activate an
// archived program, and list every program with its activations. Programs are never deleted; history stays as it is.

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, Env } from "./env";
import { ApiError, fail, nowISO, readJson } from "./http";
import { mapExercise, readProgram, readProgramInfos, readProgramVersions } from "./data";
import {
  EQUIPMENT_CHOICES,
  GeneratorInputError,
  HOLD_SECONDS,
  LAYOUTS,
  SEED_PRIORITY,
  SLOTS,
  STYLES,
  STYLE_NAME,
  checkPlan,
  dayMinutes,
  generateProgram,
  programVolume,
  resolveStyle,
  scheme,
  toDayExercises,
  weeklyTargets,
  type GeneratorInput,
  type Plan,
  type PlanDay,
  type TargetGroup,
} from "./lib/generator";
import { TARGET_GROUPS } from "./lib/muscles";
import type { Exercise, ProgramVersion } from "./lib/types";
import { ID_RE, ulid } from "./lib/ulid";

const id = z.string().regex(ID_RE);

const inputSchema = z.object({
  days_per_week: z.number().int().min(2).max(6),
  style: z.enum(STYLES),
  session_minutes: z.union([z.literal(45), z.literal(60), z.literal(75), z.literal(90)]),
  priority_muscles: z.array(z.enum(TARGET_GROUPS)).max(TARGET_GROUPS.length),
  avoid: z.array(id).max(300),
  equipment: z.enum(EQUIPMENT_CHOICES),
  seed: z.number().int().min(0).max(2_147_483_647),
});

/** An edited proposal: the generator inputs and, per layout day, the exercises with their slot and sets. */
const draftSchema = z.object({
  id,
  params: inputSchema,
  days: z
    .array(
      z.object({
        exercises: z
          .array(
            z.object({
              exercise_id: id,
              slot: z.enum(SLOTS),
              sets: z.number().int().min(1).max(10),
              per_leg: z.boolean(),
              is_time: z.boolean(),
              superset_tag: z.string().regex(/^[A-C][12]$/).nullable(),
            })
          )
          .min(1)
          .max(16),
      })
    )
    .min(2)
    .max(6),
});
type Draft = z.infer<typeof draftSchema>;

/** What the generator and the approval check need from the database. */
async function generatorContext(env: Env) {
  const [exRows, history, { program }, infos] = await Promise.all([
    env.DB.prepare("SELECT * FROM exercises").all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT DISTINCT se.exercise_id AS id FROM set_entries se JOIN workout_sessions ws ON ws.id = se.session_id
       WHERE ws.status = 'done' AND (se.weight IS NOT NULL OR se.reps IS NOT NULL OR se.seconds IS NOT NULL)`
    ).all<{ id: string }>(),
    readProgram(env),
    readProgramInfos(env),
  ]);
  const exercises: Exercise[] = exRows.results.map(mapExercise);
  const active = infos.find((p) => p.status === "active");
  // §8.2: priority muscles default to the current program's; the seed program's is chest.
  const currentPriority: readonly TargetGroup[] = active?.params?.priority_muscles ?? SEED_PRIORITY;
  return { exercises, historyIds: new Set(history.results.map((r) => r.id)), current: program.days.length ? program : null, currentPriority };
}

/** A stored or submitted program as a plan the check can read: day names, kinds and offsets come from the layout. */
function toPlan(params: GeneratorInput, days: Draft["days"]): Plan {
  const style = resolveStyle(params.style, params.days_per_week);
  if (!style) throw new ApiError(400, "invalid_style", `${params.style} does not run ${params.days_per_week} days a week.`);
  const layout = LAYOUTS[style][params.days_per_week];
  if (days.length !== layout.length) throw new ApiError(400, "invalid_input", `This style has ${layout.length} days.`);
  const strength = style === "strength";
  return {
    style,
    days_per_week: params.days_per_week,
    session_minutes: params.session_minutes,
    days: layout.map(
      (l, i): PlanDay => ({
        name_en: l.name,
        kind: l.kind,
        offset: l.offset,
        exercises: days[i].exercises.map((x) => {
          const sc = scheme(x.slot, strength);
          const reps = x.is_time ? HOLD_SECONDS : sc.reps;
          return {
            exercise_id: x.exercise_id,
            slot: x.slot,
            sets: x.sets,
            reps_min: reps[0],
            reps_max: reps[1],
            rest_sec: sc.rest,
            target_rir_min: sc.rir[0],
            target_rir_max: sc.rir[1],
            per_leg: x.per_leg,
            is_time: x.is_time,
            superset_tag: x.superset_tag,
            set_range: sc.range,
          };
        }),
      })
    ),
  };
}

async function checkStored(env: Env, p: ProgramVersion) {
  if (!p.params) throw new ApiError(409, "not_generated", "Only generated programs can be checked.");
  const plan = toPlan(
    p.params,
    p.days.map((d) => ({ exercises: d.exercises.map((x) => ({ exercise_id: x.exercise_id, slot: x.slot ?? "accessory", sets: x.sets, per_leg: x.per_leg, is_time: x.is_time, superset_tag: x.superset_tag })) }))
  );
  const ctx = await generatorContext(env);
  const exMap = new Map(ctx.exercises.map((e) => [e.id, e]));
  const targets = weeklyTargets(programVolume(ctx.current ?? { days: [] }, exMap), ctx.currentPriority, p.params.priority_muscles);
  return checkPlan(plan, exMap, targets);
}

/** Makes `programId` the active program: the old one is archived and its activation closed; a new activation opens. */
function switchTo(env: Env, programId: string, now: string, approve: boolean) {
  return env.DB.batch([
    env.DB.prepare("UPDATE program_activations SET ended_at = ? WHERE ended_at IS NULL").bind(now),
    env.DB.prepare("UPDATE programs SET active = 0, archived_at = ? WHERE active = 1 AND id <> ?").bind(now, programId),
    env.DB.prepare(`UPDATE programs SET active = 1, archived_at = NULL${approve ? ", approved_at = ?" : ""} WHERE id = ?`).bind(...(approve ? [now, programId] : [programId])),
    env.DB.prepare("INSERT INTO program_activations (id, program_id, started_at) VALUES (?, ?, ?)").bind(ulid(), programId, now),
  ]);
}

export const programRoutes = new Hono<AppBindings>();

/** Every program with its days, exercises and activations, newest first. */
programRoutes.get("/", async (c) => c.json({ programs: await readProgramVersions(c.env) }));

/** A proposal for the inputs; nothing is stored. */
programRoutes.post("/generate", async (c) => {
  const input = await readJson(c, inputSchema);
  const ctx = await generatorContext(c.env);
  try {
    return c.json({ proposal: generateProgram(input, ctx) });
  } catch (e) {
    if (e instanceof GeneratorInputError) return fail(c, 400, "invalid_style", e.message);
    throw e;
  }
});

/** Saves an edited proposal as a draft (or replaces a draft with the same id). Approved programs never change. */
programRoutes.post("/", async (c) => {
  const draft = await readJson(c, draftSchema);
  const plan = toPlan(draft.params, draft.days);
  const existing = (await readProgramVersions(c.env, [draft.id]))[0];
  if (existing && existing.status !== "draft") return fail(c, 409, "not_draft", "This program is already approved and can no longer change.");
  const ids = [...new Set(plan.days.flatMap((d) => d.exercises.map((x) => x.exercise_id)))];
  const known = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM exercises WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).first<{ n: number }>();
  if ((known?.n ?? 0) !== ids.length) return fail(c, 400, "unknown_exercise", "An exercise is not in the library.");
  const now = nowISO();
  const name = `${STYLE_NAME[plan.style]} · ${plan.days_per_week} days`;
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO programs (id, name, active, created_at, style, days_per_week, params, generated_by) VALUES (?, ?, 0, ?, ?, ?, ?, 'generator')
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, style = excluded.style, days_per_week = excluded.days_per_week, params = excluded.params`
    ).bind(draft.id, name, now, plan.style, plan.days_per_week, JSON.stringify(draft.params)),
    c.env.DB.prepare("DELETE FROM day_exercises WHERE day_id IN (SELECT id FROM program_days WHERE program_id = ?)").bind(draft.id),
  ];
  plan.days.forEach((d, i) => {
    const dayId = `${draft.id}-d${i + 1}`;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO program_days (id, program_id, position, name_fa, name_en, focus_fa, est_minutes) VALUES (?, ?, ?, '', ?, '', ?)
         ON CONFLICT (id) DO UPDATE SET name_en = excluded.name_en, est_minutes = excluded.est_minutes`
      ).bind(dayId, draft.id, i + 1, d.name_en, dayMinutes(d))
    );
    for (const [k, x] of toDayExercises(d).entries())
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO day_exercises (id, day_id, exercise_id, position, sets, reps_min, reps_max, per_leg, is_time, rest_sec, superset_tag, is_main, target_rir_min, target_rir_max, slot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(`${dayId}-${k + 1}`, dayId, x.exercise_id, x.position, x.sets, x.reps_min, x.reps_max, x.per_leg ? 1 : 0, x.is_time ? 1 : 0, x.rest_sec, x.superset_tag, x.is_main ? 1 : 0, x.target_rir_min, x.target_rir_max, x.slot)
      );
  });
  await c.env.DB.batch(stmts);
  const saved = (await readProgramVersions(c.env, [draft.id]))[0];
  return c.json({ ok: true, program: saved, check: await checkStored(c.env, saved) });
});

/** Approves a draft: the hard rules are checked again here; on success it becomes the active program. */
programRoutes.post("/:id/approve", async (c) => {
  const p = (await readProgramVersions(c.env, [c.req.param("id")]))[0];
  if (!p) return fail(c, 404, "not_found", "Program not found.");
  if (p.status !== "draft") return fail(c, 409, "not_draft", "Only a draft can be approved.");
  const check = await checkStored(c.env, p);
  if (check.violations.length) return c.json({ error: { code: "rules_broken", message_fa: check.violations[0].message }, check }, 422);
  await switchTo(c.env, p.id, nowISO(), true);
  return c.json({ ok: true, programs: await readProgramInfos(c.env) });
});

/** Re-activates an archived program with a fresh activation; past sessions and activations stay as they are. */
programRoutes.post("/:id/activate", async (c) => {
  const p = (await readProgramInfos(c.env)).find((x) => x.id === c.req.param("id"));
  if (!p) return fail(c, 404, "not_found", "Program not found.");
  if (p.status !== "archived") return fail(c, 409, "not_archived", p.status === "active" ? "This program is already active." : "Approve the draft first.");
  await switchTo(c.env, p.id, nowISO(), false);
  return c.json({ ok: true, programs: await readProgramInfos(c.env) });
});

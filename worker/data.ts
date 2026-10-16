// Program, settings and workout-session data (SPEC §5, §11).

import { Hono } from "hono";
import { z } from "zod";
import { linkSession, readCalendar, syncAllReminders, syncReminder, unlinkSessionStmt } from "./calendar";
import type { AppBindings, Env } from "./env";
import { rematchAround, readWatchForSessions } from "./health";
import { fail, nowISO, readJson } from "./http";
import { addDays, DATE_RE, isValidTimeZone, localDate } from "./lib/time";
import {
  DEFAULT_SETTINGS,
  type BodyMetric,
  type Bootstrap,
  type DayExercise,
  type Exercise,
  type Program,
  type ProgramActivation,
  type ProgramDay,
  type ProgramInfo,
  type ProgramVersion,
  type SetEntry,
  type WeeklyReview,
  type Settings,
  type WorkoutSession,
} from "./lib/types";
import { isCategory } from "./lib/category";
import { readPlans } from "./plans";
import { queueAfterSession } from "./aiReports";
import { ID_RE, ulid } from "./lib/ulid";

/* ---------------- reads ---------------- */

export async function readSettings(env: Env): Promise<Settings> {
  const rows = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  return {
    unit: map.unit === "kg" ? "kg" : map.unit === "lb" ? "lb" : DEFAULT_SETTINGS.unit,
    week_start: map.week_start === "sat" || map.week_start === "sun" || map.week_start === "mon" ? map.week_start : DEFAULT_SETTINGS.week_start,
    relock_minutes: Number.isFinite(Number(map.relock_minutes)) ? Number(map.relock_minutes) : DEFAULT_SETTINGS.relock_minutes,
    timezone: map.timezone && isValidTimeZone(map.timezone) ? map.timezone : DEFAULT_SETTINGS.timezone,
  };
}

interface DayRow {
  id: string;
  program_id: string;
  position: number;
  name_fa: string;
  name_en: string;
  focus_fa: string | null;
  est_minutes: number | null;
}

const mapDay = (d: DayRow): Omit<ProgramDay, "exercises"> => ({
  id: d.id,
  program_id: d.program_id,
  position: d.position,
  name_fa: d.name_fa,
  name_en: d.name_en,
  focus_fa: d.focus_fa ?? "",
  est_minutes: d.est_minutes ?? 0,
});

export async function readProgram(env: Env): Promise<{ program: Program; other_days: Omit<ProgramDay, "exercises">[] }> {
  const prog = await env.DB.prepare("SELECT id, name FROM programs WHERE active = 1 ORDER BY created_at LIMIT 1").first<{ id: string; name: string }>();
  const days = await env.DB.prepare("SELECT * FROM program_days ORDER BY program_id, position").all<DayRow>();
  const dex = await env.DB.prepare(
    `SELECT de.* FROM day_exercises de JOIN program_days d ON d.id = de.day_id JOIN programs p ON p.id = d.program_id
     WHERE p.active = 1 ORDER BY de.day_id, de.position`
  ).all<Record<string, number | string | null>>();
  const byDay = new Map<string, DayExercise[]>();
  for (const r of dex.results) byDay.set(r.day_id as string, [...(byDay.get(r.day_id as string) ?? []), mapDayExercise(r)]);
  const activeDays = days.results.filter((d) => d.program_id === prog?.id);
  return {
    program: {
      id: prog?.id ?? "",
      name: prog?.name ?? "",
      days: activeDays.map((d) => ({ ...mapDay(d), exercises: byDay.get(d.id) ?? [] })),
    },
    other_days: days.results.filter((d) => d.program_id !== prog?.id).map(mapDay),
  };
}

interface ProgramRow {
  id: string;
  name: string;
  active: number;
  created_at: string;
  style: string | null;
  days_per_week: number | null;
  params: string | null;
  generated_by: string | null;
  approved_at: string | null;
  archived_at: string | null;
}

const parseParams = (raw: string | null): ProgramInfo["params"] => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProgramInfo["params"];
  } catch {
    return null;
  }
};

/** Every program with its activations, newest first (SPEC-v2 §8.6). */
export async function readProgramInfos(env: Env): Promise<ProgramInfo[]> {
  const [progs, acts] = await env.DB.batch<ProgramRow | ProgramActivation>([
    env.DB.prepare("SELECT id, name, active, created_at, style, days_per_week, params, generated_by, approved_at, archived_at FROM programs ORDER BY created_at DESC, id"),
    env.DB.prepare("SELECT id, program_id, started_at, ended_at FROM program_activations ORDER BY started_at, id"),
  ]);
  const byProgram = new Map<string, ProgramActivation[]>();
  for (const a of acts.results as ProgramActivation[]) byProgram.set(a.program_id, [...(byProgram.get(a.program_id) ?? []), a]);
  return (progs.results as ProgramRow[]).map((p) => ({
    id: p.id,
    name: p.name,
    style: p.style,
    days_per_week: p.days_per_week,
    params: parseParams(p.params),
    generated_by: p.generated_by === "seed" || p.generated_by === "generator" || p.generated_by === "session" || p.generated_by === "coach" ? p.generated_by : null,
    created_at: p.created_at,
    approved_at: p.approved_at,
    archived_at: p.archived_at,
    status: p.active === 1 ? "active" : p.archived_at ? "archived" : p.approved_at ? "archived" : "draft",
    activations: byProgram.get(p.id) ?? [],
  }));
}

const mapDayExercise = (r: Record<string, number | string | null>): DayExercise => ({
  id: r.id as string,
  exercise_id: r.exercise_id as string,
  position: r.position as number,
  sets: r.sets as number,
  reps_min: r.reps_min as number,
  reps_max: r.reps_max as number,
  per_leg: r.per_leg === 1,
  is_time: r.is_time === 1,
  rest_sec: r.rest_sec as number,
  superset_tag: (r.superset_tag as string | null) ?? null,
  is_main: r.is_main === 1,
  target_rir_min: (r.target_rir_min as number | null | undefined) ?? null,
  target_rir_max: (r.target_rir_max as number | null | undefined) ?? null,
  slot: (r.slot as DayExercise["slot"] | undefined) ?? null,
});

/** Programs with their days and exercises; `ids` limits the list. */
export async function readProgramVersions(env: Env, ids?: string[]): Promise<ProgramVersion[]> {
  const infos = (await readProgramInfos(env)).filter((p) => !ids || ids.includes(p.id));
  const [days, dex] = await env.DB.batch<DayRow | Record<string, number | string | null>>([
    env.DB.prepare("SELECT * FROM program_days ORDER BY program_id, position"),
    env.DB.prepare("SELECT * FROM day_exercises ORDER BY day_id, position"),
  ]);
  const byDay = new Map<string, DayExercise[]>();
  for (const r of dex.results as Record<string, number | string | null>[]) byDay.set(r.day_id as string, [...(byDay.get(r.day_id as string) ?? []), mapDayExercise(r)]);
  return infos.map((p) => ({
    ...p,
    days: (days.results as DayRow[]).filter((d) => d.program_id === p.id).map((d) => ({ ...mapDay(d), exercises: byDay.get(d.id) ?? [] })),
  }));
}

const jsonList = <T>(raw: unknown): T[] => {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

export function mapExercise(r: Record<string, unknown>): Exercise {
  return {
    id: r.id as string,
    name_fa: (r.name_fa as string | null) ?? "",
    name_en: r.name_en as string,
    muscle_primary: r.muscle_primary as string,
    is_lower: r.is_lower === 1,
    equipment: r.equipment as Exercise["equipment"],
    cue_fa: (r.cue_fa as string | null) ?? "",
    cue_en: (r.cue_en as string | null | undefined) || null,
    source: ((r.source as string | null) ?? "seed") as Exercise["source"],
    muscles_secondary: jsonList<string>(r.muscles_secondary),
    pattern: (r.pattern as Exercise["pattern"]) ?? null,
    mechanic: (r.mechanic as Exercise["mechanic"]) ?? null,
    level: (r.level as Exercise["level"]) ?? null,
    media: jsonList<Exercise["media"][number]>(r.media),
    instructions_en: jsonList<string>(r.instructions_en),
    archived_at: (r.archived_at as string | null) ?? null,
    category: isCategory(r.category) ? r.category : null,
  };
}

/**
 * Exercises the app needs offline without the library list: every exercise in a program, every exercise with
 * logged sets (history, reports, extra exercises) and every custom exercise. The full library is GET /api/exercises.
 */
export async function readExercises(env: Env): Promise<Exercise[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM exercises
     WHERE id IN (SELECT exercise_id FROM day_exercises) OR id IN (SELECT DISTINCT exercise_id FROM set_entries) OR source IN ('seed', 'custom')
     ORDER BY id`
  ).all<Record<string, unknown>>();
  return rows.results.map(mapExercise);
}

type SessionRow = Omit<WorkoutSession, "sets">;
type SetRow = Omit<SetEntry, "done" | "rir" | "is_extra"> & { session_id: string; done: number; rir: number | null; is_extra: number };

const mapSet = (r: SetRow): SetEntry => ({
  id: r.id,
  exercise_id: r.exercise_id,
  set_index: r.set_index,
  weight: r.weight,
  reps: r.reps,
  seconds: r.seconds,
  done: r.done === 1,
  rir: r.rir ?? null,
  is_extra: r.is_extra === 1,
  position: r.position ?? null,
  updated_at: r.updated_at,
});

export async function readSessions(env: Env, from: string, to: string): Promise<WorkoutSession[]> {
  const [sessions, sets] = await env.DB.batch<SessionRow | SetRow>([
    env.DB.prepare("SELECT * FROM workout_sessions WHERE local_date BETWEEN ? AND ? ORDER BY local_date DESC, started_at DESC").bind(from, to),
    env.DB.prepare(
      `SELECT se.* FROM set_entries se JOIN workout_sessions ws ON ws.id = se.session_id
       WHERE ws.local_date BETWEEN ? AND ? ORDER BY se.session_id, se.exercise_id, se.set_index`
    ).bind(from, to),
  ]);
  const bySession = new Map<string, SetEntry[]>();
  for (const r of sets.results as SetRow[]) {
    const list = bySession.get(r.session_id) ?? [];
    list.push(mapSet(r));
    bySession.set(r.session_id, list);
  }
  return (sessions.results as SessionRow[]).map((s) => ({ ...s, sets: bySession.get(s.id) ?? [] }));
}

/* ---------------- schemas ---------------- */

const iso = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)) && /T/.test(s), "iso");
const id = z.string().regex(ID_RE);
const intOrNull = z.number().int().min(-100_000).max(100_000).nullable();

const setSchema = z.object({
  id,
  exercise_id: id,
  set_index: z.number().int().min(0).max(99),
  weight: z.number().finite().min(-10_000).max(10_000).nullable(),
  reps: intOrNull,
  seconds: intOrNull,
  rir: z.number().int().min(0).max(3).nullable().optional(),
  done: z.boolean(),
  is_extra: z.boolean().optional(),
  position: z.number().int().min(0).max(99).nullable().optional(),
  updated_at: iso,
});

const sessionSchema = z.object({
  id,
  program_day_id: id,
  local_date: z.string().regex(DATE_RE),
  started_at: iso,
  ended_at: iso.nullable(),
  status: z.enum(["active", "done"]),
  unit: z.enum(["lb", "kg"]),
  note: z.string().max(10_000),
  created_at: iso,
  updated_at: iso,
  source: z.enum(["app", "import"]),
  sets: z.array(setSchema).max(300),
});

const settingsSchema = z
  .object({
    unit: z.enum(["lb", "kg"]),
    week_start: z.enum(["sat", "sun", "mon"]),
    relock_minutes: z.number().int().min(0).max(1440),
    timezone: z.string().max(64).refine(isValidTimeZone, "timezone"),
  })
  .partial();

/* ---------------- routes ---------------- */

export const dataRoutes = new Hono<AppBindings>();

dataRoutes.get("/bootstrap", async (c) => {
  const settings = await readSettings(c.env);
  const today = localDate(settings.timezone);
  const from = addDays(today, -60);
  const to = addDays(today, 1);
  const [{ program, other_days }, programs, exercises, sessions, watch, body, review, plans, calendar] = await Promise.all([
    readProgram(c.env),
    readProgramInfos(c.env),
    readExercises(c.env),
    readSessions(c.env, from, to),
    readWatchForSessions(c.env, from, to),
    readBodyMetrics(c.env, from, to),
    readLatestReview(c.env),
    readPlans(c.env, from, to),
    readCalendar(c.env, today, from),
  ]);
  const payload: Bootstrap = { settings, program, other_days, programs, exercises, sessions, watch, body, review, plans, calendar, server_time: nowISO() };
  return c.json(payload);
});

dataRoutes.put("/settings", async (c) => {
  const body = await readJson(c, settingsSchema);
  const stmts = Object.entries(body).map(([k, v]) =>
    c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(k, String(v))
  );
  if (stmts.length) await c.env.DB.batch(stmts);
  // Reminders are set in local time: a new time zone moves them.
  if (body.timezone !== undefined) await syncAllReminders(c.env, new URL(c.req.url).origin);
  return c.json({ ok: true, settings: await readSettings(c.env) });
});

dataRoutes.get("/sessions", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from !== undefined && !DATE_RE.test(from)) return fail(c, 400, "invalid_input", "The start date is not valid.");
  if (to !== undefined && !DATE_RE.test(to)) return fail(c, 400, "invalid_input", "The end date is not valid.");
  return c.json({ sessions: await readSessions(c.env, from ?? "0000-01-01", to ?? "9999-12-31") });
});

dataRoutes.put("/sessions/:id", async (c) => {
  const doc = await readJson(c, sessionSchema);
  if (doc.id !== c.req.param("id")) return fail(c, 400, "id_mismatch", "The session id does not match the URL.");
  const setIds = new Set(doc.sets.map((s) => s.id));
  if (setIds.size !== doc.sets.length) return fail(c, 400, "invalid_input", "Duplicate set ids.");

  const day = await c.env.DB.prepare("SELECT id FROM program_days WHERE id = ?").bind(doc.program_day_id).first();
  if (!day) return fail(c, 400, "unknown_day", "Program day not found.");
  const exIds = [...new Set(doc.sets.map((s) => s.exercise_id))];
  if (exIds.length) {
    const found = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM exercises WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(exIds))
      .first<{ n: number }>();
    if ((found?.n ?? 0) !== exIds.length) return fail(c, 400, "unknown_exercise", "Unknown exercise in the sets.");
  }

  // Set ids must not belong to another session.
  if (doc.sets.length) {
    const clash = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM set_entries WHERE session_id <> ? AND id IN (SELECT value FROM json_each(?))")
      .bind(doc.id, JSON.stringify(doc.sets.map((s) => s.id)))
      .first<{ n: number }>();
    if (clash?.n) return fail(c, 409, "set_conflict", "A set id belongs to another session.");
  }

  // Last-writer-wins on updated_at: an older document never overwrites a newer one.
  const existing = await c.env.DB.prepare("SELECT updated_at, status FROM workout_sessions WHERE id = ?").bind(doc.id).first<{ updated_at: string; status: string }>();
  if (existing && Date.parse(existing.updated_at) > Date.parse(doc.updated_at)) {
    const [current] = await readSessionsById(c.env, [doc.id]);
    return c.json({ ok: true, applied: false, session: current });
  }

  const db = c.env.DB;
  const keep = doc.sets.map((s) => s.id);
  const stmts = [
    db
      .prepare(
        `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET program_day_id = excluded.program_day_id, local_date = excluded.local_date,
           started_at = excluded.started_at, ended_at = excluded.ended_at, status = excluded.status, unit = excluded.unit,
           note = excluded.note, updated_at = excluded.updated_at, source = excluded.source`
      )
      .bind(doc.id, doc.program_day_id, doc.local_date, doc.started_at, doc.ended_at, doc.status, doc.unit, doc.note, doc.created_at, doc.updated_at, doc.source),
    db.prepare("DELETE FROM set_entries WHERE session_id = ? AND id NOT IN (SELECT value FROM json_each(?))").bind(doc.id, JSON.stringify(keep)),
    ...doc.sets.map((s) =>
      db
        .prepare(
          `INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, rir, is_extra, position, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET exercise_id = excluded.exercise_id, set_index = excluded.set_index, weight = excluded.weight,
             reps = excluded.reps, seconds = excluded.seconds, done = excluded.done, rir = excluded.rir, is_extra = excluded.is_extra,
             position = excluded.position, updated_at = excluded.updated_at`
        )
        .bind(s.id, doc.id, s.exercise_id, s.set_index, s.weight, s.reps, s.seconds, s.done ? 1 : 0, s.rir ?? null, s.is_extra ? 1 : 0, s.position ?? null, s.updated_at)
    ),
  ];
  await db.batch(stmts);
  // A watch workout may have arrived before this session was synced (SPEC §9.1 matching).
  await rematchAround(c.env, doc.started_at);
  // SPEC-v10 M13: the session marks its day's planned gym session done.
  await linkSession(c.env, doc, new URL(c.req.url).origin);
  // SPEC-v3 M9a / SPEC-v7 M9d: a session that reaches the server as done gets its AI report, then the training overview
  // is rewritten, both in the background.
  if (doc.status === "done" && doc.source === "app" && existing?.status !== "done")
    c.executionCtx.waitUntil(queueAfterSession(c.env, doc.id).catch((e: unknown) => console.error(`AI queue: ${e instanceof Error ? e.message : String(e)}`)));
  return c.json({ ok: true, applied: true });
});

/* ---------------- weekly review (written by Claude into D1) ---------------- */

/** Turns a JSON column into a list of strings; tolerates objects ({title, detail}/{text}) and plain text. */
export function toStringList(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return raw.trim() ? [raw.trim()] : [];
    }
  }
  if (!Array.isArray(v)) v = v == null ? [] : [v];
  return (v as unknown[])
    .map((x) => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const title = typeof o.title === "string" ? o.title : typeof o.text === "string" ? o.text : "";
        const detail = typeof o.detail === "string" ? o.detail : typeof o.body === "string" ? o.body : "";
        return [title, detail].filter(Boolean).join(": ").trim();
      }
      return x == null ? "" : String(x);
    })
    .filter(Boolean);
}

export async function readLatestReview(env: Env): Promise<WeeklyReview | null> {
  const r = await env.DB.prepare("SELECT * FROM weekly_reviews ORDER BY week_start DESC, created_at DESC LIMIT 1").first<Record<string, string>>();
  if (!r) return null;
  return {
    id: r.id,
    week_start: r.week_start,
    created_at: r.created_at,
    summary_fa: r.summary_fa ?? "",
    highlights: toStringList(r.highlights),
    suggestions: toStringList(r.suggestions),
  };
}

dataRoutes.get("/reviews/latest", async (c) => c.json({ review: await readLatestReview(c.env) }));

/** Every weekly review, newest week first (SPEC-v7 M9d: History → Weekly reviews; the rows are never deleted). */
dataRoutes.get("/reviews", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM weekly_reviews ORDER BY week_start DESC, created_at DESC").all<Record<string, string>>();
  const reviews: WeeklyReview[] = rows.results.map((r) => ({
    id: r.id,
    week_start: r.week_start,
    created_at: r.created_at,
    summary_fa: r.summary_fa ?? "",
    highlights: toStringList(r.highlights),
    suggestions: toStringList(r.suggestions),
  }));
  return c.json({ reviews });
});

/* ---------------- body metrics (manual body weight) ---------------- */

export async function readBodyMetrics(env: Env, from: string, to: string): Promise<BodyMetric[]> {
  const rows = await env.DB.prepare(
    "SELECT local_date, kind, value, unit, source FROM body_metrics WHERE local_date BETWEEN ? AND ? ORDER BY local_date, kind, source"
  )
    .bind(from, to)
    .all<BodyMetric>();
  return rows.results;
}

const bodyMassSchema = z.object({ value: z.number().positive().max(1000).nullable(), unit: z.enum(["lb", "kg"]) });

/** Manual body weight for a day ("body weight today" at the end of a session); null clears it. */
dataRoutes.put("/body-mass/:date", async (c) => {
  const date = c.req.param("date");
  if (!DATE_RE.test(date)) return fail(c, 400, "invalid_input", "The date is not valid.");
  const body = await readJson(c, bodyMassSchema);
  if (body.value === null) {
    await c.env.DB.prepare("DELETE FROM body_metrics WHERE local_date = ? AND kind = 'body_mass' AND source = 'manual'").bind(date).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO body_metrics (id, local_date, kind, value, unit, source, received_at) VALUES (?, ?, 'body_mass', ?, ?, 'manual', ?)
       ON CONFLICT (local_date, kind, source) DO UPDATE SET value = excluded.value, unit = excluded.unit, received_at = excluded.received_at`
    )
      .bind(ulid(), date, body.value, body.unit, nowISO())
      .run();
  }
  return c.json({ ok: true });
});

dataRoutes.delete("/sessions/:id", async (c) => {
  const sid = c.req.param("id");
  if (!ID_RE.test(sid)) return fail(c, 400, "invalid_input", "The session id is not valid.");
  const plans = await c.env.DB.prepare("SELECT id FROM gym_plans WHERE session_id = ?").bind(sid).all<{ id: string }>();
  await c.env.DB.batch([
    // Its planned gym session goes back to planned (SPEC-v10 §4), before the session row goes.
    unlinkSessionStmt(c.env, sid),
    c.env.DB.prepare("DELETE FROM set_entries WHERE session_id = ?").bind(sid),
    // Its AI reports describe a session that no longer exists (approved with migration 0009).
    c.env.DB.prepare("DELETE FROM session_reports WHERE session_id = ?").bind(sid),
    c.env.DB.prepare("DELETE FROM workout_sessions WHERE id = ?").bind(sid),
    c.env.DB.prepare("DELETE FROM health_workouts WHERE external_key = ?").bind(`session:${sid}`),
    // Photos are kept (they belong to the date), only unlinked from the deleted session.
    c.env.DB.prepare("UPDATE photos SET session_id = NULL WHERE session_id = ?").bind(sid),
    c.env.DB.prepare("UPDATE health_workouts SET matched_session_id = NULL WHERE matched_session_id = ?").bind(sid),
  ]);
  for (const { id: planId } of plans.results) await syncReminder(c.env, planId, new URL(c.req.url).origin);
  return c.json({ ok: true });
});

async function readSessionsById(env: Env, ids: string[]): Promise<WorkoutSession[]> {
  const out: WorkoutSession[] = [];
  for (const sid of ids) {
    const s = await env.DB.prepare("SELECT * FROM workout_sessions WHERE id = ?").bind(sid).first<SessionRow>();
    if (!s) continue;
    const sets = await env.DB.prepare("SELECT * FROM set_entries WHERE session_id = ? ORDER BY exercise_id, set_index").bind(sid).all<SetRow>();
    out.push({
      ...s,
      sets: sets.results.map(mapSet),
    });
  }
  return out;
}

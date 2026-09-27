// Program, settings and workout-session data (SPEC §5, §11).

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, Env } from "./env";
import { fail, nowISO, readJson } from "./http";
import { addDays, DATE_RE, isValidTimeZone, localDate } from "./lib/time";
import {
  DEFAULT_SETTINGS,
  type Bootstrap,
  type DayExercise,
  type Exercise,
  type Program,
  type ProgramDay,
  type SetEntry,
  type Settings,
  type WorkoutSession,
} from "./lib/types";
import { ID_RE } from "./lib/ulid";

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

async function readProgram(env: Env): Promise<{ program: Program; other_days: Omit<ProgramDay, "exercises">[] }> {
  const prog = await env.DB.prepare("SELECT id, name FROM programs WHERE active = 1 ORDER BY created_at LIMIT 1").first<{ id: string; name: string }>();
  const days = await env.DB.prepare("SELECT * FROM program_days ORDER BY program_id, position").all<DayRow>();
  const dex = await env.DB.prepare(
    `SELECT de.* FROM day_exercises de JOIN program_days d ON d.id = de.day_id JOIN programs p ON p.id = d.program_id
     WHERE p.active = 1 ORDER BY de.day_id, de.position`
  ).all<Record<string, number | string | null>>();
  const byDay = new Map<string, DayExercise[]>();
  for (const r of dex.results) {
    const list = byDay.get(r.day_id as string) ?? [];
    list.push({
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
    });
    byDay.set(r.day_id as string, list);
  }
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

async function readExercises(env: Env): Promise<Exercise[]> {
  const rows = await env.DB.prepare("SELECT * FROM exercises ORDER BY id").all<Record<string, string | number | null>>();
  return rows.results.map((r) => ({
    id: r.id as string,
    name_fa: r.name_fa as string,
    name_en: r.name_en as string,
    muscle_primary: r.muscle_primary as string,
    is_lower: r.is_lower === 1,
    equipment: r.equipment as Exercise["equipment"],
    cue_fa: (r.cue_fa as string | null) ?? "",
  }));
}

type SessionRow = Omit<WorkoutSession, "sets">;
type SetRow = Omit<SetEntry, "done"> & { session_id: string; done: number };

async function readSessions(env: Env, from: string, to: string): Promise<WorkoutSession[]> {
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
    list.push({
      id: r.id,
      exercise_id: r.exercise_id,
      set_index: r.set_index,
      weight: r.weight,
      reps: r.reps,
      seconds: r.seconds,
      done: r.done === 1,
      updated_at: r.updated_at,
    });
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
  done: z.boolean(),
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
  const [{ program, other_days }, exercises, sessions] = await Promise.all([
    readProgram(c.env),
    readExercises(c.env),
    readSessions(c.env, addDays(today, -60), addDays(today, 1)),
  ]);
  const body: Bootstrap = { settings, program, other_days, exercises, sessions, server_time: nowISO() };
  return c.json(body);
});

dataRoutes.put("/settings", async (c) => {
  const body = await readJson(c, settingsSchema);
  const stmts = Object.entries(body).map(([k, v]) =>
    c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(k, String(v))
  );
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, settings: await readSettings(c.env) });
});

dataRoutes.get("/sessions", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from !== undefined && !DATE_RE.test(from)) return fail(c, 400, "invalid_input", "تاریخ شروع معتبر نیست.");
  if (to !== undefined && !DATE_RE.test(to)) return fail(c, 400, "invalid_input", "تاریخ پایان معتبر نیست.");
  return c.json({ sessions: await readSessions(c.env, from ?? "0000-01-01", to ?? "9999-12-31") });
});

dataRoutes.put("/sessions/:id", async (c) => {
  const doc = await readJson(c, sessionSchema);
  if (doc.id !== c.req.param("id")) return fail(c, 400, "id_mismatch", "شناسه‌ی جلسه با آدرس یکی نیست.");
  const setIds = new Set(doc.sets.map((s) => s.id));
  if (setIds.size !== doc.sets.length) return fail(c, 400, "invalid_input", "شناسه‌ی ست‌ها تکراری است.");

  const day = await c.env.DB.prepare("SELECT id FROM program_days WHERE id = ?").bind(doc.program_day_id).first();
  if (!day) return fail(c, 400, "unknown_day", "روز برنامه پیدا نشد.");
  const exIds = [...new Set(doc.sets.map((s) => s.exercise_id))];
  if (exIds.length) {
    const found = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM exercises WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(exIds))
      .first<{ n: number }>();
    if ((found?.n ?? 0) !== exIds.length) return fail(c, 400, "unknown_exercise", "حرکت ناشناخته در ست‌ها.");
  }

  // Set ids must not belong to another session.
  if (doc.sets.length) {
    const clash = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM set_entries WHERE session_id <> ? AND id IN (SELECT value FROM json_each(?))")
      .bind(doc.id, JSON.stringify(doc.sets.map((s) => s.id)))
      .first<{ n: number }>();
    if (clash?.n) return fail(c, 409, "set_conflict", "شناسه‌ی ست متعلق به جلسه‌ی دیگری است.");
  }

  // Last-writer-wins on updated_at: an older document never overwrites a newer one.
  const existing = await c.env.DB.prepare("SELECT updated_at FROM workout_sessions WHERE id = ?").bind(doc.id).first<{ updated_at: string }>();
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
          `INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET exercise_id = excluded.exercise_id, set_index = excluded.set_index, weight = excluded.weight,
             reps = excluded.reps, seconds = excluded.seconds, done = excluded.done, updated_at = excluded.updated_at`
        )
        .bind(s.id, doc.id, s.exercise_id, s.set_index, s.weight, s.reps, s.seconds, s.done ? 1 : 0, s.updated_at)
    ),
  ];
  await db.batch(stmts);
  return c.json({ ok: true, applied: true });
});

dataRoutes.delete("/sessions/:id", async (c) => {
  const sid = c.req.param("id");
  if (!ID_RE.test(sid)) return fail(c, 400, "invalid_input", "شناسه‌ی جلسه معتبر نیست.");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM set_entries WHERE session_id = ?").bind(sid),
    c.env.DB.prepare("DELETE FROM workout_sessions WHERE id = ?").bind(sid),
  ]);
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
      sets: sets.results.map((r) => ({
        id: r.id,
        exercise_id: r.exercise_id,
        set_index: r.set_index,
        weight: r.weight,
        reps: r.reps,
        seconds: r.seconds,
        done: r.done === 1,
        updated_at: r.updated_at,
      })),
    });
  }
  return out;
}

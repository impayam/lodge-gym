// Apple Watch bridge (approved SPEC §9 change): shortcut tokens, raw Shortcuts ingest, matching, status.

import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { randomToken, sha256Hex } from "./crypto";
import type { AppBindings, Env } from "./env";
import { fail, nowISO, readJson } from "./http";
import { faNum } from "./lib/digits";
import { matchSession } from "./lib/matching";
import { parseShortcutsPayload } from "./lib/shortcuts";
import type { HealthWorkout } from "./lib/types";
import { ID_RE, ulid } from "./lib/ulid";
import { readSettings } from "./data";

const HEALTH_SCOPE = "health:write";
const MAX_BODY = 5 * 1024 * 1024;
const DAY = 86_400_000;

/* ---------------- tokens (session auth) ---------------- */

export const tokenRoutes = new Hono<AppBindings>();

tokenRoutes.post("/", async (c) => {
  const body = await readJson(c, z.object({ label: z.string().trim().max(60).optional() }));
  const id = ulid();
  const token = `lgt_${randomToken()}`;
  const created_at = nowISO();
  const label = body.label || "iPhone Shortcuts";
  await c.env.DB.prepare("INSERT INTO api_tokens (id, token_hash, label, scope, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(token), label, HEALTH_SCOPE, created_at)
    .run();
  return c.json({ id, label, scope: HEALTH_SCOPE, created_at, token });
});

tokenRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, label, scope, created_at, last_used_at, revoked_at FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC"
  ).all();
  return c.json({ tokens: rows.results });
});

tokenRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "شناسه‌ی توکن معتبر نیست.");
  await c.env.DB.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowISO(), id).run();
  return c.json({ ok: true });
});

/* ---------------- bearer auth ---------------- */

export const requireHealthToken: MiddlewareHandler<AppBindings> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const m = header.trim().match(/^Bearer\s+(\S+)$/i);
  if (!m) return fail(c, 401, "missing_token", "توکن ارسال نشده است. هدر Authorization را با Bearer و توکن تنظیم کن.");
  const hash = await sha256Hex(m[1]);
  const row = await c.env.DB.prepare("SELECT id, scope FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL").bind(hash).first<{ id: string; scope: string }>();
  if (!row || !row.scope.split(/[ ,]/).includes(HEALTH_SCOPE)) return fail(c, 401, "bad_token", "توکن معتبر نیست یا باطل شده است.");
  await c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(nowISO(), row.id).run();
  await next();
};

/* ---------------- matching ---------------- */

/** Matches still-unmatched watch workouts that start in [from, to] to workout sessions (SPEC §9.1). */
export async function rematchUnmatched(env: Env, from: string, to: string, tz?: string): Promise<number> {
  const unmatched = await env.DB.prepare(
    "SELECT id, started_at, ended_at FROM health_workouts WHERE matched_session_id IS NULL AND started_at BETWEEN ? AND ?"
  )
    .bind(from, to)
    .all<{ id: string; started_at: string; ended_at: string | null }>();
  if (!unmatched.results.length) return 0;
  const zone = tz ?? (await readSettings(env)).timezone;
  const sessions = await env.DB.prepare(
    "SELECT id, local_date, started_at, ended_at FROM workout_sessions WHERE started_at BETWEEN ? AND ?"
  )
    .bind(new Date(Date.parse(from) - DAY).toISOString(), new Date(Date.parse(to) + DAY).toISOString())
    .all<{ id: string; local_date: string; started_at: string; ended_at: string | null }>();
  const updates = [];
  for (const w of unmatched.results) {
    const sid = matchSession(w, sessions.results, zone);
    if (sid) updates.push(env.DB.prepare("UPDATE health_workouts SET matched_session_id = ? WHERE id = ? AND matched_session_id IS NULL").bind(sid, w.id));
  }
  if (updates.length) await env.DB.batch(updates);
  return updates.length;
}

/** Re-matches around a session's start after it is created or edited. */
export async function rematchAround(env: Env, startedAt: string) {
  const t = Date.parse(startedAt);
  await rematchUnmatched(env, new Date(t - DAY).toISOString(), new Date(t + DAY).toISOString());
}

/* ---------------- reads ---------------- */

type HealthRow = HealthWorkout & { raw?: string | null; received_at?: string };

const HEALTH_COLUMNS = "hw.id, hw.activity_type, hw.started_at, hw.ended_at, hw.duration_sec, hw.active_kcal, hw.total_kcal, hw.hr_avg, hw.hr_max, hw.matched_session_id, hw.received_at";

/** Watch workouts matched to sessions whose local date is in [from, to]. */
export async function readWatchForSessions(env: Env, from: string, to: string): Promise<HealthWorkout[]> {
  const rows = await env.DB.prepare(
    `SELECT ${HEALTH_COLUMNS} FROM health_workouts hw JOIN workout_sessions ws ON ws.id = hw.matched_session_id
     WHERE ws.local_date BETWEEN ? AND ? ORDER BY hw.started_at`
  )
    .bind(from, to)
    .all<HealthRow>();
  return rows.results;
}

/* ---------------- session-auth routes ---------------- */

export const healthRoutes = new Hono<AppBindings>();

healthRoutes.get("/status", async (c) => {
  const [last, result, workouts] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT value FROM settings WHERE key = 'health_last_received_at'"),
    c.env.DB.prepare("SELECT value FROM settings WHERE key = 'health_last_result'"),
    c.env.DB.prepare(`SELECT ${HEALTH_COLUMNS} FROM health_workouts hw ORDER BY hw.started_at DESC LIMIT 10`),
  ]);
  const lastResult = (result.results[0] as { value?: string } | undefined)?.value;
  return c.json({
    last_received_at: (last.results[0] as { value?: string } | undefined)?.value ?? null,
    last_result: lastResult ? JSON.parse(lastResult) : null,
    workouts: workouts.results,
  });
});

healthRoutes.put("/workouts/:id/match", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "شناسه معتبر نیست.");
  const body = await readJson(c, z.object({ session_id: z.string().regex(ID_RE) }));
  const session = await c.env.DB.prepare("SELECT id FROM workout_sessions WHERE id = ?").bind(body.session_id).first();
  if (!session) return fail(c, 404, "session_not_found", "جلسه پیدا نشد. اگر جلسه را آفلاین ساخته‌ای، اول بگذار همگام شود.");
  const res = await c.env.DB.prepare("UPDATE health_workouts SET matched_session_id = ? WHERE id = ?").bind(body.session_id, id).run();
  if (!res.meta.changes) return fail(c, 404, "not_found", "تمرین ساعت پیدا نشد.");
  const row = await c.env.DB.prepare(`SELECT ${HEALTH_COLUMNS} FROM health_workouts hw WHERE hw.id = ?`).bind(id).first<HealthRow>();
  return c.json({ ok: true, workout: row });
});

/* ---------------- raw ingest (bearer auth) ---------------- */

async function readRawBody(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("Content-Length") ?? "0");
  if (len > MAX_BODY) throw new RangeError("too_large");
  const type = (req.headers.get("Content-Type") ?? "").toLowerCase();
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    const out: Record<string, string[]> = {};
    for (const [k, v] of form.entries()) (out[k] ??= []).push(typeof v === "string" ? v : await v.text());
    return out;
  }
  const text = await req.text();
  if (text.length > MAX_BODY) throw new RangeError("too_large");
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Plain text body: treat it as the workouts text.
    return { workouts: trimmed };
  }
}

export async function ingestRaw(c: import("hono").Context<AppBindings>) {
  let payload: unknown;
  try {
    payload = await readRawBody(c.req.raw);
  } catch {
    return fail(c, 413, "too_large", "داده‌ی ارسالی خیلی بزرگ است.");
  }
  const settings = await readSettings(c.env);
  const parsed = parseShortcutsPayload(payload, settings.timezone);
  const received_at = nowISO();

  const stmts = [];
  const keys: string[] = [];
  for (const w of parsed.workouts) {
    const key = await sha256Hex(`${(w.activity_type ?? "workout").toLowerCase()}|${w.started_at}`);
    keys.push(key);
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO health_workouts (id, external_key, activity_type, started_at, ended_at, duration_sec, active_kcal, total_kcal, hr_avg, hr_max, matched_session_id, raw, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT (external_key) DO UPDATE SET
           activity_type = COALESCE(excluded.activity_type, health_workouts.activity_type),
           ended_at = COALESCE(excluded.ended_at, health_workouts.ended_at),
           duration_sec = COALESCE(excluded.duration_sec, health_workouts.duration_sec),
           active_kcal = COALESCE(excluded.active_kcal, health_workouts.active_kcal),
           total_kcal = COALESCE(excluded.total_kcal, health_workouts.total_kcal),
           hr_avg = COALESCE(excluded.hr_avg, health_workouts.hr_avg),
           hr_max = COALESCE(excluded.hr_max, health_workouts.hr_max),
           raw = excluded.raw,
           received_at = excluded.received_at`
      ).bind(
        ulid(),
        key,
        w.activity_type,
        w.started_at,
        w.ended_at,
        w.duration_sec,
        w.active_kcal,
        w.total_kcal,
        w.hr_avg,
        w.hr_max,
        JSON.stringify({ source: "shortcut", hr_count: w.hr_count }),
        received_at
      )
    );
  }

  let matched = 0;
  if (stmts.length) {
    await c.env.DB.batch(stmts);
    const starts = parsed.workouts.map((w) => Date.parse(w.started_at));
    await rematchUnmatched(c.env, new Date(Math.min(...starts) - 1000).toISOString(), new Date(Math.max(...starts) + 1000).toISOString(), settings.timezone);
    const r = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM health_workouts WHERE matched_session_id IS NOT NULL AND external_key IN (SELECT value FROM json_each(?))"
    )
      .bind(JSON.stringify(keys))
      .first<{ n: number }>();
    matched = r?.n ?? 0;
  }

  const summary = { stored: parsed.workouts.length, matched, hr_samples: parsed.hr_samples, warnings: parsed.warnings };
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('health_last_received_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(received_at),
    c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('health_last_result', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(summary)),
  ]);

  const message = parsed.workouts.length
    ? `Lodge Gym: ${faNum(parsed.workouts.length)} تمرین دریافت شد، ${faNum(matched)} مورد به جلسه وصل شد.`
    : "Lodge Gym: داده رسید ولی تمرینی در آن پیدا نشد.";
  return c.json({ ok: true, ...summary, message });
}

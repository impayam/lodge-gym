// Full JSON export (SPEC §11 GET /export) and the weekly automatic backup to R2 (Cron Trigger, keep 12).

import { Hono } from "hono";
import { readBodyMetrics, readSessions, readSettings } from "./data";
import type { AppBindings, Env } from "./env";
import { fail, nowISO } from "./http";
import { localDate } from "./lib/time";

export const BACKUP_PREFIX = "backups/";
export const BACKUPS_KEPT = 12;

export async function buildExport(env: Env) {
  const [settings, sessions, health, body, photos] = await Promise.all([
    readSettings(env),
    readSessions(env, "0000-01-01", "9999-12-31"),
    env.DB.prepare(
      "SELECT id, external_key, activity_type, started_at, ended_at, duration_sec, active_kcal, total_kcal, hr_avg, hr_max, matched_session_id, received_at FROM health_workouts ORDER BY started_at"
    ).all(),
    readBodyMetrics(env, "0000-01-01", "9999-12-31"),
    env.DB.prepare("SELECT id, session_id, local_date, pose, width, height, bytes, created_at FROM photos ORDER BY local_date, created_at").all(),
  ]);
  return {
    app: "lodge-gym",
    format: 1,
    exported_at: nowISO(),
    settings,
    sessions: [...sessions].sort((a, b) => (a.local_date + a.started_at).localeCompare(b.local_date + b.started_at)),
    health_workouts: health.results,
    body_metrics: body,
    photos: photos.results,
  };
}

/** Writes today's backup to R2 and keeps only the newest BACKUPS_KEPT. */
export async function runBackup(env: Env): Promise<{ key: string; bytes: number; deleted: string[] }> {
  const data = await buildExport(env);
  const body = JSON.stringify(data);
  const key = `${BACKUP_PREFIX}lodge-gym-${localDate(data.settings.timezone)}.json`;
  await env.PHOTOS.put(key, body, { httpMetadata: { contentType: "application/json" }, customMetadata: { exported_at: data.exported_at } });
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: BACKUP_PREFIX, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const old = keys.sort().reverse().slice(BACKUPS_KEPT);
  if (old.length) await env.PHOTOS.delete(old);
  return { key, bytes: body.length, deleted: old };
}

const download = (body: BodyInit, name: string) =>
  new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });

export const exportRoutes = new Hono<AppBindings>();

exportRoutes.get("/export", async (c) => {
  const data = await buildExport(c.env);
  return download(JSON.stringify(data), `lodge-gym-export-${localDate(data.settings.timezone)}.json`);
});

exportRoutes.get("/backups", async (c) => {
  const page = await c.env.PHOTOS.list({ prefix: BACKUP_PREFIX });
  const backups = page.objects
    .map((o) => ({ name: o.key.slice(BACKUP_PREFIX.length), bytes: o.size, uploaded: o.uploaded.toISOString() }))
    .sort((a, b) => b.name.localeCompare(a.name));
  return c.json({ backups });
});

exportRoutes.get("/backups/latest", async (c) => {
  const page = await c.env.PHOTOS.list({ prefix: BACKUP_PREFIX });
  const latest = page.objects.map((o) => o.key).sort().pop();
  if (!latest) return fail(c, 404, "no_backup", "هنوز پشتیبان خودکاری ساخته نشده است.");
  const obj = await c.env.PHOTOS.get(latest);
  if (!obj) return fail(c, 404, "no_backup", "پشتیبان پیدا نشد.");
  return download(obj.body, latest.slice(BACKUP_PREFIX.length));
});

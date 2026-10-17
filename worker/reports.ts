// Report endpoints (SPEC §10/§11): computed on the server from D1.

import { Hono } from "hono";
import { readExercises, readProgram, readProgramVersions, readSessions, readSettings, readBodyMetrics } from "./data";
import type { AppBindings, Env } from "./env";
import { fail } from "./http";
import { monthKeyOf, monthRange, monthlyReport, progressReport, setsCsv, weeklyReport, type ReportData } from "./lib/reports";
import { DATE_RE, localDate } from "./lib/time";
import { weekRange } from "./lib/cycle";
import { profile } from "./lib/profile";
import { readGoals, readMeasurements } from "./body";
import type { HealthWorkout, Photo } from "./lib/types";

export async function loadReportData(env: Env): Promise<ReportData> {
  const settings = await readSettings(env);
  const [{ program }, programs, exercises, sessions, watch, body, photos, goals, measurements] = await Promise.all([
    readProgram(env),
    readProgramVersions(env),
    readExercises(env),
    readSessions(env, "0000-01-01", "9999-12-31"),
    env.DB.prepare(
      `SELECT id, activity_type, started_at, ended_at, duration_sec, active_kcal, total_kcal, hr_avg, hr_max, matched_session_id,
         CASE WHEN external_key LIKE 'session:%' THEN 'session' ELSE 'workout' END AS kind
       FROM health_workouts WHERE matched_session_id IS NOT NULL`
    ).all<HealthWorkout>(),
    readBodyMetrics(env, "0000-01-01", "9999-12-31"),
    env.DB.prepare("SELECT id, session_id, local_date, pose, framing, width, height, bytes, created_at FROM photos").all<Photo>(),
    readGoals(env),
    readMeasurements(env),
  ]);
  return { settings, program, programs, exercises, sessions, watch: watch.results, body, photos: photos.results, goals, measurements };
}

const csv = (body: string, name: string) =>
  new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const reportRoutes = new Hono<AppBindings>();

reportRoutes.get("/week", async (c) => {
  const d = await loadReportData(c.env);
  const start = c.req.query("start") ?? localDate(d.settings.timezone);
  if (!DATE_RE.test(start)) return fail(c, 400, "invalid_input", "The week date is not valid.");
  if (c.req.query("format") === "csv") {
    const r = weekRange(start, d.settings.week_start);
    return csv(setsCsv(d, r.start, r.end), `gym-time-week-${r.start}.csv`);
  }
  return c.json(weeklyReport(d, start));
});

reportRoutes.get("/month", async (c) => {
  const d = await loadReportData(c.env);
  const key = c.req.query("month") ?? monthKeyOf(localDate(d.settings.timezone));
  if (!MONTH_RE.test(key)) return fail(c, 400, "invalid_input", "The month is not valid.");
  if (c.req.query("format") === "csv") {
    const r = monthRange(key);
    return csv(setsCsv(d, r.start, r.end), `gym-time-month-${key}.csv`);
  }
  return c.json(monthlyReport(d, key, localDate(d.settings.timezone)));
});

reportRoutes.get("/progress", async (c) => {
  const d = await loadReportData(c.env);
  return c.json(progressReport(d, localDate(d.settings.timezone)));
});

/** GET /api/profile (SPEC-v12 M15 §3, §5): the after-session line, the Living Diamond and the body goal line. */
export const profileRoutes = new Hono<AppBindings>();

profileRoutes.get("/", async (c) => {
  const d = await loadReportData(c.env);
  return c.json(profile({ ...d, goals: d.goals ?? null, measurements: d.measurements ?? [] }, localDate(d.settings.timezone)));
});

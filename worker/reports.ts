// Report endpoints (SPEC §10/§11): computed on the server from D1.

import { Hono } from "hono";
import { readExercises, readProgram, readSessions, readSettings, readBodyMetrics } from "./data";
import type { AppBindings, Env } from "./env";
import { fail } from "./http";
import { monthKeyOf, monthRange, monthlyReport, progressReport, setsCsv, weeklyReport, type ReportData } from "./lib/reports";
import { DATE_RE, localDate } from "./lib/time";
import { weekRange } from "./lib/cycle";
import type { HealthWorkout, Photo } from "./lib/types";

export async function loadReportData(env: Env): Promise<ReportData> {
  const settings = await readSettings(env);
  const [{ program }, exercises, sessions, watch, body, photos] = await Promise.all([
    readProgram(env),
    readExercises(env),
    readSessions(env, "0000-01-01", "9999-12-31"),
    env.DB.prepare(
      `SELECT id, activity_type, started_at, ended_at, duration_sec, active_kcal, total_kcal, hr_avg, hr_max, matched_session_id,
         CASE WHEN external_key LIKE 'session:%' THEN 'session' ELSE 'workout' END AS kind
       FROM health_workouts WHERE matched_session_id IS NOT NULL`
    ).all<HealthWorkout>(),
    readBodyMetrics(env, "0000-01-01", "9999-12-31"),
    env.DB.prepare("SELECT id, session_id, local_date, pose, width, height, bytes, created_at FROM photos").all<Photo>(),
  ]);
  return { settings, program, exercises, sessions, watch: watch.results, body, photos: photos.results };
}

const csv = (body: string, name: string) =>
  new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const reportRoutes = new Hono<AppBindings>();

reportRoutes.get("/week", async (c) => {
  const d = await loadReportData(c.env);
  const start = c.req.query("start") ?? localDate(d.settings.timezone);
  if (!DATE_RE.test(start)) return fail(c, 400, "invalid_input", "تاریخ هفته معتبر نیست.");
  if (c.req.query("format") === "csv") {
    const r = weekRange(start, d.settings.week_start);
    return csv(setsCsv(d, r.start, r.end), `lodge-gym-week-${r.start}.csv`);
  }
  return c.json(weeklyReport(d, start));
});

reportRoutes.get("/month", async (c) => {
  const d = await loadReportData(c.env);
  const key = c.req.query("month") ?? monthKeyOf(localDate(d.settings.timezone), d.settings.month_calendar);
  if (!MONTH_RE.test(key)) return fail(c, 400, "invalid_input", "ماه معتبر نیست.");
  if (c.req.query("format") === "csv") {
    const r = monthRange(key, d.settings.month_calendar);
    return csv(setsCsv(d, r.start, r.end), `lodge-gym-month-${key}.csv`);
  }
  return c.json(monthlyReport(d, key));
});

reportRoutes.get("/progress", async (c) => {
  const d = await loadReportData(c.env);
  return c.json(progressReport(d, localDate(d.settings.timezone)));
});

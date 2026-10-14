// Training overview (SPEC-v7 M9d), behind sign-in:
//   GET  /api/overview          the latest overview, whether a newer attempt failed, and whether one is being written
//   POST /api/overview          rewrite it now (Regenerate), in the background
//   GET  /api/session-reports   every session's latest report, newest session first (the Reports list)
//   GET  /api/report-timeline   every saved report on its date, for History → Reports timeline (no report text)
//   GET  /api/overviews/:id     one saved overview, read-only (opened from the timeline)
// The overview is rewritten by the AiJobs Durable Object after every finished session, right after that session's
// report (worker/aiReports.ts). Older rows are kept; a failed attempt never hides the previous overview.

import { Hono } from "hono";
import { callModel, effortOf, maxTokensOf, modelOf, type AiFail, type AiOk } from "./ai";
import { errorText, overLimit } from "./aiLimits";
import { readProgramInfos, readSettings } from "./data";
import type { AppBindings, Env } from "./env";
import { fail, nowISO } from "./http";
import { readAllPlans } from "./plans";
import { loadReportData } from "./reports";
import { DAILY_LIMIT, errorCode } from "./lib/ai/cost";
import {
  buildOverviewInput,
  checkOverview,
  normalizeOverview,
  OVERVIEW_SYSTEM,
  OverviewOutput,
  type OverviewResponse,
  type OverviewView,
  type SessionReportItem,
  type TrainingOverview,
} from "./lib/ai/overview";
import { buildTimeline, type TimelineItem, type TimelineRows } from "./lib/ai/timeline";
import { localDate } from "./lib/time";
import { ID_RE, ulid } from "./lib/ulid";

/** Default reply size of an overview (OVERVIEW_MAX_TOKENS); thinking counts toward it. */
export const OVERVIEW_DEFAULT_MAX_TOKENS = 4000;

interface OverviewRow {
  id: string;
  created_at: string;
  trigger_session_id: string | null;
  window_start: string;
  window_end: string;
  model: string;
  status: "ok" | "error";
  overview_json: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * Writes one overview row (ok or error) over this week and the previous 4. `triggerSessionId` is the finished session
 * that asked for it, or null (Regenerate).
 */
export async function generateOverview(env: Env, triggerSessionId: string | null): Promise<OverviewRow> {
  const [d, plans, infos] = await Promise.all([loadReportData(env), readAllPlans(env), readProgramInfos(env)]);
  const today = localDate(d.settings.timezone);
  const input = buildOverviewInput(d, plans, today, infos.find((p) => p.status === "active")?.style ?? null);
  const row: OverviewRow = {
    id: ulid(),
    created_at: nowISO(),
    trigger_session_id: triggerSessionId,
    window_start: input.window.start,
    window_end: input.window.end,
    model: modelOf(env),
    status: "error",
    overview_json: null,
    error: null,
    input_tokens: null,
    output_tokens: null,
  };
  if (await overLimit(env, "overview")) {
    row.error = `limit: The daily limit of ${DAILY_LIMIT.overview} overviews is reached.`;
  } else {
    const r: AiOk<OverviewOutput> | AiFail = await callModel(env, {
      system: OVERVIEW_SYSTEM,
      input,
      schema: OverviewOutput,
      effort: effortOf(env.OVERVIEW_EFFORT, "medium"),
      maxTokens: maxTokensOf(env.OVERVIEW_MAX_TOKENS, OVERVIEW_DEFAULT_MAX_TOKENS),
      check: (out) => checkOverview(out, input),
    });
    Object.assign(row, { model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens });
    if (r.ok) Object.assign(row, { status: "ok", overview_json: JSON.stringify(normalizeOverview(r.data, input)) });
    else row.error = errorText(r);
  }
  // The triggering session may have been deleted meanwhile; the overview stays, without its trigger.
  if (row.trigger_session_id && !(await env.DB.prepare("SELECT 1 AS x FROM workout_sessions WHERE id = ?").bind(row.trigger_session_id).first())) row.trigger_session_id = null;
  await env.DB.prepare(
    `INSERT INTO training_overviews (id, created_at, trigger_session_id, window_start, window_end, model, status, overview_json, error, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(row.id, row.created_at, row.trigger_session_id, row.window_start, row.window_end, row.model, row.status, row.overview_json, row.error, row.input_tokens, row.output_tokens)
    .run();
  return row;
}

const jobs = (env: Env) => env.AI_JOBS.get(env.AI_JOBS.idFromName("owner"));

async function viewOf(env: Env, r: OverviewRow): Promise<OverviewView> {
  const s = r.trigger_session_id
    ? await env.DB.prepare("SELECT id, program_day_id, local_date FROM workout_sessions WHERE id = ?").bind(r.trigger_session_id).first<{ id: string; program_day_id: string; local_date: string }>()
    : null;
  return {
    id: r.id,
    created_at: r.created_at,
    model: r.model,
    window_start: r.window_start,
    window_end: r.window_end,
    trigger: s ? { session_id: s.id, program_day_id: s.program_day_id, local_date: s.local_date } : null,
    overview: JSON.parse(r.overview_json!) as TrainingOverview,
  };
}

export const overviewRoutes = new Hono<AppBindings>();

overviewRoutes.get("/overview", async (c) => {
  // The queue first: a job leaves it only after its row is written.
  const pending = await jobs(c.env).overviewPending();
  const [ok, last] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM training_overviews WHERE status = 'ok' ORDER BY created_at DESC, id DESC LIMIT 1").first<OverviewRow>(),
    c.env.DB.prepare("SELECT * FROM training_overviews ORDER BY created_at DESC, id DESC LIMIT 1").first<OverviewRow>(),
  ]);
  const failed = last && last.status === "error" && (!ok || last.created_at > ok.created_at) ? { created_at: last.created_at, error_code: errorCode(last.error) } : null;
  return c.json<OverviewResponse>({ overview: ok ? await viewOf(c.env, ok) : null, failed, pending });
});

overviewRoutes.post("/overview", async (c) => {
  if (await overLimit(c.env, "overview")) return fail(c, 429, "limit", `The daily limit of ${DAILY_LIMIT.overview} overviews is reached. Try again tomorrow.`);
  await jobs(c.env).enqueueOverview(null);
  return c.json({ ok: true, pending: true }, 202);
});

overviewRoutes.get("/overviews/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "The overview id is not valid.");
  const row = await c.env.DB.prepare("SELECT * FROM training_overviews WHERE id = ? AND status = 'ok'").bind(id).first<OverviewRow>();
  if (!row) return fail(c, 404, "not_found", "No saved overview with this id.");
  return c.json({ overview: await viewOf(c.env, row) });
});

overviewRoutes.get("/report-timeline", async (c) => {
  const [reports, overviews, reviews] = await c.env.DB.batch([
    // A session's latest report, when it is ok (a newer failed attempt hides the session from the timeline).
    c.env.DB.prepare(
      `SELECT r.session_id, s.local_date, s.program_day_id, r.created_at
       FROM session_reports r JOIN workout_sessions s ON s.id = r.session_id
       WHERE r.status = 'ok' AND r.id = (SELECT r2.id FROM session_reports r2 WHERE r2.session_id = r.session_id ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)`
    ),
    c.env.DB.prepare(
      `SELECT o.id, o.created_at, s.local_date AS trigger_date, s.program_day_id AS trigger_day
       FROM training_overviews o LEFT JOIN workout_sessions s ON s.id = o.trigger_session_id WHERE o.status = 'ok'`
    ),
    c.env.DB.prepare("SELECT id, week_start, created_at FROM weekly_reviews"),
  ]);
  const { timezone } = await readSettings(c.env);
  const rows: TimelineRows = {
    reports: reports.results as TimelineRows["reports"],
    overviews: overviews.results as TimelineRows["overviews"],
    reviews: reviews.results as TimelineRows["reviews"],
  };
  return c.json<{ items: TimelineItem[] }>({ items: buildTimeline(rows, timezone) });
});

overviewRoutes.get("/session-reports", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.session_id, s.local_date, s.program_day_id, r.created_at, r.status, json_extract(r.report_json, '$.summary_fa') AS summary_fa, r.error
     FROM session_reports r JOIN workout_sessions s ON s.id = r.session_id
     WHERE r.id = (SELECT r2.id FROM session_reports r2 WHERE r2.session_id = r.session_id ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)
     ORDER BY s.local_date DESC, s.started_at DESC`
  ).all<Omit<SessionReportItem, "error_code"> & { error: string | null }>();
  const reports: SessionReportItem[] = rows.results.map(({ error, ...r }) => ({ ...r, error_code: errorCode(error) }));
  return c.json({ reports });
});

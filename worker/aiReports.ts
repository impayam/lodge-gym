// AI session report and plan advice endpoints (SPEC-v3 M9a, M9c), behind sign-in:
//   GET  /api/sessions/:id/report        the latest report row, whether one is queued, and when it will be written
//   POST /api/sessions/:id/report        "Write report now": write (or rewrite) it at once in the background; older rows are kept
//   POST /api/sessions/:id/plan-advice   advice on a saved plan, one model call per tap
//   GET  /api/ai/usage                   Settings: this month's reports, advice and cost; the key's status
// Reports are written by the AiJobs Durable Object from an alarm (up to 15 minutes, retried), not by ctx.waitUntil,
// whose 30 s after the response is shorter than a report can take (approved 2026-10-13). A session that syncs as done
// queues its report; nothing ever blocks finishing a session.

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { callModel, effortOf, modelOf, type AiFail, type AiOk } from "./ai";
import { mapExercise, readProgramInfos, readSettings } from "./data";
import type { AppBindings, Env } from "./env";
import { fail, nowISO } from "./http";
import { readPlan } from "./plans";
import { loadReportData } from "./reports";
import { ADVICE_SYSTEM, AdviceOutput, buildAdviceInput, validateAdvice, type PlanAdvice } from "./lib/ai/advice";
import { costUsd, DAILY_LIMIT, errorCode, keyStatus, monthUsage, usedToday, type AiUsage } from "./lib/ai/cost";
import { aiRows, errorText, overLimit } from "./aiLimits";
import { generateOverview } from "./aiOverview";
import { buildOverviewInput, whereYouAre } from "./lib/ai/overview";
import { buildReportInput, normalizeReport, REPORT_SYSTEM, ReportOutput, type ReportView, type SessionReport } from "./lib/ai/report";
import { addDays, localDate, zonedToUtcISO } from "./lib/time";
import { monthRange } from "./lib/reports";
import { ID_RE, ulid } from "./lib/ulid";
import { coachMonth } from "./coach";
import { runCoachTurn, type CoachEvent } from "./coachTurn";

/* ---------------- rows ---------------- */

interface ReportRow {
  id: string;
  session_id: string;
  created_at: string;
  model: string;
  status: "ok" | "error";
  report_json: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

const reportView = (r: ReportRow): ReportView => ({
  id: r.id,
  created_at: r.created_at,
  model: r.model,
  status: r.status,
  report: r.report_json ? (JSON.parse(r.report_json) as SessionReport) : null,
  error_code: errorCode(r.error),
  error: r.error,
  cost_usd: costUsd(r.model, r.input_tokens, r.output_tokens),
});

/* ---------------- session report ---------------- */

/**
 * Writes one report row for a done session: the validated report, or the error (key missing or invalid, API or
 * network error, reply invalid twice, daily limit). Nothing is written for a session that is gone or not done.
 */
export async function generateReport(env: Env, sessionId: string): Promise<ReportView | null> {
  const s = await env.DB.prepare("SELECT status FROM workout_sessions WHERE id = ?").bind(sessionId).first<{ status: string }>();
  if (!s || s.status !== "done") return null;
  const row: ReportRow = { id: ulid(), session_id: sessionId, created_at: nowISO(), model: modelOf(env), status: "error", report_json: null, error: null, input_tokens: null, output_tokens: null };
  if (await overLimit(env, "report")) {
    row.error = `limit: The daily limit of ${DAILY_LIMIT.report} reports is reached.`;
  } else {
    const d = await loadReportData(env);
    const input = buildReportInput(d, sessionId, await readPlan(env, sessionId));
    // "Where you are" as of the session's date: the overview's consistency and main-lift facts (no plans needed).
    input.where_you_are = whereYouAre(buildOverviewInput(d, [], input.session.date, null));
    input.recent_motivation = await recentMotivation(env);
    const r: AiOk<ReportOutput> | AiFail = await callModel(env, { system: REPORT_SYSTEM, input, schema: ReportOutput, effort: effortOf(env.REPORT_EFFORT, "low") });
    Object.assign(row, { model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens });
    if (r.ok) Object.assign(row, { status: "ok", report_json: JSON.stringify(normalizeReport(r.data, input)) });
    else row.error = errorText(r);
  }
  // The session may have been deleted while the model was writing.
  const still = await env.DB.prepare("SELECT 1 AS x FROM workout_sessions WHERE id = ?").bind(sessionId).first();
  if (!still) return null;
  await env.DB.prepare(
    "INSERT INTO session_reports (id, session_id, created_at, model, status, report_json, error, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(row.id, row.session_id, row.created_at, row.model, row.status, row.report_json, row.error, row.input_tokens, row.output_tokens)
    .run();
  return reportView(row);
}

/** Lines kept so the next report's motivational line says something new. */
const RECENT_MOTIVATION = 6;

/** The motivational lines of the latest written reports (a rewrite of this session's included), newest first. */
async function recentMotivation(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT json_extract(report_json, '$.motivation_fa') AS line FROM session_reports WHERE status = 'ok' AND json_extract(report_json, '$.motivation_fa') IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ?"
  )
    .bind(RECENT_MOTIVATION)
    .all<{ line: string }>();
  return rows.results.map((r) => r.line);
}

/** A queued job: a session's report, or the training overview (a manual Regenerate). */
interface Job {
  /** Jobs queued before SPEC-v7 have no kind: they are reports. */
  kind?: "report" | "overview";
  /** report: its session; overview: the session that triggered it, or null. */
  session_id: string | null;
  queued_at: number;
  attempts: number;
  /** When it may run (ms). A report waits for its timing rule; jobs queued before it have none and run at once. */
  run_at?: number;
}

const kindOf = (j: Job) => j.kind ?? "report";
const runAtOf = (j: Job) => j.run_at ?? j.queued_at;
const sameJob = (a: Job, b: Job) => kindOf(a) === kindOf(b) && a.session_id === b.session_id && a.queued_at === b.queued_at;

/** Retries of a job whose run threw (D1 or runtime trouble; model errors are stored as rows, not retried here). */
const JOB_ATTEMPTS = 3;

/**
 * The after-session report is written once (Payam, 2026-10-16): as soon as that day's body weight and the Apple Health
 * workout matched to the session are both in, or REPORT_WAIT_MS after the session ends, whichever comes first. "Write
 * report now" writes it at once.
 */
export const REPORT_WAIT_MS = 2 * 3_600_000;

/** That day's body weight (any source) and the watch workout matched to the session are both in. */
export async function reportReady(env: Env, sessionId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM body_metrics b WHERE b.local_date = s.local_date AND b.kind = 'body_mass') AS weight,
            EXISTS (SELECT 1 FROM health_workouts h WHERE h.matched_session_id = s.id) AS watch
     FROM workout_sessions s WHERE s.id = ?`
  )
    .bind(sessionId)
    .first<{ weight: number; watch: number }>();
  return Boolean(r?.weight && r?.watch);
}

/**
 * The background writer of session reports and the training overview: one object for the single user, a queue in its
 * storage, and an alarm that runs the due jobs one by one in queue order (an alarm may run 15 minutes and is retried
 * by the platform). A job runs from its run_at on; the alarm is set for the earliest one. A finished session queues
 * its report for its timing rule; the overview is written only on a manual Regenerate.
 */
export class AiJobs extends DurableObject<Env> {
  /** Chats with an answer being written (one at a time per chat). */
  private coachRunning = new Set<string>();

  /**
   * One coach answer (SPEC-v9 M12, worker/coachTurn.ts), streamed as server-sent events. It runs here for the Durable
   * Object's CPU budget; it keeps running if the chat closes, and its rows are saved as they come. Null while the chat
   * already has an answer being written. A comment line every 15 s keeps the connection open while the model thinks.
   */
  async coachTurn(threadId: string): Promise<ReadableStream<Uint8Array> | null> {
    if (this.coachRunning.has(threadId)) return null;
    this.coachRunning.add(threadId);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    let open = true;
    const write = (chunk: string) => {
      if (open) writer.write(enc.encode(chunk)).catch(() => (open = false));
    };
    const ping = setInterval(() => write(": ping\n\n"), 15_000);
    const run = runCoachTurn(this.env, threadId, (e: CoachEvent) => write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`))
      .catch((e) => {
        console.error(`coach ${threadId} failed: ${e instanceof Error ? e.message : String(e)}`);
        write(`event: error\ndata: ${JSON.stringify({ type: "error", code: "internal", message: "The answer failed on the server." })}\n\n`);
      })
      .finally(() => {
        clearInterval(ping);
        this.coachRunning.delete(threadId);
        if (open) writer.close().catch(() => undefined);
      });
    this.ctx.waitUntil(run);
    return readable;
  }

  private async jobs(): Promise<Job[]> {
    return (await this.ctx.storage.get<Job[]>("jobs")) ?? [];
  }

  /** The alarm at the earliest job's run_at (never later than one already set for it). */
  private async wake(jobs?: Job[]): Promise<void> {
    const list = jobs ?? (await this.jobs());
    if (!list.length) return;
    const next = Math.max(Date.now(), Math.min(...list.map(runAtOf)));
    const set = await this.ctx.storage.getAlarm();
    if (set == null || set > next) await this.ctx.storage.setAlarm(next);
  }

  /** A session's report from `runAt` on (default now); a report already queued keeps the earlier of the two times. */
  async enqueue(sessionId: string, runAt: number = Date.now()): Promise<void> {
    const jobs = await this.jobs();
    const job = jobs.find((j) => kindOf(j) === "report" && j.session_id === sessionId);
    if (job) job.run_at = Math.min(runAtOf(job), runAt);
    else jobs.push({ kind: "report", session_id: sessionId, queued_at: Date.now(), attempts: 0, run_at: runAt });
    await this.ctx.storage.put("jobs", jobs);
    await this.wake(jobs);
  }

  /** Waiting reports whose body weight and watch workout are now both in run now. */
  async checkReady(): Promise<number> {
    const jobs = await this.jobs();
    const now = Date.now();
    let moved = 0;
    for (const j of jobs)
      if (kindOf(j) === "report" && j.session_id && runAtOf(j) > now && (await reportReady(this.env, j.session_id))) {
        j.run_at = now;
        moved++;
      }
    if (moved) {
      await this.ctx.storage.put("jobs", jobs);
      await this.wake(jobs);
    }
    return moved;
  }

  /** When a session's queued report will be written (ms), or null when none is queued. */
  async dueAt(sessionId: string): Promise<number | null> {
    const job = (await this.jobs()).find((j) => kindOf(j) === "report" && j.session_id === sessionId);
    return job ? runAtOf(job) : null;
  }

  /**
   * Queues an overview at the end of the queue. One that is waiting (not first, so not running) is moved to the end
   * and takes the newer trigger: one overview after the latest data is enough.
   */
  async enqueueOverview(triggerSessionId: string | null): Promise<void> {
    const jobs = (await this.jobs()).filter((j, i) => !(kindOf(j) === "overview" && i > 0));
    jobs.push({ kind: "overview", session_id: triggerSessionId, queued_at: Date.now(), attempts: 0 });
    await this.ctx.storage.put("jobs", jobs);
    await this.wake(jobs);
  }

  async overviewPending(): Promise<boolean> {
    return (await this.jobs()).some((j) => kindOf(j) === "overview");
  }

  /** The queue, for tests and diagnostics. */
  async queued(): Promise<{ kind: "report" | "overview"; session_id: string | null; run_at: number }[]> {
    return (await this.jobs()).map((j) => ({ kind: kindOf(j), session_id: j.session_id, run_at: runAtOf(j) }));
  }

  async alarm(): Promise<void> {
    const queue = await this.jobs();
    // The first due job in queue order; none due yet: wait for the earliest.
    const job = queue.find((j) => runAtOf(j) <= Date.now());
    if (!job) {
      await this.wake(queue);
      return;
    }
    let done = true;
    try {
      if (kindOf(job) === "overview") await generateOverview(this.env, job.session_id);
      else if (job.session_id) await generateReport(this.env, job.session_id);
    } catch (e) {
      console.error(`${kindOf(job)} ${job.session_id ?? "-"} failed: ${e instanceof Error ? e.message : String(e)}`);
      done = job.attempts + 1 >= JOB_ATTEMPTS;
    }
    // Re-read: jobs may have been queued while this one ran. A failed run waits 30 s × attempts; other jobs go on.
    const jobs = (await this.jobs()).flatMap((j) =>
      !sameJob(j, job) ? [j] : done ? [] : [{ ...j, attempts: j.attempts + 1, run_at: Date.now() + 30_000 * (job.attempts + 1) }]
    );
    await this.ctx.storage.put("jobs", jobs);
    if (jobs.length) await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...jobs.map(runAtOf))));
  }
}

const jobs = (env: Env) => env.AI_JOBS.get(env.AI_JOBS.idFromName("owner"));

/**
 * A session that just synced as done gets its after-session report (unless it already has one), written by the timing
 * rule: at once when that day's body weight and its watch workout are in, else REPORT_WAIT_MS after it ended. The
 * training overview is no longer rewritten after each session (Payam, 2026-10-16).
 */
export async function queueAfterSession(env: Env, sessionId: string): Promise<void> {
  const has = await env.DB.prepare("SELECT 1 AS x FROM session_reports WHERE session_id = ? LIMIT 1").bind(sessionId).first();
  if (has) return;
  const s = await env.DB.prepare("SELECT started_at, ended_at FROM workout_sessions WHERE id = ?").bind(sessionId).first<{ started_at: string; ended_at: string | null }>();
  if (!s) return;
  const due = Date.parse(s.ended_at ?? s.started_at) + REPORT_WAIT_MS;
  await jobs(env).enqueue(sessionId, (await reportReady(env, sessionId)) ? Date.now() : due);
}

/** A body weight or a watch workout came in: waiting reports that now have both are written. */
export async function reportsMayBeReady(env: Env): Promise<void> {
  await jobs(env).checkReady();
}

/* ---------------- routes ---------------- */

export const aiSessionRoutes = new Hono<AppBindings>();

aiSessionRoutes.get("/:id/report", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "The session id is not valid.");
  const s = await c.env.DB.prepare("SELECT status FROM workout_sessions WHERE id = ?").bind(id).first<{ status: string }>();
  if (!s) return fail(c, 404, "not_found", "The session has not reached the server yet.");
  // The queue first: a job leaves it only after its row is written, so "not pending" always comes with that row.
  const due = await jobs(c.env).dueAt(id);
  const r = await c.env.DB.prepare("SELECT * FROM session_reports WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(id).first<ReportRow>();
  // due_at: when the queued report will be written (its timing rule), or null when none is queued.
  return c.json({ report: r ? reportView(r) : null, pending: due != null, due_at: due == null ? null : new Date(due).toISOString(), session_status: s.status });
});

aiSessionRoutes.post("/:id/report", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "The session id is not valid.");
  const s = await c.env.DB.prepare("SELECT status FROM workout_sessions WHERE id = ?").bind(id).first<{ status: string }>();
  if (!s) return fail(c, 404, "not_found", "The session has not reached the server yet.");
  if (s.status !== "done") return fail(c, 409, "not_done", "Finish the session first.");
  if (await overLimit(c.env, "report")) return fail(c, 429, "limit", `The daily limit of ${DAILY_LIMIT.report} reports is reached. Try again tomorrow.`);
  await jobs(c.env).enqueue(id);
  return c.json({ ok: true, pending: true }, 202);
});

interface AdviceRow {
  id: string;
  created_at: string;
  model: string;
  status: "ok" | "error";
}

aiSessionRoutes.post("/:id/plan-advice", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "The plan id is not valid.");
  const plan = await readPlan(c.env, id);
  if (!plan) return fail(c, 404, "not_found", "Plan not found. Save it first.");
  if (plan.status !== "planned") return fail(c, 409, "not_planned", "Advice is for a plan that has not started.");
  if (await overLimit(c.env, "advice")) return fail(c, 429, "limit", `The daily limit of ${DAILY_LIMIT.advice} advice requests is reached. Try again tomorrow.`);
  const [d, library, infos] = await Promise.all([
    loadReportData(c.env),
    c.env.DB.prepare("SELECT * FROM exercises").all<Record<string, unknown>>(),
    readProgramInfos(c.env),
  ]);
  const now = nowISO();
  const input = buildAdviceInput(d, plan, library.results.map(mapExercise), now, localDate(d.settings.timezone), infos.find((p) => p.status === "active")?.style ?? null);
  const r = await callModel(c.env, { system: ADVICE_SYSTEM, input, schema: AdviceOutput, effort: effortOf(c.env.ADVICE_EFFORT, "medium") });
  const row: AdviceRow = { id: ulid(), created_at: nowISO(), model: r.model, status: r.ok ? "ok" : "error" };
  let advice: PlanAdvice | null = null;
  let dropped = 0;
  if (r.ok) ({ advice, dropped } = validateAdvice(r.data, plan, input.candidates));
  await c.env.DB.prepare(
    "INSERT INTO plan_advice (id, session_id, created_at, model, status, advice_json, error, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(row.id, id, row.created_at, row.model, row.status, advice ? JSON.stringify(advice) : null, r.ok ? null : errorText(r), r.input_tokens, r.output_tokens)
    .run();
  if (!r.ok) return fail(c, r.code === "missing" || r.code === "auth" ? 503 : 502, `ai_${r.code}`, r.code === "auth" ? "Advice unavailable — API key expired or invalid." : "Advice unavailable. Try again.");
  return c.json({ id: row.id, created_at: row.created_at, model: row.model, advice, dropped, candidates: input.candidates.map((x) => ({ id: x.id, name: x.name })) });
});

export const aiRoutes = new Hono<AppBindings>();

aiRoutes.get("/usage", async (c) => {
  const { timezone } = await readSettings(c.env);
  const today = localDate(timezone);
  const rows = await aiRows(c.env, new Date(Date.now() - 40 * 86_400_000).toISOString());
  const month = monthRange(today.slice(0, 7));
  const coach = await coachMonth(c.env, zonedToUtcISO(month.start, "00:00", timezone), zonedToUtcISO(addDays(month.end, 1), "00:00", timezone));
  return c.json<AiUsage>({
    model: modelOf(c.env),
    key: c.env.ANTHROPIC_API_KEY?.trim() ? "set" : "missing",
    key_status: keyStatus(rows),
    month: monthUsage(rows, timezone, today.slice(0, 7)),
    today: {
      reports: usedToday(rows, "report", timezone, today),
      advice: usedToday(rows, "advice", timezone, today),
      overviews: usedToday(rows, "overview", timezone, today),
    },
    limits: DAILY_LIMIT,
    coach,
  });
});

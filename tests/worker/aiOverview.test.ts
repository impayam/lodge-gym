import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OverviewResponse, SessionReportItem } from "../../worker/lib/ai/overview";
import type { SetEntry, WeeklyReview, WorkoutSession } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import { mockAnthropic, OVERVIEW_REPLY, REPORT_REPLY } from "../fixtures/anthropic-mock";
import { Client, resetAuth, setupOwner } from "./helpers";

// SPEC-v7 M9d: the training overview, rewritten by the AiJobs Durable Object after every finished session, right after
// that session's report. The Anthropic API is mocked in every test.
let client: Client;
let mock: ReturnType<typeof mockAnthropic> | null = null;
const jobs = () => env.AI_JOBS.get(env.AI_JOBS.idFromName("owner"));

beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.83"));
});
beforeEach(async () => {
  await settled();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM training_overviews"),
    env.DB.prepare("DELETE FROM plan_advice"),
    env.DB.prepare("DELETE FROM session_reports"),
    env.DB.prepare("DELETE FROM set_entries"),
    env.DB.prepare("DELETE FROM workout_sessions"),
  ]);
});
afterEach(() => {
  mock?.restore();
  mock = null;
});

/**
 * Runs the queued jobs (unless the runtime already started its alarm) until the queue is empty. A session that reached
 * the server as done queues its report, then the training overview (SPEC-v7 M9d), in the background after the response
 * (waitUntil): with `sessionId`, first wait until that has happened.
 */
async function settled(sessionId?: string) {
  if (sessionId)
    await expect
      .poll(
        async () =>
          (await jobs().queued()).some((j) => j.kind === "overview" && j.session_id === sessionId) ||
          !!(await env.DB.prepare("SELECT 1 AS x FROM training_overviews WHERE trigger_session_id = ?").bind(sessionId).first()),
        { timeout: 20_000, interval: 50 }
      )
      .toBe(true);
  for (let i = 0; i < 10 && (await jobs().queued()).length; i++) {
    await runDurableObjectAlarm(jobs());
    await expect.poll(async () => (await jobs().queued()).length <= 1, { timeout: 20_000, interval: 100 }).toBe(true);
  }
  await expect.poll(async () => (await jobs().queued()).length, { timeout: 20_000, interval: 100 }).toBe(0);
}

const stamp = "2026-10-12T23:59:00.000Z";
const set = (id: string, exercise_id: string, i: number, weight: number, reps: number): SetEntry => ({ id, exercise_id, set_index: i, weight, reps, seconds: null, done: true, rir: 1, updated_at: stamp });
function session(id: string, note = ""): WorkoutSession {
  return {
    id,
    program_day_id: "D1",
    local_date: "2026-10-12",
    started_at: "2026-10-12T23:00:00.000Z",
    ended_at: "2026-10-13T00:00:00.000Z",
    status: "done",
    unit: "lb",
    note,
    created_at: "2026-10-12T23:00:00.000Z",
    updated_at: stamp,
    source: "app",
    sets: [0, 1, 2, 3].map((i) => set(`${id}-${i}`, "bench", i, 135, 5)),
  };
}
const put = (s: WorkoutSession) => client.fetch(`/api/sessions/${s.id}`, { method: "PUT", json: s });
const overview = async () => (await (await client.fetch("/api/overview")).json()) as OverviewResponse;
const kindOf = (body: Record<string, unknown>) => (String(body.system).includes("overview of Payam") ? "overview" : String(body.system).includes("training report") ? "report" : "other");

describe("training overview", () => {
  it("a finished session queues its report, then the overview, and both are written in that order", async () => {
    mock = mockAnthropic([{ json: REPORT_REPLY }, { json: OVERVIEW_REPLY, usage: { input_tokens: 9000, output_tokens: 1200 } }]);
    const s = session(ulid());
    await put({ ...s, status: "active", ended_at: null });
    expect(await jobs().queued()).toEqual([]);
    await put({ ...s, updated_at: "2026-10-13T00:00:01.000Z" });
    await settled(s.id);
    expect(mock.calls.map((c) => kindOf(c.body))).toEqual(["report", "overview"]);
    expect(mock.calls[1].body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 4000, output_config: { effort: "medium" } });
    const o = await overview();
    expect(o.pending).toBe(false);
    expect(o.failed).toBeNull();
    expect(o.overview).toMatchObject({ model: "claude-opus-5-5", trigger: { session_id: s.id, program_day_id: "D1", local_date: "2026-10-12" } });
    expect(o.overview!.overview.summary_fa).toBe(OVERVIEW_REPLY.summary_fa);
    expect(o.overview!.overview.lifts.find((l) => l.exercise_id === "bench")).toMatchObject({ latest_e1rm: 157.5, sessions: 1 });
    expect(await env.DB.prepare("SELECT input_tokens, output_tokens, window_start, window_end FROM training_overviews").first()).toMatchObject({ input_tokens: 9000, output_tokens: 1200 });
  });

  it("is built from raw data only: no text of session reports or earlier overviews reaches the model", async () => {
    const s = session(ulid(), "Felt strong.");
    mock = mockAnthropic([{ json: REPORT_REPLY }, { json: OVERVIEW_REPLY }]);
    await put(s);
    await settled(s.id);
    await env.DB.batch([
      env.DB.prepare("UPDATE session_reports SET report_json = json_set(report_json, '$.summary_fa', 'MARKER_REPORT_TEXT')"),
      env.DB.prepare("UPDATE training_overviews SET overview_json = json_set(overview_json, '$.summary_fa', 'MARKER_OVERVIEW_TEXT')"),
    ]);
    mock.restore();
    mock = mockAnthropic([{ json: OVERVIEW_REPLY }]);
    expect((await client.post("/api/overview")).status).toBe(202);
    await settled();
    const body = JSON.stringify(mock.calls[0].body);
    expect(body).not.toContain("MARKER_REPORT_TEXT");
    expect(body).not.toContain("MARKER_OVERVIEW_TEXT");
    // Payam's own note is raw data and is included.
    expect(body).toContain("Felt strong.");
  });

  it("a failed update keeps the previous overview visible, flagged as failed; Retry clears it", async () => {
    mock = mockAnthropic([{ json: OVERVIEW_REPLY }]);
    await client.post("/api/overview");
    await settled();
    const first = (await overview()).overview!.id;
    mock.restore();
    mock = mockAnthropic([{ status: 400, type: "invalid_request_error", message: "mock failure" }]);
    await client.post("/api/overview");
    await settled();
    const o = await overview();
    expect(o.overview!.id).toBe(first);
    expect(o.failed).toMatchObject({ error_code: "api" });
    mock.restore();
    mock = mockAnthropic([{ json: OVERVIEW_REPLY }]);
    await client.post("/api/overview");
    await settled();
    const again = await overview();
    expect(again.failed).toBeNull();
    expect(again.overview!.id).not.toBe(first);
    expect(again.overview!.trigger).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM training_overviews").first<{ n: number }>())!.n).toBe(3);
  });

  it("an invalid reply is retried once, then stored as an error; so is a summary with numbers the app did not supply", async () => {
    mock = mockAnthropic([{ text: "not JSON" }, { json: { ...OVERVIEW_REPLY, summary_fa: "۹۹۹۹ جلسه زدی." } }]);
    await client.post("/api/overview");
    await settled();
    expect(mock.calls).toHaveLength(2);
    const row = await env.DB.prepare("SELECT status, error FROM training_overviews").first<{ status: string; error: string }>();
    expect(row).toMatchObject({ status: "error" });
    expect(row!.error).toMatch(/^invalid: The summary has numbers the app did not supply/);
    expect((await overview()).overview).toBeNull();
  });

  it("stops at 10 overviews a day; Settings counts them", async () => {
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 10 }, () =>
        env.DB.prepare(
          "INSERT INTO training_overviews (id, created_at, window_start, window_end, model, status, overview_json, input_tokens, output_tokens) VALUES (?, ?, '2026-09-14', '2026-10-13', 'claude-opus-5-5', 'ok', '{}', 9000, 1000)"
        ).bind(ulid(), now)
      )
    );
    const res = await client.post("/api/overview");
    expect(res.status).toBe(429);
    const u = (await (await client.fetch("/api/ai/usage")).json()) as { month: { overviews: number; cost_usd: number }; today: { overviews: number }; limits: { overview: number } };
    expect(u.month.overviews).toBe(10);
    expect(u.today.overviews).toBe(10);
    expect(u.limits.overview).toBe(10);
    // 10 × (9000 × $4 + 1000 × $20) / 1M = $0.56
    expect(u.month.cost_usd).toBe(0.56);
  });

  it("lists every session's latest report, newest session first; backups include the overviews; a deleted trigger leaves the overview", async () => {
    const a = { ...session(ulid()), local_date: "2026-10-10", started_at: "2026-10-10T23:00:00.000Z" };
    const b = session(ulid());
    mock = mockAnthropic([{ json: REPORT_REPLY }, { json: OVERVIEW_REPLY }, { json: { ...REPORT_REPLY, summary_fa: "گزارش دوم" } }, { json: OVERVIEW_REPLY }]);
    await put(a);
    await settled(a.id);
    await put(b);
    await settled(b.id);
    const list = ((await (await client.fetch("/api/session-reports")).json()) as { reports: SessionReportItem[] }).reports;
    expect(list.map((r) => [r.session_id, r.local_date, r.status, r.summary_fa])).toEqual([
      [b.id, "2026-10-12", "ok", "گزارش دوم"],
      [a.id, "2026-10-10", "ok", REPORT_REPLY.summary_fa],
    ]);
    const backup = (await (await client.fetch("/api/export")).json()) as { training_overviews: { status: string; overview_json: unknown }[] };
    expect(backup.training_overviews).toHaveLength(2);
    expect(backup.training_overviews[0].overview_json).toMatchObject({ summary_fa: OVERVIEW_REPLY.summary_fa });
    expect((await client.fetch(`/api/sessions/${b.id}`, { method: "DELETE" })).status).toBe(200);
    const o = await overview();
    expect(o.overview).not.toBeNull();
    expect(o.overview!.trigger).toBeNull();
  });
});

describe("weekly reviews history", () => {
  it("lists every weekly review, newest week first; the rows are kept", async () => {
    await env.DB.prepare("DELETE FROM weekly_reviews").run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES ('w1', '2026-09-14', '2026-09-21T08:00:00Z', 'اول', '[]', '[]')"),
      env.DB.prepare("INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES ('w2', '2026-09-21', '2026-09-28T08:00:00Z', 'دوم', '[\"خوب\"]', '[]')"),
    ]);
    const r = (await (await client.fetch("/api/reviews")).json()) as { reviews: WeeklyReview[] };
    expect(r.reviews.map((x) => [x.id, x.week_start, x.summary_fa, x.highlights])).toEqual([
      ["w2", "2026-09-21", "دوم", ["خوب"]],
      ["w1", "2026-09-14", "اول", []],
    ]);
  });
});

import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OverviewResponse, OverviewView, SessionReportItem } from "../../worker/lib/ai/overview";
import type { TimelineItem } from "../../worker/lib/ai/timeline";
import { phaseOf, type MotivationInput } from "../../worker/lib/ai/motivation";
import type { OverviewInput } from "../../worker/lib/ai/overview";
import { weekRange } from "../../worker/lib/cycle";
import { addDays, localDate } from "../../worker/lib/time";
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

describe("the weekly motivational line", () => {
  /** A line the way the prompt asks: each reported week's sessions done and planned; on a bad week, the next session. */
  const lineFrom = (m: MotivationInput) => {
    const weeks = m.cover.map((k) => `${k === "last_week" ? "هفتهٔ گذشته" : "این هفته"} ${m[k].sessions_done} جلسه از ${m[k].sessions_planned} جلسه`);
    const bad = m.cover.some((k) => m[k].bad);
    return `${weeks.join("؛ ")}.${bad ? ` کمتر از نصف برنامه بود؛ قدم بعدی: ${m.next_session}.` : ""}`;
  };

  it("the app's facts go to the model, a line that states them is kept, and last week's result is announced unless an overview was written last weekend", async () => {
    await env.DB.prepare("DELETE FROM weekly_reviews").run();
    mock = mockAnthropic([{ build: (input: OverviewInput) => ({ ...OVERVIEW_REPLY, motivation_fa: input.motivation ? lineFrom(input.motivation) : null }) }]);
    await client.post("/api/overview");
    await settled();
    const first = JSON.parse((mock.calls[0].body.messages as { content: string }[])[0].content) as OverviewInput;
    const tz = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'").first<{ value: string }>())?.value ?? "America/Denver";
    const today = localDate(tz);
    // The seed program was activated on Sep 27, so this week always has sessions planned.
    const m = first.motivation!;
    expect(m.phase).toBe(phaseOf(today).phase);
    expect(m.this_week.start).toBe(weekRange(today, "mon").start);
    // No overview before: the first one of the week gives last week's result too (Monday–Tuesday report last week anyway).
    expect(m.announce_last_week).toBe(true);
    expect(m.cover).toEqual(m.phase === "start" ? ["last_week"] : ["last_week", "this_week"]);
    const stored = (await overview()).overview!.overview.motivation!;
    expect(stored).toMatchObject({ phase: m.phase, announce_last_week: true, text_fa: lineFrom(m), bad: m.cover.some((k) => m[k].bad) });

    // An overview written last Saturday (17:00 local): Wednesday–Sunday report this week only.
    const lastSaturday = addDays(weekRange(today, "mon").start, -2);
    await env.DB.prepare("UPDATE training_overviews SET created_at = ?").bind(`${lastSaturday}T23:00:00.000Z`).run();
    mock.restore();
    mock = mockAnthropic([{ json: { ...OVERVIEW_REPLY, motivation_fa: "هفتهٔ خوبی بود، ادامه بده!" } }]);
    await client.post("/api/overview");
    await settled();
    const second = JSON.parse((mock.calls[0].body.messages as { content: string }[])[0].content) as OverviewInput;
    expect(second.motivation!.announce_last_week).toBe(false);
    expect(second.motivation!.cover).toEqual(second.motivation!.phase === "start" ? ["last_week"] : ["this_week"]);
    // Generic praise without the week's numbers is dropped.
    const latest = (await overview()).overview!.overview;
    expect(latest.motivation).toBeNull();
    expect(latest.dropped).toBe(1);
  });
});

describe("report timeline (History) and saved overviews", () => {
  it("lists each session's latest ok report, every ok overview and every weekly review on its date; a saved overview opens by id", async () => {
    await env.DB.prepare("DELETE FROM weekly_reviews").run();
    const a = { ...session(ulid()), local_date: "2026-10-10", started_at: "2026-10-10T23:00:00.000Z" };
    const b = session(ulid());
    mock = mockAnthropic([{ json: REPORT_REPLY }, { json: OVERVIEW_REPLY }, { json: REPORT_REPLY }, { json: OVERVIEW_REPLY }]);
    await put(a);
    await settled(a.id);
    await put(b);
    await settled(b.id);
    // Session b's latest report failed: it leaves the timeline (its earlier ok report is no longer the latest).
    await env.DB.prepare(
      "INSERT INTO session_reports (id, session_id, created_at, model, status, report_json, error, input_tokens, output_tokens) VALUES (?, ?, ?, 'claude-opus-5-5', 'error', NULL, 'api: mock', NULL, NULL)"
    )
      .bind(ulid(), b.id, new Date(Date.now() + 60_000).toISOString())
      .run();
    // A failed overview is not listed; a Regenerate (no trigger) written Oct 11 at 21:00 Denver sits on Oct 11.
    const ok = await env.DB.prepare("SELECT overview_json FROM training_overviews WHERE status = 'ok' LIMIT 1").first<{ overview_json: string }>();
    const manual = ulid();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO training_overviews (id, created_at, window_start, window_end, model, status, error) VALUES (?, '2026-10-12T04:00:00.000Z', '2026-09-07', '2026-10-11', 'claude-opus-5-5', 'error', 'api: mock')").bind(ulid()),
      env.DB.prepare("INSERT INTO training_overviews (id, created_at, window_start, window_end, model, status, overview_json) VALUES (?, '2026-10-12T03:00:00.000Z', '2026-09-07', '2026-10-11', 'claude-opus-5-5', 'ok', ?)").bind(manual, ok!.overview_json),
      env.DB.prepare("INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES ('wr-2026-09-28', '2026-09-28', '2026-10-05T13:58:00Z', 'مرور', '[]', '[]')"),
    ]);
    const items = ((await (await client.fetch("/api/report-timeline")).json()) as { items: TimelineItem[] }).items;
    const overviews = await env.DB.prepare("SELECT id, trigger_session_id FROM training_overviews WHERE status = 'ok' AND trigger_session_id IS NOT NULL ORDER BY created_at").all<{ id: string; trigger_session_id: string }>();
    expect(items.map((i) => [i.kind, i.date, i.program_day_id])).toEqual([
      ["overview", "2026-10-12", "D1"],
      ["overview", "2026-10-11", null],
      ["session", "2026-10-10", "D1"],
      ["overview", "2026-10-10", "D1"],
      ["review", "2026-10-04", null],
    ]);
    expect(items.find((i) => i.kind === "session")!.id).toBe(a.id);
    expect(items.filter((i) => i.kind === "overview" && i.program_day_id).map((i) => i.id).sort()).toEqual(overviews.results.map((r) => r.id).sort());
    expect(items.find((i) => i.kind === "review")).toMatchObject({ id: "wr-2026-09-28", week_start: "2026-09-28" });
    // The timeline carries no report text.
    expect(JSON.stringify(items)).not.toContain(OVERVIEW_REPLY.summary_fa);

    const one = (await (await client.fetch(`/api/overviews/${manual}`)).json()) as { overview: OverviewView };
    expect(one.overview).toMatchObject({ id: manual, trigger: null, window_end: "2026-10-11" });
    expect(one.overview.overview.summary_fa).toBe(OVERVIEW_REPLY.summary_fa);
    expect((await client.fetch(`/api/overviews/${ulid()}`)).status).toBe(404);
    expect((await client.fetch("/api/overviews/bad%20id")).status).toBe(400);
  });
});

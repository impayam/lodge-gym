import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateReport, REPORT_WAIT_MS } from "../../worker/aiReports";
import { suggest } from "../../worker/lib/progression";
import type { Bootstrap } from "../../worker/lib/types";
import type { ReportInput, ReportResponse } from "../../worker/lib/ai/report";
import { localDate } from "../../worker/lib/time";
import type { SessionPlan } from "../../worker/lib/plan";
import type { SetEntry, WorkoutSession } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import { mockAnthropic, REPORT_REPLY } from "../fixtures/anthropic-mock";
import { Client, ORIGIN, resetAuth, setupOwner } from "./helpers";

// SPEC-v3 M9a (AI session report; since Step 3 the one after-session report, written by its timing rule) and M9c (Get
// advice) on the Worker. The Anthropic API is mocked in every test.
let client: Client;
let mock: ReturnType<typeof mockAnthropic> | null = null;
const jobs = () => env.AI_JOBS.get(env.AI_JOBS.idFromName("owner"));

beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.81"));
});
beforeEach(async () => {
  await settled();
  // Reports still waiting for their timing rule belong to the previous test.
  await runInDurableObject(jobs(), async (_obj, state) => {
    await state.storage.delete("jobs");
    await state.storage.deleteAlarm();
  });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM training_overviews"),
    env.DB.prepare("DELETE FROM plan_advice"),
    env.DB.prepare("DELETE FROM session_reports"),
    env.DB.prepare("DELETE FROM health_workouts"),
    env.DB.prepare("DELETE FROM body_metrics"),
    env.DB.prepare("DELETE FROM set_entries"),
    env.DB.prepare("DELETE FROM workout_sessions"),
  ]);
});
afterEach(() => {
  mock?.restore();
  mock = null;
});

const stamp = "2026-10-12T23:59:00.000Z";
const set = (id: string, exercise_id: string, i: number, weight: number, reps: number, extra: Partial<SetEntry> = {}): SetEntry => ({
  id,
  exercise_id,
  set_index: i,
  weight,
  reps,
  seconds: null,
  done: true,
  rir: 1,
  updated_at: stamp,
  ...extra,
});
function session(id: string, status: "active" | "done" = "done"): WorkoutSession {
  return {
    id,
    program_day_id: "D1",
    local_date: "2026-10-12",
    started_at: "2026-10-12T23:00:00.000Z",
    ended_at: status === "done" ? "2026-10-13T00:00:00.000Z" : null,
    status,
    unit: "lb",
    note: "",
    created_at: "2026-10-12T23:00:00.000Z",
    updated_at: stamp,
    source: "app",
    sets: [
      set(`${id}-1`, "bench", 0, 135, 5),
      set(`${id}-2`, "bench", 1, 135, 5),
      set(`${id}-3`, "curl", 0, 30, 10, { is_extra: true, position: 0 }),
    ],
  };
}
const put = (s: WorkoutSession) => client.fetch(`/api/sessions/${s.id}`, { method: "PUT", json: s });
const getReport = async (id: string) => (await (await client.fetch(`/api/sessions/${id}/report`)).json()) as ReportResponse;
const rows = async (id: string) => (await env.DB.prepare("SELECT * FROM session_reports WHERE session_id = ? ORDER BY created_at, id").bind(id).all<Record<string, unknown>>()).results;

/** Jobs whose time has come. */
const due = async () => (await jobs().queued()).filter((j) => j.run_at <= Date.now());
/** The session's report has been queued or written (a session that syncs as done queues it after the response). */
const queuedOrWritten = (sessionId: string) =>
  expect
    .poll(async () => (await jobs().queued()).some((j) => j.session_id === sessionId) || (await rows(sessionId)).length > 0, { timeout: 20_000, interval: 50 })
    .toBe(true);

/**
 * Runs the due jobs (unless the runtime already started its alarm) until none is due; reports waiting for their timing
 * rule stay queued. With `sessionId`, first wait until that session's report is queued or written.
 */
async function settled(sessionId?: string) {
  if (sessionId) await queuedOrWritten(sessionId);
  for (let i = 0; i < 10 && (await due()).length; i++) {
    await runDurableObjectAlarm(jobs());
    await expect.poll(async () => (await due()).length <= 1, { timeout: 20_000, interval: 100 }).toBe(true);
  }
  await expect.poll(async () => (await due()).length, { timeout: 20_000, interval: 100 }).toBe(0);
}

/** The model's input of a mocked call. */
const inputOf = (call: { body: Record<string, unknown> }) => JSON.parse((call.body.messages as { content: string }[])[0].content) as ReportInput;

describe("session report", () => {
  it("a session that syncs as done gets one after-session report (it ended over 2 h ago: at once); no overview follows", async () => {
    mock = mockAnthropic([{ json: REPORT_REPLY, usage: { input_tokens: 4100, output_tokens: 850 } }]);
    const reviews = async () => (await client.fetch("/api/reviews")).text();
    const reviewsBefore = await reviews();
    const s = session(ulid());
    expect((await put({ ...s, status: "active", ended_at: null })).status).toBe(200);
    // Still active: nothing queued.
    expect((await getReport(s.id)).pending).toBe(false);
    expect((await put({ ...s, updated_at: "2026-10-13T00:00:01.000Z" })).status).toBe(200);
    await settled(s.id);
    await expect.poll(async () => (await getReport(s.id)).report?.status, { timeout: 5000 }).toBe("ok");
    const r = await getReport(s.id);
    expect(r).toMatchObject({ pending: false, due_at: null });
    // $4 / $20 per million tokens: 4100 × 4 + 850 × 20 = 33,400 µ$.
    expect(r.report).toMatchObject({ model: "claude-opus-5-5", status: "ok", error_code: null, cost_usd: 0.0334 });
    expect(r.report!.report!.summary_fa).toBe(REPORT_REPLY.summary_fa);
    expect(r.report!.report!.where_fa).toEqual(REPORT_REPLY.where_fa);
    expect(r.report!.report!.motivation_fa).toBe(REPORT_REPLY.motivation_fa);
    expect((await rows(s.id))[0]).toMatchObject({ input_tokens: 4100, output_tokens: 850 });

    // One call, the report: no training overview after a session (Step 3), and the weekly reviews are untouched.
    expect(mock.calls).toHaveLength(1);
    expect(String(mock.calls[0].body.system)).toMatch(/^You write the after-session training report/);
    expect(await jobs().queued()).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM training_overviews").first()).toEqual({ n: 0 });
    expect(await reviews()).toBe(reviewsBefore);

    // The volume rows are the app's own: every group of the week so far, with the input's numbers (the model writes none).
    const input = inputOf(mock.calls[0]);
    expect(r.report!.report!.volume).toEqual(input.week_so_far.volume.map(({ group, today, week, target, status }) => ({ group, today, week, target, status })));
    expect(r.report!.report!.volume.find((v) => v.group === "Chest")).toEqual({ group: "Chest", today: 2, week: 2, target: expect.any(Number), status: "under" });
    // "Where you are": the session's 5 weeks and the main lifts' trend; no earlier report, so no earlier motivational line.
    expect(input.where_you_are!.weeks).toHaveLength(5);
    expect(input.where_you_are!.lifts.find((l) => l.name === "Barbell Bench Press")).toMatchObject({ sessions: 1, latest_e1rm: 157.5, change_pct: null });
    expect(input.recent_motivation).toEqual([]);

    // The request: REPORT_MODEL, max_tokens 3000, effort low, JSON schema output, no temperature, the API key header.
    const call = mock.calls[0];
    expect(call.url).toBe("https://anthropic.invalid/v1/messages");
    expect(call.headers["x-api-key"]).toBe(env.ANTHROPIC_API_KEY);
    // Opus only: no fallback model (Payam, 2026-10-13).
    expect(call.headers["anthropic-beta"]).toBeUndefined();
    expect(call.body).not.toHaveProperty("fallbacks");
    expect(call.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 3000, output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(call.body).not.toHaveProperty("temperature");
    expect(String(call.body.system)).toMatch(/Persian/);
    // The input includes the extra exercise.
    expect(input.exercises.find((x) => x.exercise_id === "curl")).toMatchObject({ is_extra: true, planned: null });
    // Synced again as done: no second report.
    expect((await put({ ...s, note: "edited", updated_at: "2026-10-13T00:00:02.000Z" })).status).toBe(200);
    expect((await getReport(s.id)).pending).toBe(false);
    expect(await jobs().queued()).toEqual([]);
  });

  it("the next report reads the earlier motivational lines; prose with a number the app did not supply is left out", async () => {
    const a = { ...session(ulid()), local_date: "2026-10-10", started_at: "2026-10-10T23:00:00.000Z", ended_at: "2026-10-11T00:00:00.000Z" };
    const b = session(ulid());
    mock = mockAnthropic([
      { json: REPORT_REPLY },
      { json: { ...REPORT_REPLY, where_fa: ["روند خوب است.", "هفتهٔ بعد ۹۹۹۹ ست بزن."], motivation_fa: "امروز ۹۹۹۹ بار بهتر بودی." } },
    ]);
    await put(a);
    await settled(a.id);
    await put(b);
    await settled(b.id);
    expect(mock.calls).toHaveLength(2);
    expect(inputOf(mock.calls[1]).recent_motivation).toEqual([REPORT_REPLY.motivation_fa]);
    const r = (await getReport(b.id)).report!.report!;
    expect(r.where_fa).toEqual(["روند خوب است."]);
    expect(r.where_dropped).toBe(1);
    expect(r.motivation_fa).toBeNull();
  });

  it("stores the progression function's next-time weights, not the model's numbers", async () => {
    // Bench: all 4 planned sets of 5 at 135 lb → the app's rule gives 140 lb (+5 lb, barbell upper body).
    const s = { ...session(ulid()), sets: [0, 1, 2, 3].map((i) => set(`${ulid()}-${i}`, "bench", i, 135, 5)) };
    await put(s);
    await settled(s.id);
    await env.DB.prepare("DELETE FROM session_reports").run();
    mock = mockAnthropic([{ json: { ...REPORT_REPLY, next_time: [{ exercise_id: "bench", note_fa: "دفعهٔ بعد ۱۵۵ پوند." }] } }]);
    const v = (await generateReport(env, s.id))!;
    const boot = (await (await client.fetch("/api/bootstrap")).json()) as Bootstrap;
    const plan = boot.program.days.find((d) => d.id === "D1")!.exercises.find((x) => x.exercise_id === "bench")!;
    const app = suggest(plan, boot.exercises.find((e) => e.id === "bench")!, { session_id: s.id, local_date: s.local_date, unit: "lb", sets: s.sets });
    expect(app).toMatchObject({ kind: "weight", weight: 140 });
    expect(v.report!.next_time).toEqual([{ exercise_id: "bench", name: "Barbell Bench Press", kind: "weight", weight: app.kind === "weight" ? app.weight : null, unit: "lb", seconds: null, reps: "5", change: "up", step: 5, note_fa: null }]);
  });

  it("a refusal is stored as an error at once (no fallback model, no retry)", async () => {
    const s = session(ulid());
    await put(s);
    await settled(s.id);
    mock = mockAnthropic([{ json: {}, stop_reason: "refusal" }]);
    expect(await generateReport(env, s.id)).toMatchObject({ status: "error", error_code: "refusal", model: "claude-opus-5-5" });
    expect(mock.calls).toHaveLength(1);
  });

  it("retries bad model JSON once, then stores the error", async () => {
    const s = session(ulid());
    await put(s);
    await settled(s.id);
    await env.DB.prepare("DELETE FROM session_reports").run();
    mock = mockAnthropic([
      { text: "this is not JSON", usage: { input_tokens: 4000, output_tokens: 100 } },
      { json: { summary_fa: "" }, usage: { input_tokens: 4000, output_tokens: 120 } },
    ]);
    const v = (await generateReport(env, s.id))!;
    expect(mock.calls).toHaveLength(2);
    expect(v).toMatchObject({ status: "error", error_code: "invalid", report: null });
    expect((await rows(s.id)).at(-1)).toMatchObject({ status: "error", input_tokens: 8000, output_tokens: 220 });
    mock.restore();

    // A bad first answer and a good second one: the report is stored, with both calls' tokens.
    mock = mockAnthropic([
      { text: '{"summary_fa": "cut', stop_reason: "max_tokens", usage: { input_tokens: 4000, output_tokens: 3000 } },
      { json: REPORT_REPLY, usage: { input_tokens: 4000, output_tokens: 800 } },
    ]);
    const ok = (await generateReport(env, s.id))!;
    expect(ok.status).toBe("ok");
    expect((await rows(s.id)).at(-1)).toMatchObject({ status: "ok", input_tokens: 8000, output_tokens: 3800 });
    // Older rows are kept; GET returns the latest.
    expect(await rows(s.id)).toHaveLength(2);
    expect((await getReport(s.id)).report!.id).toBe(ok.id);
  });

  it("an authentication error is stored as 'auth' and shows in Settings until a call succeeds", async () => {
    const s = session(ulid());
    await put(s);
    await settled(s.id);
    await env.DB.prepare("DELETE FROM session_reports").run();
    mock = mockAnthropic([{ status: 401, type: "authentication_error", message: "invalid x-api-key" }]);
    const v = (await generateReport(env, s.id))!;
    expect(mock.calls).toHaveLength(1);
    expect(v).toMatchObject({ status: "error", error_code: "auth" });
    expect(v.error).not.toContain(env.ANTHROPIC_API_KEY);
    const usage = async () => (await (await client.fetch("/api/ai/usage")).json()) as { key: string; key_status: string; model: string };
    expect(await usage()).toMatchObject({ key: "set", key_status: "invalid", model: "claude-opus-5-5" });
    mock.restore();
    mock = mockAnthropic([{ json: REPORT_REPLY }]);
    await generateReport(env, s.id);
    expect((await usage()).key_status).toBe("ok");
  });

  it("without a key, nothing is called and the row says so", async () => {
    const s = session(ulid());
    await put(s);
    await settled(s.id);
    await env.DB.prepare("DELETE FROM session_reports").run();
    mock = mockAnthropic([]);
    const v = (await generateReport({ ...env, ANTHROPIC_API_KEY: "" }, s.id))!;
    expect(mock.calls).toHaveLength(0);
    expect(v).toMatchObject({ status: "error", error_code: "missing" });
  });

  it("POST regenerates in the background; a session not done or not synced has no report", async () => {
    const s = session(ulid());
    await put(s);
    await settled(s.id);
    await env.DB.prepare("DELETE FROM session_reports").run();
    mock = mockAnthropic([{ json: REPORT_REPLY }, { json: REPORT_REPLY }]);
    for (let i = 0; i < 2; i++) {
      const res = await client.post(`/api/sessions/${s.id}/report`);
      expect(res.status).toBe(202);
      // Being written, or already written (the runtime may run the job at once): never neither.
      const g = await getReport(s.id);
      expect(g.pending || (g.report?.status === "ok" && (await rows(s.id)).length === i + 1)).toBe(true);
      await settled();
      expect(await rows(s.id)).toHaveLength(i + 1);
    }
    expect((await getReport(s.id)).pending).toBe(false);

    const open = session(ulid(), "active");
    await put(open);
    expect((await client.post(`/api/sessions/${open.id}/report`)).status).toBe(409);
    expect((await client.fetch(`/api/sessions/${ulid()}/report`)).status).toBe(404);
  });

  it("stops at 10 reports a day", async () => {
    const s = session(ulid());
    await put(s);
    await settled(s.id);
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 10 }, () =>
        env.DB.prepare("INSERT INTO session_reports (id, session_id, created_at, model, status, report_json, error, input_tokens, output_tokens) VALUES (?, ?, ?, 'claude-opus-5-5', 'ok', '{}', NULL, 4000, 800)").bind(ulid(), s.id, now)
      )
    );
    const res = await client.post(`/api/sessions/${s.id}/report`);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("limit");
    mock = mockAnthropic([]);
    expect(await generateReport(env, s.id)).toMatchObject({ status: "error", error_code: "limit" });
    expect(mock.calls).toHaveLength(0);
  });

  it("deleting a session deletes its reports", async () => {
    const s = session(ulid());
    await put(s);
    await settled(s.id);
    mock = mockAnthropic([{ json: REPORT_REPLY }]);
    await generateReport(env, s.id);
    expect((await rows(s.id)).length).toBeGreaterThan(0);
    expect((await client.fetch(`/api/sessions/${s.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await rows(s.id)).toHaveLength(0);
  });

  it("Settings: this month's reports, advice and cost; backups include both tables", async () => {
    const s = session(ulid());
    await put(s);
    await settled(s.id);
    await env.DB.prepare("DELETE FROM session_reports").run();
    mock = mockAnthropic([{ json: REPORT_REPLY, usage: { input_tokens: 5000, output_tokens: 1000 } }, { status: 401, type: "authentication_error", message: "invalid x-api-key" }]);
    await generateReport(env, s.id);
    await generateReport(env, s.id);
    const u = (await (await client.fetch("/api/ai/usage")).json()) as { month: { reports: number; advice: number; cost_usd: number; input_tokens: number }; today: { reports: number }; limits: { report: number; advice: number } };
    // $4 / $20 per million tokens: 5000 × 4 + 1000 × 20 = 40,000 µ$ = $0.04. The failed call used no tokens.
    expect(u.month).toMatchObject({ reports: 1, advice: 0, input_tokens: 5000, cost_usd: 0.04 });
    expect(u.today.reports).toBe(1);
    expect(u.limits).toEqual({ report: 10, advice: 20, overview: 10 });
    const backup = (await (await client.fetch("/api/export")).json()) as { session_reports: { status: string; report_json: unknown }[]; plan_advice: unknown[] };
    expect(backup.session_reports.map((r) => r.status)).toEqual(["ok", "error"]);
    expect(backup.session_reports[0].report_json).toMatchObject({ summary_fa: REPORT_REPLY.summary_fa });
    expect(backup.plan_advice).toEqual([]);
  });
});

describe("report timing (Step 3): that day's body weight and the Apple Health workout, or 2 h after the end", () => {
  const TZ = "America/Denver";
  /** A session that ended `endedAgo` minutes ago, after an hour of training. */
  function recent(endedAgo = 10): WorkoutSession {
    const end = Date.now() - endedAgo * 60_000;
    const s = session(ulid());
    return { ...s, local_date: localDate(TZ, new Date(end - 3_600_000).toISOString()), started_at: new Date(end - 3_600_000).toISOString(), ended_at: new Date(end).toISOString() };
  }
  const weight = (date: string) => client.fetch(`/api/body-mass/${date}`, { method: "PUT", json: { value: 181.4, unit: "lb" } });
  /** A watch workout over the session, from iOS Shortcuts (bearer token, no cookie). */
  async function watchWorkout(s: WorkoutSession) {
    const { token } = (await (await client.post("/api/tokens", { label: "iPhone" })).json()) as { token: string };
    const body = JSON.stringify({
      workouts: "Traditional Strength Training",
      workout_start: new Date(Date.parse(s.started_at) + 120_000).toISOString(),
      workout_end: new Date(Date.parse(s.ended_at!) - 60_000).toISOString(),
      workout_energy: "312 kcal",
    });
    const res = await (exports as unknown as { default: Fetcher }).default.fetch(
      new Request(`${ORIGIN}/api/health/raw`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body })
    );
    expect(((await res.json()) as { matched: number }).matched).toBe(1);
  }
  const dueAt = async (id: string) => (await getReport(id)).due_at;

  it("a session that ended under 2 h ago waits: GET says when it will be written, and an early alarm writes nothing", async () => {
    mock = mockAnthropic([]);
    const s = recent(10);
    await put(s);
    await queuedOrWritten(s.id);
    const r = await getReport(s.id);
    expect(r).toMatchObject({ report: null, pending: true, due_at: new Date(Date.parse(s.ended_at!) + REPORT_WAIT_MS).toISOString() });
    expect(REPORT_WAIT_MS).toBe(2 * 3_600_000);
    await runDurableObjectAlarm(jobs());
    expect(mock.calls).toHaveLength(0);
    expect(await rows(s.id)).toHaveLength(0);
    expect((await jobs().queued()).map((j) => j.session_id)).toEqual([s.id]);
  });

  it("the body weight alone keeps it waiting; the Apple Health workout from Shortcuts then writes it at once", async () => {
    mock = mockAnthropic([{ json: REPORT_REPLY }]);
    const s = recent(10);
    await put(s);
    await queuedOrWritten(s.id);
    const later = await dueAt(s.id);
    expect((await weight(s.local_date)).status).toBe(200);
    expect(await dueAt(s.id)).toBe(later);
    await watchWorkout(s);
    // Due now: written by the next alarm, long before the 2 h.
    expect(Date.parse((await dueAt(s.id)) ?? new Date().toISOString())).toBeLessThanOrEqual(Date.now());
    await settled();
    expect((await getReport(s.id)).report?.status).toBe("ok");
    expect(mock.calls).toHaveLength(1);
    // The model sees both.
    const input = inputOf(mock.calls[0]);
    expect(input.body_weight?.today).toBe(181.4);
    expect(input.watch).toMatchObject({ active_kcal: 312 });
  });

  it("the watch workout first (attached by hand), then the body weight: written when the second arrives", async () => {
    mock = mockAnthropic([{ json: REPORT_REPLY }]);
    const s = recent(30);
    await put(s);
    await queuedOrWritten(s.id);
    const w = ulid();
    await env.DB.prepare(
      "INSERT INTO health_workouts (id, external_key, activity_type, started_at, ended_at, duration_sec, active_kcal, total_kcal, hr_avg, hr_max, matched_session_id, raw, received_at) VALUES (?, ?, 'Traditional Strength Training', ?, ?, 3300, 290, NULL, 120, 150, NULL, '{}', ?)"
    )
      .bind(w, `manual-${w}`, s.started_at, s.ended_at, new Date().toISOString())
      .run();
    expect((await client.fetch(`/api/health/workouts/${w}/match`, { method: "PUT", json: { session_id: s.id } })).status).toBe(200);
    expect(Date.parse((await dueAt(s.id))!)).toBeGreaterThan(Date.now());
    await weight(s.local_date);
    expect(Date.parse((await dueAt(s.id)) ?? new Date().toISOString())).toBeLessThanOrEqual(Date.now());
    await settled();
    expect(await rows(s.id)).toHaveLength(1);
  });

  it("2 h after the end it is written without body weight or watch", async () => {
    mock = mockAnthropic([{ json: REPORT_REPLY }]);
    const s = recent(10);
    await put(s);
    await queuedOrWritten(s.id);
    // A body weight on another day does not count.
    await weight("2026-01-01");
    expect(Date.parse((await dueAt(s.id))!)).toBeGreaterThan(Date.now());
    // The clock moves past the end + 2 h: the job's time has come.
    await runInDurableObject(jobs(), async (_obj, state) => {
      const list = (await state.storage.get<{ run_at?: number }[]>("jobs"))!;
      for (const j of list) j.run_at = Date.now() - 1000;
      await state.storage.put("jobs", list);
    });
    await settled();
    expect((await getReport(s.id)).report?.status).toBe("ok");
    expect(mock.calls).toHaveLength(1);
  });

  it("Write report now writes it at once; later data never writes a second one", async () => {
    mock = mockAnthropic([{ json: REPORT_REPLY }]);
    const s = recent(5);
    await put(s);
    await queuedOrWritten(s.id);
    expect((await getReport(s.id)).pending).toBe(true);
    expect((await client.post(`/api/sessions/${s.id}/report`)).status).toBe(202);
    expect(Date.parse((await dueAt(s.id)) ?? new Date().toISOString())).toBeLessThanOrEqual(Date.now());
    await settled();
    expect(await rows(s.id)).toHaveLength(1);
    expect(await getReport(s.id)).toMatchObject({ pending: false, due_at: null });
    // The weight, the watch workout and another sync as done: no second report.
    await weight(s.local_date);
    await watchWorkout(s);
    await put({ ...s, note: "edited", updated_at: new Date().toISOString() });
    await settled();
    expect(await jobs().queued()).toEqual([]);
    expect(await rows(s.id)).toHaveLength(1);
    expect(mock.calls).toHaveLength(1);
  });

  it("one job per session: queuing again keeps the earlier time", async () => {
    const id = ulid();
    const now = Date.now();
    await jobs().enqueue(id, now + 3_600_000);
    await jobs().enqueue(id, now + 7_200_000);
    expect(await jobs().queued()).toEqual([{ kind: "report", session_id: id, run_at: now + 3_600_000 }]);
    await jobs().enqueue(id, now);
    expect(await jobs().queued()).toEqual([{ kind: "report", session_id: id, run_at: now }]);
  });
});

describe("plan advice", () => {
  const newPlan = async () => {
    const res = await client.post("/api/sessions/plan", { id: ulid(), program_day_id: "D3" });
    const plan = ((await res.json()) as { plan: SessionPlan }).plan;
    if (plan.status === "planned") return plan;
    throw new Error("no plan");
  };

  it("one model call per tap; suggestions with unknown exercise ids are dropped; the row is stored", async () => {
    const plan = await newPlan();
    mock = mockAnthropic([
      {
        json: {
          assessment_fa: "برنامه با تمرین‌های اخیر هماهنگ است.",
          suggestions: [
            { type: "add", exercise_id: "oh_tri", replace_exercise_id: null, position: 99, sets: 3, reason_fa: "پشت بازو این هفته کم است." },
            { type: "add", exercise_id: "not_a_real_exercise", replace_exercise_id: null, position: 2, sets: 3, reason_fa: "ساختگی" },
          ],
        },
        usage: { input_tokens: 6000, output_tokens: 700 },
      },
    ]);
    const res = await client.post(`/api/sessions/${plan.id}/plan-advice`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { advice: { assessment_fa: string; suggestions: { type: string; exercise_id: string; position: number }[] }; dropped: number };
    // oh_tri is already in Day 3's plan, so the add is dropped too.
    expect(body.dropped).toBe(2);
    expect(body.advice.suggestions).toEqual([]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "medium" } });
    const input = JSON.parse((mock.calls[0].body.messages as { content: string }[])[0].content);
    expect(input.plan.exercises.map((x: { exercise_id: string }) => x.exercise_id)).toEqual(["cs_row", "pullup", "bulgarian", "fly", "curl", "oh_tri"]);
    expect(input.candidates.length).toBeGreaterThan(6);
    const row = await env.DB.prepare("SELECT * FROM plan_advice WHERE session_id = ?").bind(plan.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: "ok", input_tokens: 6000, output_tokens: 700 });
  });

  it("keeps a valid suggestion and refuses advice for plans that are not open", async () => {
    const plan = await newPlan();
    mock = mockAnthropic([
      {
        json: {
          assessment_fa: "خوب است.",
          suggestions: [{ type: "add", exercise_id: "tri_pushdown_test", replace_exercise_id: null, position: 3, sets: 3, reason_fa: "x" }, { type: "sets", exercise_id: "fly", replace_exercise_id: null, position: null, sets: 4, reason_fa: "سینه اولویت است." }],
        },
      },
    ]);
    const body = (await (await client.post(`/api/sessions/${plan.id}/plan-advice`)).json()) as { advice: { suggestions: unknown[] } };
    expect(body.advice.suggestions).toEqual([{ type: "sets", exercise_id: "fly", replace_exercise_id: null, position: null, sets: 4, reason_fa: "سینه اولویت است." }]);
    expect((await client.post(`/api/sessions/${ulid()}/plan-advice`)).status).toBe(404);
  });

  it("an expired key answers 503 ai_auth and is logged", async () => {
    const plan = await newPlan();
    mock = mockAnthropic([{ status: 401, type: "authentication_error", message: "invalid x-api-key" }]);
    const res = await client.post(`/api/sessions/${plan.id}/plan-advice`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string; message_fa: string } }).error).toEqual({ code: "ai_auth", message_fa: "Advice unavailable — API key expired or invalid." });
    expect(await env.DB.prepare("SELECT status, error FROM plan_advice WHERE session_id = ?").bind(plan.id).first()).toMatchObject({ status: "error", error: expect.stringMatching(/^auth: /) });
  });
});

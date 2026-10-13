import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateReport } from "../../worker/aiReports";
import type { ReportView } from "../../worker/lib/ai/report";
import type { SessionPlan } from "../../worker/lib/plan";
import type { SetEntry, WorkoutSession } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import { mockAnthropic, REPORT_REPLY } from "../fixtures/anthropic-mock";
import { Client, resetAuth, setupOwner } from "./helpers";

// SPEC-v3 M9a (AI session report) and M9c (Get advice) on the Worker. The Anthropic API is mocked in every test.
let client: Client;
let mock: ReturnType<typeof mockAnthropic> | null = null;
const jobs = () => env.AI_JOBS.get(env.AI_JOBS.idFromName("owner"));

beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.81"));
});
beforeEach(async () => {
  await env.DB.batch([
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
const getReport = async (id: string) => (await (await client.fetch(`/api/sessions/${id}/report`)).json()) as { report: ReportView | null; pending: boolean; session_status: string };
const rows = async (id: string) => (await env.DB.prepare("SELECT * FROM session_reports WHERE session_id = ? ORDER BY created_at, id").bind(id).all<Record<string, unknown>>()).results;

/** Runs the report job (unless the runtime already started its alarm) and waits until the session's job is done. */
async function settled(id: string) {
  await runDurableObjectAlarm(jobs());
  await expect.poll(() => jobs().pending(id), { timeout: 20_000, interval: 100 }).toBe(false);
}

describe("session report", () => {
  it("a session that syncs as done is queued, and the job writes a validated report", async () => {
    mock = mockAnthropic([{ json: REPORT_REPLY, usage: { input_tokens: 4100, output_tokens: 850 } }]);
    const s = session(ulid());
    expect((await put({ ...s, status: "active", ended_at: null })).status).toBe(200);
    // Still active: nothing queued.
    expect((await getReport(s.id)).pending).toBe(false);
    expect((await put({ ...s, updated_at: "2026-10-13T00:00:01.000Z" })).status).toBe(200);
    await settled(s.id);
    await expect.poll(async () => (await getReport(s.id)).report?.status, { timeout: 5000 }).toBe("ok");
    const r = await getReport(s.id);
    expect(r.pending).toBe(false);
    expect(r.report).toMatchObject({ model: "claude-opus-5-5", status: "ok", error_code: null });
    expect(r.report!.report!.summary_fa).toBe(REPORT_REPLY.summary_fa);
    // The volume table carries the input's numbers, not the model's.
    expect(r.report!.report!.volume).toEqual([{ group: "Chest", today: 2, week: 2, target: expect.any(Number), status: "under" }]);
    expect((await rows(s.id))[0]).toMatchObject({ input_tokens: 4100, output_tokens: 850 });

    // The request: REPORT_MODEL, max_tokens 3000, effort low, JSON schema output, no temperature, the API key header.
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call.url).toBe("https://anthropic.invalid/v1/messages?beta=true");
    expect(call.headers["x-api-key"]).toBe(env.ANTHROPIC_API_KEY);
    expect(call.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(call.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 3000, fallbacks: "default", output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(call.body).not.toHaveProperty("temperature");
    expect(String(call.body.system)).toMatch(/Persian/);
    // The input includes the extra exercise.
    const input = JSON.parse((call.body.messages as { content: string }[])[0].content);
    expect(input.exercises.find((x: { exercise_id: string }) => x.exercise_id === "curl")).toMatchObject({ is_extra: true, planned: null });
    // Synced again as done: no second report.
    expect((await put({ ...s, note: "edited", updated_at: "2026-10-13T00:00:02.000Z" })).status).toBe(200);
    expect((await getReport(s.id)).pending).toBe(false);
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
      await settled(s.id);
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
    expect(u.limits).toEqual({ report: 10, advice: 20 });
    const backup = (await (await client.fetch("/api/export")).json()) as { session_reports: { status: string; report_json: unknown }[]; plan_advice: unknown[] };
    expect(backup.session_reports.map((r) => r.status)).toEqual(["ok", "error"]);
    expect(backup.session_reports[0].report_json).toMatchObject({ summary_fa: REPORT_REPLY.summary_fa });
    expect(backup.plan_advice).toEqual([]);
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

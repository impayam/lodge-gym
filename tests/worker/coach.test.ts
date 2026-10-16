import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasExif } from "../../worker/lib/jpeg";
import { COACH_SYSTEM } from "../../worker/lib/coach/prompt";
import { COACH_BETAS, MAX_TOOL_CALLS } from "../../worker/coachTurn";
import type { CoachEvent } from "../../worker/lib/coach/events";
import { ulid } from "../../worker/lib/ulid";
import { addDays, localDate } from "../../worker/lib/time";
import { fakeJpeg } from "../fixtures/jpeg";
import { mockAnthropicStream, type StreamReply } from "../fixtures/anthropic-mock";
import type { ExerciseChange } from "../../worker/lib/coach/exerciseTool";
import { Client, resetAuth, setupOwner } from "./helpers";

// SPEC-v9 M12 Coach chat on the Worker. The Anthropic API is mocked in every test (streamed replies).
let client: Client;
let mock: ReturnType<typeof mockAnthropicStream> | null = null;

beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.91"));
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM coach_attachments"),
    env.DB.prepare("DELETE FROM coach_messages"),
    env.DB.prepare("DELETE FROM coach_threads"),
    env.DB.prepare("DELETE FROM photos"),
    env.DB.prepare("DELETE FROM program_activations WHERE program_id IN (SELECT id FROM programs WHERE generated_by = 'coach')"),
    env.DB.prepare("DELETE FROM day_exercises WHERE day_id IN (SELECT id FROM program_days WHERE program_id IN (SELECT id FROM programs WHERE generated_by = 'coach'))"),
    env.DB.prepare("DELETE FROM program_days WHERE program_id IN (SELECT id FROM programs WHERE generated_by = 'coach')"),
    env.DB.prepare("DELETE FROM programs WHERE generated_by = 'coach'"),
  ]);
});
afterEach(() => {
  mock?.restore();
  mock = null;
});

const events = (body: string): CoachEvent[] =>
  body
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(5)) as CoachEvent);

async function ask(threadId: string, text: string, attachments: { id: string; width: number; height: number }[] = []) {
  const res = await client.post(`/api/coach/threads/${threadId}/messages`, { id: ulid(), text, attachments });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  return events(await res.text());
}

const rows = async (threadId: string) =>
  (await env.DB.prepare("SELECT id, role, content_json, error, cost_usd, input_tokens, cache_read_tokens FROM coach_messages WHERE thread_id = ? ORDER BY created_at, id").bind(threadId).all<{ id: string; role: string; content_json: string; error: string | null; cost_usd: number | null; input_tokens: number | null; cache_read_tokens: number | null }>()).results;

const volumeThenAnswer = (): StreamReply[] => [
  { blocks: [{ type: "thinking", thinking: "" }, { type: "thinking", thinking: "I'll count this week's sets." }, { type: "tool_use", id: "toolu_1", name: "get_volume", input: { from: "2026-10-12", to: "2026-10-15" } }], usage: { input_tokens: 1200, output_tokens: 150, cache_creation_input_tokens: 5000 } },
  { blocks: [{ type: "thinking", thinking: "" }, { type: "text", text: "Chest is under target so far this week." }], usage: { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: 6200 } },
];

describe("coach answers (SPEC-v9 M12)", () => {
  it("streams a progress note, the tool's data card and the answer; saves every row with its cost", async () => {
    mock = mockAnthropicStream(volumeThenAnswer());
    const id = ulid();
    const ev = await ask(id, "How was my week?");
    expect(ev.filter((e) => e.type === "progress").map((e) => (e as { text: string }).text)).toEqual(["I'll count this week's sets."]);
    expect(ev.find((e) => e.type === "tool")).toMatchObject({ name: "get_volume" });
    const card = ev.find((e) => e.type === "card") as Extract<CoachEvent, { type: "card" }>;
    expect(card).toMatchObject({ name: "get_volume", is_error: false });
    expect((card.result as { weeks: unknown[] }).weeks.length).toBeGreaterThan(0);
    expect(ev.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Chest is under target so far this week.");
    const done = ev.at(-1) as Extract<CoachEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    const cost = (1200 * 4 + 150 * 20 + 5000 * 5 + 300 * 4 + 120 * 20 + 6200 * 0.2) / 1e6;
    expect(done.cost_usd).toBeCloseTo(cost, 10);

    const saved = await rows(id);
    expect(saved.map((r) => r.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const question = JSON.parse(saved[0].content_json) as { type: string; text: string }[];
    expect(question[0]).toEqual({ type: "text", text: "How was my week?" });
    expect(question.at(-1)!.text).toMatch(/^CONTEXT \(written by the app for this message\)\nToday: \w+ \d{4}-\d{2}-\d{2}\./);
    const call = JSON.parse(saved[1].content_json) as { type: string; signature?: string; thinking?: string }[];
    expect(call.map((b) => b.type)).toEqual(["thinking", "thinking", "tool_use"]);
    expect(call[1]).toMatchObject({ thinking: "I'll count this week's sets.", signature: "sig-1-1" });
    expect(JSON.parse(saved[2].content_json)[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(saved[1].cost_usd! + saved[3].cost_usd!).toBeCloseTo(cost, 10);
    const thread = await env.DB.prepare("SELECT title, archived FROM coach_threads WHERE id = ?").bind(id).first();
    expect(thread).toEqual({ title: "How was my week?", archived: 0 });
  });

  it("a gym schedule uses only the finder's times: an invented one is dropped and reported; nothing is saved before the tap (SPEC-v10 §6)", async () => {
    const tz = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'").first<{ value: string }>())?.value ?? "America/Denver";
    const day = addDays(localDate(tz), 7);
    const at = new Date().toISOString();
    await env.DB.prepare("INSERT INTO work_shifts (id, date, start_min, end_min, note, created_at, updated_at) VALUES ('coach-w1', ?, 720, 1200, '', ?, ?)").bind(day, at, at).run();
    mock = mockAnthropicStream([
      { blocks: [{ type: "tool_use", id: "toolu_f", name: "find_free_slots", input: { week_start: day } }] },
      {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_s",
            name: "propose_schedule",
            input: {
              sessions: [
                { date: day, start: "08:00", reason_fa: "قبل از شیفت طولانی" },
                { date: addDays(day, 1), start: "03:10", reason_fa: "ساعت ساختگی" },
              ],
            },
          },
        ],
      },
      { blocks: [{ type: "text", text: "دو جلسه پیشنهاد دادم." }] },
    ]);
    const ev = await ask(ulid(), "این هفته کِی برم باشگاه؟");
    const cards = ev.filter((e): e is Extract<CoachEvent, { type: "card" }> => e.type === "card");
    const slots = cards.find((c) => c.name === "find_free_slots")!.result as { slots: { date: string; start: string; before_shift_at: string | null }[] };
    expect(slots.slots.find((x) => x.date === day)).toMatchObject({ start: "08:00", before_shift_at: "12:00" });
    const schedule = cards.find((c) => c.name === "propose_schedule")!;
    expect(schedule.is_error).toBe(false);
    const r = schedule.result as { sessions: { date: string; start: string; reason_fa: string }[]; dropped: { date: string; start: string; reason: string }[] };
    expect(r.sessions).toEqual([expect.objectContaining({ date: day, start: "08:00", reason_fa: "قبل از شیفت طولانی" })]);
    expect(r.dropped).toEqual([{ date: addDays(day, 1), start: "03:10", reason: "not a find_free_slots time for that week" }]);
    // The model was told what was dropped (in the tool result it reads next).
    const toolResult = JSON.stringify((mock.calls[2].body.messages as { content: unknown }[]).at(-1));
    expect(toolResult).toContain("not a find_free_slots time for that week");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM gym_plans").first<{ n: number }>()).toEqual({ n: 0 });
    await env.DB.prepare("DELETE FROM work_shifts").run();
  });

  it("exercises for today: the app's numbers and target on the card, unknown ids dropped and told; nothing saved, program unchanged", async () => {
    const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
    const before = {
      sessions: await count("SELECT COUNT(*) AS n FROM workout_sessions"),
      plans: await count("SELECT COUNT(*) AS n FROM planned_sessions"),
      program: JSON.stringify((await env.DB.prepare("SELECT d.id, x.exercise_id, x.sets, x.reps_min, x.reps_max FROM day_exercises x JOIN program_days d ON d.id = x.day_id ORDER BY d.id, x.position").all()).results),
    };
    mock = mockAnthropicStream([
      {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_a",
            name: "propose_session_additions",
            input: {
              program_day_id: "D3",
              items: [
                { exercise_id: "lateral", reason_fa: "سرشانه‌ی جانبی امروز در برنامه نیست" },
                { exercise_id: "made_up_curl", reason_fa: "ساختگی" },
              ],
            },
          },
        ],
      },
      { blocks: [{ type: "text", text: "یک حرکت پیشنهاد دادم؛ اگر خوب است روی Add بزن." }] },
    ]);
    const ev = await ask(ulid(), "امروز پشت دارم، سرشانه هم اضافه کن");
    const card = ev.find((e): e is Extract<CoachEvent, { type: "card" }> => e.type === "card" && e.name === "propose_session_additions")!;
    expect(card.is_error).toBe(false);
    const r = card.result as { target: { kind: string; day_id: string; label: string }; named_day_id: string; items: { exercise_id: string; sets: number; basis: string }[]; dropped: { exercise_id: string; reason: string }[] };
    expect(r.target).toMatchObject({ kind: "today", day_id: "D3", label: "today's Day 3 · Back" });
    expect(r.named_day_id).toBe("D3");
    expect(r.items).toEqual([expect.objectContaining({ exercise_id: "lateral", basis: "program", sets: 3 })]);
    expect(r.dropped).toEqual([{ exercise_id: "made_up_curl", reason: "not in the library: use an id from get_library" }]);
    // The model read what was dropped in the tool result.
    expect(JSON.stringify((mock.calls[1].body.messages as { content: unknown }[]).at(-1))).toContain("made_up_curl");
    // Nothing is saved before his tap, and the program never changes.
    expect(await count("SELECT COUNT(*) AS n FROM workout_sessions")).toBe(before.sessions);
    expect(await count("SELECT COUNT(*) AS n FROM planned_sessions")).toBe(before.plans);
    expect(JSON.stringify((await env.DB.prepare("SELECT d.id, x.exercise_id, x.sets, x.reps_min, x.reps_max FROM day_exercises x JOIN program_days d ON d.id = x.day_id ORDER BY d.id, x.position").all()).results)).toBe(before.program);
  });

  it("calls Opus 5.5 the approved way: no tool_choice, progress updates as text, drop_block, cache breakpoints, unchanged replay", async () => {
    mock = mockAnthropicStream(volumeThenAnswer());
    await ask(ulid(), "How was my week?");
    expect(mock.calls).toHaveLength(2);
    for (const c of mock.calls) {
      const b = c.body as Record<string, any>;
      expect("tool_choice" in b).toBe(false);
      expect(b.model).toBe("claude-opus-5-5");
      expect(b.max_tokens).toBe(8000);
      expect(b.output_config).toEqual({ effort: "medium" });
      expect(b.thinking).toEqual({ type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } });
      expect(b.stream).toBe(true);
      expect(b.system).toEqual([{ type: "text", text: COACH_SYSTEM, cache_control: { type: "ephemeral" } }]);
      expect(b.tools.map((t: { name: string }) => t.name)).toEqual(["get_sessions", "get_e1rm_history", "get_volume", "get_adherence", "get_prs", "get_program", "get_library", "get_body_weight", "get_photos", "get_recovery", "get_training_pattern", "get_calendar", "find_free_slots", "propose_schedule", "propose_exercise", "propose_session_additions", "propose_program"]);
      expect(b.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
      for (const beta of COACH_BETAS) expect(c.headers["anthropic-beta"]).toContain(beta);
    }
    // The second call sends the first call's blocks back unchanged, thinking and signatures included.
    const second = (mock.calls[1].body as { messages: { role: string; content: Record<string, unknown>[] }[] }).messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[1].content.map((b) => b.type)).toEqual(["thinking", "thinking", "tool_use"]);
    expect(second[1].content[1]).toMatchObject({ thinking: "I'll count this week's sets.", signature: "sig-1-1" });
    // The system prompt is the same bytes on every call (the CONTEXT line is in the message instead).
    expect((mock.calls[0].body as { system: unknown }).system).toEqual((mock.calls[1].body as { system: unknown }).system);
  });

  it("saves each row of a chat later than the one before it, so a tool call always reads back before its results", async () => {
    // A deployed Worker's clock stands still while it computes, so an answer and its tool results are made in the same
    // millisecond. The test stops the clock the same way for the whole chat.
    mock = mockAnthropicStream([...volumeThenAnswer(), ...volumeThenAnswer()]);
    const id = ulid();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-15T18:00:00.000Z") });
    try {
      await ask(id, "How was my week?");
      await ask(id, "And last week?");
    } finally {
      vi.useRealTimers();
    }
    const saved = (await env.DB.prepare("SELECT role, created_at, content_json FROM coach_messages WHERE thread_id = ?").bind(id).all<{ role: string; created_at: string; content_json: string }>()).results;
    const byTime = [...saved].sort((a, b) => a.created_at.localeCompare(b.created_at));
    expect(new Set(saved.map((r) => r.created_at)).size).toBe(8);
    expect(byTime.map((r) => [r.role, (JSON.parse(r.content_json) as { type: string }[]).map((b) => b.type).filter((t) => t !== "thinking")[0]])).toEqual([
      ["user", "text"],
      ["assistant", "tool_use"],
      ["user", "tool_result"],
      ["assistant", "text"],
      ["user", "text"],
      ["assistant", "tool_use"],
      ["user", "tool_result"],
      ["assistant", "text"],
    ]);
  });

  it("a failed call keeps the question with an error row; Retry answers it, and the failed call is never sent again", async () => {
    // A 400 (the SDK retries 429, 5xx and 529 on its own before giving up).
    mock = mockAnthropicStream([{ status: 400, type: "invalid_request_error", message: "mock failure" }, ...volumeThenAnswer()]);
    const id = ulid();
    const ev = await ask(id, "How was my week?");
    expect(ev.at(-1)).toMatchObject({ type: "error", code: "api" });
    let saved = await rows(id);
    expect(saved.map((r) => [r.role, r.error?.split(":")[0] ?? null])).toEqual([["user", null], ["assistant", "api"]]);
    expect(JSON.parse(saved[1].content_json)).toEqual([]);

    const retry = events(await (await client.post(`/api/coach/threads/${id}/retry`)).text());
    expect(retry.at(-1)).toMatchObject({ type: "done" });
    saved = await rows(id);
    expect(saved.map((r) => [r.role, r.error ? "error" : "ok"])).toEqual([["user", "ok"], ["assistant", "error"], ["assistant", "ok"], ["user", "ok"], ["assistant", "ok"]]);
    // The retried call starts from the question alone: the failed row is not sent.
    expect((mock.calls.at(-2)!.body as { messages: unknown[] }).messages).toHaveLength(1);
    // Nothing left to retry.
    expect((await client.post(`/api/coach/threads/${id}/retry`)).status).toBe(409);
  });

  it("an expired key is stored as auth; the key itself never appears in a saved or streamed message", async () => {
    mock = mockAnthropicStream([{ status: 401, type: "authentication_error", message: `invalid x-api-key ${env.ANTHROPIC_API_KEY}` }]);
    const id = ulid();
    const ev = await ask(id, "Hi");
    const err = ev.at(-1) as Extract<CoachEvent, { type: "error" }>;
    expect(err.code).toBe("auth");
    expect(err.message).not.toContain(env.ANTHROPIC_API_KEY!);
    const [, row] = await rows(id);
    expect(row.error).toMatch(/^auth: /);
    expect(row.error).not.toContain(env.ANTHROPIC_API_KEY!);
  });

  it(`stops tools after ${MAX_TOOL_CALLS} calls and tells the model to answer with what it has`, async () => {
    const round = (n: number): StreamReply => ({ blocks: [{ type: "tool_use", id: `toolu_${n}`, name: "get_program", input: {} }] });
    mock = mockAnthropicStream([...Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, i) => round(i)), { blocks: [{ type: "text", text: "Done." }] }]);
    const id = ulid();
    const ev = await ask(id, "Program?");
    expect(ev.filter((e) => e.type === "card")).toHaveLength(MAX_TOOL_CALLS);
    const last = JSON.parse((await rows(id)).filter((r) => r.role === "user").at(-1)!.content_json)[0];
    expect(last).toMatchObject({ type: "tool_result", tool_use_id: `toolu_${MAX_TOOL_CALLS}`, is_error: true });
    expect(last.content).toContain("Tool limit reached");
    expect(ev.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Done.");
    expect(mock.pending()).toBe(0);
    expect(ev.at(-1)).toMatchObject({ type: "done" });
  });
});

describe("program drafts", () => {
  /** A library exercise that is in no program and has no logged sets, so the bootstrap does not carry it. */
  async function libraryOnly(id: string, name: string) {
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('exercises')").all<{ name: string }>()).results.map((r) => r.name);
    const value: Record<string, string> = { id: `'${id}'`, name_en: `'${name}'`, source: "'fedb'", source_id: `'${id}'`, archived_at: "NULL" };
    await env.DB.prepare(`INSERT INTO exercises (${cols.join(", ")}) SELECT ${cols.map((c) => value[c] ?? c).join(", ")} FROM exercises WHERE id = 'fly'`).run();
  }

  const draft = {
    name: "Chest focus · 2 days",
    summary_fa: "سینه دو بار در هفته.",
    days: [
      { name: "Day 1 · Chest", exercises: [{ exercise_id: "bench", sets: 4, reps_min: 5, reps_max: 5, rest_sec: 180, is_main: true }, { exercise_id: "fly", sets: 3, reps_min: 10, reps_max: 12, rest_sec: 60, group: "A" }, { exercise_id: "lateral", sets: 3, reps_min: 12, reps_max: 15, rest_sec: 60, group: "A" }] },
      { name: "Day 2 · Legs", exercises: [{ exercise_id: "squat", sets: 4, reps_min: 5, reps_max: 5, rest_sec: 180, is_main: true }, { exercise_id: "hack_squat_machine", sets: 3, reps_min: 8, reps_max: 10, rest_sec: 120 }] },
    ],
  };

  it("the coach sees the whole library: get_library finds an exercise the phone does not carry, and a draft keeps it with its name", async () => {
    await libraryOnly("fedb-Dumbbell_Flyes", "Dumbbell Flyes");
    const boot = (await (await client.fetch("/api/bootstrap")).json()) as { exercises: { id: string }[] };
    expect(boot.exercises.some((e) => e.id === "fedb-Dumbbell_Flyes")).toBe(false);
    const withFlyes = { name: "Chest", days: [{ name: "Day 1 · Chest", exercises: [{ exercise_id: "bench", sets: 4, reps_min: 5, reps_max: 5, rest_sec: 180, is_main: true }, { exercise_id: "fedb-Dumbbell_Flyes", sets: 3, reps_min: 10, reps_max: 12, rest_sec: 60 }] }] };
    mock = mockAnthropicStream([
      { blocks: [{ type: "tool_use", id: "toolu_l", name: "get_library", input: { query: "dumbbell flyes" } }] },
      { blocks: [{ type: "tool_use", id: "toolu_p", name: "propose_program", input: withFlyes }] },
      { blocks: [{ type: "text", text: "Here is the draft." }] },
    ]);
    const ev = await ask(ulid(), "Add dumbbell flyes to a chest day");
    const cards = ev.filter((e): e is Extract<CoachEvent, { type: "card" }> => e.type === "card");
    expect((cards[0].result as { exercises: { id: string; name: string }[] }).exercises).toContainEqual(expect.objectContaining({ id: "fedb-Dumbbell_Flyes", name: "Dumbbell Flyes" }));
    const result = cards[1].result as { draft_id: string; dropped: unknown[]; names: Record<string, string> };
    expect(result.dropped).toEqual([]);
    expect(result.names).toEqual({ bench: "Barbell Bench Press", "fedb-Dumbbell_Flyes": "Dumbbell Flyes" });

    // Add to Planner checks the draft against the same library and saves both exercises.
    const res = await client.post("/api/coach/drafts", { message_id: cards[1].message_id, tool_use_id: cards[1].tool_use_id });
    expect(res.status).toBe(200);
    const saved = await env.DB.prepare("SELECT de.exercise_id FROM day_exercises de JOIN program_days d ON d.id = de.day_id WHERE d.program_id = ? ORDER BY de.position").bind(result.draft_id).all();
    expect(saved.results).toEqual([{ exercise_id: "bench" }, { exercise_id: "fedb-Dumbbell_Flyes" }]);
    // Now in a program, the bootstrap carries it for the Drafts screen.
    const after = (await (await client.fetch("/api/bootstrap")).json()) as { exercises: { id: string }[] };
    expect(after.exercises.some((e) => e.id === "fedb-Dumbbell_Flyes")).toBe(true);
  });

  it("drops ids not in the library; Add to Planner saves an inactive coach draft, never touches the active program, and twice is the same draft", async () => {
    mock = mockAnthropicStream([{ blocks: [{ type: "tool_use", id: "toolu_d", name: "propose_program", input: draft }] }, { blocks: [{ type: "text", text: "Here is the draft." }] }]);
    const id = ulid();
    const ev = await ask(id, "Write me a chest program");
    const card = ev.find((e) => e.type === "card") as Extract<CoachEvent, { type: "card" }>;
    expect(card.name).toBe("propose_program");
    const result = card.result as { draft_id: string; dropped: unknown[]; exercises: number; warnings: string[] };
    expect(result.dropped).toEqual([{ day: "Day 2 · Legs", exercise_id: "hack_squat_machine", reason: "not in the library" }]);
    expect(result.exercises).toBe(4);
    // The generator's check comes back as warnings only; Add to Planner below still saves the draft.
    expect(result.warnings).toContain("No hinge in the week.");

    const before = await env.DB.prepare("SELECT id, active FROM programs ORDER BY id").all();
    const res = await client.post("/api/coach/drafts", { message_id: card.message_id, tool_use_id: card.tool_use_id });
    expect(await res.json()).toEqual({ ok: true, program_id: result.draft_id, existed: false });
    const p = await env.DB.prepare("SELECT name, active, style, days_per_week, generated_by, approved_at FROM programs WHERE id = ?").bind(result.draft_id).first();
    expect(p).toEqual({ name: "Chest focus · 2 days", active: 0, style: "coach", days_per_week: 2, generated_by: "coach", approved_at: null });
    const ex = await env.DB.prepare("SELECT de.exercise_id, de.superset_tag, de.is_main FROM day_exercises de JOIN program_days d ON d.id = de.day_id WHERE d.program_id = ? ORDER BY d.position, de.position").bind(result.draft_id).all();
    expect(ex.results).toEqual([
      { exercise_id: "bench", superset_tag: null, is_main: 1 },
      { exercise_id: "fly", superset_tag: "A1", is_main: 0 },
      { exercise_id: "lateral", superset_tag: "A2", is_main: 0 },
      { exercise_id: "squat", superset_tag: null, is_main: 1 },
    ]);
    const after = await env.DB.prepare("SELECT id, active FROM programs WHERE id <> ? ORDER BY id").bind(result.draft_id).all();
    expect(after.results).toEqual(before.results);
    expect(await (await client.post("/api/coach/drafts", { message_id: card.message_id, tool_use_id: card.tool_use_id })).json()).toEqual({ ok: true, program_id: result.draft_id, existed: true });

    // It is listed as a draft and can be approved with the existing tap.
    const programs = (await (await client.fetch("/api/programs")).json()) as { programs: { id: string; status: string; generated_by: string }[] };
    expect(programs.programs.find((x) => x.id === result.draft_id)).toMatchObject({ status: "draft", generated_by: "coach" });
    const approved = await client.post(`/api/programs/${result.draft_id}/approve`);
    expect(approved.status).toBe(200);
    expect(await env.DB.prepare("SELECT active FROM programs WHERE id = ?").bind(result.draft_id).first()).toEqual({ active: 1 });
    // Back to the seed program for the other tests.
    await client.post("/api/programs/fullbody4/activate");
  });

  it("one more exercise: the card has the app's numbers and only the change; Whole program saves his program plus that exercise as a draft; the active program never changes", async () => {
    const rowsOf = async (programId: string) =>
      (
        await env.DB.prepare("SELECT d.position AS day, x.exercise_id, x.sets, x.reps_min, x.reps_max, x.rest_sec, x.superset_tag, x.is_main FROM day_exercises x JOIN program_days d ON d.id = x.day_id WHERE d.program_id = ? ORDER BY d.position, x.position")
          .bind(programId)
          .all<{ day: number; exercise_id: string; superset_tag: string | null }>()
      ).results;
    const program = await rowsOf("fullbody4");
    mock = mockAnthropicStream([
      { blocks: [{ type: "tool_use", id: "toolu_p", name: "get_program", input: {} }] },
      { blocks: [{ type: "tool_use", id: "toolu_e", name: "propose_exercise", input: { program_day_id: "D1", exercise_id: "fly", after_exercise_id: "lateral", prefer: "program" } }] },
      { blocks: [{ type: "text", text: "یک حرکت ایزوله بعد از سوپرست سرشانه، سینه را بدون فشار بیشتر روی سرشانه کامل می‌کند." }] },
    ]);
    const ev = await ask(ulid(), "از این به بعد روز سینه یک حرکت سینه بیشتر داشته باشم");
    const card = ev.find((e): e is Extract<CoachEvent, { type: "card" }> => e.type === "card" && e.name === "propose_exercise")!;
    expect(card.is_error).toBe(false);
    const r = card.result as ExerciseChange;
    // After lateral (A1) means after the whole A superset: facepull (A2).
    expect(r).toMatchObject({ prefer: "program", program_id: "fullbody4", day: { id: "D1", name: "Day 1 · Chest", position: 1 }, after: { exercise_id: "facepull", name: "Face Pull" } });
    expect(r.exercise).toMatchObject({ exercise_id: "fly", name: "Cable Chest Fly", basis: "program", sets: 3, reps_min: 12, reps_max: 12, rest_sec: 90 });
    expect(r.notes[0]).toMatch(/^Chest: [\d.]+ sets a week with this change \(now [\d.]+; target [\d.]+\)\.$/);
    // The model read the result (numbers and notes), not a program it had to write itself.
    expect(JSON.stringify((mock.calls[2].body.messages as { content: unknown }[]).at(-1))).toContain("sets a week with this change");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM programs WHERE generated_by = 'coach'").first()).toEqual({ n: 0 });

    // Whole program: the same program with Cable Chest Fly after the A superset of Day 1, as an inactive coach draft.
    const res = await client.post("/api/coach/drafts", { message_id: card.message_id, tool_use_id: card.tool_use_id });
    expect(await res.json()).toEqual({ ok: true, program_id: r.draft_id, existed: false });
    expect(await env.DB.prepare("SELECT name, active, style, days_per_week, generated_by, approved_at FROM programs WHERE id = ?").bind(r.draft_id).first()).toEqual({
      name: "Full body · 4 days + Cable Chest Fly",
      active: 0,
      style: "coach",
      days_per_week: 4,
      generated_by: "coach",
      approved_at: null,
    });
    const at = program.findIndex((x) => x.day === 1 && x.exercise_id === "facepull") + 1;
    const fly = { day: 1, exercise_id: "fly", sets: 3, reps_min: 12, reps_max: 12, rest_sec: 90, superset_tag: null, is_main: 0 };
    expect(await rowsOf(r.draft_id)).toEqual([...program.slice(0, at), fly, ...program.slice(at)]);
    // One "about N min": Day 1's estimate in the draft is the card's (the Planner's rule); the other days keep his program's.
    const minutes = async (programId: string) => (await env.DB.prepare("SELECT est_minutes FROM program_days WHERE program_id = ? ORDER BY position").bind(programId).all<{ est_minutes: number }>()).results.map((x) => x.est_minutes);
    const [draftDay1, ...draftRest] = await minutes(r.draft_id);
    const [programDay1, ...programRest] = await minutes("fullbody4");
    expect(draftRest).toEqual(programRest);
    expect(r.notes).toContain(`Day 1 gets about ${draftDay1 - programDay1} min longer (about ${draftDay1} min).`);
    expect(await rowsOf("fullbody4")).toEqual(program);
    expect(await env.DB.prepare("SELECT id FROM programs WHERE active = 1").all()).toMatchObject({ results: [{ id: "fullbody4" }] });
    // A second tap returns the same draft.
    expect(await (await client.post("/api/coach/drafts", { message_id: card.message_id, tool_use_id: card.tool_use_id })).json()).toEqual({ ok: true, program_id: r.draft_id, existed: true });
  });

  it("propose_exercise errors go back to the model: an exercise already in the day, and a day not in his program", async () => {
    mock = mockAnthropicStream([
      { blocks: [{ type: "tool_use", id: "toolu_x", name: "propose_exercise", input: { program_day_id: "D1", exercise_id: "bench" } }, { type: "tool_use", id: "toolu_y", name: "propose_exercise", input: { program_day_id: "D9", exercise_id: "fly" } }] },
      { blocks: [{ type: "text", text: "Which day do you mean?" }] },
    ]);
    const ev = await ask(ulid(), "Add one chest exercise");
    const cards = ev.filter((e): e is Extract<CoachEvent, { type: "card" }> => e.type === "card");
    expect(cards.map((c) => c.is_error)).toEqual([true, true]);
    const told = JSON.stringify((mock.calls[1].body.messages as { content: unknown }[]).at(-1));
    expect(told).toContain("Barbell Bench Press is already in Day 1 · Chest: pick another exercise.");
    expect(told).toMatch(/Unknown program_day_id .*D9.*use a day id of his active program/);
  });
});

describe("photos in the chat", () => {
  it("an upload is stripped of EXIF and sent to the model as an image; a progress photo is copied, never moved", async () => {
    const thread = ulid();
    const att = ulid();
    const put = await client.fetch(`/api/coach/attachments/${att}?thread=${thread}`, { method: "PUT", body: fakeJpeg({ exif: true, comment: true }), headers: { "Content-Type": "image/jpeg" } });
    expect(await put.json()).toMatchObject({ ok: true, existed: false });
    const stored = new Uint8Array(await (await env.PHOTOS.get(`coach/${thread}/${att}.jpg`))!.arrayBuffer());
    expect(hasExif(stored)).toBe(false);
    expect(new TextDecoder("latin1").decode(stored)).not.toContain("GPS");

    // A progress photo picked for the message.
    const photo = ulid();
    await env.DB.prepare("INSERT INTO photos (id, session_id, local_date, pose, r2_key, thumb_r2_key, width, height, bytes, created_at) VALUES (?, NULL, '2026-10-10', 'front', ?, ?, 1200, 1600, 10, '2026-10-10T12:00:00.000Z')")
      .bind(photo, `photos/${photo}/full.jpg`, `photos/${photo}/thumb.jpg`)
      .run();
    await env.PHOTOS.put(`photos/${photo}/full.jpg`, fakeJpeg({}));
    const copy = ulid();
    expect(await (await client.post("/api/coach/attachments/from-photo", { id: copy, thread_id: thread, photo_id: photo })).json()).toEqual({ ok: true, id: copy, width: 1200, height: 1600 });

    mock = mockAnthropicStream([{ blocks: [{ type: "text", text: "A visual estimate: balanced." }] }]);
    const ev = await ask(thread, "Look at these", [
      { id: att, width: 1200, height: 1600 },
      { id: copy, width: 1200, height: 1600 },
    ]);
    expect(ev.at(-1)).toMatchObject({ type: "done" });
    const sent = (mock.calls[0].body as { messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[] }).messages[0].content;
    expect(sent.filter((b) => b.type === "image").map((b) => b.source!.media_type)).toEqual(["image/jpeg", "image/jpeg"]);
    const rowsA = await env.DB.prepare("SELECT id, source_photo_id FROM coach_attachments ORDER BY id").all();
    expect(rowsA.results).toEqual(
      [
        { id: att, source_photo_id: null },
        { id: copy, source_photo_id: photo },
      ].sort((a, b) => a.id.localeCompare(b.id))
    );
    expect(await env.PHOTOS.head(`photos/${photo}/full.jpg`)).not.toBeNull();
    // Served behind sign-in only.
    expect((await client.fetch(`/api/coach/attachments/${att}`)).headers.get("Content-Type")).toBe("image/jpeg");
    expect((await new Client("192.0.2.99").fetch(`/api/coach/attachments/${att}`)).status).toBe(401);
  });

  it("a photo that was never uploaded is refused", async () => {
    const res = await client.post(`/api/coach/threads/${ulid()}/messages`, { id: ulid(), text: "x", attachments: [{ id: ulid(), width: 10, height: 10 }] });
    expect(res.status).toBe(400);
  });
});

describe("chat list, archive and delete", () => {
  it("archive hides a chat and Unarchive brings it back; only an archived chat can be deleted, and the delete removes only that chat", async () => {
    mock = mockAnthropicStream([{ blocks: [{ type: "text", text: "One." }] }, { blocks: [{ type: "text", text: "Two." }] }]);
    const keep = ulid();
    const gone = ulid();
    await ask(keep, "First chat");
    const att = ulid();
    await client.fetch(`/api/coach/attachments/${att}?thread=${gone}`, { method: "PUT", body: fakeJpeg({}), headers: { "Content-Type": "image/jpeg" } });
    await ask(gone, "Second chat", [{ id: att, width: 10, height: 10 }]);
    // An upload whose message was never sent, under the same chat.
    await env.PHOTOS.put(`coach/${gone}/${ulid()}.jpg`, fakeJpeg({}));
    // A progress photo and another chat's photo must stay.
    await env.PHOTOS.put("photos/KEEP/full.jpg", fakeJpeg({}));
    const list = async (archived: 0 | 1) => ((await (await client.fetch(`/api/coach/threads?archived=${archived}`)).json()) as { threads: { id: string }[] }).threads.map((t) => t.id);
    expect((await list(0)).sort()).toEqual([keep, gone].sort());

    expect((await client.fetch(`/api/coach/threads/${gone}`, { method: "DELETE" })).status).toBe(409);
    expect((await client.post(`/api/coach/threads/${gone}/archive`)).status).toBe(200);
    expect(await list(0)).toEqual([keep]);
    expect(await list(1)).toEqual([gone]);
    expect((await client.post(`/api/coach/threads/${gone}/unarchive`)).status).toBe(200);
    expect((await list(0)).sort()).toEqual([keep, gone].sort());
    await client.post(`/api/coach/threads/${gone}/archive`);

    const count = async (table: string) => ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()) as { n: number }).n;
    const tables = ["workout_sessions", "set_entries", "photos", "programs", "exercises", "session_reports", "training_overviews", "body_metrics"];
    const before = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)])));
    const del = await client.fetch(`/api/coach/threads/${gone}`, { method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true, deleted_objects: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM coach_messages WHERE thread_id = ?").bind(gone).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM coach_threads WHERE id = ?").bind(gone).first()).toEqual({ n: 0 });
    expect(await count("coach_attachments")).toBe(0);
    expect((await env.PHOTOS.list({ prefix: `coach/${gone}/` })).objects).toHaveLength(0);
    expect(await env.PHOTOS.head("photos/KEEP/full.jpg")).not.toBeNull();
    expect(Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)])))).toEqual(before);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM coach_messages WHERE thread_id = ?").bind(keep).first()).toEqual({ n: 2 });
    expect(await list(1)).toEqual([]);
  });

  it("Me → AI reports: this month's coach questions and the cost of every coach call", async () => {
    mock = mockAnthropicStream(volumeThenAnswer());
    await ask(ulid(), "How was my week?");
    const u = (await (await client.fetch("/api/ai/usage")).json()) as { coach: { messages: number; cost_usd: number } };
    expect(u.coach.messages).toBe(1);
    expect(u.coach.cost_usd).toBe(Math.round(((1200 * 4 + 150 * 20 + 5000 * 5 + 300 * 4 + 120 * 20 + 6200 * 0.2) / 1e6) * 100) / 100);
  });
});

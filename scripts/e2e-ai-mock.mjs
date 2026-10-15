// Mock of the Claude Messages API for the Playwright tests (SPEC-v3: the real API is never called in tests). The e2e
// Workers point ANTHROPIC_BASE_URL here. It answers like the model would, from the request's own input:
//   session report:    a short Persian report that names the extra exercises and copies the volume rows given
//   plan advice:       "add" the first candidate not in the plan, at position 2
//   training overview: Persian prose using only the input's numbers, plus one warning with a number the input lacks
//                      (the app must drop it), and the weekly motivational line from the motivation block
//   coach (SPEC-v9 M12):  streamed like the real API (server-sent events), with a progress note between tool calls as a
//                      thinking block (thinking.display "updates"). A question about a program reads get_program, then
//                      proposes a draft with one id that is not in the library; a message with a photo gets a short
//                      visual-estimate answer; anything else reads get_volume for this week, then answers with text.
// Tests switch the answers with GET /__mode?report=ok|fail|auth&advice=ok|fail|auth&overview=ok|fail|auth&coach=ok|fail|auth
// and read GET /__calls (the count, the last call and the last call of each kind; coach calls also record the request
// shape: tool_choice, thinking, betas, cache breakpoints, images and message count).
import { createServer } from "node:http";

/**
 * The weekly motivational line as the prompt asks for it, from the input's motivation block only: each reported week's
 * sessions done and planned; on a bad week, plainly so and one next step; otherwise a record or a main-lift gain.
 */
export function motivationLine(m) {
  if (!m) return null;
  const weeks = m.cover.map((k) => {
    const w = m[k];
    const label = k === "last_week" ? "هفتهٔ گذشته" : m.phase === "end" ? "این هفته" : "این هفته تا امروز";
    return `${label} ${w.sessions_done} جلسه از ${w.sessions_planned} جلسهٔ برنامه انجام شد`;
  });
  if (m.cover.some((k) => m[k].bad)) return `${weeks.join("؛ ")}، یعنی کمتر از نصف برنامه. قدم بعدی: ${m.next_session ?? "جلسهٔ بعدی برنامه"} را در اولین فرصت انجام بده.`;
  const week = m.phase === "start" ? m.last_week : m.this_week;
  const record = (m.phase === "start" && m.today_session?.records[0]) || week.records[0];
  const gain = week.main_lifts.find((l) => l.change_pct != null && l.change_pct > 0);
  const extra = record ? `، با رکورد تازه در ${record.name} (${record.weight}×${record.reps})` : gain ? `، و ${gain.name} ${gain.change_pct}٪ بهتر از هفتهٔ قبل` : "";
  const today = m.phase === "start" && m.today_session ? ` امروز هفته با ${m.today_session.day} و ${m.today_session.sets_done} ست شروع شد.` : "";
  return `${weeks.join("؛ ")}${extra}.${today}`;
}

/** The training overview reply: Persian prose using only the input's numbers, plus one warning with a number the input lacks (dropped by the app). */
export function overviewReply(input) {
  return {
    summary_fa: `در ${input.window.weeks} هفتهٔ اخیر ${input.totals.sessions_done} جلسه از ${input.totals.sessions_planned} جلسهٔ برنامه انجام شد و روند کلی خوب است.`,
    trends: input.lifts.filter((l) => l.change_pct != null).map((l) => `${l.name}: ${l.change_pct}٪ تغییر در این بازه.`),
    volume_fa: "سینه اولویت توست؛ حجم آن را با هدف هفتگی هماهنگ نگه دار.",
    consistency_fa: "جلسه‌ها را طبق برنامه ادامه بده.",
    focus_next: ["روی حرکت‌های سینه با فرم درست تمرکز کن."],
    warnings: ["۹۹۹۹ ست اضافه بزن."],
    motivation_fa: motivationLine(input.motivation),
  };
}

export function startAiMock(port) {
  const mode = { report: "ok", advice: "ok", overview: "ok", coach: "ok" };
  const calls = [];
  const lastOf = {};
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "request-id": "req_e2e_mock" });
    res.end(JSON.stringify(body));
  };
  const message = (json, usage = { input_tokens: 4200, output_tokens: 850 }) => ({
    id: `msg_e2e_${calls.length}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify(json) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
  });

  const report = (input) => {
    const extras = input.exercises.filter((x) => x.is_extra && x.done_sets.length).map((x) => x.name);
    const trained = input.week_so_far.volume.filter((v) => v.today > 0 || v.target != null);
    return {
      summary_fa: `جلسهٔ ${input.session.program_day} انجام شد؛ ${input.exercises.filter((x) => x.done_sets.length).length} حرکت با ست‌های کامل.`,
      highlights: input.prs_today.map((p) => `رکورد تازه در ${p.name}: ${p.weight} × ${p.reps}`),
      volume: trained.map((v) => ({ group: v.group, today: v.today, week: v.week, target: v.target, status: v.status })),
      extras_note_fa: extras.length ? `حرکت‌های اضافه: ${extras.join("، ")}.` : null,
      missed_note_fa: input.missed.exercises_not_done.length ? `انجام نشد: ${input.missed.exercises_not_done.join("، ")}.` : null,
      // Notes only, like the real prompt asks; one with a number, which the app must not show.
      next_time: input.exercises.filter((x) => x.app_next_time).map((x, i) => ({ exercise_id: x.exercise_id, note_fa: i === 0 ? "همین مسیر را با فرم درست ادامه بده." : "دفعهٔ بعد ۲۰۰ پوند." })),
      warnings: [],
    };
  };

  const advice = (input) => {
    const pick = input.candidates.find((c) => !c.in_plan);
    return {
      assessment_fa: "برنامه با تمرین‌های اخیر هماهنگ است؛ یک حرکت تکمیلی پیشنهاد می‌شود.",
      suggestions: pick ? [{ type: "add", exercise_id: pick.id, replace_exercise_id: null, position: 2, sets: 3, reason_fa: "این گروه این هفته زیر هدف است." }] : [],
    };
  };

  const overview = overviewReply;

  /** One streamed coach reply: content blocks sent as server-sent events, a few milliseconds apart. */
  const stream = async (res, blocks, stop, usage) => {
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_e2e_mock" });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const pause = () => new Promise((r) => setTimeout(r, 25));
    ev("message_start", { message: { id: `msg_e2e_${calls.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1, cache_creation_input_tokens: usage.write, cache_read_input_tokens: usage.read } } });
    for (const [index, b] of blocks.entries()) {
      if (b.type === "thinking") {
        ev("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
        for (const part of b.thinking.match(/.{1,12}/gsu) ?? []) {
          ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: part } });
          await pause();
        }
        ev("content_block_delta", { index, delta: { type: "signature_delta", signature: `sig-e2e-${calls.length}-${index}` } });
      } else if (b.type === "text") {
        ev("content_block_start", { index, content_block: { type: "text", text: "" } });
        for (const part of b.text.match(/.{1,16}/gsu) ?? []) {
          ev("content_block_delta", { index, delta: { type: "text_delta", text: part } });
          await pause();
        }
      } else {
        ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
        ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      }
      ev("content_block_stop", { index });
    }
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output } });
    ev("message_stop", {});
    res.end();
  };

  const coach = (req, res, body) => {
    const blocksOf = (m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
    const all = body.messages.flatMap((m) => blocksOf(m).map((b) => ({ role: m.role, ...b })));
    const last = body.messages.at(-1);
    const lastBlocks = blocksOf(last);
    const questions = body.messages.filter((m) => m.role === "user" && blocksOf(m).some((b) => b.type === "image" || (b.type === "text" && !b.text.startsWith("CONTEXT"))));
    const question = blocksOf(questions.at(-1) ?? last);
    const text = question.filter((b) => b.type === "text" && !b.text.startsWith("CONTEXT")).map((b) => b.text).join(" ");
    const images = question.filter((b) => b.type === "image").length;
    const call = {
      kind: "coach",
      model: body.model,
      effort: body.output_config?.effort,
      max_tokens: body.max_tokens,
      key_set: Boolean(req.headers["x-api-key"]),
      tool_choice: body.tool_choice ?? null,
      thinking: body.thinking ?? null,
      betas: String(req.headers["anthropic-beta"] ?? ""),
      tools: (body.tools ?? []).map((t) => t.name),
      system_cached: Array.isArray(body.system) && body.system.some((b) => b.cache_control),
      last_block_cached: Boolean(lastBlocks.at(-1)?.cache_control),
      messages: body.messages.length,
      images: all.filter((b) => b.type === "image").length,
      image_bytes: all.filter((b) => b.type === "image").map((b) => b.source?.data?.length ?? 0),
      thinking_replayed: all.filter((b) => b.type === "thinking" && b.signature).length,
      question: text,
    };
    calls.push(call);
    lastOf.coach = call;
    if (mode.coach === "auth") return send(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (mode.coach === "fail") return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "mock failure" } });
    const results = lastBlocks.filter((b) => b.type === "tool_result");
    const usage = { input: 900, write: results.length ? 0 : 5200, read: results.length ? 5200 : 0, output: 300 };
    const persian = /[\u0600-\u06FF]/.test(text);
    const program = /program|برنامه/i.test(text);
    const done = new Set(all.filter((b) => b.type === "tool_use").map((b) => b.name));
    const tool = (name, input) => ({ type: "tool_use", id: `toolu_e2e_${calls.length}_${name}`, name, input });
    const note = (t) => ({ type: "thinking", thinking: t });
    if (images && !results.length)
      return void stream(res, [{ type: "text", text: persian ? "این یک برآورد دیداری است: شانه‌ها و سینه متعادل دیده می‌شوند. از یک عکس ثابت نمی‌توان فرم را کامل قضاوت کرد." : "This is a visual estimate: shoulders and chest look balanced. One still photo cannot fully judge technique." }], "end_turn", usage);
    if (program && !done.has("get_program")) return void stream(res, [note(persian ? "اول برنامه‌ی فعلی‌ات را می‌خوانم." : "First I'll read your current program."), tool("get_program", {})], "tool_use", usage);
    if (program && !done.has("propose_program"))
      return void stream(
        res,
        [
          note(persian ? "حالا پیش‌نویس را می‌نویسم." : "Now I'll write the draft."),
          tool("propose_program", {
            name: "Chest focus · 2 days",
            summary_fa: "سینه دو بار در هفته با یک حرکت اصلی سنگین در روز اول.",
            days: [
              { name: "Day 1 · Chest", exercises: [{ exercise_id: "bench", sets: 4, reps_min: 5, reps_max: 5, rest_sec: 180, is_main: true }, { exercise_id: "fly", sets: 3, reps_min: 10, reps_max: 12, rest_sec: 60, group: "A" }, { exercise_id: "lateral", sets: 3, reps_min: 12, reps_max: 15, rest_sec: 60, group: "A" }, { exercise_id: "fedb-Dumbbell_Flyes", sets: 3, reps_min: 10, reps_max: 12, rest_sec: 60 }] },
              { name: "Day 2 · Legs", exercises: [{ exercise_id: "squat", sets: 4, reps_min: 5, reps_max: 5, rest_sec: 180, is_main: true }, { exercise_id: "hack_squat_machine", sets: 3, reps_min: 8, reps_max: 10, rest_sec: 120 }] },
            ],
          }),
        ],
        "tool_use",
        usage
      );
    if (program) return void stream(res, [{ type: "text", text: persian ? "پیش‌نویس سینه را دو بار در هفته می‌گذارد. اگر خوب است به برنامه‌ریز اضافه کن." : "The draft trains chest twice a week. Add it to the Planner if it looks right." }], "end_turn", usage);
    if (!done.has("get_volume")) {
      const today = /Today: \w+ (\d{4}-\d{2}-\d{2})/.exec(question.map((b) => b.text ?? "").join("\n"))?.[1] ?? "2026-10-15";
      return void stream(res, [note(persian ? "ست‌های این هفته‌ات را می‌شمارم." : "I'll count this week's sets."), tool("get_volume", { from: today, to: today })], "tool_use", usage);
    }
    return void stream(res, [{ type: "text", text: persian ? "این هفته تا امروز سینه زیر هدف است؛ دو ست دیگر اضافه کن.\n\n- اول پرس سینه\n- بعد فلای" : "So far this week chest is under target; add two more sets.\n\n- Bench first\n- Then flyes" }], "end_turn", usage);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === "GET" && url.pathname === "/__mode") {
      for (const k of ["report", "advice", "overview", "coach"]) if (url.searchParams.has(k)) mode[k] = url.searchParams.get(k);
      return send(res, 200, { ...mode });
    }
    if (req.method === "GET" && url.pathname === "/__calls") return send(res, 200, { calls: calls.length, last: calls.at(-1) ?? null, by_kind: lastOf });
    if (req.method !== "POST" || url.pathname !== "/v1/messages") return send(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const system = Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n") : String(body.system);
      if (system.includes("You are the coach in GYM time")) return coach(req, res, body);
      const kind = system.includes("overview of Payam") ? "overview" : system.includes("training report") ? "report" : "advice";
      const call = { kind, model: body.model, effort: body.output_config?.effort, max_tokens: body.max_tokens, key_set: Boolean(req.headers["x-api-key"]) };
      calls.push(call);
      lastOf[kind] = call;
      const m = mode[kind];
      if (m === "auth") return send(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      if (m === "fail") return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "mock failure" } });
      const input = JSON.parse(body.messages[0].content);
      send(res, 200, message(kind === "report" ? report(input) : kind === "overview" ? overview(input) : advice(input)));
    });
  });
  return new Promise((resolve) => server.listen(Number(port), "127.0.0.1", () => resolve(server)));
}

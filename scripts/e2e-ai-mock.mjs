// Mock of the Claude Messages API for the Playwright tests (SPEC-v3: the real API is never called in tests). The e2e
// Workers point ANTHROPIC_BASE_URL here. It answers like the model would, from the request's own input:
//   session report: a short Persian report that names the extra exercises and copies the volume rows given
//   plan advice:    "add" the first candidate not in the plan, at position 2
// Tests switch the answers with GET /__mode?report=ok|fail|auth&advice=ok|fail|auth and read GET /__calls.
import { createServer } from "node:http";

export function startAiMock(port) {
  const mode = { report: "ok", advice: "ok" };
  const calls = [];
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

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === "GET" && url.pathname === "/__mode") {
      for (const k of ["report", "advice"]) if (url.searchParams.has(k)) mode[k] = url.searchParams.get(k);
      return send(res, 200, { ...mode });
    }
    if (req.method === "GET" && url.pathname === "/__calls") return send(res, 200, { calls: calls.length, last: calls.at(-1) ?? null });
    if (req.method !== "POST" || url.pathname !== "/v1/messages") return send(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const kind = String(body.system).includes("training report") ? "report" : "advice";
      calls.push({ kind, model: body.model, effort: body.output_config?.effort, key_set: Boolean(req.headers["x-api-key"]) });
      const m = mode[kind];
      if (m === "auth") return send(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      if (m === "fail") return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "mock failure" } });
      const input = JSON.parse(body.messages[0].content);
      send(res, 200, message(kind === "report" ? report(input) : advice(input)));
    });
  });
  return new Promise((resolve) => server.listen(Number(port), "127.0.0.1", () => resolve(server)));
}

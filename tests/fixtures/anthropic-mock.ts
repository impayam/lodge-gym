// A mock of the Claude Messages API for the Worker tests: replaces worker/ai.ts `aiTransport.fetch`, records each
// request body, and answers from a queue. The real API is never called in tests.

import { aiTransport } from "../../worker/ai";

export type MockReply =
  | { json: unknown; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number }; model?: string }
  | { text: string; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number } }
  /** A JSON reply built from the request's input (the user message), like the model writing from what it was given. */
  | { build: (input: any) => unknown; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number } }
  | { status: number; type: string; message: string };

export interface MockCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function mockAnthropic(replies: MockReply[]) {
  const calls: MockCall[] = [];
  const queue = [...replies];
  const previous = aiTransport.fetch;
  aiTransport.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: Object.fromEntries(req.headers), body: (await req.json()) as Record<string, unknown> });
    const r = queue.shift();
    if (!r) throw new Error("mockAnthropic: no reply queued");
    if ("status" in r)
      return new Response(JSON.stringify({ type: "error", error: { type: r.type, message: r.message } }), { status: r.status, headers: { "content-type": "application/json", "request-id": "req_mock" } });
    const body = calls[calls.length - 1].body as { messages: { content: string }[] };
    const text = "json" in r ? JSON.stringify(r.json) : "build" in r ? JSON.stringify(r.build(JSON.parse(body.messages[0].content))) : r.text;
    return new Response(
      JSON.stringify({
        id: `msg_mock_${calls.length}`,
        type: "message",
        role: "assistant",
        model: ("model" in r && r.model) || "claude-opus-5-5",
        content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }],
        stop_reason: r.stop_reason ?? "end_turn",
        stop_sequence: null,
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...(r.usage ?? { input_tokens: 4000, output_tokens: 900 }) },
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req_mock" } }
    );
  };
  return {
    calls,
    pending: () => queue.length,
    restore: () => {
      aiTransport.fetch = previous;
    },
  };
}

/** A valid report reply (SPEC-v3 M9a output format). */
export const REPORT_REPLY = {
  summary_fa: "جلسهٔ خوبی بود؛ پرس سینه از هفتهٔ پیش قوی‌تر شد.",
  highlights: ["رکورد تازه در پرس سینه"],
  volume: [{ group: "Chest", today: 0, week: 0, target: 0, status: "on" }],
  extras_note_fa: "جلوبازو با دمبل حجم بازو را کامل کرد.",
  missed_note_fa: null,
  next_time: [{ exercise_id: "bench", note_fa: "همین وزن را نگه دار و همهٔ تکرارها را کامل کن." }],
  warnings: [],
};

/** A valid training overview reply (SPEC-v7 M9d output format), with no numbers. */
export const OVERVIEW_REPLY = {
  summary_fa: "روند تمرین خوب است و جلسه‌ها منظم انجام شده‌اند.",
  trends: ["پرس سینه رو به بالاست."],
  volume_fa: "سینه این هفته هنوز زیر هدف است.",
  consistency_fa: "جلسه‌ها طبق برنامه انجام شده‌اند.",
  focus_next: ["روی حرکت‌های سینه تمرکز کن."],
  warnings: [],
  motivation_fa: null as string | null,
};

/** A content block of a streamed coach reply. */
export type StreamBlock =
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type StreamReply =
  | { blocks: StreamBlock[]; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  | { status: number; type: string; message: string };

/** The coach's streamed calls (server-sent events, as the Messages API streams them), from a queue. */
export function mockAnthropicStream(replies: StreamReply[]) {
  const calls: MockCall[] = [];
  const queue = [...replies];
  const previous = aiTransport.fetch;
  aiTransport.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: Object.fromEntries(req.headers), body: (await req.json()) as Record<string, unknown> });
    const r = queue.shift();
    if (!r) throw new Error("mockAnthropicStream: no reply queued");
    if ("status" in r)
      return new Response(JSON.stringify({ type: "error", error: { type: r.type, message: r.message } }), { status: r.status, headers: { "content-type": "application/json", "request-id": "req_mock" } });
    const u = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(r.usage ?? {}) };
    const lines: string[] = [];
    const ev = (type: string, data: object) => lines.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: `msg_mock_${calls.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { ...u, output_tokens: 1 } } });
    r.blocks.forEach((b, index) => {
      if (b.type === "thinking") {
        ev("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
        if (b.thinking) ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.thinking } });
        ev("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature ?? `sig-${calls.length}-${index}` } });
      } else if (b.type === "text") {
        ev("content_block_start", { index, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
      } else {
        ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
        ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      }
      ev("content_block_stop", { index });
    });
    ev("message_delta", { delta: { stop_reason: r.stop_reason ?? (r.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"), stop_sequence: null }, usage: { output_tokens: u.output_tokens } });
    ev("message_stop", {});
    return new Response(lines.join(""), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_mock" } });
  };
  return {
    calls,
    pending: () => queue.length,
    restore: () => {
      aiTransport.fetch = previous;
    },
  };
}

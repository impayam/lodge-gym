// A mock of the Claude Messages API for the Worker tests: replaces worker/ai.ts `aiTransport.fetch`, records each
// request body, and answers from a queue. The real API is never called in tests.

import { aiTransport } from "../../worker/ai";

export type MockReply =
  | { json: unknown; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number }; model?: string }
  | { text: string; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number } }
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
    const text = "json" in r ? JSON.stringify(r.json) : r.text;
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

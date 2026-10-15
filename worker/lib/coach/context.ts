// What the coach model is sent from a saved chat (SPEC-v9 M12 §6): the whole thread up to a token budget
// (COACH_CONTEXT_TOKENS, default 60 000). Older messages stay saved and visible but are not sent. Pure; the Worker
// turns image references into image blocks.
//
// Messages are replayed exactly as saved, thinking blocks included (Claude Opus 5.5 needs them unchanged). A failed
// call (an assistant row with an error) is never sent again, and a tool call whose results were never saved (the
// answer stopped half-way) is left out, so the API always gets a valid conversation.

export const DEFAULT_CONTEXT_TOKENS = 60_000;

/** A content block as saved in coach_messages.content_json. Images keep only their attachment id and size. */
export type StoredBlock =
  | { type: "text"; text: string; [k: string]: unknown }
  | { type: "image"; attachment_id: string; width: number; height: number }
  | { type: "thinking"; thinking: string; signature: string; [k: string]: unknown }
  | { type: "redacted_thinking"; data: string; [k: string]: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown; [k: string]: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: StoredBlock[];
  created_at: string;
  error: string | null;
}

/** A Payam message (text or photos), as opposed to a row that only carries tool results. */
/**
 * The time to save a chat row at: now, or 1 ms after the previous row when the clock has not moved. Rows are read back
 * in created_at order, and a Worker's clock stands still while it computes, so an answer and its tool results would
 * otherwise share a millisecond and could come back in either order.
 */
export function nextStamp(prev: string | null | undefined, nowMs: number = Date.now()): string {
  const after = prev ? Date.parse(prev) + 1 : -Infinity;
  return new Date(Math.max(nowMs, after)).toISOString();
}

export const isQuestion = (m: StoredMessage) => m.role === "user" && m.content.some((b) => b.type === "text" || b.type === "image");

/**
 * Rough token count of a message: text and JSON at 1 token per 3 characters (Persian runs denser than English), an
 * image at width × height / 750, as the API counts images. Only used to decide what fits in the budget.
 */
export function estimateTokens(m: StoredMessage): number {
  let n = 4;
  for (const b of m.content) {
    if (b.type === "image") n += Math.ceil((b.width * b.height) / 750);
    else if (b.type === "text") n += Math.ceil(b.text.length / 3);
    else if (b.type === "thinking") n += Math.ceil((b.thinking.length + b.signature.length / 4) / 3);
    else if (b.type === "redacted_thinking") n += Math.ceil(b.data.length / 12);
    else if (b.type === "tool_use") n += Math.ceil(JSON.stringify(b.input ?? {}).length / 3) + 10;
    else n += Math.ceil(b.content.length / 3) + 10;
  }
  return n;
}

/** The thread without failed calls and without tool calls that have no saved results. */
export function validHistory(rows: StoredMessage[]): StoredMessage[] {
  const ok = rows.filter((r) => !r.error);
  const out: StoredMessage[] = [];
  for (let i = 0; i < ok.length; i++) {
    const m = ok[i];
    const calls = m.role === "assistant" ? m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id) : [];
    if (calls.length) {
      const next = ok[i + 1];
      const answered = new Set(next?.role === "user" ? next.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])) : []);
      if (!calls.every((id) => answered.has(id))) continue;
    }
    // Tool results whose call was left out go too.
    if (m.role === "user" && !isQuestion(m)) {
      const prev = out.at(-1);
      const asked = new Set(prev?.role === "assistant" ? prev.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])) : []);
      if (!m.content.every((b) => b.type !== "tool_result" || asked.has(b.tool_use_id))) continue;
    }
    if (m.content.length) out.push(m);
  }
  return out;
}

export interface Window {
  /** The messages to send, oldest first; the first is always one of Payam's questions. */
  messages: StoredMessage[];
  /** Saved messages that are left out because of the budget (the chat shows a line about them). */
  omitted: number;
}

/**
 * The newest messages that fit in `budget` estimated tokens, starting at one of Payam's questions. The latest question
 * and everything after it are always sent, even when they alone exceed the budget.
 */
export function contextWindow(rows: StoredMessage[], budget = DEFAULT_CONTEXT_TOKENS): Window {
  const history = validHistory(rows);
  const lastQuestion = history.map(isQuestion).lastIndexOf(true);
  if (lastQuestion < 0) return { messages: [], omitted: history.length };
  let start = lastQuestion;
  let used = history.slice(lastQuestion).reduce((a, m) => a + estimateTokens(m), 0);
  for (let i = lastQuestion - 1; i >= 0; i--) {
    used += estimateTokens(history[i]);
    if (used > budget) break;
    if (isQuestion(history[i])) start = i;
  }
  return { messages: history.slice(start), omitted: start };
}

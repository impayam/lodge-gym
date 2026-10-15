// One coach answer (SPEC-v9 M12): the model call with the read-only tools, run by the AiJobs Durable Object so a long
// streamed answer has the Durable Object's CPU budget, and streamed to the chat as server-sent events.
//
// Claude Opus 5.5 specifics (Payam, 2026-10-15):
// - tool_choice is never set (forced tool use is an error on this model); the model calls tools on its own.
// - thinking.display "updates": the notes the model writes between tool calls come back as thinking blocks; with this
//   setting their text is returned (reasoning stays hidden) and the chat shows it as a progress line.
// - thinking blocks are saved and sent back unchanged. The system prompt and the tools never change, and every
//   request sends the saved messages unchanged; when older messages fall outside the token budget the prefix changes,
//   so block_binding "drop_block" lets the API drop the thinking it can no longer check instead of failing.
//
// At most MAX_TOOL_CALLS tool calls per answer; after that the model is told to answer with what it has. A failed call
// is saved as an assistant row with an error (never sent again) and the chat shows "Answer failed — Retry".

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { aiTransport, effortOf, type Effort } from "./ai";
import { loadReportData } from "./reports";
import { mapExercise } from "./data";
import type { ReportData } from "./lib/reports";
import { callCostUsd, type CallTokens } from "./lib/ai/cost";
import { COACH_SYSTEM } from "./lib/coach/prompt";
import { COACH_TOOLS, runTool, type CoachData } from "./lib/coach/tools";
import { proposeProgram } from "./lib/coach/draft";
import { contextWindow, DEFAULT_CONTEXT_TOKENS, nextStamp, type StoredBlock, type StoredMessage } from "./lib/coach/context";
import { localDate } from "./lib/time";
import { ulid } from "./lib/ulid";
import type { CoachEvent } from "./lib/coach/events";

export type { CoachEvent };

export const COACH_DEFAULT_MODEL = "claude-opus-5-5";
export const COACH_DEFAULT_MAX_TOKENS = 8000;
/** Tool calls per answer (decision 10). */
export const MAX_TOOL_CALLS = 8;
/** Beta features the coach request uses: progress updates as text, and dropping thinking blocks that fail the check. */
export const COACH_BETAS = ["thinking-display-updates-2026-08-18", "thinking-binding-controls-2026-08-01"];

export const coachModelOf = (env: Env) => env.COACH_MODEL?.trim() || COACH_DEFAULT_MODEL;
export const coachEffortOf = (env: Env): Effort => effortOf(env.COACH_EFFORT, "medium");

export function coachMaxTokensOf(env: Env): number {
  const n = Number(env.COACH_MAX_TOKENS);
  return Number.isInteger(n) && n >= 1024 && n <= 64_000 ? n : COACH_DEFAULT_MAX_TOKENS;
}

export function coachContextOf(env: Env): number {
  const n = Number(env.COACH_CONTEXT_TOKENS);
  return Number.isInteger(n) && n >= 4000 && n <= 900_000 ? n : DEFAULT_CONTEXT_TOKENS;
}

export interface CoachRow extends StoredMessage {
  thread_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  model: string | null;
}

export async function readThreadRows(env: Env, threadId: string): Promise<CoachRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, thread_id, role, content_json, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, model, error
       FROM coach_messages WHERE thread_id = ? ORDER BY created_at, id`
  )
    .bind(threadId)
    .all<Omit<CoachRow, "content"> & { content_json: string }>();
  return rows.results.map(({ content_json, ...r }) => ({ ...r, content: JSON.parse(content_json) as StoredBlock[] }));
}

const insertRow = (env: Env, r: Omit<CoachRow, "content"> & { content: unknown }) =>
  env.DB.prepare(
    `INSERT INTO coach_messages (id, thread_id, role, content_json, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, model, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(r.id, r.thread_id, r.role, JSON.stringify(r.content), r.created_at, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.cost_usd, r.model, r.error);

const touchThread = (env: Env, threadId: string, at: string) => env.DB.prepare("UPDATE coach_threads SET updated_at = ? WHERE id = ?").bind(at, threadId);

/** The key never appears in a stored or sent error message. */
function failure(e: unknown, key: string): { code: string; message: string } {
  const text = (e instanceof Error ? e.message : String(e)).split(key).join("[key]").slice(0, 300);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { code: "auth", message: text };
  if (e instanceof Anthropic.RateLimitError) return { code: "rate", message: text };
  if (e instanceof Anthropic.APIConnectionError) return { code: "network", message: text };
  return { code: "api", message: text };
}

/** A saved message as the API takes it: image references become image blocks read from R2. */
async function toParam(env: Env, m: StoredMessage, images: Map<string, string>): Promise<Anthropic.Beta.BetaMessageParam> {
  const content: unknown[] = [];
  for (const b of m.content) {
    if (b.type !== "image") {
      content.push(b);
      continue;
    }
    let data = images.get(b.attachment_id);
    if (data === undefined) {
      const row = await env.DB.prepare("SELECT r2_key FROM coach_attachments WHERE id = ?").bind(b.attachment_id).first<{ r2_key: string }>();
      const obj = row ? await env.PHOTOS.get(row.r2_key) : null;
      data = obj ? base64(new Uint8Array(await obj.arrayBuffer())) : "";
      images.set(b.attachment_id, data);
    }
    content.push(data ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data } } : { type: "text", text: "[A photo that is no longer available.]" });
  }
  return { role: m.role, content: content as Anthropic.Beta.BetaContentBlockParam[] };
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * The coach's data: the report data with the whole exercise library, as the Library tab and the planner advice have
 * it. The bootstrap set (program, logged, seed and custom exercises) would hide the rest of the library from
 * get_library and make propose_program drop it. Report numbers are the same: they only look up exercises in use.
 */
export async function loadCoachData(env: Env): Promise<ReportData> {
  const [d, library] = await Promise.all([loadReportData(env), env.DB.prepare("SELECT * FROM exercises").all<Record<string, unknown>>()]);
  return { ...d, exercises: library.results.map(mapExercise) };
}

/** The system prompt and the tools, with one cache breakpoint after them (tools come first in the cached prefix). */
const SYSTEM: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: COACH_SYSTEM, cache_control: { type: "ephemeral" } }];
const TOOLS = COACH_TOOLS as unknown as Anthropic.Beta.BetaToolUnion[];

/**
 * Answers the thread's latest question (or continues an answer whose tool results are saved) and streams the events.
 * Every model call is saved as one assistant row, every set of tool results as one user row.
 */
export async function runCoachTurn(env: Env, threadId: string, emit: (e: CoachEvent) => void): Promise<void> {
  const model = coachModelOf(env);
  const key = env.ANTHROPIC_API_KEY?.trim();
  const rows = await readThreadRows(env, threadId);
  // Every saved row is later than the one before it (see nextStamp).
  let lastAt = rows.at(-1)?.created_at;
  const now = () => (lastAt = nextStamp(lastAt));
  const saveError = async (code: string, message: string, tokens?: CallTokens, served = model) => {
    const at = now();
    await env.DB.batch([
      insertRow(env, {
        id: ulid(),
        thread_id: threadId,
        role: "assistant",
        content: [],
        created_at: at,
        input_tokens: tokens?.input_tokens ?? null,
        output_tokens: tokens?.output_tokens ?? null,
        cache_read_tokens: tokens?.cache_read_tokens ?? null,
        cache_write_tokens: tokens?.cache_write_tokens ?? null,
        cost_usd: tokens ? callCostUsd(served, tokens) : null,
        model: served,
        error: `${code}: ${message}`,
      }),
      touchThread(env, threadId, at),
    ]);
    emit({ type: "error", code, message });
  };
  if (!key) return saveError("missing", "ANTHROPIC_API_KEY is not set.");

  const window = contextWindow(rows, coachContextOf(env));
  if (!window.messages.length || window.messages.at(-1)!.role !== "user") return saveError("nothing", "There is no question to answer.");
  const history: StoredMessage[] = [...window.messages];
  // Tool calls already made for this question (an answer continued after a failure keeps its count).
  const lastQuestion = history.map((m) => m.role === "user" && m.content.some((b) => b.type === "text" || b.type === "image")).lastIndexOf(true);
  let toolCalls = history.slice(lastQuestion).reduce((a, m) => a + m.content.filter((b) => b.type === "tool_use").length, 0);
  // The answer's cost so far (calls made before a failure are part of it).
  let cost: number | null = rows
    .slice(rows.findIndex((r) => r.id === history[lastQuestion].id))
    .reduce<number | null>((a, r) => (r.role === "assistant" && r.cost_usd != null ? (a ?? 0) + r.cost_usd : a), null);

  const report = await loadCoachData(env);
  const data: CoachData = { ...report, today: localDate(report.settings.timezone), now: new Date().toISOString() };
  const client = new Anthropic({
    apiKey: key,
    baseURL: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    fetch: (input, init) => aiTransport.fetch(input, init),
    maxRetries: 2,
    timeout: 300_000,
  });
  const images = new Map<string, string>();
  let blockBase = 0;

  // Calls per answer: the tool rounds, one more in which further tools are refused, and the call that answers.
  for (let round = 0; round < MAX_TOOL_CALLS + 2; round++) {
    const messages = await Promise.all(history.map((m) => toParam(env, m, images)));
    // A second cache breakpoint on the newest block, so the conversation so far is read from the cache by the next call.
    const last = messages.at(-1)!.content as Anthropic.Beta.BetaContentBlockParam[];
    last[last.length - 1] = { ...last[last.length - 1], cache_control: { type: "ephemeral" } } as Anthropic.Beta.BetaContentBlockParam;

    let msg: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: coachMaxTokensOf(env),
        thinking: { type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        output_config: { effort: coachEffortOf(env) },
        system: SYSTEM,
        tools: TOOLS,
        messages,
        betas: COACH_BETAS,
      });
      stream.on("streamEvent", (e) => {
        if (e.type === "content_block_start" && e.content_block.type === "tool_use") emit({ type: "tool", id: e.content_block.id, name: e.content_block.name });
        if (e.type !== "content_block_delta") return;
        if (e.delta.type === "thinking_delta" && e.delta.thinking) emit({ type: "progress", index: blockBase + e.index, text: e.delta.thinking });
        if (e.delta.type === "text_delta" && e.delta.text) emit({ type: "text", index: blockBase + e.index, text: e.delta.text });
      });
      msg = await stream.finalMessage();
    } catch (e) {
      const f = failure(e, key);
      return saveError(f.code, f.message);
    }
    blockBase += msg.content.length;
    const u = msg.usage;
    const tokens: CallTokens = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_tokens: u.cache_creation_input_tokens ?? 0,
    };
    const served = msg.model || model;
    const callCost = callCostUsd(served, tokens);
    if (callCost != null) cost = (cost ?? 0) + callCost;
    if (msg.stop_reason === "refusal") return saveError("refusal", "The model declined to answer.", tokens, served);
    if (msg.stop_reason === "max_tokens") return saveError("cut", "The answer was cut off (COACH_MAX_TOKENS).", tokens, served);

    const answer: StoredMessage = { id: ulid(), role: "assistant", content: msg.content as unknown as StoredBlock[], created_at: now(), error: null };
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const stmts = [insertRow(env, { ...answer, thread_id: threadId, ...tokens, cost_usd: callCost, model: served })];
    let results: StoredMessage | null = null;
    const cards: CoachEvent[] = [];
    if (calls.length) {
      const content: StoredBlock[] = calls.map((call) => {
        toolCalls++;
        if (toolCalls > MAX_TOOL_CALLS) {
          return { type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ error: `Tool limit reached (${MAX_TOOL_CALLS} calls for one answer). Answer now with what you have.` }), is_error: true };
        }
        const out = runTool(data, call.name, call.input, (input) => proposeProgram(data, input, ulid(), data.today));
        const body = out.ok ? out.result : { error: out.error };
        cards.push({ type: "card", message_id: answer.id, tool_use_id: call.id, name: call.name, input: call.input, result: body, is_error: !out.ok });
        return out.ok ? { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out.result) } : { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(body), is_error: true };
      });
      results = { id: ulid(), role: "user", content, created_at: now(), error: null };
      stmts.push(insertRow(env, { ...results, thread_id: threadId, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, model: null }));
    }
    stmts.push(touchThread(env, threadId, lastAt!));
    await env.DB.batch(stmts);
    emit({ type: "saved", message_id: answer.id, role: "assistant" });
    for (const c of cards) emit(c);
    if (!results || msg.stop_reason !== "tool_use") break;
    emit({ type: "saved", message_id: results.id, role: "user" });
    history.push(answer, results);
  }
  emit({ type: "done", cost_usd: cost, model, omitted: window.omitted });
}

// Claude Messages API calls for the AI session report and plan advice (SPEC-v3 M9a, M9c). Server-side only: the
// ANTHROPIC_API_KEY Worker secret never reaches the client and is never logged. The model, effort and max_tokens come
// from config (REPORT_MODEL, REPORT_EFFORT, ADVICE_EFFORT, REPORT_MAX_TOKENS). claude-opus-5-5 has no temperature
// (it is rejected); effort is the control (approved 2026-10-13: low for the report, medium for advice).
// The reply is JSON constrained by the output schema and validated again with Zod; an invalid or cut-off reply is
// retried once, then reported as an error. Opus only: no fallback model; a refusal is stored as an error and the app
// shows "Report unavailable" with Retry (Payam, 2026-10-13). Tests replace `aiTransport.fetch`; they never call the
// real API.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Env } from "./env";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_MAX_TOKENS = 3000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * Error codes stored with a failed call ("<code>: <message>"):
 * missing (no key), auth (key expired or invalid), limit (daily limit), rate (API rate limit), network, api (any other
 * API error), invalid (the reply failed validation twice), refusal (the model declined).
 */
export type AiErrorCode = "missing" | "auth" | "limit" | "rate" | "network" | "api" | "invalid" | "refusal";

/** The HTTP layer of the Anthropic client; tests replace it with a mock. */
export const aiTransport: { fetch: typeof fetch } = { fetch: (input, init) => fetch(input, init) };

export interface AiOk<T> {
  ok: true;
  data: T;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface AiFail {
  ok: false;
  code: AiErrorCode;
  message: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

export const modelOf = (env: Env) => env.REPORT_MODEL?.trim() || DEFAULT_MODEL;

export function effortOf(value: string | undefined, fallback: Effort): Effort {
  const v = value?.trim();
  return (EFFORTS as readonly string[]).includes(v ?? "") ? (v as Effort) : fallback;
}

export function maxTokensOf(env: Env): number {
  const n = Number(env.REPORT_MAX_TOKENS);
  return Number.isInteger(n) && n >= 256 && n <= 64_000 ? n : DEFAULT_MAX_TOKENS;
}

/** Maps an SDK error to a stored code; the key never appears in the message. */
function failure(e: unknown, key: string): { code: AiErrorCode; message: string } {
  const text = (e instanceof Error ? e.message : String(e)).split(key).join("[key]").slice(0, 300);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { code: "auth", message: text };
  if (e instanceof Anthropic.RateLimitError) return { code: "rate", message: text };
  if (e instanceof Anthropic.APIConnectionError) return { code: "network", message: text };
  return { code: "api", message: text };
}

/**
 * One model call with a JSON reply checked against `schema`. A reply that is cut off (max_tokens), not JSON, or not
 * valid against the schema is retried once; tokens of both attempts are counted.
 */
export async function callModel<T>(env: Env, req: { system: string; input: unknown; schema: z.ZodType<T>; effort: Effort }): Promise<AiOk<T> | AiFail> {
  const model = modelOf(env);
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return { ok: false, code: "missing", message: "ANTHROPIC_API_KEY is not set.", model, input_tokens: null, output_tokens: null };
  const client = new Anthropic({
    apiKey: key,
    baseURL: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    fetch: (input, init) => aiTransport.fetch(input, init),
    maxRetries: 2,
    timeout: 180_000,
  });
  let input = 0;
  let output = 0;
  let served = model;
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create({
        model,
        max_tokens: maxTokensOf(env),
        output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
        system: req.system,
        messages: [{ role: "user", content: JSON.stringify(req.input) }],
      });
    } catch (e) {
      const f = failure(e, key);
      return { ok: false, ...f, model: served, input_tokens: input || null, output_tokens: output || null };
    }
    const u = msg.usage;
    input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    output += u.output_tokens ?? 0;
    served = msg.model || model;
    if (msg.stop_reason === "refusal") return { ok: false, code: "refusal", message: "The model declined to answer.", model: served, input_tokens: input, output_tokens: output };
    if (msg.stop_reason === "max_tokens") {
      problem = "The answer was cut off (max_tokens).";
      continue;
    }
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      problem = "The answer was not valid JSON.";
      continue;
    }
    const parsed = req.schema.safeParse(json);
    if (parsed.success) return { ok: true, data: parsed.data, model: served, input_tokens: input, output_tokens: output };
    problem = `The answer did not match the format: ${parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
      .join("; ")}`.slice(0, 300);
  }
  return { ok: false, code: "invalid", message: problem, model: served, input_tokens: input, output_tokens: output };
}

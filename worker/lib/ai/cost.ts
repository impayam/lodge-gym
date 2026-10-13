// Cost log of the AI features (SPEC-v3 M9a): token counts per call, the Settings line "This month: N reports, ~$X",
// and the daily limits. Pure; the Worker reads the rows of session_reports and plan_advice.

import { localDate } from "../time";

/** USD per million tokens (price check 2026-10-12: Opus 5.5 $4 input, $20 output). */
export const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-fable-5-1": { input: 10, output: 50 },
};

/** SPEC-v3: 10 session reports and 20 plan advice per day. */
export const DAILY_LIMIT = { report: 10, advice: 20 } as const;

export type AiKind = keyof typeof DAILY_LIMIT;

export interface AiRow {
  kind: AiKind;
  created_at: string;
  model: string;
  status: "ok" | "error";
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/** GET /api/ai/usage: the Settings line and the key's status (never its value). */
export interface AiUsage {
  model: string;
  key: "set" | "missing";
  key_status: "ok" | "invalid" | "unknown";
  month: MonthUsage;
  today: { reports: number; advice: number };
  limits: typeof DAILY_LIMIT;
}

/** Cost of one call, or null for a model without a known price. */
export function costUsd(model: string, input: number | null, output: number | null): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return ((input ?? 0) * p.input + (output ?? 0) * p.output) / 1_000_000;
}

/** The code part of a stored error ("auth: …" → "auth"). */
export const errorCode = (error: string | null): string | null => (error ? error.slice(0, Math.max(0, error.indexOf(":"))) || error : null);

/** A row counts toward the daily limit when the model was called and used tokens. */
export const countsToLimit = (r: Pick<AiRow, "input_tokens">) => (r.input_tokens ?? 0) > 0;

/** Calls of one kind on the local day `today`. */
export function usedToday(rows: AiRow[], kind: AiKind, tz: string, today: string): number {
  return rows.filter((r) => r.kind === kind && countsToLimit(r) && localDate(tz, r.created_at) === today).length;
}

export interface MonthUsage {
  month: string;
  reports: number;
  advice: number;
  input_tokens: number;
  output_tokens: number;
  /** Rounded to the cent; calls of a model without a known price are left out (see `unpriced`). */
  cost_usd: number;
  unpriced: number;
}

/** "This month" on the local calendar of `tz`: successful reports and advice, tokens and cost of every call. */
export function monthUsage(rows: AiRow[], tz: string, month: string): MonthUsage {
  const mine = rows.filter((r) => localDate(tz, r.created_at).slice(0, 7) === month);
  let cost = 0;
  let unpriced = 0;
  for (const r of mine) {
    if (!r.input_tokens && !r.output_tokens) continue;
    const c = costUsd(r.model, r.input_tokens, r.output_tokens);
    if (c == null) unpriced++;
    else cost += c;
  }
  return {
    month,
    reports: mine.filter((r) => r.kind === "report" && r.status === "ok").length,
    advice: mine.filter((r) => r.kind === "advice" && r.status === "ok").length,
    input_tokens: mine.reduce((a, r) => a + (r.input_tokens ?? 0), 0),
    output_tokens: mine.reduce((a, r) => a + (r.output_tokens ?? 0), 0),
    cost_usd: Math.round(cost * 100) / 100,
    unpriced,
  };
}

/**
 * The API key as the latest call saw it: "invalid" after an authentication error (expired, revoked or wrong key),
 * "ok" after any call that reached the model, "unknown" before the first call. Calls that never reached the API
 * (key missing, daily limit) say nothing about the key.
 */
export function keyStatus(rows: AiRow[]): "ok" | "invalid" | "unknown" {
  const seen = rows
    .filter((r) => r.status === "ok" || !["missing", "limit", "network"].includes(errorCode(r.error) ?? ""))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!seen) return "unknown";
  return errorCode(seen.error) === "auth" ? "invalid" : "ok";
}

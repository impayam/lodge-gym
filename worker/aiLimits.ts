// Cost log and daily limits of the AI features (SPEC-v3 M9a, SPEC-v7 M9d): the rows of session_reports, plan_advice and
// training_overviews, read for the limits, the Settings cost line and the API key's status.

import type { AiFail } from "./ai";
import { readSettings } from "./data";
import type { Env } from "./env";
import { DAILY_LIMIT, usedToday, type AiKind, type AiRow } from "./lib/ai/cost";
import { localDate } from "./lib/time";

/** The AI calls since `sinceIso` (all three tables). */
export async function aiRows(env: Env, sinceIso: string): Promise<AiRow[]> {
  const cols = "created_at, model, status, error, input_tokens, output_tokens";
  const [reports, advice, overviews] = await env.DB.batch<Omit<AiRow, "kind">>([
    env.DB.prepare(`SELECT ${cols} FROM session_reports WHERE created_at >= ?`).bind(sinceIso),
    env.DB.prepare(`SELECT ${cols} FROM plan_advice WHERE created_at >= ?`).bind(sinceIso),
    env.DB.prepare(`SELECT ${cols} FROM training_overviews WHERE created_at >= ?`).bind(sinceIso),
  ]);
  return [
    ...reports.results.map((r) => ({ ...r, kind: "report" as const })),
    ...advice.results.map((r) => ({ ...r, kind: "advice" as const })),
    ...overviews.results.map((r) => ({ ...r, kind: "overview" as const })),
  ];
}

/** Whether today's (local day) calls of this kind reached the daily limit. */
export async function overLimit(env: Env, kind: AiKind): Promise<boolean> {
  const { timezone } = await readSettings(env);
  const rows = await aiRows(env, new Date(Date.now() - 3 * 86_400_000).toISOString());
  return usedToday(rows, kind, timezone, localDate(timezone)) >= DAILY_LIMIT[kind];
}

export const errorText = (r: AiFail) => `${r.code}: ${r.message}`;

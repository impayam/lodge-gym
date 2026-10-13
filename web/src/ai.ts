// AI session report and plan advice on the phone (SPEC-v3 M9a, M9c). Both need a connection; the report is written on
// the server once the session has synced, so until then it is "pending". Nothing here holds the API key.

import type { PlanAdvice } from "../../worker/lib/ai/suggestions";
import type { AiUsage } from "../../worker/lib/ai/cost";
import type { ReportResponse } from "../../worker/lib/ai/report";
import { api } from "./api";
import * as ldb from "./localdb";

export type { AiUsage, PlanAdvice, ReportResponse };

/** The latest answer per session, so a screen shown again starts from what it last saw. */
const seen = new Map<string, ReportResponse>();
export const lastReport = (sessionId: string) => seen.get(sessionId) ?? null;

export async function fetchReport(sessionId: string): Promise<ReportResponse> {
  const r = await api<ReportResponse>("GET", `/sessions/${encodeURIComponent(sessionId)}/report`);
  seen.set(sessionId, r);
  return r;
}

/** Write (or rewrite) the report; the server keeps the older ones. */
export async function requestReport(sessionId: string): Promise<void> {
  await api("POST", `/sessions/${encodeURIComponent(sessionId)}/report`, {});
}

/** Whether the session's latest version is still waiting in the outbox. */
export async function sessionUnsynced(sessionId: string): Promise<boolean> {
  return (await ldb.outboxAll()).some((e) => e.key === "session:" + sessionId);
}

export const fetchUsage = () => api<AiUsage>("GET", "/ai/usage");

export interface AdviceResponse {
  id: string;
  created_at: string;
  model: string;
  advice: PlanAdvice;
  dropped: number;
  candidates: { id: string; name: string }[];
}

export const fetchAdvice = (planId: string) => api<AdviceResponse>("POST", `/sessions/${encodeURIComponent(planId)}/plan-advice`, {});

/** Why a report is unavailable, from its stored error code. */
export function unavailableReason(code: string | null): string {
  switch (code) {
    case "auth":
      return "API key expired or invalid.";
    case "missing":
      return "The API key is not set.";
    case "limit":
      return "Today's limit of 10 reports is reached.";
    case "rate":
      return "The AI service is busy. Try again in a minute.";
    case "network":
      return "The AI service could not be reached.";
    default:
      return "The AI service did not return a usable report.";
  }
}

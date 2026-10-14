// AI session report, plan advice and training overview on the phone (SPEC-v3 M9a, M9c; SPEC-v7 M9d). They need a
// connection; the report and the overview are written on the server once the session has synced, so until then they are
// "pending". Nothing here holds the API key.

import type { PlanAdvice } from "../../worker/lib/ai/suggestions";
import type { AiUsage } from "../../worker/lib/ai/cost";
import type { OverviewResponse, OverviewView, SessionReportItem } from "../../worker/lib/ai/overview";
import type { TimelineItem } from "../../worker/lib/ai/timeline";
import type { ReportResponse } from "../../worker/lib/ai/report";
import type { WeeklyReview } from "../../worker/lib/types";
import { api } from "./api";
import * as ldb from "./localdb";

export type { AiUsage, OverviewResponse, OverviewView, PlanAdvice, ReportResponse, SessionReportItem, TimelineItem };

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

/** The training overview; the last answer is kept on the device so Reports shows it offline. */
export async function fetchOverview(): Promise<OverviewResponse> {
  const r = await api<OverviewResponse>("GET", "/overview");
  await ldb.kvSet("ai:overview", r);
  return r;
}
export const cachedOverview = () => ldb.kvGet<OverviewResponse>("ai:overview");

/** Rewrite the overview now (Regenerate, Retry); the server keeps the older ones. */
export async function requestOverview(): Promise<void> {
  await api("POST", "/overview", {});
}

/** Every session's latest report, newest session first; kept on the device for offline use. */
export async function fetchSessionReports(): Promise<SessionReportItem[]> {
  const r = await api<{ reports: SessionReportItem[] }>("GET", "/session-reports");
  await ldb.kvSet("ai:session-reports", r.reports);
  return r.reports;
}
export const cachedSessionReports = () => ldb.kvGet<SessionReportItem[]>("ai:session-reports");

/** Every weekly review, newest week first (History → Weekly reviews); kept on the device for offline use. */
export async function fetchReviews(): Promise<WeeklyReview[]> {
  const r = await api<{ reviews: WeeklyReview[] }>("GET", "/reviews");
  await ldb.kvSet("reviews", r.reviews);
  return r.reviews;
}
export const cachedReviews = () => ldb.kvGet<WeeklyReview[]>("reviews");

/** Every saved report on its date (History → Reports timeline); kept on the device for offline use. */
export async function fetchTimeline(): Promise<TimelineItem[]> {
  const r = await api<{ items: TimelineItem[] }>("GET", "/report-timeline");
  await ldb.kvSet("ai:timeline", r.items);
  return r.items;
}
export const cachedTimeline = () => ldb.kvGet<TimelineItem[]>("ai:timeline");

/** One saved overview, read-only; the ones already opened are kept on the device. */
export async function fetchSavedOverview(id: string): Promise<OverviewView> {
  const r = await api<{ overview: OverviewView }>("GET", `/overviews/${encodeURIComponent(id)}`);
  await ldb.kvSet(`ai:overview:${id}`, r.overview);
  return r.overview;
}
export const cachedSavedOverview = (id: string) => ldb.kvGet<OverviewView>(`ai:overview:${id}`);

/** Why a report or an overview is unavailable, from its stored error code. */
export function unavailableReason(code: string | null, what: "report" | "overview" = "report"): string {
  switch (code) {
    case "auth":
      return "API key expired or invalid.";
    case "missing":
      return "The API key is not set.";
    case "limit":
      return what === "report" ? "Today's limit of 10 reports is reached." : "Today's limit of 10 overviews is reached.";
    case "rate":
      return "The AI service is busy. Try again in a minute.";
    case "network":
      return "The AI service could not be reached.";
    case "refusal":
      return `The model declined to write this ${what}.`;
    default:
      return `The AI service did not return a usable ${what}.`;
  }
}

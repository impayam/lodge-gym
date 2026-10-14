import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { test, type BrowserContext, type Page } from "@playwright/test";

/** Local D1 of the server the current project talks to (see scripts/e2e-server.mjs). */
const persist = () => (test.info().project.name.startsWith("webkit") ? ".wrangler/e2e-https" : ".wrangler/e2e");

/** Runs SQL against the e2e Worker's local D1. */
export function sql(command: string): unknown[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", persist(), "--json", "--command", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results: unknown[] }[];
  return parsed[0]?.results ?? [];
}

const PROXY = `http://localhost:${process.env.E2E_PROXY_PORT ?? "8790"}`;
const isWebKit = () => test.info().project.name.startsWith("webkit");
const network = async (offline: boolean) => {
  const res = await fetch(`${PROXY}/__network?offline=${offline ? 1 : 0}`, { headers: { Connection: "close" } });
  if (((await res.json()) as { offline: boolean }).offline !== offline) throw new Error("e2e proxy did not switch");
};

/**
 * Airplane mode. Chromium uses Playwright's offline emulation. WebKit's emulation also fails every Blob read and every
 * service-worker navigation (iOS does not), so for WebKit the e2e proxy drops the network instead and the page gets the
 * offline/online event the phone would fire.
 */
export async function setOffline(context: BrowserContext, page: Page, offline: boolean) {
  if (!isWebKit()) return context.setOffline(offline);
  await network(offline);
  await page.evaluate((off) => window.dispatchEvent(new Event(off ? "offline" : "online")), offline);
}

/** Signs in by creating a full session row and setting its cookie (for browsers without a virtual authenticator). */
export async function signIn(context: BrowserContext, baseURL: string) {
  if (isWebKit()) await network(false);
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const exp = new Date(now.getTime() + 30 * 86_400_000);
  sql(`INSERT INTO auth_sessions (token_hash, created_at, expires_at, scope) VALUES ('${hash}', '${now.toISOString()}', '${exp.toISOString()}', 'full')`);
  const { hostname } = new URL(baseURL);
  await context.addCookies([{ name: "__Host-lg_session", value: token, domain: hostname, path: "/", httpOnly: true, secure: true, sameSite: "Strict" }]);
}

export function resetWorkouts() {
  sql("DELETE FROM training_overviews; DELETE FROM plan_advice; DELETE FROM session_reports; DELETE FROM session_plan_items; DELETE FROM planned_sessions; DELETE FROM set_entries; DELETE FROM workout_sessions");
}

/** The seed program active again; versions made by the generator (M8) or by Apply to program (M9c) go. */
export function resetPrograms() {
  const made = "SELECT id FROM programs WHERE generated_by IN ('generator', 'session')";
  sql(
    [
      `DELETE FROM plan_advice WHERE session_id IN (SELECT id FROM planned_sessions WHERE program_day_id IN (SELECT id FROM program_days WHERE program_id IN (${made})))`,
      `DELETE FROM session_plan_items WHERE session_id IN (SELECT id FROM planned_sessions WHERE program_day_id IN (SELECT id FROM program_days WHERE program_id IN (${made})))`,
      `DELETE FROM planned_sessions WHERE program_day_id IN (SELECT id FROM program_days WHERE program_id IN (${made}))`,
      `DELETE FROM day_exercises WHERE day_id IN (SELECT id FROM program_days WHERE program_id IN (${made}))`,
      `DELETE FROM program_days WHERE program_id IN (${made})`,
      "DELETE FROM program_activations WHERE id <> 'act-fullbody4-seed'",
      "DELETE FROM programs WHERE generated_by IN ('generator', 'session')",
      "UPDATE program_activations SET ended_at = NULL",
      "UPDATE programs SET active = CASE id WHEN 'fullbody4' THEN 1 ELSE 0 END, archived_at = CASE id WHEN 'fullbody4' THEN NULL ELSE created_at END",
    ].join("; ")
  );
}

export async function waitForSynced(page: Page) {
  await page.getByTestId("sync-chip").filter({ hasText: "Synced" }).waitFor();
}

const AI_MOCK = `http://127.0.0.1:${process.env.E2E_AI_PORT ?? "8791"}`;

type AiAnswer = "ok" | "fail" | "auth";

/** Switches the mock model's answers (scripts/e2e-ai-mock.mjs): ok, fail (API error) or auth (expired key). */
export async function aiMode(mode: { report?: AiAnswer; advice?: AiAnswer; overview?: AiAnswer }) {
  const q = new URLSearchParams(mode as Record<string, string>);
  const res = await fetch(`${AI_MOCK}/__mode?${q}`, { headers: { Connection: "close" } });
  if (!res.ok) throw new Error("AI mock did not switch");
}

interface AiCall {
  kind: "report" | "advice" | "overview";
  model: string;
  effort: string;
  max_tokens: number;
  key_set: boolean;
}

/** Calls the mock model received, the last one, and the last one of each kind. */
export async function aiCalls(): Promise<{ calls: number; last: AiCall | null; by_kind: Partial<Record<AiCall["kind"], AiCall>> }> {
  return (await fetch(`${AI_MOCK}/__calls`, { headers: { Connection: "close" } })).json() as Promise<{ calls: number; last: AiCall | null; by_kind: Partial<Record<AiCall["kind"], AiCall>> }>;
}

/** Where goTo can go: a tab, or a screen inside Me (SPEC-v8 §5). */
export type Place = "Train" | "History" | "Library" | "Reports" | "Me" | "Photos" | "Program" | "Settings" | "AI reports" | "Backup";
const IN_ME: Partial<Record<Place, string>> = { Photos: "me-add-photo", Program: "me-program", Settings: "me-settings", "AI reports": "me-ai", Backup: "me-backup" };

/** Opens a tab from the tab bar, or a screen that moved into Me (Photos, Program, Settings, AI reports, Backup). */
export async function goTo(page: Page, place: Place) {
  const tab = (name: string) => page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name, exact: true }).click();
  const inMe = IN_ME[place];
  if (!inMe) return tab(place);
  await tab("Me");
  await page.getByTestId(inMe).click();
}

import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { currentSlot } from "./slot";

const databases = new Map<string, DatabaseSync>();

/** The SQLite file of a local D1 (wrangler keeps it under <persist>/v3/d1), opened once per test worker. */
function d1(persist: string): DatabaseSync {
  let db = databases.get(persist);
  if (!db) {
    const dir = `${persist}/v3/d1/miniflare-D1DatabaseObject`;
    const files = readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
    if (files.length !== 1) throw new Error(`expected one D1 database in ${dir}, found ${files.length}`);
    db = new DatabaseSync(`${dir}/${files[0]}`);
    // Foreign keys on, as in D1. The Worker uses the same file: wait for its write lock instead of failing.
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000");
    databases.set(persist, db);
  }
  return db;
}

/**
 * Runs SQL against the local D1 of the Worker this test talks to (its worker's own, see scripts/e2e-slots.mjs), in the
 * database's SQLite file like `wrangler d1 execute --local` does, without starting wrangler for every call. All
 * statements run in one transaction, like a D1 batch; returns the first statement's rows.
 */
export function sql(command: string): unknown[] {
  const db = d1(currentSlot().persist);
  const results: Record<string, unknown>[][] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let rest = command.trim(); rest; ) {
      const statement = db.prepare(rest);
      results.push(statement.all() as Record<string, unknown>[]);
      rest = rest.slice(statement.sourceSQL.length).trim();
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return (results[0] ?? []).map((row) => ({ ...row }));
}

const isWebKit = () => test.info().project.name.startsWith("webkit");
const network = async (offline: boolean) => {
  const res = await fetch(`${currentSlot().proxy}/__network?offline=${offline ? 1 : 0}`, { headers: { Connection: "close" } });
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
  const chip = page.getByTestId("sync-chip");
  // The session screen is full screen: its sync status is in the More sheet.
  if ((await chip.count()) === 0 && (await page.getByTestId("more").count()) > 0) {
    await openMore(page);
    await chip.filter({ hasText: "Synced" }).waitFor();
    await closeMore(page);
    return;
  }
  await chip.filter({ hasText: "Synced" }).waitFor();
}

type AiAnswer = "ok" | "fail" | "auth";

/** Switches the mock model's answers (scripts/e2e-ai-mock.mjs): ok, fail (API error) or auth (expired key). */
export async function aiMode(mode: { report?: AiAnswer; advice?: AiAnswer; overview?: AiAnswer }) {
  const q = new URLSearchParams(mode as Record<string, string>);
  const res = await fetch(`${currentSlot().ai}/__mode?${q}`, { headers: { Connection: "close" } });
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
  return (await fetch(`${currentSlot().ai}/__calls`, { headers: { Connection: "close" } })).json() as Promise<{ calls: number; last: AiCall | null; by_kind: Partial<Record<AiCall["kind"], AiCall>> }>;
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

/* ---------------- active session (SPEC-v8 §6.02): one exercise card at a time ---------------- */

const card = (page: Page) => page.getByTestId("ex-card");

async function step(page: Page, dir: "prev" | "next") {
  const before = await card(page).getAttribute("data-ex");
  await page.getByTestId(dir).click();
  await expect(card(page)).not.toHaveAttribute("data-ex", before!);
}

/** Shows an exercise on the session card with Prev / Next (the card holds one exercise at a time). */
export async function showExercise(page: Page, exerciseId: string) {
  await expect(card(page)).toBeVisible();
  if ((await card(page).getAttribute("data-ex")) === exerciseId) return;
  while (await page.getByTestId("prev").isEnabled()) {
    await step(page, "prev");
    if ((await card(page).getAttribute("data-ex")) === exerciseId) return;
  }
  while ((await card(page).getAttribute("data-ex")) !== exerciseId) {
    if (!(await page.getByTestId("next").isEnabled())) throw new Error(`${exerciseId} is not in the session`);
    await step(page, "next");
  }
}

/** The active session's exercises in order, read by stepping through the card from the first. */
export async function sessionOrder(page: Page): Promise<string[]> {
  await expect(card(page)).toBeVisible();
  while (await page.getByTestId("prev").isEnabled()) await step(page, "prev");
  const ids = [(await card(page).getAttribute("data-ex"))!];
  while (await page.getByTestId("next").isEnabled()) {
    await step(page, "next");
    ids.push((await card(page).getAttribute("data-ex"))!);
  }
  return ids;
}

/** Checks a set (showing its exercise first). */
export async function checkSet(page: Page, exerciseId: string, set: number) {
  await showExercise(page, exerciseId);
  await page.getByTestId(`check-${exerciseId}-${set}`).click();
}

/** Types a set's weight (w), reps (r) or seconds (s) in the set sheet, then closes it. */
export async function enterSet(page: Page, exerciseId: string, set: number, field: "w" | "r" | "s", value: string) {
  await showExercise(page, exerciseId);
  await page.getByTestId(`${field}-${exerciseId}-${set}`).click();
  const sheet = page.getByTestId("set-sheet");
  await sheet.getByTestId(`sheet-${field}`).locator("input").fill(value);
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

/** Opens the session's More sheet (date and time, unit, note, body weight, add exercise, reorder, delete). */
export async function openMore(page: Page) {
  await page.getByTestId("more").click();
  await expect(page.getByTestId("more-sheet")).toHaveAttribute("open", "");
  return page.getByTestId("more-sheet");
}

/** Closes the More sheet with Escape. */
export async function closeMore(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("more-sheet")).toHaveCount(0);
}

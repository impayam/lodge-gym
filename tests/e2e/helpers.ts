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
  sql("DELETE FROM set_entries");
  sql("DELETE FROM workout_sessions");
}

export async function waitForSynced(page: Page) {
  await page.getByTestId("sync-chip").filter({ hasText: "Synced" }).waitFor();
}

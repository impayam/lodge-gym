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

/** Signs in by creating a full session row and setting its cookie (for browsers without a virtual authenticator). */
export async function signIn(context: BrowserContext, baseURL: string) {
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
  await page.getByTestId("sync-chip").filter({ hasText: "همگام" }).waitFor();
}

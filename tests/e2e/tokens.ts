import { readFileSync } from "node:fs";
import { STAGE_STATUS_TOKEN } from "../../web/src/lib/anatomy-status";
import type { BalanceStatus } from "../../worker/lib/reports";

// Design token values (web/src/styles/tokens.css) for e2e assertions on colours drawn outside CSS (the 3D map).
const tokens = readFileSync(new URL("../../web/src/styles/tokens.css", import.meta.url), "utf8");

/** A token's value as written in tokens.css, lowercased. */
export function tokenValue(name: string): string {
  const m = tokens.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`no token ${name}`);
  return m[1].trim().toLowerCase();
}

/** The 3D muscle map's status colours (the --model-* tokens). */
export const STAGE_STATUS_COLOR = Object.fromEntries(
  (Object.keys(STAGE_STATUS_TOKEN) as BalanceStatus[]).map((s) => [s, tokenValue(STAGE_STATUS_TOKEN[s])])
) as Record<BalanceStatus, string>;

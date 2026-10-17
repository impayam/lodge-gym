import { readFileSync } from "node:fs";
import { BODY_TINT, type BodyDay } from "../../web/src/lib/anatomy-status";

// Design token values (web/src/styles/tokens.css) for e2e assertions on colours drawn outside CSS (the 3D map).
const tokens = readFileSync(new URL("../../web/src/styles/tokens.css", import.meta.url), "utf8");

/** A token's value as written in tokens.css, lowercased. */
export function tokenValue(name: string): string {
  const m = tokens.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`no token ${name}`);
  return m[1].trim().toLowerCase();
}

/** Profile → My body's colours: today, this week, the rest. */
export const BODY_COLOR = Object.fromEntries((Object.keys(BODY_TINT) as BodyDay[]).map((s) => [s, tokenValue(BODY_TINT[s])])) as Record<BodyDay, string>;

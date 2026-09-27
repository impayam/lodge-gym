import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("seed", () => {
  it("is idempotent", async () => {
    const lines = env.TEST_SEED_SQL.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
    await env.DB.batch(lines.map((l) => env.DB.prepare(l)));
    await env.DB.batch(lines.map((l) => env.DB.prepare(l)));
    const n = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
    expect(await n("exercises")).toBe(27);
    expect(await n("programs")).toBe(2);
    expect(await n("program_days")).toBe(8);
    expect(await n("day_exercises")).toBe(25 + 25);
    expect(await n("settings")).toBe(4);
  });
});

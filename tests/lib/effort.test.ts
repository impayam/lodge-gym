import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { effortColor, effortLabel, effortOf, type EffortStops } from "../../web/src/lib/effort";

// SPEC-v8 §6 and §10: effort = sets done / sets planned; colour mixes --effort-1 → --effort-2 → --effort-3.
const tokens = env.TEST_UI_FILES["web/src/styles/tokens.css"];
const value = (name: string) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))![1];
const STOPS: EffortStops = [value("--effort-1"), value("--effort-2"), value("--effort-3")];

describe("effort colour", () => {
  it("reads the three effort tokens", () => {
    expect(STOPS).toEqual(["#A78BFA", "#F472B6", "#FB923C"]);
  });

  it("0, 0.33, 0.5, 0.67 and 1 give the expected colours", () => {
    expect([0, 0.33, 0.5, 0.67, 1].map((e) => effortColor(e, STOPS))).toEqual(["#a78bfa", "#da7bcd", "#f472b6", "#f67d8d", "#fb923c"]);
  });

  it("clamps outside 0..1", () => {
    expect(effortColor(-0.2, STOPS)).toBe("#a78bfa");
    expect(effortColor(1.4, STOPS)).toBe("#fb923c");
  });

  it("effort is the share of planned sets done; nothing planned is 0", () => {
    expect(effortOf(0, 12)).toBe(0);
    expect(effortOf(6, 12)).toBe(0.5);
    expect(effortOf(12, 12)).toBe(1);
    expect(effortOf(14, 12)).toBe(1);
    expect(effortOf(3, 0)).toBe(0);
  });

  it("labels: Warming up below 0.34, Working below 0.67, then All in", () => {
    expect([0, 0.33, 0.34, 0.66, 0.67, 1].map(effortLabel)).toEqual(["Warming up", "Warming up", "Working", "Working", "All in", "All in"]);
  });
});

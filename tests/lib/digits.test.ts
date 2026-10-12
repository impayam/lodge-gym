import { describe, expect, it } from "vitest";
import { fmtNum, parseNumber, toLatinDigits } from "../../worker/lib/digits";

describe("digits", () => {
  it("parses Persian, Arabic and Latin digits", () => {
    expect(parseNumber("۱۳۵")).toBe(135);
    expect(parseNumber("١٣٥")).toBe(135);
    expect(parseNumber("135")).toBe(135);
  });
  it("accepts comma, dot and Persian decimal separators", () => {
    expect(parseNumber("۲۲٫۵")).toBe(22.5);
    expect(parseNumber("22,5")).toBe(22.5);
    expect(parseNumber("22.5")).toBe(22.5);
    expect(parseNumber(".5")).toBe(0.5);
  });
  it("accepts negative numbers (assisted pull-up)", () => {
    expect(parseNumber("-40")).toBe(-40);
    expect(parseNumber("−۴۰")).toBe(-40);
  });
  it("returns null for empty or invalid input", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("  ")).toBeNull();
    expect(parseNumber(null)).toBeNull();
    expect(parseNumber("12a")).toBeNull();
    expect(parseNumber("1.2.3")).toBeNull();
    expect(parseNumber("-")).toBeNull();
  });
  it("formats with Latin digits", () => {
    expect(toLatinDigits("۱۲:۰۵")).toBe("12:05");
    expect(fmtNum(22.5)).toBe("22.5");
    expect(fmtNum(135)).toBe("135");
    expect(fmtNum(-40)).toBe("-40");
    expect(fmtNum(1 / 3)).toBe("0.33");
    expect(fmtNum(-0.001)).toBe("0");
    expect(fmtNum(null)).toBe("");
  });
});

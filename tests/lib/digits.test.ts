import { describe, expect, it } from "vitest";
import { faNum, parseNumber, toLatinDigits, toPersianDigits } from "../../worker/lib/digits";

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
  it("formats with Persian digits", () => {
    expect(toPersianDigits("12:05")).toBe("۱۲:۰۵");
    expect(toLatinDigits("۱۲:۰۵")).toBe("12:05");
    expect(faNum(22.5)).toBe("۲۲٫۵");
    expect(faNum(135)).toBe("۱۳۵");
    expect(faNum(-40)).toBe("‎-۴۰");
    expect(faNum(null)).toBe("");
  });
});

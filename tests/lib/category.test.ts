import { describe, expect, it } from "vitest";
import { CATEGORIES, countsVolume, fedbCategory, isCategory } from "../../worker/lib/category";

describe("exercise categories (SPEC-v2 §7.4, decided 2026-10-12)", () => {
  it("only strength, powerlifting and olympic weightlifting count toward volume", () => {
    expect(CATEGORIES.filter(countsVolume)).toEqual(["strength", "powerlifting", "olympic_weightlifting"]);
    for (const c of ["strongman", "stretching", "plyometrics", "cardio", null, undefined, "", "yoga"]) expect(countsVolume(c)).toBe(false);
  });
  it("maps free-exercise-db's category names onto the stored keys and refuses unknown ones", () => {
    expect(fedbCategory("olympic weightlifting")).toBe("olympic_weightlifting");
    expect(fedbCategory("strength")).toBe("strength");
    expect(fedbCategory("cardio")).toBe("cardio");
    expect(() => fedbCategory("yoga")).toThrow(/unknown free-exercise-db category/);
    expect(() => fedbCategory(null)).toThrow(/unknown/);
    expect(isCategory("strongman")).toBe(true);
    expect(isCategory("olympic weightlifting")).toBe(false);
  });
});

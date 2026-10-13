import { describe, expect, it } from "vitest";
import { BACK, FRONT } from "../../web/src/components/bodyMap";
import { BODY_AREAS, areaDef, areaOfMuscle, musclePicks } from "../../worker/lib/bodyAreas";
import { CANONICAL_MUSCLES } from "../../worker/lib/muscles";
import type { Exercise } from "../../worker/lib/types";
import { exercises } from "../fixtures/report-data";

describe("body areas (SPEC-v3 M9b)", () => {
  const drawn = [...new Set([...FRONT, ...BACK].map((r) => r.key))];

  it("cover all 17 drawn muscle keys, each in exactly one area", () => {
    expect(drawn).toHaveLength(17);
    for (const key of drawn) expect(BODY_AREAS.filter((a) => a.muscles.includes(key)).map((a) => a.key), key).toHaveLength(1);
  });

  it("are the spec's eight areas with the spec's muscles", () => {
    expect(Object.fromEntries(BODY_AREAS.map((a) => [a.label, a.muscles]))).toEqual({
      Chest: ["chest"],
      Shoulders: ["shoulders_front", "shoulders_side", "rear_delts"],
      Arms: ["biceps", "triceps", "forearms"],
      Back: ["back_lats", "back_upper", "traps", "lower_back"],
      Core: ["core"],
      "Glutes & hips": ["glutes", "adductors", "abductors"],
      Thighs: ["quads", "hamstrings"],
      Calves: ["calves"],
    });
    // Abductors are not drawn but are reachable through their chip; neck has no area.
    expect(areaOfMuscle("abductors")).toBe("glutes_hips");
    expect(areaOfMuscle("neck")).toBeNull();
    for (const a of BODY_AREAS) for (const m of a.muscles) expect(CANONICAL_MUSCLES).toContain(m);
  });

  it("open on a figure that shows them, with a toggle where the area has two sides", () => {
    for (const a of BODY_AREAS) {
      const first = a.views[0] === "front" ? FRONT : BACK;
      expect(first.some((r) => a.muscles.includes(r.key)), a.key).toBe(true);
    }
    expect(areaDef("arms").views).toEqual(["front", "back"]);
    expect(FRONT.some((r) => r.key === "biceps") && BACK.some((r) => r.key === "triceps")).toBe(true);
  });
});

describe("the exercise list of a muscle", () => {
  const ex = (id: string, over: Partial<Exercise>): Exercise => ({
    ...exercises()[0],
    id,
    name_en: id,
    muscle_primary: "triceps",
    muscles_secondary: [],
    equipment: "cable",
    mechanic: "isolation",
    category: "strength",
    archived_at: null,
    ...over,
  });
  const lib = [
    ex("Z isolation never done", {}),
    ex("A isolation never done", {}),
    ex("Compound never done", { mechanic: "compound", equipment: "barbell" }),
    ex("In program", {}),
    ex("Done long ago", {}),
    ex("Done recently", { equipment: "dumbbell" }),
    ex("Archived", { archived_at: "2026-10-01T00:00:00Z" }),
    ex("Stretch", { category: "stretching" }),
    ex("Bench (secondary)", { muscle_primary: "chest", muscles_secondary: ["shoulders_front", "triceps"], mechanic: "compound" }),
    ex("Curl", { muscle_primary: "biceps" }),
  ];
  const base = {
    equipment: "" as const,
    category: "counted" as const,
    lastDone: new Map([
      ["Done long ago", "2026-09-01T"],
      ["Done recently", "2026-10-10T"],
    ]),
    programIds: new Set(["In program"]),
  };

  it("primary first in the order: done before (most recent first), program, compound, name; then secondary", () => {
    const r = musclePicks(lib, "triceps", base);
    expect(r.primary.map((e) => e.id)).toEqual(["Done recently", "Done long ago", "In program", "Compound never done", "A isolation never done", "Z isolation never done"]);
    expect(r.secondary.map((e) => e.id)).toEqual(["Bench (secondary)"]);
  });

  it("filters by equipment and category; archived exercises never show", () => {
    expect(musclePicks(lib, "triceps", { ...base, equipment: "dumbbell" }).primary.map((e) => e.id)).toEqual(["Done recently"]);
    expect(musclePicks(lib, "triceps", base).primary.map((e) => e.id)).not.toContain("Stretch");
    expect(musclePicks(lib, "triceps", { ...base, category: "all" }).primary.map((e) => e.id)).toContain("Stretch");
    expect(musclePicks(lib, "triceps", { ...base, category: "stretching" }).primary.map((e) => e.id)).toEqual(["Stretch"]);
    expect(musclePicks(lib, "triceps", { ...base, category: "all" }).primary.map((e) => e.id)).not.toContain("Archived");
  });
});

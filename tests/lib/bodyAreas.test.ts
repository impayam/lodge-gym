import { describe, expect, it } from "vitest";
import { BODY_AREAS, areaDef, areaOfMuscle, musclePicks } from "../../worker/lib/bodyAreas";
import { CANONICAL_MUSCLES } from "../../worker/lib/muscles";
import type { Exercise } from "../../worker/lib/types";
import { exercises } from "../fixtures/report-data";

describe("body areas (SPEC-v3 M9b)", () => {
  it("cover all 18 picker muscles (every canonical key but neck), each in exactly one area", () => {
    const picker = CANONICAL_MUSCLES.filter((m) => m !== "neck");
    expect(picker).toHaveLength(18);
    for (const key of picker) expect(BODY_AREAS.filter((a) => a.muscles.includes(key)).map((a) => a.key), key).toHaveLength(1);
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
    // Abductors (gluteus medius and minimus on the 3D model) are in Glutes & hips; neck has no area.
    expect(areaOfMuscle("abductors")).toBe("glutes_hips");
    expect(areaOfMuscle("neck")).toBeNull();
    for (const a of BODY_AREAS) for (const m of a.muscles) expect(CANONICAL_MUSCLES).toContain(m);
  });

  it("open their close-up on the side that shows them", () => {
    expect(Object.fromEntries(BODY_AREAS.map((a) => [a.key, a.views[0]]))).toEqual({
      chest: "front",
      shoulders: "front",
      arms: "front",
      back: "back",
      core: "front",
      glutes_hips: "back",
      thighs: "front",
      calves: "back",
    });
    expect(areaDef("arms").views).toEqual(["front", "back"]);
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

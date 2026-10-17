import { describe, expect, it } from "vitest";
import { REGIONS, REGION_INFO, regionTags, regionsOf, ruleText, type Region, type RegionInput } from "../../worker/lib/regions";

// SPEC-v11 M14 A3: the reviewed region rule table (approved 2026-10-16; forearm and neck regions added in Phase B,
// approved 2026-10-17). Fixtures per region: the main focus a typical exercise gets, and what it must never get.

const ex = (name_en: string, muscle_primary: string, muscles_secondary: string[] = [], pattern: string | null = null, category = "strength"): RegionInput => ({ name_en, muscle_primary, muscles_secondary, pattern, category });
const primary = (x: RegionInput) => regionTags(x).filter((t) => t.emphasis === "primary").map((t) => t.region);
const tagOf = (x: RegionInput, r: Region) => regionTags(x).find((t) => t.region === r);

describe("region list", () => {
  it("has the 30 approved keys, each under a muscle chip", () => {
    expect(REGIONS).toHaveLength(30);
    for (const r of REGIONS) expect(REGION_INFO[r].label).toBeTruthy();
    expect(regionsOf("chest")).toEqual(["chest_upper", "chest_mid", "chest_lower"]);
    expect(regionsOf("biceps")).toEqual(["biceps_long", "biceps_short", "brachialis"]);
    expect(regionsOf("forearms")).toEqual(["forearm_flexors", "forearm_extensors"]);
    expect(regionsOf("neck")).toEqual(["neck_flexors", "neck_extensors"]);
  });
});

describe("rule table: one fixture per region", () => {
  const cases: [RegionInput, Region, string][] = [
    [ex("Incline Dumbbell Bench Press", "chest", ["shoulders_front", "triceps"], "h_push"), "chest_upper", "moderate"],
    [ex("Low-to-High Cable Fly", "chest", [], "isolation"), "chest_upper", "weak"],
    [ex("Barbell Bench Press", "chest", ["shoulders_front", "triceps"], "h_push"), "chest_mid", "strong"],
    [ex("Pec Deck", "chest", [], "isolation"), "chest_mid", "moderate"],
    [ex("Decline Barbell Bench Press", "chest", ["triceps"], "h_push"), "chest_lower", "moderate"],
    [ex("High-to-Low Cable Fly", "chest", [], "isolation"), "chest_lower", "weak"],
    [ex("Dips - Chest Version", "chest", ["triceps"], "h_push"), "chest_lower", "weak"],
    [ex("Standing Military Press", "shoulders_front", ["triceps"], "v_push"), "shoulders_front", "strong"],
    [ex("Cable Lateral Raise", "shoulders_side", [], "isolation"), "shoulders_side", "strong"],
    [ex("Face Pull", "rear_delts", ["back_upper"], "isolation"), "rear_delts", "strong"],
    [ex("Wide-Grip Lat Pulldown", "back_lats", ["biceps"], "v_pull"), "back_lats", "strong"],
    [ex("Straight-Arm Pulldown", "back_lats", [], "isolation"), "back_lats", "moderate"],
    [ex("Seated Cable Row", "back_upper", ["back_lats", "biceps"], "h_pull"), "back_upper", "strong"],
    [ex("Barbell Shrug", "traps", [], "isolation"), "traps", "strong"],
    [ex("Overhead Cable Triceps Extension", "triceps", [], "isolation"), "triceps_long", "strong"],
    [ex("Triceps Pushdown", "triceps", [], "isolation"), "triceps_lateral_medial", "moderate"],
    [ex("Incline Dumbbell Curl", "biceps", [], "isolation"), "biceps_long", "moderate"],
    [ex("Preacher Curl", "biceps", [], "isolation"), "biceps_short", "weak"],
    [ex("Hammer Curls", "biceps", ["forearms"], "isolation"), "brachialis", "moderate"],
    [ex("Barbell Full Squat", "quads", ["glutes", "hamstrings"], "squat"), "quads_squat", "strong"],
    [ex("Leg Extensions", "quads", [], "isolation"), "quads_knee_ext", "strong"],
    [ex("Romanian Deadlift", "hamstrings", ["glutes", "lower_back"], "hinge"), "hamstrings_hinge", "strong"],
    [ex("Seated Leg Curl", "hamstrings", [], "isolation"), "hamstrings_curl", "strong"],
    [ex("Barbell Hip Thrust", "glutes", ["hamstrings"], "hinge"), "glutes_ext", "strong"],
    [ex("Hip Abduction Machine", "abductors", ["glutes"], "isolation"), "glutes_abd", "moderate"],
    [ex("Standing Calf Raises", "calves", [], "isolation"), "calves_gastroc", "moderate"],
    [ex("Seated Calf Raise", "calves", [], "isolation"), "calves_soleus", "moderate"],
    [ex("Copenhagen Plank", "adductors", ["core"], "core"), "adductors", "strong"],
    [ex("Ab Wheel Rollout", "core", [], "core"), "core_anti_ext", "moderate"],
    [ex("Cable Crunch", "core", [], "core"), "core_flexion", "strong"],
    [ex("Pallof Press", "core", [], "core"), "core_anti_rot", "moderate"],
    [ex("Palms-Up Barbell Wrist Curl Over A Bench", "forearms", [], "isolation"), "forearm_flexors", "strong"],
    [ex("Plate Pinch", "forearms", [], "isolation"), "forearm_flexors", "moderate"],
    [ex("Palms-Down Wrist Curl Over A Bench", "forearms", [], "isolation"), "forearm_extensors", "strong"],
    [ex("Cable Reverse Wrist Curl", "forearms", [], "isolation"), "forearm_extensors", "strong"],
    [ex("Lying Face Up Plate Neck Resistance", "neck", [], "isolation"), "neck_flexors", "moderate"],
    [ex("Isometric Neck Flexion (Hand Resistance)", "neck", [], "isolation"), "neck_flexors", "moderate"],
    [ex("Lying Face Down Plate Neck Resistance", "neck", [], "isolation"), "neck_extensors", "strong"],
    [ex("Isometric Neck Extension (Hand Resistance)", "neck", [], "isolation"), "neck_extensors", "moderate"],
  ];
  it.each(cases.map(([x, r, ev]) => [x.name_en, x, r, ev] as const))("%s → %s", (_n, x, region, evidence) => {
    const t = tagOf(x, region);
    expect(t?.emphasis).toBe("primary");
    expect(t?.evidence).toBe(evidence);
  });

  it("every region is somebody's main focus in the fixtures", () => {
    expect(new Set(cases.map(([, r]) => r))).toEqual(new Set(REGIONS));
  });
});

describe("rule details", () => {
  it("a flat press trains the upper and lower chest as well (secondary), an incline press the middle", () => {
    const flat = regionTags(ex("Dumbbell Bench Press", "chest", ["triceps"], "h_push"));
    expect(flat.filter((t) => t.emphasis === "secondary").map((t) => t.region)).toEqual(expect.arrayContaining(["chest_upper", "chest_lower"]));
    expect(tagOf(ex("Incline Bench Press", "chest", [], "h_push"), "chest_mid")?.emphasis).toBe("secondary");
  });

  it("fly direction: low-to-high is upper, high-to-low is lower, a plain crossover is middle", () => {
    expect(primary(ex("Cable Crossover", "chest", [], "isolation"))).toEqual(["chest_mid"]);
    expect(primary(ex("Low Cable Crossover", "chest", [], "isolation"))).toEqual(["chest_upper"]);
    expect(primary(ex("High Cable Fly", "chest", [], "isolation"))).toEqual(["chest_lower"]);
  });

  it("a plain curl tags both biceps heads as main focus (the reviewed exception), hammer curls the brachialis", () => {
    expect(primary(ex("Barbell Curl", "biceps", ["forearms"], "isolation"))).toEqual(["biceps_long", "biceps_short"]);
    expect(primary(ex("Reverse Barbell Curl", "biceps", [], "isolation"))).toEqual(["brachialis"]);
  });

  it("presses, push-ups and dips tag the triceps lateral and medial heads only, never the long head (Payam, 2026-10-16)", () => {
    const presses = [
      ex("Barbell Bench Press", "chest", ["shoulders_front", "triceps"], "h_push"),
      ex("Incline Barbell Bench Press", "chest", ["shoulders_front", "triceps"], "h_push"),
      ex("Decline Dumbbell Bench Press", "chest", ["triceps"], "h_push"),
      ex("Standing Overhead Press", "shoulders_front", ["triceps"], "v_push"),
      ex("Barbell Press Behind Neck", "shoulders_front", ["triceps"], "v_push"),
      ex("Dips - Chest Version", "chest", ["triceps"], "v_push"),
      ex("Dips - Triceps Version", "triceps", ["chest"], "v_push"),
      ex("Close-Grip Barbell Bench Press", "triceps", ["chest"], "h_push"),
      ex("Diamond Push-Up", "triceps", ["chest"], "h_push"),
      ex("JM Press", "triceps", [], "h_push"),
      // A custom press without a pattern: the name decides.
      ex("Machine Press", "chest", ["triceps"], null),
    ];
    for (const x of presses) {
      const t = regionTags(x);
      expect(t.some((r) => r.region === "triceps_long"), x.name_en).toBe(false);
      expect(t.find((r) => r.region === "triceps_lateral_medial")?.emphasis, x.name_en).toBe(x.muscle_primary === "triceps" ? "primary" : "secondary");
    }
    // Extensions keep the long head.
    expect(tagOf(ex("Overhead Cable Triceps Extension", "triceps", [], "isolation"), "triceps_long")?.emphasis).toBe("primary");
    expect(tagOf(ex("Triceps Pushdown", "triceps", [], "isolation"), "triceps_long")?.emphasis).toBe("secondary");
    expect(tagOf(ex("Lying Triceps Press", "triceps", [], "isolation"), "triceps_long")?.emphasis).toBe("primary");
  });

  it("a row trains the upper back first, even with the lats as its main muscle; a pulldown the lats", () => {
    expect(primary(ex("One-Arm Dumbbell Row", "back_lats", ["back_upper", "biceps"], "h_pull"))).toEqual(["back_upper"]);
    expect(primary(ex("Chin-Up", "back_lats", ["biceps"], "v_pull"))).toEqual(["back_lats"]);
  });

  it("secondary muscles: synergists tag as secondary; hamstrings only in a hinge; calves, core, lower back never", () => {
    const squat = regionTags(ex("Barbell Squat", "quads", ["glutes", "hamstrings", "calves", "lower_back", "core"], "squat"));
    expect(squat.map((t) => t.region)).toEqual(["quads_squat", "glutes_ext", "adductors"]);
    expect(squat.find((t) => t.region === "glutes_ext")?.emphasis).toBe("secondary");
    const dl = regionTags(ex("Barbell Deadlift", "lower_back", ["hamstrings", "glutes", "quads"], "hinge"));
    expect(dl.find((t) => t.region === "hamstrings_hinge")?.emphasis).toBe("secondary");
    expect(dl.some((t) => t.emphasis === "primary" && t.region.startsWith("calves"))).toBe(false);
  });

  it("a reverse wrist curl is wrist extension, not brachialis work; a hammer or reverse curl stays brachialis", () => {
    expect(primary(ex("Cable Reverse Wrist Curl", "forearms", [], "isolation"))).toEqual(["forearm_extensors"]);
    expect(tagOf(ex("Cable Reverse Wrist Curl", "forearms", [], "isolation"), "brachialis")).toBeUndefined();
    expect(primary(ex("Reverse Barbell Curl", "forearms", ["biceps"], "isolation"))).toEqual(["brachialis"]);
    expect(primary(ex("Hammer Curl", "forearms", ["biceps"], "isolation"))).toEqual(["brachialis"]);
  });

  it("forearms: rollers and rotations train both groups, a neutral wrist curl neither as main focus; forearms as a secondary muscle tag nothing", () => {
    expect(primary(ex("Wrist Roller", "forearms", [], "isolation"))).toEqual(["forearm_flexors", "forearm_extensors"]);
    expect(primary(ex("Wrist Rotations with Straight Bar", "forearms", [], "isolation"))).toEqual(["forearm_flexors", "forearm_extensors"]);
    expect(primary(ex("Dumbbell Neutral-Grip Wrist Curl", "forearms", [], "isolation"))).toEqual([]);
    expect(regionTags(ex("Dumbbell Neutral-Grip Wrist Curl", "forearms", [], "isolation")).map((t) => t.emphasis)).toEqual(["secondary", "secondary"]);
    expect(primary(ex("Dead Hang", "forearms", [], "isolation"))).toEqual(["forearm_flexors"]);
    // Payam, 2026-10-17: forearms are not "also trained" in rows, pulls and deadlifts.
    for (const x of [ex("Seated Cable Row", "back_upper", ["forearms", "biceps"], "h_pull"), ex("Barbell Deadlift", "lower_back", ["forearms", "hamstrings"], "hinge")])
      expect(regionTags(x).some((t) => t.region.startsWith("forearm_")), x.name_en).toBe(false);
  });

  it("neck: front-and-back isometrics train both groups; side work neither as main focus", () => {
    expect(primary(ex("Isometric Neck Exercise - Front And Back", "neck", [], "isolation"))).toEqual(["neck_flexors", "neck_extensors"]);
    expect(primary(ex("Isometric Neck Exercise - Sides", "neck", [], "isolation"))).toEqual([]);
    expect(primary(ex("Lying Neck Extension", "neck", [], "isolation"))).toEqual(["neck_extensors"]);
    expect(primary(ex("Lying Neck Flexion", "neck", [], "isolation"))).toEqual(["neck_flexors"]);
  });

  it("stretching and cardio carry no region, forearm and neck stretches included", () => {
    expect(regionTags(ex("Kneeling Forearm Stretch", "forearms", [], null, "stretching"))).toEqual([]);
    expect(regionTags(ex("Side Neck Stretch", "neck", [], null, "stretching"))).toEqual([]);
    expect(regionTags(ex("Doorway Pec Stretch", "chest", [], null, "stretching"))).toEqual([]);
    expect(regionTags(ex("Rowing Machine", "back_lats", [], null, "cardio"))).toEqual([]);
  });

  it("names nothing it should not: no inner or outer chest, no peak", () => {
    for (const r of REGIONS) expect(REGION_INFO[r].label).not.toMatch(/inner|outer|peak/i);
  });

  it("a reviewed override replaces the rules", () => {
    const tags = regionTags({ id: "x", ...ex("Odd Press", "chest", [], "h_push") }, { x: { tags: [{ region: "chest_upper", emphasis: "primary", evidence: "weak" }], reason: "test" } });
    expect(tags).toEqual([{ region: "chest_upper", emphasis: "primary", evidence: "weak", note: "reviewed" }]);
  });

  it("matches spelling variants", () => {
    expect(ruleText("Push-Ups")).toContain(" pushup ");
    expect(ruleText("Incline Flyes")).toContain(" fly ");
    expect(ruleText("Lat Pull-Down")).toContain(" pulldown ");
  });
});

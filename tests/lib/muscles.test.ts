import { describe, expect, it } from "vitest";
import program from "../../seed/program.json";
import seedMatches from "../../seed/library/seed-matches.json";
import { CANONICAL_MUSCLES, fedbMuscle, fedbMuscles, groupOf, isLowerBody, REPORT_GROUPS, setContribution, TARGET_GROUPS } from "../../worker/lib/muscles";

describe("canonical muscle keys (SPEC-v2 §7.2)", () => {
  it("has the 19 keys of the muscle map", () => {
    expect(CANONICAL_MUSCLES).toHaveLength(19);
    expect(TARGET_GROUPS).toEqual(["chest", "back", "quads", "hamstrings_glutes", "shoulders", "rear_delts", "calves", "core", "biceps", "triceps"]);
    expect(REPORT_GROUPS).toHaveLength(16);
  });
  it("rolls every key up into a report group; the old group keys still count", () => {
    expect(groupOf("back_lats")).toBe("back");
    expect(groupOf("back_upper")).toBe("back");
    expect(groupOf("glutes")).toBe("hamstrings_glutes");
    expect(groupOf("shoulders_side")).toBe("shoulders");
    expect(groupOf("rear_delts")).toBe("rear_delts");
    expect(groupOf("lower_back")).toBe("lower_back");
    expect(groupOf("hamstrings_glutes")).toBe("hamstrings_glutes");
    expect(groupOf("back")).toBe("back");
    expect(groupOf("hip flexors")).toBeNull();
    expect(groupOf(null)).toBeNull();
    for (const m of CANONICAL_MUSCLES) expect(REPORT_GROUPS).toContain(groupOf(m));
  });
  it("lower-body keys", () => {
    expect(isLowerBody("glutes")).toBe(true);
    expect(isLowerBody("calves")).toBe(true);
    expect(isLowerBody("lower_back")).toBe(false);
    expect(isLowerBody("chest")).toBe(false);
  });
});

describe("fractional set contribution (SPEC-v2 §7.4)", () => {
  it("primary 1, each secondary group 0.5, a group never twice", () => {
    expect(Object.fromEntries(setContribution("chest", ["shoulders_front", "triceps"]))).toEqual({ chest: 1, shoulders: 0.5, triceps: 0.5 });
    // Lats primary with upper back secondary: both are "back", so it counts 1, not 1.5.
    expect(Object.fromEntries(setContribution("back_lats", ["back_upper", "biceps", "rear_delts"]))).toEqual({ back: 1, biceps: 0.5, rear_delts: 0.5 });
    // Two secondaries in one group count 0.5 once.
    expect(Object.fromEntries(setContribution("quads", ["glutes", "hamstrings"]))).toEqual({ quads: 1, hamstrings_glutes: 0.5 });
    expect(Object.fromEntries(setContribution("core", []))).toEqual({ core: 1 });
    expect(setContribution("unknown", ["also unknown"]).size).toBe(0);
  });
  it("per set a group gets at most 1.0: primary 1.0 (secondaries in the group add nothing), secondaries only 0.5 (Payam, 2026-10-12)", () => {
    const sec = Object.fromEntries((seedMatches as { id: string; muscles_secondary: string[] }[]).map((s) => [s.id, s.muscles_secondary]));
    const prim = Object.fromEntries(program.exercises.map((e) => [e.id, e.muscle_primary]));
    const per = (id: string, group: string) => setContribution(prim[id], sec[id]).get(group as never) ?? 0;
    // Deadlift: lats and upper back are both secondaries → back 0.5, not 1.0; glutes primary + hamstrings → 1.0.
    expect(sec.deadlift).toEqual(expect.arrayContaining(["back_lats", "back_upper", "hamstrings"]));
    expect(per("deadlift", "back")).toBe(0.5);
    expect(per("deadlift", "hamstrings_glutes")).toBe(1);
    // Squat, leg press, Bulgarian split squat: glutes and hamstrings secondaries → 0.5.
    for (const id of ["squat", "leg_press", "bulgarian"]) expect(per(id, "hamstrings_glutes"), id).toBe(0.5);
    // Rows and pulldowns: primary back plus a back secondary → 1.0, not 1.5.
    for (const id of ["cable_row", "cs_row", "pulldown", "pullup"]) expect(per(id, "back"), id).toBe(1);
    // RDL: hamstrings primary + glutes secondary → 1.0.
    expect(per("rdl", "hamstrings_glutes")).toBe(1);
    // Bench: front-delt secondary → shoulders 0.5.
    expect(per("bench", "shoulders")).toBe(0.5);
  });
});

describe("free-exercise-db muscle names", () => {
  const ex = (name: string, force: string | null = "push") => ({ name, force });
  it("maps the dataset's names", () => {
    expect(fedbMuscle("lats", "primary", ex("x"))).toBe("back_lats");
    expect(fedbMuscle("middle back", "primary", ex("x"))).toBe("back_upper");
    expect(fedbMuscle("lower back", "secondary", ex("x"))).toBe("lower_back");
    expect(fedbMuscle("abdominals", "primary", ex("x"))).toBe("core");
    expect(fedbMuscle("quadriceps", "primary", ex("x"))).toBe("quads");
    expect(fedbMuscle("hip flexors", "primary", ex("x"))).toBeNull();
  });
  it("splits shoulders by exercise name (primary) or force (secondary)", () => {
    expect(fedbMuscle("shoulders", "primary", ex("Standing Military Press"))).toBe("shoulders_front");
    expect(fedbMuscle("shoulders", "primary", ex("Side Lateral Raise"))).toBe("shoulders_side");
    expect(fedbMuscle("shoulders", "primary", ex("Upright Barbell Row", "pull"))).toBe("shoulders_side");
    expect(fedbMuscle("shoulders", "primary", ex("Face Pull", "pull"))).toBe("rear_delts");
    expect(fedbMuscle("shoulders", "primary", ex("Reverse Flyes", "pull"))).toBe("rear_delts");
    expect(fedbMuscle("shoulders", "primary", ex("Dumbbell Lying Rear Lateral Raise", "pull"))).toBe("rear_delts");
    expect(fedbMuscle("shoulders", "primary", ex("Bent Over Low-Pulley Side Lateral", "pull"))).toBe("rear_delts");
    expect(fedbMuscle("shoulders", "secondary", ex("Barbell Bench Press", "push"))).toBe("shoulders_front");
    expect(fedbMuscle("shoulders", "secondary", ex("Seated Cable Rows", "pull"))).toBe("rear_delts");
  });
  it("primary is the first mappable primary; secondaries deduplicated and never the primary", () => {
    expect(fedbMuscles({ name: "Barbell Deadlift", force: "pull", primaryMuscles: ["lower back"], secondaryMuscles: ["glutes", "hamstrings", "lats", "middle back", "glutes"] })).toEqual({
      primary: "lower_back",
      secondary: ["glutes", "hamstrings", "back_lats", "back_upper"],
    });
    expect(fedbMuscles({ name: "Kettlebell Halo", force: "push", primaryMuscles: ["shoulders", "triceps"], secondaryMuscles: ["triceps"] })).toEqual({ primary: "shoulders_front", secondary: ["triceps"] });
    expect(fedbMuscles({ name: "x", force: null, primaryMuscles: ["hip flexors"], secondaryMuscles: [] })).toEqual({ primary: null, secondary: [] });
  });
});

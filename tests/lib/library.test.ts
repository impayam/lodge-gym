import { describe, expect, it } from "vitest";
import program from "../../seed/program.json";
import equipmentReview from "../../seed/library/fedb-equipment.json";
import manual from "../../seed/library/manual.json";
import patterns from "../../seed/library/fedb-patterns.json";
import seedMatches from "../../seed/library/seed-matches.json";
import sample from "../fixtures/library/fedb-sample.json";
import {
  buildLibrary,
  fedbExerciseId,
  imageKeys,
  librarySql,
  reportMarkdown,
  resolveEquipment,
  validateInputs,
  type EquipmentReview,
  type FedbExercise,
  type ManualExercise,
  type PatternFile,
  type SeedMatch,
} from "../../worker/lib/library";
import { ID_RE } from "../../worker/lib/ulid";

const seedPrimary = Object.fromEntries(program.exercises.map((e) => [e.id, e.muscle_primary]));
const review = equipmentReview as EquipmentReview;
const build = (dataset = sample as FedbExercise[]) => buildLibrary(dataset, patterns as PatternFile, seedMatches as SeedMatch[], manual as ManualExercise[], seedPrimary, review);

describe("equipment (decisions 2026-10-13)", () => {
  it("maps the standard values, reviewed 'other' and missing entries; excludes only the five types", () => {
    expect(resolveEquipment({ id: "a", equipment: "body only" }, review)).toBe("bodyweight");
    expect(resolveEquipment({ id: "a", equipment: "e-z curl bar" }, review)).toBe("barbell");
    expect(resolveEquipment({ id: "Trap_Bar_Deadlift", equipment: "other" }, review)).toBe("barbell");
    expect(resolveEquipment({ id: "Farmers_Walk", equipment: "other" }, review)).toBe("dumbbell");
    expect(resolveEquipment({ id: "Dips_-_Chest_Version", equipment: "other" }, review)).toBe("bodyweight");
    expect(resolveEquipment({ id: "Hyperextensions_Back_Extensions", equipment: "other" }, review)).toBe("bodyweight");
    expect(resolveEquipment({ id: "Inverted_Row", equipment: null }, review)).toBe("bodyweight");
    for (const e of ["kettlebells", "bands", "medicine ball", "exercise ball", "foam roll"]) expect(resolveEquipment({ id: "a", equipment: e }, review)).toBeNull();
    expect(() => resolveEquipment({ id: "Not_Reviewed", equipment: "other" }, review)).toThrow(/not reviewed/);
    expect(() => resolveEquipment({ id: "a", equipment: "spaceship" }, review)).toThrow(/unknown equipment/);
  });
  it("the reviewed file covers 122 'other' and 77 missing entries with allowed values", () => {
    expect(Object.keys(review.other)).toHaveLength(122);
    expect(Object.keys(review.missing)).toHaveLength(77);
    expect(validateInputs(seedMatches as SeedMatch[], manual as ManualExercise[], patterns as PatternFile, review)).toEqual([]);
  });
});

describe("library build from the fixture (real free-exercise-db entries)", () => {
  const lib = build();
  const byId = new Map(lib.rows.map((r) => [r.id, r]));

  it("seeded exercises are enriched in place, never duplicated", () => {
    expect(lib.seedUpdates).toHaveLength(27);
    expect(byId.has(fedbExerciseId("Barbell_Bench_Press_-_Medium_Grip"))).toBe(false);
    const bench = lib.seedUpdates.find((s) => s.id === "bench")!;
    expect(bench).toMatchObject({ muscles_secondary: ["shoulders_front", "triceps"], pattern: "h_push", mechanic: "compound", level: "beginner" });
    expect(bench.media).toEqual([
      { kind: "image", r2_key: "library/free-exercise-db/images/Barbell_Bench_Press_-_Medium_Grip/0.jpg" },
      { kind: "image", r2_key: "library/free-exercise-db/images/Barbell_Bench_Press_-_Medium_Grip/1.jpg" },
    ]);
    expect(lib.seedUpdates.find((s) => s.id === "bulgarian")).toMatchObject({ media: [], level: null, pattern: "lunge" });
  });

  it("imports mapped entries with a primary muscle key and excludes the five equipment types", () => {
    expect(byId.get("fedb-Trap_Bar_Deadlift")).toMatchObject({ equipment: "barbell", pattern: "hinge", muscle_primary: "quads", is_lower: true, source: "fedb", source_id: "Trap_Bar_Deadlift" });
    expect(byId.get("fedb-Farmers_Walk")).toMatchObject({ equipment: "dumbbell", pattern: "carry" });
    expect(byId.get("fedb-Inverted_Row")).toMatchObject({ equipment: "bodyweight", pattern: "h_pull" });
    expect(byId.get("fedb-EZ-Bar_Curl")).toMatchObject({ equipment: "barbell", muscle_primary: "biceps" });
    expect(byId.has("fedb-Goblet_Squat")).toBe(false);
    expect(byId.has("fedb-Band_Hip_Adductions")).toBe(false);
    expect(lib.report.excluded_equipment.map((x) => x.id)).toEqual(["Band_Hip_Adductions", "Goblet_Squat"]);
    expect(lib.rows.every((r) => r.muscle_primary && ID_RE.test(r.id))).toBe(true);
    expect(byId.get("fedb-Hamstring_Stretch")).toMatchObject({ pattern: null });
    expect(lib.report.unmapped_pattern.map((x) => x.id)).toContain("Hamstring_Stretch");
  });

  it("adds the hand-written gap fill as source 'manual' without media", () => {
    const m = lib.rows.filter((r) => r.source === "manual");
    expect(m).toHaveLength((manual as ManualExercise[]).length);
    expect(m.every((r) => r.media.length === 0 && r.pattern && r.mechanic && r.source_id === r.id)).toBe(true);
  });

  it("report: counts, equipment table and the full 'other' list", () => {
    const r = lib.report;
    expect(r.dataset.total).toBe(40);
    expect(r.equipment.find((e) => e.from === "kettlebells")).toEqual({ from: "kettlebells", to: "excluded", count: 1 });
    expect(r.reviewed_equipment).toEqual(
      expect.arrayContaining([
        { id: "Trap_Bar_Deadlift", name: "Trap Bar Deadlift", from: "other", to: "barbell" },
        { id: "Inverted_Row", name: "Inverted Row", from: "missing", to: "bodyweight" },
      ])
    );
    const md = reportMarkdown(r);
    expect(md).toContain("- Equipment mapped onto the five allowed values: 13");
    expect(md).toContain("- Excluded by equipment (kettlebell, bands, medicine ball, exercise ball, foam roll): 2");
    expect(md).toContain("- Trap Bar Deadlift → barbell");
    expect(md).toContain("| other | barbell |");
  });

  it("image keys cover the rows and the seed enrichment", () => {
    const keys = imageKeys(lib.rows, lib.seedUpdates);
    expect(keys).toContain("library/free-exercise-db/images/Barbell_Bench_Press_-_Medium_Grip/0.jpg");
    expect(keys).toContain("library/free-exercise-db/images/Farmers_Walk/1.jpg");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("refuses an unmatched seed id, a primary repeated as secondary, and bad manual rows", () => {
    expect(() => buildLibrary(sample as FedbExercise[], {}, [{ id: "bench", fedb: "Nope", pattern: "h_push", mechanic: "compound", muscles_secondary: [] }], [], seedPrimary, review)).toThrow(/has no Nope/);
    expect(() => buildLibrary(sample as FedbExercise[], {}, [{ id: "bench", fedb: null, pattern: "h_push", mechanic: "compound", muscles_secondary: ["chest"] }], [], seedPrimary, review)).toThrow(/repeated/);
    const bad = [{ id: "manual-x", name_en: "X", equipment: "kettlebell", muscle_primary: "chest", muscles_secondary: ["chest"], pattern: "push", mechanic: "compound" }] as unknown as ManualExercise[];
    expect(validateInputs([], bad, {}, review)).toEqual(["manual manual-x: equipment kettlebell", "manual manual-x: secondary chest", "manual manual-x: pattern push"]);
  });
});

describe("library SQL", () => {
  it("only writes when a value differs", () => {
    const lib = build();
    const sql = librarySql(lib.rows, lib.seedUpdates);
    expect(sql).toHaveLength(lib.rows.length + lib.seedUpdates.length);
    expect(sql[0]).toMatch(/^INSERT INTO exercises .* ON CONFLICT \(id\) DO UPDATE SET .* WHERE exercises\.name_en IS NOT excluded\.name_en OR /);
    expect(sql[sql.length - 1]).toMatch(/^UPDATE exercises SET .* WHERE id = '[a-z_]+' AND source = 'seed' AND \(.* IS NOT .*\);$/);
  });
});

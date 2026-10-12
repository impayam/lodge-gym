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
  unknownReviewIds,
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
  it("the reviewed file covers 100 'other' and 77 missing entries with allowed values, and 22 exclusions", () => {
    expect(Object.keys(review.other)).toHaveLength(100);
    expect(Object.keys(review.missing)).toHaveLength(77);
    expect(Object.values(review.excluded).filter((r) => r === "strongman-only")).toHaveLength(13);
    expect(Object.values(review.excluded).filter((r) => r === "excluded on review")).toHaveLength(9);
    expect(review.other).toMatchObject({ Trap_Bar_Deadlift: "barbell", Axle_Deadlift: "barbell", "Band_Assisted_Pull-Up": "bodyweight" });
    expect(validateInputs(seedMatches as SeedMatch[], manual as ManualExercise[], patterns as PatternFile, review)).toEqual([]);
  });
  it("refuses an exclusion without a reason, one that is also mapped, one matched to a seed, and ids the dataset lacks", () => {
    const bad: EquipmentReview = { other: { Atlas_Stones: "barbell" }, missing: {}, excluded: { Atlas_Stones: "strongman-only", "Neck-SMR": " ", "Barbell_Bench_Press_-_Medium_Grip": "x" } };
    expect(validateInputs(seedMatches as SeedMatch[], [], {}, bad)).toEqual([
      "excluded Atlas_Stones: also has an equipment mapping",
      "excluded Neck-SMR: a reason is required",
      "excluded Barbell_Bench_Press_-_Medium_Grip: matched to a seeded exercise",
    ]);
    expect(unknownReviewIds([{ id: "A" }], { other: { A: "barbell", B: "dumbbell" }, missing: { M: "bodyweight" }, excluded: { C: "x" } })).toEqual(["B", "C", "M"]);
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

  it("stores the dataset's category, the reviewed override, and strength for manual rows (SPEC-v2 §7.4)", () => {
    expect(byId.get("fedb-Hamstring_Stretch")?.category).toBe("stretching");
    expect(byId.get("fedb-Sled_Push")?.category).toBe("strongman");
    expect(byId.get("fedb-Farmers_Walk")?.category).toBe("strength");
    expect(byId.get("fedb-Trap_Bar_Deadlift")?.category).toBe("strength");
    expect(lib.rows.filter((r) => r.source === "manual").every((r) => r.category === "strength")).toBe(true);
    expect(lib.report.category_overrides).toEqual([{ id: "Farmers_Walk", name: "Farmer's Walk", from: "strongman", to: "strength" }]);
    expect(lib.report.not_counted_strongman).toEqual([{ id: "Sled_Push", name: "Sled Push" }]);
    expect(lib.report.categories).toEqual(
      expect.arrayContaining([
        { category: "stretching", counted: false, count: 1 },
        { category: "strongman", counted: false, count: 1 },
      ])
    );
    const md = reportMarkdown(lib.report);
    expect(md).toContain("| stretching | no | 1 |");
    expect(md).toContain("- Farmer's Walk: strongman → strength");
    expect(md).toContain("## Strongman rows that count 0 sets (1)");
  });

  it("refuses a category the dataset adds and an invalid reviewed override", () => {
    const odd = (sample as FedbExercise[]).map((x) => (x.id === "Hamstring_Stretch" ? { ...x, category: "yoga" } : x));
    expect(() => build(odd)).toThrow(/unknown free-exercise-db category "yoga"/);
    expect(validateInputs([], [], { X: { pattern: null, category: "yoga" as never } }, review)).toEqual(["patterns X: category yoga"]);
  });

  it("leaves out the entries excluded on review, whatever their equipment", () => {
    expect(byId.has("fedb-Atlas_Stones")).toBe(false);
    expect(byId.has("fedb-Neck-SMR")).toBe(false);
    expect(lib.report.excluded_review).toEqual([
      { id: "Atlas_Stones", name: "Atlas Stones", reason: "strongman-only" },
      { id: "Neck-SMR", name: "Neck-SMR", reason: "excluded on review" },
    ]);
    expect(lib.report.reviewed_equipment.map((x) => x.id)).not.toContain("Atlas_Stones");
  });

  it("adds the hand-written gap fill as source 'manual' without media", () => {
    const m = lib.rows.filter((r) => r.source === "manual");
    expect(m).toHaveLength((manual as ManualExercise[]).length);
    expect(m.every((r) => r.media.length === 0 && r.pattern && r.mechanic && r.source_id === r.id)).toBe(true);
  });

  it("report: counts, equipment table and the full 'other' list", () => {
    const r = lib.report;
    expect(r.dataset.total).toBe(43);
    expect(r.equipment.find((e) => e.from === "kettlebells")).toEqual({ from: "kettlebells", to: "excluded", count: 1 });
    expect(r.reviewed_equipment).toEqual(
      expect.arrayContaining([
        { id: "Trap_Bar_Deadlift", name: "Trap Bar Deadlift", from: "other", to: "barbell" },
        { id: "Inverted_Row", name: "Inverted Row", from: "missing", to: "bodyweight" },
      ])
    );
    const md = reportMarkdown(r);
    expect(md).toContain("- Equipment mapped onto the five allowed values: 14");
    expect(md).toContain("- Excluded by equipment (kettlebell, bands, medicine ball, exercise ball, foam roll): 2");
    expect(md).toContain("- Excluded on review (strongman-only and others, seed/library/fedb-equipment.json): 2");
    expect(md).toContain("- Atlas Stones (strongman-only)");
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
    expect(sql[0]).toContain(" OR exercises.category IS NOT excluded.category;");
    expect(sql[sql.length - 1]).toMatch(/^UPDATE exercises SET .* WHERE id = '[a-z_]+' AND source = 'seed' AND \(.* IS NOT .*\);$/);
  });
});

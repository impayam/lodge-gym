import { describe, expect, it } from "vitest";
import { exactRepeats, regionChecks, regionsSql, sourceImageKey, sourceRows, validateDecisions, type DecisionFile, type DedupeEntry } from "../../worker/lib/libraryDecisions";
import { SOURCES } from "../../worker/lib/librarySources";
import type { RegionTag } from "../../worker/lib/regions";

// SPEC-v11 M14 A2: reviewed decisions → library rows. Nothing is merged; a reviewed duplicate is simply not added,
// existing ids never change, and the import refuses inconsistent or incomplete decisions.

const row = (name_en: string, extra = {}) => ({
  name_en,
  category: "strength" as const,
  equipment: "dumbbell" as const,
  muscle_primary: "chest" as const,
  muscles_secondary: ["triceps" as const],
  pattern: "h_push" as const,
  mechanic: "compound" as const,
  instructions_en: ["Lie on a bench with a dumbbell in each hand.", "Press them up until your arms are straight."],
  ...extra,
});

const wger = (decisions: DecisionFile["decisions"]): DecisionFile => ({ source: "wger", sha: SOURCES.wger.sha, decisions });
const edb = (decisions: DecisionFile["decisions"]): DecisionFile => ({ source: "exercisedb", sha: SOURCES.exercisedb.sha, decisions });

describe("validation", () => {
  const ok = [
    wger([
      { sid: "1", name: "DB Squeeze Press", decision: "include", row: row("Dumbbell Squeeze Press"), license: "CC-BY-SA-4.0", license_author: "a", images: [{ url: "https://wger.de/media/exercise-images/1/x.png", license: "CC-BY-SA-3.0", author: "b" }] },
      { sid: "2", name: "Snach", decision: "exclude", reason: "typo of an existing lift" },
      { sid: "3", name: "Bench press DB", decision: "duplicate", duplicate_of: "fedb-Dumbbell_Bench_Press", reason: "same" },
    ]),
    edb([{ sid: "0001", name: "dumbbell squeeze press", decision: "duplicate", duplicate_of: "wger-1", reason: "same" }]),
  ];
  const dedupe: DedupeEntry[] = [
    { candidate: "wger:3", name: "Bench press DB", closest: { id: "fedb-Dumbbell_Bench_Press", name: "Dumbbell Bench Press", score: 1 }, decision: "same", duplicate_of: "fedb-Dumbbell_Bench_Press", reason: "spelling" },
    { candidate: "exercisedb:0001", name: "dumbbell squeeze press", closest: null, decision: "same", duplicate_of: "wger-1", reason: "same exercise" },
  ];
  const lib = new Set(["fedb-Dumbbell_Bench_Press"]);

  it("accepts consistent decisions", () => {
    expect(validateDecisions(ok, dedupe, lib)).toEqual([]);
  });

  it("refuses: a duplicate not listed as same, an unknown target, an exclusion without a reason, a facts-only source with a licence", () => {
    const bad = [
      wger([
        { sid: "1", name: "x", decision: "include", row: row("X Press"), license: "CC-BY-SA-4.0", license_author: "a" },
        { sid: "2", name: "y", decision: "exclude" },
        { sid: "3", name: "z", decision: "duplicate", duplicate_of: "fedb-Nope", reason: "same" },
      ]),
      edb([{ sid: "0002", name: "w", decision: "include", row: row("W Press"), license: "CC-BY-SA-4.0" }]),
    ];
    const errors = validateDecisions(bad, [{ candidate: "wger:3", name: "z", closest: null, decision: "same", duplicate_of: "fedb-Nope", reason: "r" }], lib);
    expect(errors.join("\n")).toMatch(/wger:2: an exclusion needs a reason/);
    expect(errors.join("\n")).toMatch(/fedb-Nope is not in the library/);
    expect(errors.join("\n")).toMatch(/facts-only source stores no licensed content/);
  });

  it("refuses an included row with bad facts or steps, and a pattern on cardio only when it is valid", () => {
    const errors = validateDecisions(
      [
        wger([
          { sid: "1", name: "x", decision: "include", row: row("X", { equipment: "kettlebell", instructions_en: ["only one"] }), license: "CC0-1.0", license_author: "a" },
          { sid: "2", name: "y", decision: "include", row: row("Rowing Machine", { category: "cardio", pattern: null, mechanic: null }), license: "CC0-1.0", license_author: "a" },
        ]),
      ],
      [],
      lib
    );
    expect(errors).toEqual(["wger:1 (X): equipment kettlebell", "wger:1 (X): two or three instruction steps"]);
  });

  it("a duplicate marked different must get a row", () => {
    const errors = validateDecisions(ok, [{ ...dedupe[0], decision: "different" }, dedupe[1]], lib);
    expect(errors.join("\n")).toMatch(/marked different, so its decision needs a row/);
  });
});

describe("rows", () => {
  it("adds only the included records not listed as same, with licence, author and image keys", () => {
    const files = [
      wger([
        { sid: "1", name: "a", decision: "include", row: row("Dumbbell Squeeze Press"), license: "CC-BY-SA-4.0", license_author: "a", images: [{ url: "https://wger.de/media/exercise-images/1/x.png", license: "CC-BY-SA-3.0", author: "b" }] },
        { sid: "2", name: "b", decision: "include", row: row("Floor Press") , license: "CC0-1.0", license_author: "c" },
      ]),
    ];
    const rows = sourceRows(files, [{ candidate: "wger:2", name: "b", closest: null, decision: "same", duplicate_of: "x", reason: "r" }]);
    expect(rows.map((r) => r.id)).toEqual(["wger-1"]);
    expect(rows[0]).toMatchObject({ source: "wger", source_id: "1", license: "CC-BY-SA-4.0", license_author: "a", is_lower: false });
    expect(rows[0].media).toEqual([{ kind: "image", r2_key: "library/sources/wger/images/1/x.png", license: "CC-BY-SA-3.0", author: "b" }]);
  });

  it("image keys: wger keeps its folder, everkinetic the file name", () => {
    expect(sourceImageKey("wger", "https://wger.de/media/exercise-images/91/Crunches-1.png")).toBe("library/sources/wger/images/91/Crunches-1.png");
    expect(sourceImageKey("everkinetic", `https://raw.githubusercontent.com/everkinetic/data/${SOURCES.everkinetic.sha}/dist/png/0001-a.png`)).toBe("library/sources/everkinetic/images/0001-a.png");
  });

  it("an added row that repeats the library exactly is reported", () => {
    const rows = sourceRows([wger([{ sid: "1", name: "a", decision: "include", row: row("Bench Press (Dumbbell)"), license: "CC0-1.0", license_author: "a" }])], []);
    expect(exactRepeats(rows, [{ id: "fedb-x", name_en: "Dumbbell Bench Press", equipment: "dumbbell" }])).toEqual(["wger-1 (Bench Press (Dumbbell)) repeats fedb-x"]);
  });
});

describe("region SQL and checks", () => {
  const t = (region: RegionTag["region"], emphasis: RegionTag["emphasis"] = "primary"): RegionTag => ({ region, emphasis, evidence: "strong", note: "rule" });

  it("writes only when a value differs and removes tags the rules no longer give", () => {
    const sql = regionsSql(new Map([["a", [t("chest_mid")]], ["b", []]]));
    expect(sql).toEqual([
      "INSERT INTO exercise_regions (exercise_id, region_key, emphasis, evidence, note) VALUES ('a', 'chest_mid', 'primary', 'strong', 'rule') ON CONFLICT (exercise_id, region_key) DO UPDATE SET emphasis = excluded.emphasis, evidence = excluded.evidence, note = excluded.note WHERE exercise_regions.emphasis IS NOT excluded.emphasis OR exercise_regions.evidence IS NOT excluded.evidence OR exercise_regions.note IS NOT excluded.note;",
      "DELETE FROM exercise_regions WHERE exercise_id = 'a' AND region_key NOT IN ('chest_mid');",
      "DELETE FROM exercise_regions WHERE exercise_id = 'b';",
    ]);
  });

  it("checks: untagged counted exercises (forearm work included) and two primary regions of one muscle", () => {
    const rows = [
      { id: "a", name_en: "A", muscle_primary: "chest", category: "strength" },
      { id: "b", name_en: "Wrist Curl", muscle_primary: "forearms", category: "strength" },
      { id: "c", name_en: "C", muscle_primary: "chest", category: "strength" },
      { id: "d", name_en: "Stretch", muscle_primary: "chest", category: "stretching" },
    ];
    const c = regionChecks(rows, new Map([["c", [t("chest_upper"), t("chest_mid")]]]));
    expect(c.untagged.map((x) => x.id)).toEqual(["a", "b"]);
    expect(c.doublePrimary).toEqual(["c (C): 2 primary chest regions"]);
  });
});

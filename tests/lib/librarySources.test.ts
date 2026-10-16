import { describe, expect, it } from "vitest";
import {
  SOURCES,
  dedupeKey,
  keyTokens,
  nameTokens,
  parseLiftosaur,
  readEverkinetic,
  readExercemus,
  readExerciseDb,
  readLiftosaur,
  readWger,
  screenSources,
  similarity,
  sourceExerciseId,
  type SourceRecord,
} from "../../worker/lib/librarySources";

// SPEC-v11 M14 A1/A2: the source readers (pinned commits, facts mapped onto our keys), name normalisation for
// de-duplication, and the screening (automatic exclusions, exact duplicates, candidates with their closest match).

describe("names", () => {
  it("unifies DB/dumbbell, BB/barbell, push-ups, flyes, plurals and word order", () => {
    expect(nameTokens("DB Incline Flyes")).toEqual(["dumbbell", "incline", "fly"]);
    expect(nameTokens("Push-Ups")).toEqual(["pushup"]);
    expect(nameTokens("Standing Calf Raises")).toEqual(["standing", "calf", "raise"]);
    expect(dedupeKey("Bench Press (Barbell)", "barbell")).toBe(dedupeKey("Barbell Bench Press", "barbell"));
    expect(dedupeKey("BB bench press", "barbell")).toBe(dedupeKey("barbell bench press", "barbell"));
    expect(dedupeKey("One-Arm Dumbbell Row", "dumbbell")).toBe(dedupeKey("Single Arm DB Row", "dumbbell"));
  });

  it("keeps the equipment out of the movement words, and apart in the key", () => {
    expect([...keyTokens("Cable Lateral Raise")]).toEqual(["lateral", "raise"]);
    expect(dedupeKey("Lateral Raise", "cable")).not.toBe(dedupeKey("Lateral Raise", "dumbbell"));
  });

  it("keeps a material difference: incline, grip, stance", () => {
    expect(dedupeKey("Incline Bench Press", "barbell")).not.toBe(dedupeKey("Bench Press", "barbell"));
    expect(dedupeKey("Close-Grip Bench Press", "barbell")).not.toBe(dedupeKey("Bench Press", "barbell"));
  });

  it("near: high word overlap, or all but one word", () => {
    expect(similarity(keyTokens("Standing Concentration Curl"), keyTokens("Concentration Curl")).near).toBe(true);
    expect(similarity(keyTokens("Leg Press"), keyTokens("Lat Pulldown")).near).toBe(false);
  });

  it("source ids fit the exercise id rule", () => {
    expect(sourceExerciseId("liftosaur", "benchPress:barbell")).toBe("lift-benchPress-barbell");
    expect(sourceExerciseId("wger", "123")).toBe("wger-123");
    expect(sourceExerciseId("exercisedb", "0001")).toMatch(/^[0-9A-Za-z_-]{1,64}$/);
  });
});

describe("readers", () => {
  it("wger: English name, mapped muscles and equipment, the record's licence and author, licensed non-AI images", () => {
    const [r] = readWger(
      [{ model: "exercises.exercise", pk: 9, fields: { license: 2, license_author: "someone", category: 11, muscles: [4], muscles_secondary: [2, 5], equipment: [3, 8] } }],
      [
        { model: "exercises.translation", pk: 1, fields: { exercise: 9, language: 1, name: "Schrägbankdrücken", license: 2, license_author: "x" } },
        { model: "exercises.translation", pk: 2, fields: { exercise: 9, language: 2, name: "Incline Dumbbell Press", license: 2, license_author: "x" } },
      ],
      [
        { exercise: 9, image: "https://wger.de/media/exercise-images/9/a.png", is_main: true, license: 1, license_author: "artist", is_ai_generated: false },
        { exercise: 9, image: "https://wger.de/media/exercise-images/9/b.png", is_main: false, license: 2, license_author: "", is_ai_generated: true },
      ]
    );
    expect(r).toMatchObject({ source: "wger", sid: "9", name: "Incline Dumbbell Press", equipment: "dumbbell", primary: "chest", category: "strength", license: "CC-BY-SA-4.0", licenseAuthor: "someone" });
    expect(r.secondary).toEqual(["shoulders_front", "triceps"]);
    expect(r.images).toEqual([{ url: "https://wger.de/media/exercise-images/9/a.png", license: "CC-BY-SA-3.0", author: "artist" }]);
  });

  it("wger: cardio category, kettlebell and band as excluded equipment, a machine named in the name", () => {
    const base = (pk: number, category: number, equipment: number[]) => ({ model: "exercises.exercise", pk, fields: { license: 3, license_author: "", category, muscles: [10], muscles_secondary: [], equipment } });
    const tr = (pk: number, name: string) => ({ model: "exercises.translation", pk, fields: { exercise: pk, language: 2, name, license: 3, license_author: "" } });
    const rs = readWger([base(1, 15, []), base(2, 9, [10]), base(3, 9, [])], [tr(1, "Rowing"), tr(2, "Goblet Squat"), tr(3, "Leg Press Machine")]);
    expect(rs.map((r) => [r.category, r.excludedEquipment, r.equipment, r.license])).toEqual([
      ["cardio", false, "bodyweight", "CC0-1.0"],
      ["strength", true, null, "CC0-1.0"],
      ["strength", false, "machine", "CC0-1.0"],
    ]);
  });

  it("everkinetic: CC BY-SA images from the pinned commit", () => {
    const [r] = readEverkinetic([{ id: "0005", title: "Barbell Curl", type: "isolation", primary: ["biceps brachii"], secondary: ["forearm"], equipment: ["barbell"], png: ["png/0005-a.png"] }]);
    expect(r).toMatchObject({ equipment: "barbell", primary: "biceps", secondary: ["forearms"], license: "CC-BY-SA-4.0" });
    expect(r.images[0].url).toBe(`https://raw.githubusercontent.com/everkinetic/data/${SOURCES.everkinetic.sha}/dist/png/0005-a.png`);
  });

  it("ExerciseDB: facts only (no licence, no images), title case, delts by name, cardio's stand-in muscle", () => {
    const rs = readExerciseDb([
      { id: "0001", name: "dumbbell lateral raise", equipment: "dumbbell", target: "delts", secondary_muscles: ["traps"] },
      { id: "0002", name: "run", equipment: "body weight", target: "cardiovascular system", secondary_muscles: ["quadriceps", "calves"] },
      { id: "0003", name: "band pull apart", equipment: "band", target: "upper back", secondary_muscles: [] },
    ]);
    expect(rs[0]).toMatchObject({ name: "Dumbbell Lateral Raise", primary: "shoulders_side", license: null, images: [] });
    expect(rs[1]).toMatchObject({ category: "cardio", primary: "quads" });
    expect(rs[2].excludedEquipment).toBe(true);
  });

  it("Liftosaur: one record per exercise and equipment, the equipment in front of the name", () => {
    const src = `export const allExercisesList: Record<IExerciseId, IExercise> = {
  benchPress: {
    id: "benchPress",
    name: "Bench Press",
    defaultEquipment: "barbell",
  },
};
export const metadata: Record<IExerciseId, IMetaExercises> = {
  benchPress: {
    targetMuscles: ["Pectoralis Major Sternal Head"],
    synergistMuscles: ["Deltoid Anterior", "Triceps Brachii"],
    bodyParts: ["Chest"],
    sortedEquipment: ["barbell", "dumbbell", "band"],
  },
};
export type IExerciseKind = "core";`;
    const rs = readLiftosaur(parseLiftosaur(src));
    expect(rs.map((r) => [r.sid, r.name, r.equipment, r.excludedEquipment])).toEqual([
      ["benchPress:barbell", "Barbell Bench Press", "barbell", false],
      ["benchPress:dumbbell", "Dumbbell Bench Press", "dumbbell", false],
      ["benchPress:band", "Band Bench Press", null, true],
    ]);
    expect(rs[0]).toMatchObject({ primary: "chest", secondary: ["shoulders_front", "triceps"] });
  });

  it("exercemus: its category, a slug for an id", () => {
    const [r] = readExercemus({ exercises: [{ name: "Box Jump", category: "plyometrics", equipment: ["none"], primary_muscles: ["quads"], secondary_muscles: [] }] });
    expect(r).toMatchObject({ sid: "box-jump", category: "plyometrics", equipment: "bodyweight" });
  });
});

describe("screening", () => {
  const rec = (source: SourceRecord["source"], sid: string, name: string, extra: Partial<SourceRecord> = {}): SourceRecord => ({
    source,
    sid,
    name,
    equipment: "barbell",
    equipmentFrom: "barbell",
    excludedEquipment: false,
    category: "strength",
    primary: "chest",
    secondary: [],
    license: null,
    licenseAuthor: null,
    images: [],
    ...extra,
  });
  const library = [{ id: "fedb-Barbell_Bench_Press", name_en: "Barbell Bench Press - Medium Grip", equipment: "barbell" as const }, { id: "bench", name_en: "Barbell Bench Press", equipment: "barbell" as const }];

  it("automatic exclusions, then exact duplicates, then candidates with their closest match", () => {
    const out = screenSources(
      [
        rec("exercisedb", "2", "barbell bench press"),
        rec("wger", "1", "Box Jump", { category: "plyometrics" }),
        rec("wger", "3", "Kettlebell Press", { excludedEquipment: true }),
        rec("wger", "4", "Jalón abierto", { equipment: "cable" }),
        rec("wger", "5", "Mystery", { primary: null }),
        rec("wger", "6", "Mystery Stretch", { primary: null, category: "stretching" }),
        rec("wger", "7", "Thing", { equipment: null }),
        rec("wger", "8", "Paused Barbell Bench Press"),
        rec("everkinetic", "9", "Barbell Bench Press (Paused)"),
      ],
      library
    );
    expect(out.map((x) => [x.source, x.sid, x.kind, x.match?.id ?? null])).toEqual([
      ["wger", "1", "category", null],
      ["wger", "3", "equipment", null],
      ["wger", "4", "language", null],
      ["wger", "5", "no_muscle", null],
      ["wger", "6", "candidate", null],
      ["wger", "7", "no_equipment", null],
      ["wger", "8", "candidate", "bench"],
      ["everkinetic", "9", "duplicate", "wger-8"],
      ["exercisedb", "2", "duplicate", "bench"],
    ]);
  });
});

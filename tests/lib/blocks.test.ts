import { describe, expect, it } from "vitest";
import {
  BLOCK_LETTERS,
  EQUIPMENT_MIX,
  EQUIPMENT_ROLES,
  MIX_FAMILIES,
  blockLetter,
  blockMix,
  checkPlan,
  directRegionSets,
  directTarget,
  equipKind,
  mixFamilyOf,
  nextBlock,
  programVolume,
  regionCoverage,
  type Plan,
  type PlanExercise,
} from "../../worker/lib/generator";
import { CANONICAL_MUSCLES } from "../../worker/lib/muscles";
import { REGIONS } from "../../worker/lib/regions";
import { currentProgram, libraryExercises } from "../fixtures/generator/pool";

// SPEC-v11 Phase B (approved 2026-10-17): blocks A → B → C, the equipment table, forearm and neck direct targets, and
// the plan check's region coverage, same region + equipment rule and direct sets.

const exercises = libraryExercises();
const exMap = new Map(exercises.map((e) => [e.id, e]));
const byName = (name: string) => exercises.find((e) => e.name_en === name)!;

describe("blocks", () => {
  it("the seed program is block A; each new program the next block, in the order A → B → C → A", () => {
    expect([1, 2, 3, 4, 5, 6].map(blockLetter)).toEqual(["A", "B", "C", "A", "B", "C"]);
    expect(nextBlock(null)).toBe(2);
    expect(nextBlock({ block: undefined })).toBe(2);
    expect(nextBlock({ block: 3 })).toBe(4);
    expect(BLOCK_LETTERS).toEqual(["A", "B", "C"]);
  });

  it("the approved equipment order per muscle", () => {
    expect([1, 2, 3].map((b) => blockMix("chest", b))).toEqual([["barbell", "cable"], ["dumbbell", "cable"], ["barbell", "dumbbell", "cable"]]);
    expect([1, 2, 3].map((b) => blockMix("side_delts", b))).toEqual([["dumbbell", "cable"], ["cable", "machine"], ["dumbbell", "machine"]]);
    expect([1, 2, 3].map((b) => blockMix("quads", b))).toEqual([["barbell", "machine"], ["dumbbell", "machine"], ["barbell", "dumbbell", "machine"]]);
    expect([1, 2, 3].map((b) => blockMix("traps", b))).toEqual([["barbell"], ["dumbbell"], ["cable"]]);
    expect([1, 2, 3].map((b) => blockMix("neck", b))).toEqual([["plate", "bodyweight"], ["plate", "isometric"], ["plate", "bodyweight"]]);
    expect(blockMix("calves", 4)).toEqual(["machine"]);
    // Every row has a role for each equipment it uses; growth is never a barbell's role.
    for (const f of MIX_FAMILIES) {
      for (const k of new Set(EQUIPMENT_MIX[f].flat())) expect(EQUIPMENT_ROLES[f][k], `${f} ${k}`).toBeTruthy();
      expect(Object.values(EQUIPMENT_ROLES[f]).join(" ")).not.toMatch(/growth|hypertroph/i);
    }
  });

  it("every muscle with regions has a table row; neck work tells a plate from bodyweight and isometric holds", () => {
    for (const m of CANONICAL_MUSCLES) expect(mixFamilyOf(m), m).not.toBeNull();
    expect(equipKind(byName("Lying Face Down Plate Neck Resistance"))).toBe("plate");
    expect(equipKind(byName("Isometric Neck Extension (Hand Resistance)"))).toBe("isometric");
    expect(equipKind(byName("Lying Neck Flexion"))).toBe("bodyweight");
    expect(equipKind(byName("Barbell Bench Press"))).toBe("barbell");
  });

  it("forearms start at 4 direct sets (2 + 2) and neck at 2 (1 + 1); each block adds 1, up to 8 and 6", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((b) => directTarget("forearms", b))).toEqual([0, 4, 5, 6, 7, 8, 8, 8]);
    expect([1, 2, 3, 4, 5, 6, 7].map((b) => directTarget("neck", b))).toEqual([0, 2, 3, 4, 5, 6, 6]);
    expect(directRegionSets("forearms", 2)).toEqual([["forearm_flexors", 2], ["forearm_extensors", 2]]);
    expect(directRegionSets("forearms", 3)).toEqual([["forearm_flexors", 3], ["forearm_extensors", 2]]);
    expect(directRegionSets("neck", 2)).toEqual([["neck_flexors", 1], ["neck_extensors", 1]]);
    expect(directRegionSets("neck", 3)).toEqual([["neck_flexors", 1], ["neck_extensors", 2]]);
  });
});

describe("plan check, Phase B", () => {
  const { current } = currentProgram();
  const targets = programVolume(current, exMap);
  const x = (exercise_id: string, slot: PlanExercise["slot"] = "isolation", sets = 2): PlanExercise => ({
    exercise_id,
    slot,
    sets,
    reps_min: 10,
    reps_max: 15,
    rest_sec: 75,
    target_rir_min: 0,
    target_rir_max: 2,
    per_leg: false,
    is_time: false,
    superset_tag: null,
    set_range: [1, 3],
  });
  const plan = (days: PlanExercise[][]): Plan => ({ style: "full_body", days_per_week: days.length, session_minutes: 90, days: days.map((exercises, i) => ({ name_en: `D${i + 1}`, kind: "full", offset: i * 3, exercises })) });

  it("coverage lists every region with its main-focus exercises, and warns about the missing ones", () => {
    const p = plan([[x("bench", "main", 4), x("fly")]]);
    const cov = regionCoverage(p.days, exMap);
    expect(cov.map((c) => c.region)).toEqual([...REGIONS]);
    expect(cov.find((c) => c.region === "chest_mid")!.exercises).toEqual(["bench", "fly"]);
    const w = checkPlan(p, exMap, targets).warnings.find((i) => i.code === "coverage")!;
    expect(w.message).toMatch(/^No main-focus exercise this block for: Upper chest, Lower chest, /);
  });

  it("two exercises with the same main-focus region and equipment in a day is advice; on two days it is fine", () => {
    const fly = byName("Cable Chest Fly").id;
    const crossover = exercises.find((e) => e.equipment === "cable" && e.id !== fly && e.regions.some((r) => r.region === "chest_mid" && r.emphasis === "primary"))!;
    const same = checkPlan(plan([[x(fly), x(crossover.id)]]), exMap, targets).warnings.filter((i) => i.code === "region_equipment");
    expect(same.map((i) => i.message)).toEqual([`D1: Cable Chest Fly and ${crossover.name_en} both train middle chest with the cable.`]);
    expect(checkPlan(plan([[x(fly)], [x(crossover.id)]]), exMap, targets).warnings.filter((i) => i.code === "region_equipment")).toEqual([]);
  });

  it("forearm and neck direct sets against the block's target (only for programs with a block)", () => {
    const wrist = byName("Palms-Up Barbell Wrist Curl Over A Bench").id;
    const neck = byName("Lying Neck Extension").id;
    const p = plan([[x(wrist, "isolation", 3), x(neck, "isolation", 1)]]);
    expect(checkPlan(p, exMap, targets).direct).toEqual([]);
    const r = checkPlan(p, exMap, targets, { block: 2 });
    expect(r.direct).toEqual([
      { group: "forearms", target: 4, planned: 3 },
      { group: "neck", target: 2, planned: 1 },
    ]);
    expect(r.warnings.filter((i) => i.code === "direct_under").map((i) => i.message)).toEqual(["Forearms: 3 of 4 direct sets.", "Neck: 1 of 2 direct sets."]);
  });
});

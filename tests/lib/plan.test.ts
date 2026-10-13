import { describe, expect, it } from "vitest";
import {
  ADD_DEFAULTS,
  addItem,
  canGroup,
  groupItems,
  groupLabels,
  isEdited,
  itemAsDayExercise,
  liveItems,
  moveBlock,
  moveGroup,
  moveInGroup,
  moveItem,
  planBlocks,
  planFromDay,
  planMinutes,
  planSeconds,
  removeItem,
  replaceItem,
  restAfterGroupSet,
  setGroupRest,
  ungroup,
  updateItem,
  type SessionPlan,
} from "../../worker/lib/plan";
import type { DayExercise, ProgramDay } from "../../worker/lib/types";

// SPEC-v3 M9c: the session planner's pure plan operations.
const de = (exercise_id: string, position: number, sets: number, reps: number, rest: number, superset_tag: string | null = null, is_main = false): DayExercise => ({
  id: `D1_${position}`,
  exercise_id,
  position,
  sets,
  reps_min: reps,
  reps_max: reps,
  per_leg: false,
  is_time: false,
  rest_sec: rest,
  superset_tag,
  is_main,
  target_rir_min: null,
  target_rir_max: null,
  slot: null,
});

// The seed program's Day 1.
const DAY: ProgramDay = {
  id: "D1",
  program_id: "fullbody4",
  position: 1,
  name_fa: "",
  name_en: "Day 1 · Chest",
  focus_fa: "",
  est_minutes: 60,
  exercises: [
    de("bench", 1, 4, 5, 180, null, true),
    de("incline_db", 2, 3, 10, 120),
    de("rdl", 3, 3, 8, 150),
    de("cable_row", 4, 3, 10, 90),
    de("lateral", 5, 3, 12, 75, "A1"),
    de("facepull", 6, 3, 15, 75, "A2"),
  ],
};

const T0 = "2026-10-13T10:00:00.000Z";
const T1 = "2026-10-13T10:05:00.000Z";
const ids = () => {
  let n = 0;
  return () => `I${n++}`;
};
const fresh = () => planFromDay(DAY, "P1", T0, ids());
const order = (p: SessionPlan) => liveItems(p).map((it) => it.exercise_id);
const labels = (p: SessionPlan) => liveItems(p).map((it) => groupLabels(p).get(it.id) ?? "");

describe("a plan from a program day", () => {
  it("copies the day: exercises, order, sets, reps, rest; its supersets become groups", () => {
    const p = fresh();
    expect(p).toMatchObject({ id: "P1", program_day_id: "D1", status: "planned", started_at: null });
    expect(order(p)).toEqual(["bench", "incline_db", "rdl", "cable_row", "lateral", "facepull"]);
    expect(liveItems(p)[0]).toMatchObject({ sets: 4, reps_min: 5, reps_max: 5, rest_sec: 180, origin: "program", position: 0 });
    expect(labels(p)).toEqual(["", "", "", "", "A1", "A2"]);
    // The round rest defaults to the longest planned rest of the members.
    expect(liveItems(p)[4].group_rest_sec).toBe(75);
    expect(isEdited(p, DAY)).toBe(false);
  });
});

describe("planner edits", () => {
  it("replace keeps the slot's sets, reps and rest; replacing back restores the program exercise", () => {
    let p = replaceItem(fresh(), "I1", "incline_bb", T1);
    expect(liveItems(p)[1]).toMatchObject({ exercise_id: "incline_bb", sets: 3, reps_min: 10, rest_sec: 120, origin: "replaced", replaced_exercise_id: "incline_db", updated_at: T1 });
    p = replaceItem(p, "I1", "machine_press", T1);
    expect(liveItems(p)[1]).toMatchObject({ origin: "replaced", replaced_exercise_id: "incline_db" });
    p = replaceItem(p, "I1", "incline_db", T1);
    expect(liveItems(p)[1]).toMatchObject({ origin: "program", replaced_exercise_id: null });
    expect(isEdited(p, DAY)).toBe(false);
  });

  it("an exercise appears once: adding or replacing with one already in the plan changes nothing", () => {
    const p = fresh();
    expect(addItem(p, "bench", T1, "N1")).toBe(p);
    expect(replaceItem(p, "I1", "rdl", T1)).toBe(p);
  });

  it("add appends with the defaults (3 × 8–12, 90 s, no RIR target)", () => {
    const p = addItem(fresh(), "dips", T1, "N1");
    const last = liveItems(p).at(-1)!;
    expect(last).toMatchObject({ id: "N1", exercise_id: "dips", position: 6, sets: 3, reps_min: 8, reps_max: 12, rest_sec: 90, target_rir_min: null, origin: "added" });
    expect(ADD_DEFAULTS).toEqual({ sets: 3, reps_min: 8, reps_max: 12, rest_sec: 90 });
    expect(isEdited(p, DAY)).toBe(true);
  });

  it("delete is soft: the item keeps removed_at; a group left with one member dissolves", () => {
    const p = removeItem(fresh(), "I5", T1);
    expect(order(p)).toEqual(["bench", "incline_db", "rdl", "cable_row", "lateral"]);
    expect(p.items.find((it) => it.id === "I5")).toMatchObject({ removed_at: T1 });
    expect(p.items).toHaveLength(6);
    expect(labels(p)).toEqual(["", "", "", "", ""]);
  });

  it("edits sets, reps and rest; sets stay within 1–10", () => {
    let p = updateItem(fresh(), "I0", { sets: 5, reps_min: 3, reps_max: 3, rest_sec: 240 }, T1);
    expect(liveItems(p)[0]).toMatchObject({ sets: 5, reps_min: 3, reps_max: 3, rest_sec: 240, updated_at: T1 });
    expect(updateItem(p, "I0", { sets: 0 }, T1)).toBe(p);
    expect(updateItem(p, "I0", { sets: 11 }, T1)).toBe(p);
    p = updateItem(p, "I0", { reps_min: 6 }, T1);
    expect(liveItems(p)[0]).toMatchObject({ reps_min: 6, reps_max: 6 });
  });
});

describe("reordering", () => {
  it("an item alone moves past a whole group", () => {
    const p = moveItem(fresh(), "I3", 1, T1);
    expect(order(p)).toEqual(["bench", "incline_db", "rdl", "lateral", "facepull", "cable_row"]);
    expect(labels(p)).toEqual(["", "", "", "A1", "A2", ""]);
  });

  it("inside a group an item swaps with its neighbour and never leaves the group", () => {
    let p = moveItem(fresh(), "I5", -1, T1);
    expect(order(p).slice(4)).toEqual(["facepull", "lateral"]);
    expect(labels(p).slice(4)).toEqual(["A1", "A2"]);
    // The last member cannot move down out of its group.
    expect(moveItem(p, "I4", 1, T1)).toBe(p);
    p = moveInGroup(p, "I5", 1, T1);
    expect(order(p).slice(4)).toEqual(["lateral", "facepull"]);
  });

  it("a group moves as a whole; blocks move by drag index", () => {
    let p = moveGroup(fresh(), "A", -1, T1);
    expect(order(p)).toEqual(["bench", "incline_db", "rdl", "lateral", "facepull", "cable_row"]);
    p = moveBlock(fresh(), 0, 2, T1);
    expect(order(p)).toEqual(["incline_db", "rdl", "bench", "cable_row", "lateral", "facepull"]);
    expect(planBlocks(p).map((b) => b.items.length)).toEqual([1, 1, 1, 1, 2]);
  });
});

describe("groups (supersets and tri-sets)", () => {
  it("groups any 2–3 ungrouped items, same muscle included, as A/B by order, with no warning", () => {
    // A chest-only tri-set: bench, incline press and a third chest exercise.
    let p = addItem(fresh(), "cable_fly", T1, "N1");
    expect(canGroup(p, ["I0", "I1", "N1"])).toBe(true);
    p = groupItems(p, ["I0", "I1", "N1"], T1);
    expect(order(p)).toEqual(["bench", "incline_db", "cable_fly", "rdl", "cable_row", "lateral", "facepull"]);
    expect(labels(p)).toEqual(["A1", "A2", "A3", "", "", "B1", "B2"]);
    // Rest after the round: the longest member rest.
    expect(liveItems(p)[0].group_rest_sec).toBe(180);
    p = setGroupRest(p, "A", 120, T1);
    expect(liveItems(p).slice(0, 3).map((it) => it.group_rest_sec)).toEqual([120, 120, 120]);
  });

  it("refuses 1 or 4 items and items already grouped", () => {
    const p = fresh();
    expect(canGroup(p, ["I0"])).toBe(false);
    expect(canGroup(p, ["I0", "I1", "I2", "I3"])).toBe(false);
    expect(canGroup(p, ["I0", "I4"])).toBe(false);
    expect(groupItems(p, ["I0", "I4"], T1)).toBe(p);
  });

  it("ungroup keeps the order and drops the labels", () => {
    const g = groupItems(fresh(), ["I0", "I2"], T1);
    expect(order(g)).toEqual(["bench", "rdl", "incline_db", "cable_row", "lateral", "facepull"]);
    const u = ungroup(g, "A", T1);
    expect(order(u)).toEqual(order(g));
    expect(labels(u)).toEqual(["", "", "", "", "A1", "A2"]);
  });
});

describe("time estimate (SPEC-v2 §8.4 rule: rest + 40 s per set; groups rest once per round)", () => {
  it("an unedited plan shows its day's estimate; edits move it by their seconds", () => {
    expect(planMinutes(fresh(), DAY)).toBe(60);
    // + dips, 3 × (90 s + 40 s) = 390 s.
    expect(planMinutes(addItem(fresh(), "dips", T1, "N1"), DAY)).toBe(67);
    // − RDL, 3 × (150 s + 40 s) = 570 s.
    expect(planMinutes(removeItem(fresh(), "I2", T1), DAY)).toBe(51);
    // + one set of cable row, 90 s + 40 s.
    expect(planMinutes(updateItem(fresh(), "I3", { sets: 4 }, T1), DAY)).toBe(62);
  });

  it("a group rests once per round; a longer member's extra sets rest on their own", () => {
    // The day's own superset: 3 rounds of 2 × 40 s + 75 s.
    expect(planSeconds({ items: liveItems(fresh()).slice(4) })).toBe(3 * (80 + 75));
    // Chest tri-set: bench 4 sets (180 s), incline 3 (120 s), fly 3 (90 s); round rest 180 s.
    let p = addItem(fresh(), "cable_fly", T1, "N1");
    const apart = planSeconds(p);
    p = groupItems(p, ["I0", "I1", "N1"], T1);
    // Before: 4 × 220 + 3 × 160 + 3 × 130 = 1750 s. After: 3 rounds × (3 × 40 + 180) + bench's 4th set alone (180 + 40).
    expect(apart - planSeconds(p)).toBe(1750 - (3 * 300 + 220));
    expect(planMinutes(p, DAY)).toBe(Math.round(60 + (planSeconds(p) - planSeconds(fresh())) / 60));
    // A shorter round rest saves time too.
    expect(planSeconds(setGroupRest(p, "A", 120, T1))).toBe(planSeconds(p) - 3 * 60);
  });
});

describe("in the session", () => {
  it("a plan item reads as a day exercise; Main stays on the program slot", () => {
    const p = replaceItem(fresh(), "I0", "db_bench", T1);
    const it = liveItems(p)[0];
    expect(itemAsDayExercise(it, null, DAY.exercises[0])).toMatchObject({ exercise_id: "db_bench", sets: 4, reps_max: 5, rest_sec: 180, is_main: true, superset_tag: null });
    const added = liveItems(addItem(p, "dips", T1, "N1")).at(-1)!;
    expect(itemAsDayExercise(added, "B1")).toMatchObject({ reps_min: 8, reps_max: 12, rest_sec: 90, is_main: false, superset_tag: "B1" });
  });

  it("rest inside a round: none; after the round's last set: the group rest; extra sets alone: their own rest", () => {
    // A1 set 1 done, A2 set 1 not yet: no timer.
    expect(restAfterGroupSet([[true, false, false], [false, false, false]], 0, 120, 75)).toBeNull();
    // A2 set 1 done too: the round is complete.
    expect(restAfterGroupSet([[true, false, false], [true, false, false]], 0, 120, 75)).toBe(120);
    // A tri-set waits for A3.
    expect(restAfterGroupSet([[true], [true], [false]], 0, 150, 90)).toBeNull();
    expect(restAfterGroupSet([[true], [true], [true]], 0, 150, 90)).toBe(150);
    // A1 has a 4th set the others don't: done alone, with its own rest.
    expect(restAfterGroupSet([[true, true, true, true], [true, true, true]], 3, 120, 90)).toBe(90);
  });
});

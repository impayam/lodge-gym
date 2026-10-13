import { describe, expect, it } from "vitest";
import { addItem, groupItems, liveItems, moveItem, planFromDay, removeItem, replaceItem, seqIds, ungroup, type SessionPlan } from "../../worker/lib/plan";
import { DEFAULT_SETTINGS, type DayExercise, type Exercise, type ProgramDay, type SetEntry, type WorkoutSession } from "../../worker/lib/types";
import { openPlanFor, planForSession, plannedLabel, sessionBlocks, sessionFromPlan, sessionPlan } from "../../web/src/model";
import type { BootData } from "../../web/src/localdb";

// SPEC-v3 M9c in the PWA: a plan becomes the session, and the session's cards, order, groups and targets follow it.
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

const ex = (id: string): Exercise =>
  ({ id, name_en: id, name_fa: "", muscle_primary: "chest", is_lower: false, equipment: "barbell", cue_fa: "", cue_en: null }) as unknown as Exercise;
const IDS = ["bench", "incline_db", "incline_bb", "rdl", "cable_row", "lateral", "facepull", "dips", "cable_fly"];
const exMap = new Map(IDS.map((id) => [id, ex(id)]));

const boot = {
  settings: DEFAULT_SETTINGS,
  program: { id: "fullbody4", name: "", days: [DAY] },
  other_days: [],
  programs: [],
  exercises: IDS.map(ex),
  watch: [],
  body: [],
  review: null,
} as unknown as BootData;

const T0 = "2026-10-13T10:00:00.000Z";
const T1 = "2026-10-13T10:05:00.000Z";
const fresh = (): SessionPlan => planFromDay(DAY, "P1", T0, seqIds("P1"));
const set = (exercise_id: string, set_index: number, done = false, extra = false): SetEntry => ({
  id: `${exercise_id}-${set_index}`,
  exercise_id,
  set_index,
  weight: 100,
  reps: 8,
  seconds: null,
  done,
  updated_at: T0,
  ...(extra ? { is_extra: true, position: 0 } : {}),
});
const session = (id: string, sets: SetEntry[]): WorkoutSession => ({
  id,
  program_day_id: "D1",
  local_date: "2026-10-13",
  started_at: T0,
  ended_at: null,
  status: "active",
  unit: "lb",
  note: "",
  created_at: T0,
  updated_at: T0,
  source: "app",
  sets,
});

describe("plan → start", () => {
  it("the session keeps the plan's id, order and set counts; the cards show the plan's sets, reps and rest", () => {
    let p = replaceItem(fresh(), "P1-2", "incline_bb", T1);
    p = removeItem(p, "P1-3", T1);
    p = moveItem(p, "P1-4", -1, T1);
    p = { ...p, status: "started", started_at: T1 };
    const s = sessionFromPlan(boot, p, "2026-10-14", T1);
    expect(s).toMatchObject({ id: "P1", program_day_id: "D1", local_date: "2026-10-14", started_at: T1, status: "active" });
    const order = ["bench", "cable_row", "incline_bb", "lateral", "facepull"];
    expect([...new Set(s.sets.map((x) => x.exercise_id))]).toEqual(order);
    expect(s.sets.filter((x) => x.exercise_id === "bench")).toHaveLength(4);
    const blocks = sessionBlocks(boot, s, exMap, p);
    expect(blocks.map((b) => b.ex.id)).toEqual(order);
    // The replacement keeps the slot's targets; Main stays on the bench slot.
    expect(blocks[2].plan).toMatchObject({ exercise_id: "incline_bb", sets: 3, reps_max: 10, rest_sec: 120, is_main: false });
    expect(blocks[0].plan).toMatchObject({ is_main: true, sets: 4, reps_max: 5 });
    expect(blocks.map((b) => b.plan.superset_tag)).toEqual([null, null, null, "A1", "A2"]);
    expect(blocks[3].group).toEqual({ tag: "A", index: 0, size: 2, rest: 75 });
    expect(sessionPlan({ P1: p }, "P1")).toBe(p);
  });

  it("exercises added during the session follow the plan's exercises", () => {
    const p = { ...fresh(), status: "started" as const, started_at: T0 };
    const s = sessionFromPlan(boot, p, "2026-10-13", T0);
    s.sets.push(set("dips", 0, false, true));
    const blocks = sessionBlocks(boot, s, exMap, p);
    expect(blocks.at(-1)).toMatchObject({ extra: true, itemId: null, group: null });
    expect(blocks.at(-1)!.ex.id).toBe("dips");
  });
});

describe("groups in a session", () => {
  it("the day's own supersets are groups, resting for the longest member rest", () => {
    const s = session("S1", DAY.exercises.flatMap((x) => [set(x.exercise_id, 0)]));
    const blocks = sessionBlocks(boot, s, exMap);
    expect(blocks.map((b) => b.group)).toEqual([null, null, null, null, { tag: "A", index: 0, size: 2, rest: 75 }, { tag: "A", index: 1, size: 2, rest: 75 }]);
  });

  it("a plan's tri-set (three chest exercises) carries its round rest", () => {
    let p = addItem(fresh(), "cable_fly", T1, "N1");
    p = groupItems(p, ["P1-1", "P1-2", "N1"], T1);
    const blocks = sessionBlocks(boot, sessionFromPlan(boot, { ...p, status: "started", started_at: T1 }, "2026-10-13", T1), exMap, p);
    expect(blocks.slice(0, 3).map((b) => [b.ex.id, b.plan.superset_tag, b.group?.size, b.group?.rest])).toEqual([
      ["bench", "A1", 3, 180],
      ["incline_db", "A2", 3, 180],
      ["cable_fly", "A3", 3, 180],
    ]);
    const back = ungroup(p, "A", T1);
    expect(sessionBlocks(boot, sessionFromPlan(boot, back, "2026-10-13", T1), exMap, back).slice(0, 3).map((b) => b.group)).toEqual([null, null, null]);
  });
});

describe("editing a session started without a plan (approved default 7)", () => {
  it("copies the session as a started plan with the session's id: order, groups and extras", () => {
    const s = session("S2", [...DAY.exercises.map((x) => set(x.exercise_id, 0, x.exercise_id === "bench")), set("dips", 0, false, true)]);
    const p = planForSession(boot, s, null, exMap, T1);
    expect(p).toMatchObject({ id: "S2", program_day_id: "D1", status: "started", started_at: T0 });
    expect(liveItems(p).map((it) => [it.exercise_id, it.origin, it.group_tag])).toEqual([
      ["bench", "program", null],
      ["incline_db", "program", null],
      ["rdl", "program", null],
      ["cable_row", "program", null],
      ["lateral", "program", "A"],
      ["facepull", "program", "A"],
      ["dips", "added", null],
    ]);
    expect(liveItems(p).map((it) => it.id)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `S2-${n}`));
    expect(liveItems(p)[0]).toMatchObject({ sets: 4, reps_min: 5, reps_max: 5, rest_sec: 180 });
    // The same session renders the same way through its new plan.
    expect(sessionBlocks(boot, s, exMap, p).map((b) => b.ex.id)).toEqual(sessionBlocks(boot, s, exMap).map((b) => b.ex.id));
    // An exercise added after the plan was made joins it at the end.
    s.sets.push(set("cable_fly", 0, false, true));
    expect(liveItems(planForSession(boot, s, p, exMap, T1)).at(-1)).toMatchObject({ exercise_id: "cable_fly", origin: "added" });
  });
});

describe("home", () => {
  it("shows the open plan of a day, marked edited when it differs from the day", () => {
    const p = fresh();
    expect(openPlanFor({ P1: p }, "D1")).toBe(p);
    expect(openPlanFor({ P1: { ...p, status: "discarded" } }, "D1")).toBeNull();
    expect(plannedLabel(boot, p)).toBe("Planned: Day 1 · Chest");
    expect(plannedLabel(boot, removeItem(p, "P1-3", T1))).toBe("Planned: Day 1 · Chest (edited)");
    expect(plannedLabel(boot, removeItem(p, "P1-3", T1), false)).toBe("Planned (edited)");
  });
});

import { describe, expect, it } from "vitest";
import type { DayExercise, Exercise, SetEntry, WorkoutSession } from "../../worker/lib/types";
import { dayTitle, liftLabel } from "../../web/src/lib/lifts";
import { nextRows, topSetText } from "../../web/src/lib/next";
import { e1rmPoints, hasRecord, topLift } from "../../web/src/lib/records";

// SPEC-v8 §6.01 Home and §6.04 session cards: numbers come from the app's own rules (progression, Epley best set).
let n = 0;
const set = (exercise_id: string, weight: number | null, reps: number | null, extra: Partial<SetEntry> = {}): SetEntry => ({
  id: `s${n++}`,
  exercise_id,
  set_index: n,
  weight,
  reps,
  seconds: null,
  done: true,
  rir: 1,
  updated_at: "2026-10-01T00:00:00.000Z",
  ...extra,
});
const session = (id: string, date: string, sets: SetEntry[], unit: "lb" | "kg" = "lb"): WorkoutSession => ({
  id,
  program_day_id: "D2",
  local_date: date,
  started_at: `${date}T18:00:00.000Z`,
  ended_at: `${date}T19:00:00.000Z`,
  status: "done",
  unit,
  note: "",
  created_at: `${date}T18:00:00.000Z`,
  updated_at: `${date}T19:00:00.000Z`,
  source: "app",
  sets,
});
const slot = (exercise_id: string, p: Partial<DayExercise> = {}): DayExercise => ({
  id: `p-${exercise_id}`,
  exercise_id,
  position: 0,
  sets: 3,
  reps_min: 5,
  reps_max: 5,
  per_leg: false,
  is_time: false,
  rest_sec: 120,
  superset_tag: null,
  is_main: false,
  target_rir_min: null,
  target_rir_max: null,
  slot: null,
  ...p,
});
const ex = (id: string, name_en: string, equipment: Exercise["equipment"], is_lower: boolean) => ({ id, name_en, equipment, is_lower }) as Exercise;

describe("lift labels", () => {
  it("the big three get short names; everything else keeps its full name", () => {
    expect(liftLabel("bench", "Barbell Bench Press")).toBe("Bench");
    expect(liftLabel("squat", "Barbell Back Squat")).toBe("Squat");
    expect(liftLabel("deadlift", "Conventional Deadlift")).toBe("Deadlift");
    expect(liftLabel("ohp", "Standing Overhead Press")).toBe("Standing Overhead Press");
  });
  it("a day's title drops its Day N prefix", () => {
    expect(dayTitle("Day 2 · Legs")).toBe("Legs");
    expect(dayTitle("Upper A")).toBe("Upper A");
  });
});

describe("next session table", () => {
  const byId = new Map([
    ["squat", ex("squat", "Barbell Back Squat", "barbell", true)],
    ["legpress", ex("legpress", "Leg Press", "machine", true)],
    ["plank", ex("plank", "Plank", "bodyweight", false)],
    ["calf", ex("calf", "Calf Raise", "machine", true)],
  ]);
  const history = [
    session("A", "2026-10-02", [set("squat", 70, 5), set("squat", 70, 5), set("squat", 70, 5), set("legpress", 230, 10), set("legpress", 230, 8), set("legpress", 230, 10), set("plank", null, null, { seconds: 45 })]),
  ];

  it("Last is the top set; Today is the progression weight with the planned reps", () => {
    const rows = nextRows(
      [slot("squat", { position: 1, is_main: true }), slot("legpress", { position: 2, reps_min: 8, reps_max: 10 }), slot("plank", { position: 3, is_time: true, reps_max: 45 }), slot("calf", { position: 4, reps_min: 12, reps_max: 15 })],
      byId,
      history,
      "lb"
    );
    expect(rows.map((r) => [r.name, r.last, r.today])).toEqual([
      // Every set hit 5: lower-body barbell +10 lb.
      ["Barbell Back Squat", "70 × 5", "80 × 5"],
      // A set missed the top of the range: stay.
      ["Leg Press", "230 × 10", "230 × 8–10"],
      // One hold of three planned: same time.
      ["Plank", "45 s", "45 s"],
      // Never done: the planned reps.
      ["Calf Raise", "–", "12–15 reps"],
    ]);
  });

  it("a last set in another unit says so", () => {
    expect(topSetText({ session_id: "x", local_date: "2026-10-01", unit: "kg", sets: [set("squat", 60, 5)] }, false, "lb")).toBe("60 × 5 kg");
  });
});

describe("session cards", () => {
  const a = session("A", "2026-09-28", [set("bench", 130, 5), set("row", 50, 8)]);
  const b = session("B", "2026-10-05", [set("bench", 135, 5), set("row", 50, 8)]);
  const c = session("C", "2026-10-12", [set("bench", 130, 5)]);

  it("a record beats every earlier best e1RM of the same exercise; the first session sets none", () => {
    const all = [a, b, c];
    expect(hasRecord(all, a, "lb")).toBe(false);
    expect(hasRecord(all, b, "lb")).toBe(true);
    expect(hasRecord(all, c, "lb")).toBe(false);
  });

  it("the top lift is the day's main exercise, else the heaviest set", () => {
    expect(topLift(b, [{ exercise_id: "bench", is_main: true }], "lb")).toEqual({ exercise_id: "bench", set: { weight: 135, reps: 5, e1rm: 157.5 } });
    expect(topLift(b, [], "lb")!.exercise_id).toBe("bench");
  });

  it("e1RM points: one per day since the window start, oldest first", () => {
    expect(e1rmPoints([c, a, b], "bench", "lb", "2026-10-01").map((p) => [p.date, p.value])).toEqual([
      ["2026-10-05", 157.5],
      ["2026-10-12", 151.7],
    ]);
  });
});

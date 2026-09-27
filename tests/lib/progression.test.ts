import { describe, expect, it } from "vitest";
import { lastPerformance, stepperIncrement, suggest, weightIncrement, type PerfSession } from "../../worker/lib/progression";
import type { SetEntry } from "../../worker/lib/types";

const set = (i: number, weight: number | null, reps: number | null, done = true, seconds: number | null = null, ex = "bench", rir: number | null = null): SetEntry => ({
  id: `${ex}-${i}-${Math.random()}`,
  exercise_id: ex,
  set_index: i,
  weight,
  reps,
  seconds,
  done,
  rir,
  updated_at: "2026-09-20T18:00:00.000Z",
});
const withRir = (sets: SetEntry[], rirs: (number | null)[]) => sets.map((x, i) => ({ ...x, rir: rirs[i] }));
const perf = (sets: SetEntry[], unit: "lb" | "kg" = "lb") => ({ session_id: "s", local_date: "2026-09-20", unit, sets });

const barbellUpper = { equipment: "barbell" as const, is_lower: false };
const barbellLower = { equipment: "barbell" as const, is_lower: true };
const dumbbellLower = { equipment: "dumbbell" as const, is_lower: true };
const bodyweight = { equipment: "bodyweight" as const, is_lower: false };
const bench = { sets: 4, reps_max: 5, is_time: false };

describe("increments", () => {
  it("matches SPEC §6", () => {
    expect(weightIncrement(barbellUpper, "lb")).toBe(5);
    expect(weightIncrement(barbellUpper, "kg")).toBe(2.5);
    expect(weightIncrement(barbellLower, "lb")).toBe(10);
    expect(weightIncrement(barbellLower, "kg")).toBe(5);
    expect(weightIncrement({ equipment: "machine", is_lower: true }, "lb")).toBe(10);
    expect(weightIncrement({ equipment: "cable", is_lower: false }, "kg")).toBe(2.5);
    expect(weightIncrement(dumbbellLower, "lb")).toBe(5);
    expect(weightIncrement(dumbbellLower, "kg")).toBe(2);
    expect(stepperIncrement(bodyweight, "lb")).toBe(5);
  });
});

describe("suggestion", () => {
  it("adds the increment when every planned set hit the top of the range", () => {
    const r = suggest(bench, barbellUpper, perf([set(0, 135, 5), set(1, 135, 5), set(2, 135, 6), set(3, 135, 5)]));
    expect(r).toEqual({ kind: "weight", allHit: true, easy: false, weight: 140, unit: "lb", lastTop: 135 });
  });
  it("keeps the weight when a set fell short", () => {
    const r = suggest(bench, barbellUpper, perf([set(0, 135, 5), set(1, 135, 5), set(2, 135, 4), set(3, 135, 5)]));
    expect(r).toMatchObject({ kind: "weight", allHit: false, weight: 135 });
  });
  it("keeps the weight when a set was not marked done", () => {
    const r = suggest(bench, barbellUpper, perf([set(0, 135, 5), set(1, 135, 5), set(2, 135, 5), set(3, 135, 5, false)]));
    expect(r).toMatchObject({ allHit: false, weight: 135 });
  });
  it("keeps the weight when fewer sets than planned were logged", () => {
    const r = suggest(bench, barbellUpper, perf([set(0, 135, 5), set(1, 135, 5), set(2, 135, 5)]));
    expect(r).toMatchObject({ allHit: false, weight: 135 });
  });
  it("uses the top weight and the last session's unit", () => {
    const r = suggest({ sets: 3, reps_max: 5, is_time: false }, barbellLower, perf([set(0, 100, 5), set(1, 110, 5), set(2, 105, 5)], "kg"));
    expect(r).toEqual({ kind: "weight", allHit: true, easy: false, weight: 115, unit: "kg", lastTop: 110 });
  });
  it("uses the top of a rep range", () => {
    const plan = { sets: 3, reps_max: 8, is_time: false };
    expect(suggest(plan, bodyweight, perf([set(0, -40, 8), set(1, -40, 8), set(2, -40, 8)]))).toEqual({ kind: "bodyweight", allHit: true, easy: false, weight: -40, unit: "lb" });
    expect(suggest(plan, bodyweight, perf([set(0, -40, 8), set(1, -40, 7), set(2, -40, 6)]))).toMatchObject({ kind: "bodyweight", allHit: false });
  });
  it("adds 15 s to timed exercises", () => {
    const plan = { sets: 3, reps_max: 45, is_time: true };
    const ok = [set(0, null, null, true, 45, "plank"), set(1, null, null, true, 50, "plank"), set(2, null, null, true, 45, "plank")];
    expect(suggest(plan, bodyweight, perf(ok))).toEqual({ kind: "time", allHit: true, easy: false, seconds: 65 });
    const short = [set(0, null, null, true, 45, "plank"), set(1, null, null, true, 30, "plank"), set(2, null, null, true, 45, "plank")];
    expect(suggest(plan, bodyweight, perf(short))).toEqual({ kind: "time", allHit: false, easy: false, seconds: 45 });
  });
  it("returns none without history", () => {
    expect(suggest(bench, barbellUpper, null)).toEqual({ kind: "none" });
  });
});

describe("RIR rules", () => {
  const four = [set(0, 135, 5), set(1, 135, 5), set(2, 135, 5), set(3, 135, 5)];
  it("all sets at top reps with RIR 3+ → double increment", () => {
    expect(suggest(bench, barbellUpper, perf(withRir(four, [3, 3, 3, 3])))).toMatchObject({ allHit: true, easy: true, weight: 145 });
    expect(suggest({ sets: 3, reps_max: 5, is_time: false }, barbellLower, perf(withRir(four.slice(0, 3), [3, 3, 3]), "kg"))).toMatchObject({ easy: true, weight: 145 });
    expect(suggest({ sets: 3, reps_max: 10, is_time: false }, dumbbellLower, perf(withRir([set(0, 40, 10), set(1, 40, 10), set(2, 40, 10)], [3, 3, 3])))).toMatchObject({ weight: 50 });
  });
  it("RIR 3+ on only some sets, or RIR missing → normal increment", () => {
    expect(suggest(bench, barbellUpper, perf(withRir(four, [3, 3, 2, 3])))).toMatchObject({ easy: false, weight: 140 });
    expect(suggest(bench, barbellUpper, perf(withRir(four, [3, 3, null, 3])))).toMatchObject({ easy: false, weight: 140 });
  });
  it("RIR 0 with missed reps → keep weight", () => {
    const missed = withRir([set(0, 135, 5), set(1, 135, 5), set(2, 135, 4), set(3, 135, 3)], [1, 0, 0, 0]);
    expect(suggest(bench, barbellUpper, perf(missed))).toMatchObject({ allHit: false, easy: false, weight: 135 });
  });
  it("RIR 3+ does not help when reps were missed", () => {
    const missed = withRir([set(0, 135, 5), set(1, 135, 5), set(2, 135, 4), set(3, 135, 5)], [3, 3, 3, 3]);
    expect(suggest(bench, barbellUpper, perf(missed))).toMatchObject({ allHit: false, easy: false, weight: 135 });
  });
  it("bodyweight and timed exercises", () => {
    const plan = { sets: 3, reps_max: 8, is_time: false };
    expect(suggest(plan, bodyweight, perf(withRir([set(0, -40, 8), set(1, -40, 8), set(2, -40, 8)], [3, 3, 3])))).toMatchObject({ kind: "bodyweight", easy: true });
    const t = { sets: 3, reps_max: 45, is_time: true };
    const ok = withRir([set(0, null, null, true, 45, "plank"), set(1, null, null, true, 45, "plank"), set(2, null, null, true, 45, "plank")], [3, 3, 3]);
    expect(suggest(t, bodyweight, perf(ok))).toEqual({ kind: "time", allHit: true, easy: true, seconds: 75 });
  });
});

describe("last performance", () => {
  const mk = (id: string, date: string, status: "active" | "done", sets: SetEntry[]): PerfSession => ({
    id,
    local_date: date,
    started_at: `${date}T17:00:00.000Z`,
    status,
    unit: "lb",
    sets,
  });
  it("finds the latest done session with data for the exercise", () => {
    const sessions = [
      mk("a", "2026-09-10", "done", [set(0, 125, 5)]),
      mk("b", "2026-09-15", "done", [set(0, 130, 5)]),
      mk("c", "2026-09-18", "done", [set(0, null, null, false)]),
      mk("d", "2026-09-20", "active", [set(0, 140, 5)]),
    ];
    expect(lastPerformance("bench", sessions)?.session_id).toBe("b");
    expect(lastPerformance("bench", sessions, "b")?.session_id).toBe("a");
    expect(lastPerformance("squat", sessions)).toBeNull();
  });
});

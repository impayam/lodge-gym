import { describe, expect, it } from "vitest";
import { addDays } from "../../worker/lib/time";
import { dueList, dueText, rotationRole, rotationStatus, type RotationInput } from "../../worker/lib/rotation";
import type { DayExercise, Exercise, ProgramVersion, SetEntry, WorkoutSession } from "../../worker/lib/types";

// SPEC-v11 Phase B rotation (approved 2026-10-17): main and secondary lifts keep 6 weeks and change by 8 (between 6
// and 8 when stalled or without a new best in their last 2 weeks); other work keeps 3 and changes by 4 (between 3 and 4
// when stalled). Weeks count from when the exercise entered the program in that role; weeks without training don't.

const ex = (id: string, mechanic: "compound" | "isolation", pattern: Exercise["pattern"]): Exercise =>
  ({ id, name_en: id, mechanic, pattern, muscle_primary: "chest", muscles_secondary: [], equipment: "barbell", category: "strength", archived_at: null, regions: [] }) as unknown as Exercise;
const EX = new Map([ex("bench", "compound", "h_push"), ex("fly", "isolation", "isolation"), ex("row", "compound", "h_pull"), ex("pullup", "compound", "v_pull"), ex("plank", "isolation", "core")].map((e) => [e.id, e]));

const entry = (exercise_id: string, slot: DayExercise["slot"], is_main = slot === "main"): DayExercise =>
  ({ id: `${exercise_id}-e`, exercise_id, position: 1, sets: 3, reps_min: 8, reps_max: 12, per_leg: false, is_time: false, rest_sec: 90, superset_tag: null, is_main, target_rir_min: null, target_rir_max: null, slot }) as DayExercise;

const version = (id: string, exercises: DayExercise[], started: string[]): Pick<ProgramVersion, "id" | "days" | "activations"> => ({
  id,
  days: [{ id: `${id}-d1`, program_id: id, position: 1, name_fa: "", name_en: "Day 1", focus_fa: "", est_minutes: 60, exercises }],
  activations: started.map((s, i) => ({ id: `${id}-a${i}`, program_id: id, started_at: s, ended_at: null })),
});

let n = 0;
/** A done session on `date` with one done set per [exercise, weight, reps]. */
function session(date: string, sets: [string, number | null, number | null, number?][]): WorkoutSession {
  n++;
  return {
    id: `s${n}`,
    program_day_id: "p-d1",
    local_date: date,
    started_at: `${date}T17:00:00.000Z`,
    ended_at: `${date}T18:00:00.000Z`,
    status: "done",
    unit: "lb",
    note: "",
    created_at: `${date}T17:00:00.000Z`,
    updated_at: `${date}T18:00:00.000Z`,
    source: "app",
    sets: sets.map(([exercise_id, weight, reps, seconds], i): SetEntry => ({ id: `s${n}-${i}`, exercise_id, set_index: i, weight, reps, seconds: seconds ?? null, done: true, rir: null, updated_at: `${date}T17:10:00.000Z` })),
  };
}

/** Mondays from 2026-08-03 (week_start mon). */
const week = (i: number, day = 0) => addDays("2026-08-03", i * 7 + day);

function input(programs: Pick<ProgramVersion, "id" | "days" | "activations">[], sessions: WorkoutSession[], today = "2026-10-17"): RotationInput {
  const active = programs.at(-1)!;
  return { program: active, programs, sessions, exercises: EX, today, weekStart: "mon", unit: "lb", localDateOf: (iso) => iso.slice(0, 10) };
}
const of = (list: ReturnType<typeof rotationStatus>, id: string) => list.find((s) => s.exercise_id === id)!;

describe("roles", () => {
  it("slots decide; on the seed program a main lift and other compound lifts follow the main-lift rule", () => {
    expect(rotationRole(entry("bench", "secondary"), EX.get("bench"))).toBe("main");
    expect(rotationRole(entry("row", "accessory"), EX.get("row"))).toBe("other");
    expect(rotationRole(entry("bench", null, false), EX.get("bench"))).toBe("main");
    expect(rotationRole(entry("fly", null, false), EX.get("fly"))).toBe("other");
    expect(rotationRole(entry("plank", null, false), EX.get("plank"))).toBe("other");
  });
});

describe("weeks in the program", () => {
  it("count weeks with training, across versions that kept the exercise in the same role; a role change starts again", () => {
    const sessions = [0, 1, 2, 4, 5, 6, 7].map((w) => session(week(w), [["bench", 135 + w * 5, 5], ["fly", 30, 12], ["row", 100, 10]]));
    const a = version("a", [entry("bench", "main"), entry("fly", "isolation"), entry("row", "accessory")], ["2026-08-01T10:00:00.000Z"]);
    // Week 3 has no training; the program changes in week 5: bench and fly stay in their roles, row becomes a secondary.
    const b = version("b", [entry("bench", "main"), entry("fly", "isolation"), entry("row", "secondary")], ["2026-09-03T10:00:00.000Z"]);
    const list = rotationStatus(input([a, b], sessions));
    expect(of(list, "bench")).toMatchObject({ role: "main", weeks: 7, since: "2026-08-01" });
    expect(of(list, "fly")).toMatchObject({ role: "other", weeks: 7, due: true, reason: "max" });
    // Row: only the weeks since it became a secondary (weeks 5, 6, 7).
    expect(of(list, "row")).toMatchObject({ role: "main", weeks: 3, since: "2026-09-03", due: false });
  });

  it("a week counts when he trained at all, also without this exercise; sessions after today and open sessions do not", () => {
    const sessions = [session(week(0), [["bench", 135, 5]]), session(week(1), [["fly", 30, 12]]), session(week(2), [["bench", 140, 5]]), { ...session(week(3), [["bench", 145, 5]]), status: "active" as const }, session("2026-10-30", [["bench", 150, 5]])];
    const list = rotationStatus(input([version("a", [entry("bench", "main"), entry("fly", "isolation")], ["2026-08-01T10:00:00.000Z"])], sessions));
    expect(of(list, "bench").weeks).toBe(3);
  });
});

describe("due rules", () => {
  const prog = (started = "2026-07-01T10:00:00.000Z") => [version("a", [entry("bench", "main"), entry("fly", "isolation")], [started])];

  it("main lift: kept until 6 weeks; at 6–7 due without a new best in its last 2 weeks or when stalled; always by 8", () => {
    // Rising every week: never stalled, always a new best.
    const rising = (weeks: number) => Array.from({ length: weeks }, (_, w) => session(week(w), [["bench", 135 + w * 5, 5]]));
    expect(of(rotationStatus(input(prog(), rising(5))), "bench")).toMatchObject({ weeks: 5, due: false, due_next_week: false });
    expect(of(rotationStatus(input(prog(), rising(7))), "bench")).toMatchObject({ weeks: 7, new_best: true, due: false, due_next_week: true });
    expect(of(rotationStatus(input(prog(), rising(8))), "bench")).toMatchObject({ weeks: 8, due: true, reason: "max" });
    // Best in week 3, then the same lower weight: no new best in the last 2 weeks, and stalled.
    const flat = [140, 150, 155, 150, 150, 150].map((w, i) => session(week(i), [["bench", w, 5]]));
    expect(of(rotationStatus(input(prog(), flat)), "bench")).toMatchObject({ weeks: 6, stalled: true, new_best: false, due: true, reason: "stalled" });
    // A new best in the last 2 weeks, but not stalled: no reason yet.
    const late = [140, 145, 150, 150, 150, 160].map((w, i) => session(week(i), [["bench", w, 5]]));
    expect(of(rotationStatus(input(prog(), late)), "bench")).toMatchObject({ weeks: 6, stalled: false, new_best: true, due: false });
    // No new best in the last 2 weeks without a stall (the best was 3 sessions ago, then two lower ones).
    const dip = [140, 145, 150, 160, 155, 150].map((w, i) => session(week(i), [["bench", w, 5]]));
    expect(of(rotationStatus(input(prog(), dip)), "bench")).toMatchObject({ weeks: 6, stalled: false, new_best: false, due: true, reason: "no_new_best" });
  });

  it("other work: kept until 3 weeks; at 3 due when stalled; always by 4", () => {
    const flat = (weeks: number) => Array.from({ length: weeks }, (_, w) => session(week(w), [["fly", 30, 12]]));
    expect(of(rotationStatus(input(prog(), flat(3))), "fly")).toMatchObject({ weeks: 3, stalled: false, due: false, due_next_week: true });
    expect(of(rotationStatus(input(prog(), flat(4))), "fly")).toMatchObject({ weeks: 4, stalled: true, due: true, reason: "max" });
    // Stalled in 3 weeks: 4 sessions (two a week), the last 3 below the first.
    const stalled = [session(week(0), [["fly", 35, 12]]), session(week(0, 3), [["fly", 30, 12]]), session(week(1), [["fly", 30, 12]]), session(week(2), [["fly", 30, 11]])];
    expect(of(rotationStatus(input(prog(), stalled)), "fly")).toMatchObject({ weeks: 3, stalled: true, due: true, reason: "stalled" });
  });

  it("a stall needs its last 3 sessions inside this run; bodyweight work is scored by reps, holds by seconds", () => {
    // Bench stalled before it left the program; it is back in a new version since week 6.
    const sessions = [140, 150, 145, 145, 145].map((w, i) => session(week(i), [["bench", w, 5]]));
    const a = version("a", [entry("fly", "isolation")], ["2026-07-01T10:00:00.000Z"]);
    const b = version("b", [entry("bench", "main"), entry("fly", "isolation")], ["2026-09-06T10:00:00.000Z"]);
    sessions.push(session(week(5), [["bench", 140, 5]]));
    expect(of(rotationStatus(input([a, b], sessions)), "bench")).toMatchObject({ weeks: 1, stalled: false });
    const pullups = [10, 9, 9, 8].map((r, i) => session(week(i), [["pullup", null, r]]));
    const p = [version("a", [entry("pullup", "accessory"), entry("plank", "core")], ["2026-07-01T10:00:00.000Z"])];
    expect(of(rotationStatus(input(p, pullups)), "pullup")).toMatchObject({ stalled: true, due: true });
    const holds = [30, 40, 45, 50].map((s, i) => session(week(i), [["plank", null, null, s]]));
    expect(of(rotationStatus(input(p, holds)), "plank")).toMatchObject({ weeks: 4, stalled: false, reason: "max" });
  });

  it("due lines: most overdue first, with the reason in words", () => {
    const sessions = Array.from({ length: 9 }, (_, w) => session(week(w), [["bench", 135 + w * 5, 5], ["fly", 30, 12], ["row", 100, 10]]));
    const a = version("a", [entry("bench", "main"), entry("fly", "isolation"), entry("row", "accessory")], ["2026-07-01T10:00:00.000Z"]);
    const due = dueList(rotationStatus(input([a], sessions)));
    expect(due.map((s) => s.exercise_id)).toEqual(["fly", "row", "bench"]);
    expect(due.map(dueText)).toEqual(["9 weeks in the program", "9 weeks in the program", "9 weeks in the program"]);
    expect(dueText({ ...due[2], weeks: 6, reason: "no_new_best" })).toBe("6 weeks, no new best in the last 2 weeks");
    expect(dueText({ ...due[2], weeks: 7, reason: "stalled" })).toBe("7 weeks, no progress in the last 3 sessions");
  });
});

import { describe, expect, it } from "vitest";
import type { SetEntry, WorkoutSession } from "../../worker/lib/types";
import { inGroup, LIBRARY_GROUPS, regionChipLabel, regionsForGroup, rowFacts } from "../../web/src/lib/libraryView";

const at = "2026-10-01T10:00:00.000Z";
function session(id: string, date: string, sets: Partial<SetEntry>[], unit: "lb" | "kg" = "lb", status: "done" | "active" = "done"): WorkoutSession {
  return {
    id,
    program_day_id: "D1",
    local_date: date,
    started_at: `${date}T10:00:00.000Z`,
    ended_at: `${date}T11:00:00.000Z`,
    status,
    unit,
    note: "",
    created_at: at,
    updated_at: at,
    source: "app",
    sets: sets.map((x, i) => ({ id: `${id}${i}`, exercise_id: "bench", set_index: i, weight: null, reps: null, seconds: null, done: true, rir: null, updated_at: at, ...x })),
  } as WorkoutSession;
}

describe("Library view (SPEC-v8 §6.05)", () => {
  it("groups: the main muscle decides; All holds everything", () => {
    expect(LIBRARY_GROUPS.map((g) => g.label)).toEqual(["All", "Chest", "Back", "Legs", "Shoulders", "Arms", "Core"]);
    expect(inGroup("chest", "chest")).toBe(true);
    expect(inGroup("rear_delts", "shoulders")).toBe(true);
    expect(inGroup("glutes", "legs")).toBe(true);
    expect(inGroup("traps", "back")).toBe(true);
    expect(inGroup("neck", "all")).toBe(true);
    expect(LIBRARY_GROUPS.some((g) => g.muscles?.includes("neck"))).toBe(false);
    expect(inGroup("biceps", "chest")).toBe(false);
  });

  it("row numbers: best e1RM for the big three, else the last top set, hold or reps; undone sets and open sessions do not count", () => {
    const sessions = [
      session("A", "2026-09-20", [
        { exercise_id: "bench", weight: 140, reps: 5 },
        { exercise_id: "incline_db", weight: 50, reps: 10 },
      ]),
      session("B", "2026-10-01", [
        { exercise_id: "bench", weight: 135, reps: 5 },
        { exercise_id: "incline_db", weight: 40, reps: 8 },
        { exercise_id: "incline_db", weight: 60, reps: 8, done: false },
        { exercise_id: "plank", seconds: 45 },
        { exercise_id: "pushup", reps: 20 },
      ]),
      session("C", "2026-10-05", [{ exercise_id: "squat", weight: 200, reps: 5 }], "lb", "active"),
    ];
    const facts = rowFacts(sessions, "lb", new Set(["bench", "squat", "deadlift"]));
    // Epley: 140 × (1 + 5/30) = 163.3 → 163.
    expect(facts.get("bench")).toEqual({ value: 163, label: "est. 1RM" });
    expect(facts.get("incline_db")).toEqual({ value: 40, label: "last × 8" });
    expect(facts.get("plank")).toEqual({ value: 45, label: "last, seconds" });
    expect(facts.get("pushup")).toEqual({ value: 20, label: "last, reps" });
    expect(facts.has("squat")).toBe(false);
  });

  it("row numbers convert to the display unit", () => {
    const facts = rowFacts([session("K", "2026-10-01", [{ exercise_id: "incline_db", weight: 20, reps: 10 }], "kg")], "lb", new Set());
    expect(facts.get("incline_db")).toEqual({ value: 44.1, label: "last × 10" });
  });

  it("region chips: Arms holds triceps, biceps and the two forearm regions; neck regions show under All only (Phase B)", () => {
    expect(regionsForGroup("arms")).toEqual(["triceps_long", "triceps_lateral_medial", "biceps_long", "biceps_short", "brachialis", "forearm_flexors", "forearm_extensors"]);
    expect(regionChipLabel("forearm_extensors", "arms")).toBe("Forearm extensors");
    for (const g of LIBRARY_GROUPS) expect(regionsForGroup(g.key).some((r) => r.startsWith("neck_")), g.key).toBe(false);
  });
});

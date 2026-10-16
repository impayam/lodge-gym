import { describe, expect, it } from "vitest";
import { sessionFacts, sessionLines } from "../../worker/lib/coach/sessionContext";
import type { SetEntry, WorkoutSession } from "../../worker/lib/types";
import { reportData } from "../fixtures/report-data";

// Ask Coach from the session screen (Payam, 2026-10-16): what the app writes into the message's CONTEXT block.
const set = (exercise_id: string, set_index: number, over: Partial<SetEntry>, updated_at: string): SetEntry => ({
  id: `${exercise_id}-${set_index}`,
  exercise_id,
  set_index,
  weight: null,
  reps: null,
  seconds: null,
  done: false,
  updated_at,
  ...over,
});
const session = (sets: SetEntry[]): WorkoutSession => ({
  id: "S1",
  program_day_id: "D1",
  local_date: "2026-10-16",
  started_at: "2026-10-16T23:05:00.000Z",
  ended_at: null,
  status: "active",
  unit: "lb",
  note: "",
  created_at: "2026-10-16T23:05:00.000Z",
  updated_at: "2026-10-16T23:30:00.000Z",
  source: "app",
  sets,
});

describe("Ask Coach: the session in the CONTEXT block", () => {
  const d = reportData();
  const day = d.program.days.find((x) => x.id === "D1")!;
  const [first, second] = day.exercises.map((x) => d.exercises.find((e) => e.id === x.exercise_id)!);

  it("the day, the start time in his zone, the exercise and set on screen, and done sets in the order he did them", () => {
    const s = session([
      set(second.id, 0, { weight: 50, reps: 10, done: true }, "2026-10-16T23:20:00.000Z"),
      set(first.id, 1, { weight: 137.5, reps: 5, done: true }, "2026-10-16T23:12:00.000Z"),
      set(first.id, 0, { weight: 135, reps: 5, done: true }, "2026-10-16T23:10:00.000Z"),
      set(first.id, 2, {}, "2026-10-16T23:05:00.000Z"),
      set(second.id, 1, {}, "2026-10-16T23:05:00.000Z"),
    ]);
    const f = sessionFacts(d, s, first.id, 2, "America/Denver");
    expect(sessionLines(f)).toEqual([
      `He is training now (the session open today): ${day.name_en}, started 17:05.`,
      `On his screen: ${first.name_en}, set 3 of 3.`,
      `Done so far (lb): ${first.name_en} 135×5, 137.5×5; ${second.name_en} 50×10.`,
    ]);
  });

  it("holds in seconds, reps without a weight; no set yet; no exercise on screen", () => {
    const s = session([set("plank", 0, { seconds: 45, done: true }, "2026-10-16T23:10:00.000Z"), set("pullup", 0, { reps: 8, done: true }, "2026-10-16T23:12:00.000Z")]);
    const lines = sessionLines(sessionFacts(d, s, null, null, "America/Denver"));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Done so far \(lb\): .+ 45 s; .+ ×8\.$/);
    expect(sessionLines(sessionFacts(d, session([set(first.id, 0, {}, "2026-10-16T23:05:00.000Z")]), first.id, 0, "America/Denver")).slice(1)).toEqual([`On his screen: ${first.name_en}, set 1 of 1.`, "Done so far: no set yet."]);
    // An exercise not in the session: no "On his screen" line.
    expect(sessionLines(sessionFacts(d, session([]), "squat", 0, "America/Denver"))).toHaveLength(2);
  });
});

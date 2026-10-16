import { describe, expect, it } from "vitest";
import { reportData } from "../fixtures/report-data";
import { COACH_TOOLS, runTool, type CoachData } from "../../worker/lib/coach/tools";
import { EXTRA_SETS, MAX_ADDITIONS, nextProgramDay, type SessionAdditions } from "../../worker/lib/coach/sessionTools";
import { lastPerformance, suggest } from "../../worker/lib/progression";
import type { Exercise, WorkoutSession } from "../../worker/lib/types";

// propose_session_additions (Payam, 2026-10-16): the model picks exercises and says why; the app fills every number
// with the session screen's progression (lastPerformance + suggest) and never changes the program.
const base = reportData();
const curl = base.exercises.find((e) => e.id === "curl")!;
const lib = (id: string, more: Partial<Exercise> = {}): Exercise => ({ ...curl, id, name_en: id, ...more });
const extra = [
  lib("hammer_curl", { name_en: "Dumbbell Hammer Curl", mechanic: "isolation" }),
  lib("ez_curl", { name_en: "EZ-Bar Curl", equipment: "barbell", mechanic: "isolation" }),
  lib("wrist_curl", { name_en: "Dumbbell Wrist Curl", muscle_primary: "forearms", mechanic: null, pattern: "isolation" }),
  lib("old_curl", { name_en: "Archived Curl", archived_at: "2026-01-01T00:00:00Z" }),
];
const done = (id: string, date: string, ex: string, sets: [number, number][]): WorkoutSession => ({
  id,
  program_day_id: "D1",
  local_date: date,
  started_at: `${date}T23:00:00.000Z`,
  ended_at: `${date}T23:59:00.000Z`,
  status: "done",
  unit: "lb",
  note: "",
  created_at: `${date}T23:00:00.000Z`,
  updated_at: `${date}T23:59:00.000Z`,
  source: "app",
  sets: sets.map(([w, r], i) => ({ id: `${id}-${i}`, exercise_id: ex, set_index: i, weight: w, reps: r, seconds: null, done: true, rir: 2, updated_at: `${date}T23:30:00.000Z` })),
});
/** The fixture without its open session (A1), plus EZ-bar curls a week before today: 60 × 12, 12, 12. */
const data = (sessions: WorkoutSession[] = base.sessions.filter((s) => s.status === "done")): CoachData => ({
  ...base,
  exercises: [...base.exercises, ...extra],
  sessions: [...sessions, done("H1", "2026-10-09", "ez_curl", [[60, 12], [60, 12], [60, 12]])],
  today: "2026-10-16",
  now: "2026-10-16T18:00:00.000Z",
});
const ok = (r: ReturnType<typeof runTool>): SessionAdditions => {
  if (!r.ok) throw new Error(r.error);
  return r.result as SessionAdditions;
};
const reason_fa = "دلیل";

describe("propose_session_additions", () => {
  it("is offered to the model with a strict schema and no numbers to fill in", () => {
    const t = COACH_TOOLS.find((x) => x.name === "propose_session_additions")!;
    expect(t.input_schema).toMatchObject({ type: "object", additionalProperties: false, required: ["items"] });
    expect(Object.keys(t.input_schema.properties.items.items.properties)).toEqual(["exercise_id", "reason_fa"]);
  });

  it("numbers equal the session screen's progression: program entry, history, or none", () => {
    const d = data();
    const r = ok(runTool(d, "propose_session_additions", { program_day_id: "D3", items: ["lateral", "ez_curl", "hammer_curl"].map((exercise_id) => ({ exercise_id, reason_fa })) }));
    const [lateral, ez, hammer] = r.items;

    // In the program (Day 1): that entry's sets and reps, and suggest() on his last session with it.
    const entry = d.program.days.flatMap((x) => x.exercises).find((x) => x.exercise_id === "lateral")!;
    const g = suggest(entry, d.exercises.find((e) => e.id === "lateral")!, lastPerformance("lateral", d.sessions));
    expect(g.kind).toBe("weight");
    expect(lateral).toMatchObject({ basis: "program", sets: entry.sets, reps_min: entry.reps_min, reps_max: entry.reps_max, weight: g.kind === "weight" ? g.weight : null, weight_unit: "lb" });
    expect(lateral.last).toEqual({ date: "2026-09-21", sets: "15×12, 15×12, 15×12" });

    // Not in the program, done before: his last set count and top reps; every set at 12 → +5 lb (upper body).
    expect(ez).toMatchObject({ basis: "history", sets: 3, reps_min: 12, reps_max: 12, weight: 65, weight_unit: "lb", rule: "+5 lb: every set reached 12 reps last time" });
    const stand = suggest({ sets: 3, reps_max: 12, is_time: false }, d.exercises.find((e) => e.id === "ez_curl")!, lastPerformance("ez_curl", d.sessions));
    expect(stand.kind === "weight" && stand.weight).toBe(65);

    // Never done: three sets, the generator's isolation range, no weight, and it says so.
    expect(hammer).toMatchObject({ basis: "none", sets: EXTRA_SETS, reps_min: 10, reps_max: 15, weight: null, weight_unit: null, last: null, rule: "No history with this exercise: enter the weight" });
  });

  it("drops ids not in the library (archived too), repeats and exercises already in the day, and says why", () => {
    const r = ok(
      runTool(data(), "propose_session_additions", {
        program_day_id: "D3",
        items: [
          { exercise_id: "wrist_curl", reason_fa },
          { exercise_id: "made_up_curl", reason_fa },
          { exercise_id: "old_curl", reason_fa },
          { exercise_id: "wrist_curl", reason_fa },
          { exercise_id: "curl", reason_fa },
        ],
      })
    );
    expect(r.items.map((x) => x.exercise_id)).toEqual(["wrist_curl"]);
    expect(r.items[0]).toMatchObject({ reps_min: 10, reps_max: 15, reason_fa });
    expect(r.dropped).toEqual([
      { exercise_id: "made_up_curl", reason: "not in the library: use an id from get_library" },
      { exercise_id: "old_curl", reason: "not in the library: use an id from get_library" },
      { exercise_id: "wrist_curl", reason: "listed twice" },
      { exercise_id: "curl", reason: "already in Day 3 · Back" },
    ]);
    // Nothing left: an error the model can fix.
    const none = runTool(data(), "propose_session_additions", { items: [{ exercise_id: "made_up_curl", reason_fa }] });
    expect(none.ok).toBe(false);
    expect(!none.ok && none.error).toMatch(/^No exercise could be proposed: made_up_curl \(not in the library/);
  });

  it("target: the open session when he is training, else the day he named, else Home's next day", () => {
    const named = ok(runTool(data(), "propose_session_additions", { program_day_id: "D2", items: [{ exercise_id: "hammer_curl", reason_fa }] }));
    expect(named.target).toEqual({ kind: "start_day", day_id: "D2", day: "Day 2 · Legs", named: true });

    const d = data();
    const next = ok(runTool(d, "propose_session_additions", { items: [{ exercise_id: "hammer_curl", reason_fa }] }));
    expect(next.target).toEqual({ kind: "start_day", day_id: nextProgramDay(d).id, day: nextProgramDay(d).name_en, named: false });

    // With the fixture's open session (A1, Day 4): the items go there, and its exercises are "already in".
    const open = ok(runTool(data(base.sessions), "propose_session_additions", { program_day_id: "D3", items: [{ exercise_id: "deadlift", reason_fa }, { exercise_id: "hammer_curl", reason_fa }] }));
    expect(open.target).toEqual({ kind: "open_session", session_id: "A1", date: "2026-09-27", day_id: "D4", day: "Day 4 · Deadlift" });
    expect(open.dropped).toEqual([{ exercise_id: "deadlift", reason: "already in today's open session" }]);
  });

  it("checks its input: a day of the active program, 1 to 6 items, a reason each", () => {
    const bad = runTool(data(), "propose_session_additions", { program_day_id: "D9", items: [{ exercise_id: "hammer_curl", reason_fa }] });
    expect(!bad.ok && bad.error).toMatch(/^Unknown program_day_id "D9"/);
    expect(runTool(data(), "propose_session_additions", { items: [] }).ok).toBe(false);
    expect(runTool(data(), "propose_session_additions", { items: Array.from({ length: MAX_ADDITIONS + 1 }, () => ({ exercise_id: "hammer_curl", reason_fa })) }).ok).toBe(false);
    expect(runTool(data(), "propose_session_additions", { items: [{ exercise_id: "hammer_curl" }] }).ok).toBe(false);
    expect(runTool(data(), "propose_session_additions", { items: [{ exercise_id: "hammer_curl", reason_fa, sets: 5 }] }).ok).toBe(false);
  });

  it("never touches the program", () => {
    const d = data();
    const before = JSON.stringify(d.program);
    ok(runTool(d, "propose_session_additions", { program_day_id: "D3", items: [{ exercise_id: "hammer_curl", reason_fa }, { exercise_id: "lateral", reason_fa }] }));
    expect(JSON.stringify(d.program)).toBe(before);
  });
});

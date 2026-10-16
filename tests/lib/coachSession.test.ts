import { describe, expect, it } from "vitest";
import { reportData } from "../fixtures/report-data";
import { COACH_TOOLS, runTool, type CoachData } from "../../worker/lib/coach/tools";
import { EXTRA_SETS, MAX_ADDITIONS, nextProgramDay, type SessionAdditions } from "../../worker/lib/coach/sessionTools";
import { additionTargets, UPCOMING_MAX } from "../../worker/lib/coach/additionTarget";
import type { GymPlan } from "../../worker/lib/calendar";
import { lastPerformance, suggest } from "../../worker/lib/progression";
import type { Exercise, WorkoutSession } from "../../worker/lib/types";
import { DEFAULT_CALENDAR_SETTINGS } from "../../worker/lib/calendar";

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
const data = (sessions: WorkoutSession[] = base.sessions.filter((s) => s.status === "done"), plans: GymPlan[] = []): CoachData => ({
  ...base,
  exercises: [...base.exercises, ...extra],
  sessions: [...sessions, done("H1", "2026-10-09", "ez_curl", [[60, 12], [60, 12], [60, 12]])],
  today: "2026-10-16",
  now: "2026-10-16T18:00:00.000Z",
  calendar: { shifts: [], plans, settings: DEFAULT_CALENDAR_SETTINGS },
});
const gym = (id: string, date: string, start_min: number, program_day_id: string, status: GymPlan["status"] = "planned"): GymPlan => ({
  id, date, start_min, end_min: start_min + 60, program_day_id, source: "manual", session_id: null, status, reminder_at: null, created_at: "x", updated_at: "x",
});
/** A session open now: started today, one set of Day 3 done. */
const openToday = (date = "2026-10-16"): WorkoutSession => ({ ...done("O1", date, "cs_row", [[25, 8]]), program_day_id: "D3", status: "active", ended_at: null });
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
    expect(r.target.kind).toBe("start_today");
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

  it("target by date: a session open today, else today's named or planned day, else the next planned session, else Home's next day", () => {
    const add = (d: CoachData, named?: string) => ok(runTool(d, "propose_session_additions", { ...(named ? { program_day_id: named } : {}), items: [{ exercise_id: "hammer_curl", reason_fa }] }));

    // 1. Open today: that session, whatever day he names; its exercises are "already in".
    const open = ok(runTool(data([...base.sessions.filter((s) => s.status === "done"), openToday()]), "propose_session_additions", { program_day_id: "D1", items: [{ exercise_id: "cs_row", reason_fa }, { exercise_id: "hammer_curl", reason_fa }] }));
    expect(open.target).toMatchObject({ kind: "open_session", session_id: "O1", date: "2026-10-16", day_id: "D3", label: "today's session: Day 3 · Back" });
    expect(open.dropped).toEqual([{ exercise_id: "cs_row", reason: "already in today's open session" }]);

    // 2. Today: the day he names, else today's planned gym session's day (with its time).
    const plans = [gym("g-today", "2026-10-16", 17 * 60 + 30, "D2"), gym("g-tom", "2026-10-17", 8 * 60, "D4")];
    expect(add(data(undefined, plans), "D3").target).toMatchObject({ kind: "start_today", day_id: "D3", gym_plan_id: null, label: "today's Day 3 · Back" });
    expect(add(data(undefined, plans)).target).toMatchObject({ kind: "start_today", day_id: "D2", gym_plan_id: "g-today", label: "today's Day 2 · Legs (17:30)" });

    // 3. Nothing today: the nearest planned session ahead.
    const ahead = add(data(undefined, [gym("g-sat", "2026-10-24", 9 * 60, "D1"), gym("g-tom", "2026-10-17", 8 * 60, "D4"), gym("g-gone", "2026-10-17", 7 * 60, "D2", "cancelled")]));
    expect(ahead.target).toMatchObject({ kind: "planned", date: "2026-10-17", day_id: "D4", gym_plan_id: "g-tom", start: "08:00", label: "tomorrow 08:00 · Day 4 · Deadlift" });
    expect(ahead.dropped).toEqual([]);

    // 4. Nothing planned: Home's next day, today.
    const d = data();
    expect(add(d).target).toMatchObject({ kind: "start_today", day_id: nextProgramDay(d).id, gym_plan_id: null });

    // A session left open from an earlier day is never the target (the app closes it).
    expect(add(data([...base.sessions.filter((s) => s.status === "done"), openToday("2026-10-15")])).target.kind).toBe("start_today");
  });

  it("Change offers today's session (or every day started today) and the planned sessions ahead, the default first", () => {
    const sessions = [{ id: "O1", local_date: "2026-10-16", started_at: "2026-10-16T15:00:00Z", status: "active" as const, program_day_id: "D3" }];
    const plans = Array.from({ length: 9 }, (_, i) => gym(`g${i}`, `2026-10-${String(17 + i).padStart(2, "0")}`, 480, "D1"));
    const base2 = { today: "2026-10-16", plans, dayIds: ["D1", "D2", "D3", "D4"], nextDayId: "D2" };
    const withOpen = additionTargets({ ...base2, sessions });
    expect(withOpen.choices.map((c) => c.kind)).toEqual(["open_session", ...Array(UPCOMING_MAX).fill("planned")]);
    const none = additionTargets({ ...base2, sessions: [], plans: [] });
    expect(none.target).toMatchObject({ kind: "start_today", day_id: "D2" });
    expect(none.choices.map((c) => c.kind === "start_today" && c.day_id)).toEqual(["D2", "D1", "D3", "D4"]);
    // Two weeks ahead at most.
    expect(additionTargets({ ...base2, sessions: [], plans: [gym("far", "2026-11-01", 480, "D1")] }).choices.some((c) => c.kind === "planned")).toBe(false);
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

describe("coach prompt (exercises for a session)", () => {
  it("uses the tool, gives no numbers of its own, respects his groups, keeps the 48-hour rule as advice, saves nothing", async () => {
    const { COACH_SYSTEM } = await import("../../worker/lib/coach/prompt");
    expect(COACH_SYSTEM).toContain("call propose_session_additions once");
    expect(COACH_SYSTEM).toContain("Give no sets, reps or weights");
    expect(COACH_SYSTEM).toContain("If it is unclear which day he means, ask him first.");
    expect(COACH_SYSTEM).toContain("never split, change or criticise his supersets and tri-sets");
    expect(COACH_SYSTEM).toContain("Never refuse or drop an exercise because of it.");
    expect(COACH_SYSTEM).toContain('Nothing is added until he taps "Add" on the card.');
  });
});

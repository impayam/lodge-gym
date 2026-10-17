import { describe, expect, it } from "vitest";
import { reportData } from "../fixtures/report-data";
import { COACH_TOOLS, runTool, type CoachData } from "../../worker/lib/coach/tools";
import { additionNumbers } from "../../worker/lib/coach/sessionTools";
import { exerciseDraft, insertIndex, programDraftDays, type ExerciseChange } from "../../worker/lib/coach/exerciseTool";
import { draftDayRows, scoreDraft } from "../../worker/lib/coach/draft";
import { COACH_SYSTEM } from "../../worker/lib/coach/prompt";
import { DEFAULT_CALENDAR_SETTINGS } from "../../worker/lib/calendar";
import { liveItems, moveAfter, addItem, planFromDay, planMinutes, seqIds } from "../../worker/lib/plan";
import type { Exercise } from "../../worker/lib/types";

// propose_exercise (Payam, 2026-10-16): one more exercise for a day. The model picks the day, the exercise and the
// place; the app fills the numbers (as propose_session_additions does), builds the whole-program draft itself, and
// lists only what the change causes. Nothing is saved by the tool and the program never changes.
const base = reportData();
const fly = base.exercises.find((e) => e.id === "fly")!;
const pecDeck: Exercise = { ...fly, id: "pec_deck", name_en: "Butterfly (Pec Deck)", equipment: "machine", mechanic: "isolation", pattern: "isolation" };
const archived: Exercise = { ...fly, id: "old_fly", name_en: "Old Fly", archived_at: "2026-01-01T00:00:00Z" };
const data = (): CoachData => ({
  ...base,
  exercises: [...base.exercises, pecDeck, archived],
  sessions: base.sessions.filter((s) => s.status === "done"),
  today: "2026-10-16",
  now: "2026-10-16T18:00:00.000Z",
  calendar: { shifts: [], plans: [], settings: DEFAULT_CALENDAR_SETTINGS },
});
const propose = (d: CoachData, input: unknown) => runTool(d, "propose_exercise", input, undefined, () => "01DRAFT00000000000000000000");
const ok = (r: ReturnType<typeof runTool>): ExerciseChange => {
  if (!r.ok) throw new Error(r.error);
  return r.result as ExerciseChange;
};
const d1 = () => base.program.days.find((x) => x.id === "D1")!;

describe("propose_exercise", () => {
  it("is offered to the model with a strict schema and no numbers to fill in", () => {
    const t = COACH_TOOLS.find((x) => x.name === "propose_exercise")!;
    expect(t.input_schema).toMatchObject({ type: "object", additionalProperties: false, required: ["program_day_id", "exercise_id"] });
    expect(Object.keys(t.input_schema.properties)).toEqual(["program_day_id", "exercise_id", "after_exercise_id", "replaces_exercise_id", "prefer"]);
    expect(t.input_schema.properties.prefer.enum).toEqual(["session", "program"]);
  });

  it("numbers are propose_session_additions' numbers; rest and RIR from his program entry, else the generator's scheme", () => {
    const d = data();
    // In his program (Day 3): that entry's sets, reps and rest; the weight from the session screen's progression.
    const inProgram = ok(propose(d, { program_day_id: "D1", exercise_id: "fly" })).exercise;
    const entry = d.program.days.flatMap((x) => x.exercises).find((x) => x.exercise_id === "fly")!;
    expect(inProgram).toMatchObject({ ...additionNumbers(d, fly), exercise_id: "fly", name: "Cable Chest Fly", rest_sec: entry.rest_sec, per_leg: false, target_rir_min: null, target_rir_max: null });
    expect(inProgram.basis).toBe("program");
    // Never done and not in the program: three sets of the isolation range, no weight, isolation rest (75 s). The seed
    // program has no RIR targets, so neither does the new entry.
    const fresh = ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck" })).exercise;
    expect(fresh).toMatchObject({ basis: "none", sets: 3, reps_min: 10, reps_max: 15, weight: null, rest_sec: 75, target_rir_min: null, rule: "No history with this exercise: enter the weight" });
  });

  it("goes after the exercise he named, after a whole group for a group member, or at the end of the day", () => {
    const d = data();
    expect(ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck", after_exercise_id: "cable_row" })).after).toEqual({ exercise_id: "cable_row", name: "Seated Cable Row" });
    // lateral is A1 of the A superset (lateral + facepull): never inside his group.
    expect(ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck", after_exercise_id: "lateral" })).after).toEqual({ exercise_id: "facepull", name: "Face Pull" });
    expect(ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck" })).after?.exercise_id).toBe("facepull");
    const days = programDraftDays(base.program.days);
    expect(insertIndex(days[0].exercises, "cable_row")).toBe(4);
    expect(insertIndex(days[0].exercises, "lateral")).toBe(6);
    expect(insertIndex(days[0].exercises, undefined)).toBe(6);
    expect(insertIndex(days[0].exercises, "squat")).toBe(-1);
  });

  it("returns an error the model can act on: unknown day, not in the library, archived, already in the day, a place not in the day", () => {
    const d = data();
    const err = (input: object) => {
      const r = propose(d, input);
      return r.ok ? null : r.error;
    };
    expect(err({ program_day_id: "D9", exercise_id: "pec_deck" })).toContain('Unknown program_day_id "D9"');
    expect(err({ program_day_id: "D1", exercise_id: "made_up_fly" })).toBe('"made_up_fly" is not in the library: use an id from get_library.');
    expect(err({ program_day_id: "D1", exercise_id: "old_fly" })).toContain("is not in the library");
    expect(err({ program_day_id: "D1", exercise_id: "bench" })).toBe("Barbell Bench Press is already in Day 1 · Chest: pick another exercise.");
    expect(err({ program_day_id: "D1", exercise_id: "pec_deck", after_exercise_id: "squat" })).toContain('after_exercise_id "squat" is not in Day 1 · Chest');
    expect(err({ program_day_id: "D1", exercise_id: "pec_deck", sets: 4 })).toContain("sets");
    expect(err({ program_day_id: "D1", exercise_id: "pec_deck", prefer: "always" })).toContain("prefer");
  });

  it("which button comes first: what he asked for, or nothing when he did not say", () => {
    const d = data();
    expect(ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck" })).prefer).toBeNull();
    expect(ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck", prefer: "session" })).prefer).toBe("session");
    expect(ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck", prefer: "program" })).prefer).toBe("program");
  });

  it("Worth knowing lists only what the change causes: the weekly sets it changes, the day's extra minutes, new check notes", () => {
    const d = data();
    const r = ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck", after_exercise_id: "cable_row" }));
    const days = programDraftDays(base.program.days);
    const was = scoreDraft(d, days, d.today);
    const chestNow = was.planned.chest;
    expect(r.notes[0]).toBe(`Chest: ${chestNow + 3} sets a week with this change (now ${chestNow}; target ${was.targets.chest}).`);
    // The day's length by the Planner's own rule (planMinutes): Day 1's estimate (60 min) plus 3 × (75 s rest + 40 s
    // work), the number the Planner shows once the exercise is in that day's plan.
    const plan = addItem(planFromDay(d1(), "P", "t", seqIds("P")), "pec_deck", "t", "X", { sets: 3, reps_min: 10, reps_max: 15, rest_sec: 75 });
    const longer = planMinutes(plan, d1());
    expect(longer).toBe(Math.round(60 + (3 * 115) / 60));
    expect(r.notes).toContain(`Day 1 gets about ${longer - 60} min longer (about ${longer} min).`);
    // The secondary group too (a fly counts 0.5 for shoulders), and nothing else: Day 1 and its neighbours already
    // train chest, so no spacing note is new, and over target is said by the weekly-sets line.
    expect(r.notes).toEqual([
      `Chest: ${chestNow + 3} sets a week with this change (now ${chestNow}; target ${was.targets.chest}).`,
      `Shoulders: ${was.planned.shoulders + 1.5} sets a week with this change (now ${was.planned.shoulders}; target ${was.targets.shoulders}).`,
      `Day 1 gets about ${longer - 60} min longer (about ${longer} min).`,
    ]);
  });

  it("spacing advice names only what the change adds, never a note the program already had", () => {
    const d = data();
    // Day 4 has no chest work; Day 3 (fly) and Day 1 (bench) do: chest becomes trained on both of two adjacent days.
    const r = ok(propose(d, { program_day_id: "D4", exercise_id: "pec_deck" }));
    const before = scoreDraft(d, programDraftDays(base.program.days), d.today).issues.map((i) => i.message);
    // Day 4 and Day 1 already shared hamstrings & glutes, shoulders and rear delts: only chest is new.
    expect(before).toContain("If you train Day 4 and Day 1 back to back, Hamstrings & glutes, Shoulders, Rear delts are trained on both days.");
    expect(r.notes.filter((n) => n.startsWith("If you train"))).toEqual(["If you train Day 3 and Day 4 back to back, Chest is trained on both days.", "If you train Day 4 and Day 1 back to back, Chest is trained on both days."]);
  });

  it("the tool saves nothing and never changes the program", () => {
    const d = data();
    const before = JSON.stringify(d.program);
    ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck", after_exercise_id: "cable_row", prefer: "program" }));
    expect(JSON.stringify(d.program)).toBe(before);
  });
});

describe("the exercise card's Whole program draft", () => {
  it("is his program with that one exercise in that place, groups and main lifts kept, named after it", () => {
    const d = data();
    const r = ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck", after_exercise_id: "cable_row" }));
    const draft = exerciseDraft(d, r)!;
    // Named after his program as the app shows it (the seed program's English name), plus the exercise.
    const seedInfo = { ...base.program, style: "seed_full_body", days_per_week: 4, params: null, generated_by: "seed" as const, created_at: "x", approved_at: "x", archived_at: null, status: "active" as const, activations: [] };
    expect(exerciseDraft({ ...d, programs: [seedInfo] }, r)!.name).toBe("Full body · 4 days + Butterfly (Pec Deck)");
    const rows = draftDayRows(draft);
    expect(rows[0].exercises.map((x) => [x.exercise_id, x.superset_tag, x.is_main])).toEqual([
      ["bench", null, true],
      ["incline_db", null, false],
      ["rdl", null, false],
      ["cable_row", null, false],
      ["pec_deck", null, false],
      ["lateral", "A1", false],
      ["facepull", "A2", false],
    ]);
    expect(rows[0].exercises[4]).toMatchObject({ sets: 3, reps_min: 10, reps_max: 15, rest_sec: 75, target_rir_min: null });
    // Every other day is the program's day, unchanged, with the program's estimate; Day 1's estimate is the card's.
    const program = draftDayRows({ name: "x", summary_fa: null, days: programDraftDays(base.program.days) });
    expect(rows.slice(1)).toEqual(program.slice(1));
    expect(rows.map((x) => x.est_minutes)).toEqual([planMinutes(addItem(planFromDay(d1(), "P", "t", seqIds("P")), "pec_deck", "t", "X", { sets: 3, rest_sec: 75 }), d1()), ...base.program.days.slice(1).map((x) => x.est_minutes)]);
    expect(r.notes).toContain(`Day 1 gets about ${rows[0].est_minutes - d1().est_minutes} min longer (about ${rows[0].est_minutes} min).`);
    expect(rows[0].exercises.filter((x) => x.exercise_id !== "pec_deck").map(({ position: _p, ...x }) => x)).toEqual(program[0].exercises.map(({ position: _p, ...x }) => x));
  });

  it("uses the numbers on the card even when his history has changed since", () => {
    const d = data();
    const r = ok(propose(d, { program_day_id: "D1", exercise_id: "fly" }));
    const shown = { ...r, exercise: { ...r.exercise, sets: 4, reps_min: 11, reps_max: 13 } };
    const day = draftDayRows(exerciseDraft(d, shown)!)[0];
    expect(day.exercises.at(-1)).toMatchObject({ exercise_id: "fly", sets: 4, reps_min: 11, reps_max: 13 });
  });

  it("is not built when the program version, the day or the exercise is gone, or the day already has it", () => {
    const d = data();
    const r = ok(propose(d, { program_day_id: "D1", exercise_id: "pec_deck" }));
    expect(exerciseDraft(d, { ...r, program_id: "gone" })).toBeNull();
    expect(exerciseDraft(d, { ...r, day: { ...r.day, id: "D9" } })).toBeNull();
    expect(exerciseDraft({ ...d, exercises: d.exercises.map((e) => (e.id === "pec_deck" ? { ...e, archived_at: "2026-10-16T00:00:00Z" } : e)) }, r)).toBeNull();
    expect(exerciseDraft(d, { ...r, exercise: { ...r.exercise, exercise_id: "bench" } })).toBeNull();
  });
});

describe("Only this session in a plan: moveAfter", () => {
  const plan = () => planFromDay(d1(), "P1", "t0", seqIds("P1"));
  const order = (p: ReturnType<typeof plan>) => liveItems(p).map((i) => i.exercise_id);

  it("puts the added exercise right after the named one, or after its whole group", () => {
    const after = (exerciseId: string) => {
      const p = addItem(plan(), "pec_deck", "t1", "X");
      return order(moveAfter(p, "X", exerciseId, "t1"));
    };
    expect(after("cable_row")).toEqual(["bench", "incline_db", "rdl", "cable_row", "pec_deck", "lateral", "facepull"]);
    expect(after("lateral")).toEqual(["bench", "incline_db", "rdl", "cable_row", "lateral", "facepull", "pec_deck"]);
    expect(after("bench")).toEqual(["bench", "pec_deck", "incline_db", "rdl", "cable_row", "lateral", "facepull"]);
    // Not in the plan (replaced since): stays at the end.
    expect(after("squat")).toEqual(["bench", "incline_db", "rdl", "cable_row", "lateral", "facepull", "pec_deck"]);
    // His group stays whole.
    const p = moveAfter(addItem(plan(), "pec_deck", "t1", "X"), "X", "cable_row", "t1");
    expect(liveItems(p).filter((i) => i.group_tag).map((i) => i.exercise_id)).toEqual(["lateral", "facepull"]);
  });
});

describe("cards he did not ask to see", () => {
  it("get_program, get_library and get_recovery take show; the other read tools do not", () => {
    const withShow = COACH_TOOLS.filter((t) => "show" in (t.input_schema.properties as object)).map((t) => t.name);
    expect(withShow).toEqual(["get_program", "get_library", "get_recovery"]);
    const d = data();
    expect(runTool(d, "get_program", { show: true }).ok).toBe(true);
    expect(runTool(d, "get_program", {}).ok).toBe(true);
    expect(runTool(d, "get_recovery", { show: false }).ok).toBe(true);
    expect(runTool(d, "get_library", { muscle: "chest", show: true }).ok).toBe(true);
    // show is not a filter.
    expect(runTool(d, "get_library", { show: true }).ok).toBe(false);
    expect(runTool(d, "get_program", { show: "yes" }).ok).toBe(false);
  });

  it("the prompt tells the coach when to pass show, to use propose_exercise for one exercise and to give the reason once", () => {
    expect(COACH_SYSTEM).toContain("get_program, get_library and get_recovery are shown only when you pass show: true, which you do only when he asks to see that directly");
    expect(COACH_SYSTEM).toContain("then call propose_exercise once: the day, the exercise, and the exercise of that day it goes after. Do not write a program draft for this.");
    expect(COACH_SYSTEM).toContain("say in one or two short sentences why this exercise and this place; do not repeat the card.");
    expect(COACH_SYSTEM).toContain("For one added exercise, use propose_exercise instead (below).");
    expect(COACH_SYSTEM).toContain("When he asks to add two or more exercises for today or for a session");
  });
});

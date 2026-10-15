import { describe, expect, it } from "vitest";
import { ADVICE_SYSTEM, AdviceOutput, applySuggestion, buildAdviceInput, candidateList, CANDIDATES_PER_GROUP, undoSuggestion, validateAdvice, type AdviceSuggestion } from "../../worker/lib/ai/advice";
import { groupItems, liveItems, planFromDay, seqIds, type SessionPlan } from "../../worker/lib/plan";
import type { Exercise } from "../../worker/lib/types";
import { program, reportData } from "../fixtures/report-data";

// SPEC-v3 M9c AI plan advice: input, candidate list, validation (unknown exercise ids are dropped), Apply and Undo.

const NOW = "2026-09-28T15:00:00.000Z";
const lib = (id: string, name: string, primary: string, extra: Partial<Exercise> = {}): Exercise => ({
  id,
  name_fa: "",
  name_en: name,
  muscle_primary: primary,
  is_lower: false,
  equipment: "cable",
  cue_fa: "",
  cue_en: null,
  source: "fedb",
  muscles_secondary: [],
  pattern: null,
  mechanic: "isolation",
  level: null,
  media: [],
  instructions_en: [],
  archived_at: null,
  category: "strength",
  ...extra,
});

function library(): Exercise[] {
  const d = reportData();
  return [
    ...d.exercises,
    lib("tri_pushdown", "Triceps Pushdown", "triceps"),
    lib("tri_kickback", "Triceps Kickback", "triceps", { equipment: "dumbbell" }),
    lib("tri_stretch", "Triceps Stretch", "triceps", { category: "stretching" }),
    lib("tri_old", "Old Triceps Move", "triceps", { archived_at: "2026-01-01T00:00:00.000Z" }),
    ...Array.from({ length: 14 }, (_, i) => lib(`chest_${String(i).padStart(2, "0")}`, `Chest Move ${String(i).padStart(2, "0")}`, "chest")),
  ];
}

const day1 = () => program().days.find((d) => d.id === "D1")!;
const plan = (): SessionPlan => planFromDay(day1(), "PL1", NOW, seqIds("PL1"));
const ids = (p: SessionPlan) => liveItems(p).map((it) => it.exercise_id);

describe("buildAdviceInput", () => {
  const d = reportData();
  const input = buildAdviceInput(d, plan(), library(), NOW, "2026-09-28", "seed_full_body");

  it("has the plan in order with its groups, and the original day", () => {
    expect(input.plan.program_day).toBe("Day 1 · Chest");
    expect(input.plan.exercises.map((x) => [x.position, x.exercise_id, x.group])).toEqual([
      [1, "bench", null],
      [2, "incline_db", null],
      [3, "rdl", null],
      [4, "cable_row", null],
      [5, "lateral", "A1"],
      [6, "facepull", "A2"],
    ]);
    expect(input.original_day.map((x) => x.exercise_id)).toEqual(["bench", "incline_db", "rdl", "cable_row", "lateral", "facepull"]);
    expect(input.program_style).toBe("seed_full_body");
    expect(input.preferences.join(" ")).toMatch(/Chest is the current priority/);
  });

  it("has the last 14 days of done sessions only (no active ones)", () => {
    expect(input.recent_sessions.map((s) => s.date)).toEqual(["2026-09-15", "2026-09-18", "2026-09-21", "2026-09-23", "2026-09-26"]);
    expect(input.recent_sessions[2].exercises[0]).toEqual({ name: "Barbell Bench Press", done_sets: 4, best_set: "135 lb × 5" });
  });

  it("has group volume against the weekly targets and what the plan adds", () => {
    const chest = input.volume.find((v) => v.group === "Chest")!;
    expect(chest.week_so_far).toBe(0);
    expect(chest.status_week_so_far).toBe("none");
    expect(chest.this_plan_adds).toBe(7);
    expect(chest.last_7_days).toBeGreaterThan(0);
  });

  it("has the last heavy compound per group, with hours since", () => {
    const quads = input.last_heavy_compound.find((x) => x.group === "Quads")!;
    expect(quads).toMatchObject({ date: "2026-09-26", exercise: expect.any(String) });
    expect(quads.hours_ago).toBe(Math.round((Date.parse(NOW) - Date.parse("2026-09-27T00:00:00.000Z")) / 3_600_000));
  });
});

describe("candidateList", () => {
  const d = reportData();
  const list = candidateList(d, plan(), library(), ["triceps"]);

  it("starts with the plan's exercises, then real strength exercises of the discussed groups", () => {
    expect(list.slice(0, 6).map((c) => [c.id, c.in_plan])).toEqual(ids(plan()).map((x) => [x, true]));
    const tri = list.filter((c) => !c.in_plan && c.primary_muscle === "triceps").map((c) => c.id);
    expect(tri).toContain("tri_pushdown");
    expect(tri).toContain("oh_tri");
    // Archived and non-strength exercises are never candidates.
    expect(tri).not.toContain("tri_stretch");
    expect(tri).not.toContain("tri_old");
  });

  it("puts exercises done before first and caps each group", () => {
    const tri = list.filter((c) => !c.in_plan && c.primary_muscle === "triceps");
    expect(tri[0]).toMatchObject({ id: "oh_tri", last_done: "2026-09-26" });
    expect(list.filter((c) => !c.in_plan && c.primary_muscle === "chest").length).toBeLessThanOrEqual(CANDIDATES_PER_GROUP);
  });
});

describe("validateAdvice", () => {
  const p = plan();
  const candidates = candidateList(reportData(), p, library(), ["triceps"]);
  const s = (x: Partial<AdviceSuggestion> & Pick<AdviceSuggestion, "type" | "exercise_id">) => ({ replace_exercise_id: null, position: null, sets: null, reason_fa: "دلیل", ...x });

  it("drops suggestions whose exercise ids are unknown or do not fit the plan", () => {
    const out = AdviceOutput.parse({
      assessment_fa: "برنامهٔ خوبی است.",
      suggestions: [
        s({ type: "add", exercise_id: "tri_pushdown", position: 3, sets: 3 }),
        s({ type: "add", exercise_id: "made_up_exercise", position: 2, sets: 3 }),
        s({ type: "add", exercise_id: "bench", position: 2, sets: 3 }),
        s({ type: "remove", exercise_id: "tri_kickback" }),
        s({ type: "replace", exercise_id: "tri_kickback", replace_exercise_id: "not_in_plan" }),
        s({ type: "replace", exercise_id: "chest_00", replace_exercise_id: "incline_db" }),
        s({ type: "reorder", exercise_id: "lateral", position: 5 }),
        s({ type: "sets", exercise_id: "rdl", sets: 3 }),
        s({ type: "sets", exercise_id: "rdl", sets: 40 }),
        s({ type: "add", exercise_id: "tri_pushdown", position: 3, sets: 3 }),
        s({ type: "superset" as never, exercise_id: "bench" }),
      ],
    });
    const { advice, dropped } = validateAdvice(out, p, candidates);
    expect(advice.suggestions).toEqual([
      s({ type: "add", exercise_id: "tri_pushdown", position: 3, sets: 3 }),
      s({ type: "replace", exercise_id: "chest_00", replace_exercise_id: "incline_db" }),
      s({ type: "sets", exercise_id: "rdl", sets: 10 }),
    ]);
    expect(dropped).toBe(8);
  });

  it("brings positions and set counts into range", () => {
    const out = AdviceOutput.parse({ assessment_fa: "x", suggestions: [s({ type: "add", exercise_id: "oh_tri", position: 99, sets: 0 }), s({ type: "reorder", exercise_id: "facepull", position: -4 })] });
    expect(validateAdvice(out, p, candidates).advice.suggestions).toEqual([s({ type: "add", exercise_id: "oh_tri", position: 7, sets: 1 }), s({ type: "reorder", exercise_id: "facepull", position: 1 })]);
  });
});

describe("applySuggestion / undoSuggestion", () => {
  const T = "2026-09-28T16:00:00.000Z";
  const s = (x: Partial<AdviceSuggestion> & Pick<AdviceSuggestion, "type" | "exercise_id">): AdviceSuggestion => ({ replace_exercise_id: null, position: null, sets: null, reason_fa: "", ...x });

  it("add: the exercise goes in at the given position as an AI item; Undo removes it", () => {
    const r = applySuggestion(plan(), s({ type: "add", exercise_id: "tri_pushdown", position: 3, sets: 2 }), T, "PL1-ai1")!;
    expect(ids(r.plan)).toEqual(["bench", "incline_db", "tri_pushdown", "rdl", "cable_row", "lateral", "facepull"]);
    expect(liveItems(r.plan)[2]).toMatchObject({ id: "PL1-ai1", origin: "ai", sets: 2, reps_min: 8, reps_max: 12, rest_sec: 90 });
    expect(ids(undoSuggestion(r.plan, r.change, T))).toEqual(ids(plan()));
  });

  it("replace: the slot keeps its sets and reps, marked AI with the program's exercise; Undo restores it", () => {
    const r = applySuggestion(plan(), s({ type: "replace", exercise_id: "chest_00", replace_exercise_id: "incline_db" }), T, "x")!;
    expect(liveItems(r.plan)[1]).toMatchObject({ exercise_id: "chest_00", origin: "ai", replaced_exercise_id: "incline_db", sets: 3, reps_min: 10 });
    const back = liveItems(undoSuggestion(r.plan, r.change, T))[1];
    expect(back).toMatchObject({ exercise_id: "incline_db", origin: "program", replaced_exercise_id: null });
  });

  it("remove and reorder and sets, each undone", () => {
    const rm = applySuggestion(plan(), s({ type: "remove", exercise_id: "rdl" }), T, "x")!;
    expect(ids(rm.plan)).not.toContain("rdl");
    expect(ids(undoSuggestion(rm.plan, rm.change, T))).toEqual(ids(plan()));

    const mv = applySuggestion(plan(), s({ type: "reorder", exercise_id: "rdl", position: 1 }), T, "x")!;
    expect(ids(mv.plan)).toEqual(["rdl", "bench", "incline_db", "cable_row", "lateral", "facepull"]);
    expect(ids(undoSuggestion(mv.plan, mv.change, T))).toEqual(ids(plan()));

    const st = applySuggestion(plan(), s({ type: "sets", exercise_id: "bench", sets: 5 }), T, "x")!;
    expect(liveItems(st.plan)[0].sets).toBe(5);
    expect(liveItems(undoSuggestion(st.plan, st.change, T))[0].sets).toBe(4);
  });

  it("never splits Payam's groups: an exercise moved into a group's place lands before the group", () => {
    const grouped = groupItems(plan(), liveItems(plan()).slice(0, 2).map((it) => it.id), T);
    expect(liveItems(grouped).map((it) => it.group_tag)).toEqual(["A", "A", null, null, "B", "B"]);
    const r = applySuggestion(grouped, s({ type: "add", exercise_id: "tri_pushdown", position: 2, sets: 3 }), T, "PL1-ai2")!;
    expect(ids(r.plan)).toEqual(["tri_pushdown", "bench", "incline_db", "rdl", "cable_row", "lateral", "facepull"]);
    expect(liveItems(r.plan).map((it) => it.group_tag)).toEqual([null, "A", "A", null, null, "B", "B"]);
  });

  it("does nothing when the suggestion no longer fits the plan", () => {
    expect(applySuggestion(plan(), s({ type: "remove", exercise_id: "tri_pushdown" }), T, "x")).toBeNull();
    expect(applySuggestion(plan(), s({ type: "add", exercise_id: "bench", position: 1, sets: 3 }), T, "x")).toBeNull();
  });
});

describe("ADVICE_SYSTEM", () => {
  it("the 48-hour rule is advice with options, never a ban and never a reason to remove an exercise (Payam, 2026-10-15)", () => {
    expect(ADVICE_SYSTEM).toContain("recovery, as advice and never a ban: a muscle group should get 48 hours between heavy compound lifts");
    expect(ADVICE_SYSTEM).toContain("Chest had heavy bench 24 h ago: today prefer isolation or a lighter incline, or move heavy incline to tomorrow");
    expect(ADVICE_SYSTEM).toContain("he chooses. Never suggest removing an exercise because of recovery");
    expect(ADVICE_SYSTEM).not.toMatch(/no heavy compound/i);
  });
});

import { describe, expect, it } from "vitest";
import { reportData } from "../fixtures/report-data";
import { libraryExercises } from "../fixtures/generator/pool";
import { COACH_SYSTEM, contextBlock } from "../../worker/lib/coach/prompt";
import { getProgram, runTool, type CoachData } from "../../worker/lib/coach/tools";
import { exerciseDraft, type ExerciseChange } from "../../worker/lib/coach/exerciseTool";
import { rotationFacts, rotationLines } from "../../worker/lib/coach/rotationContext";
import { equipmentRole } from "../../worker/lib/coach/rotationTools";
import { buildOverviewInput } from "../../worker/lib/ai/overview";
import { DEFAULT_CALENDAR_SETTINGS } from "../../worker/lib/calendar";
import { blockMix, equipKind, mainLiftOk } from "../../worker/lib/generator";
import { groupOf } from "../../worker/lib/muscles";
import type { ProgramVersion } from "../../worker/lib/types";

// SPEC-v11 Phase B (Payam, 2026-10-17): the due line's Coach. suggest_replacements gives 2–3 replacements by the
// rotation rules, propose_exercise's replace mode shows them on the one-exercise card (Only this session / Whole
// program), and the CONTEXT block, get_program and the weekly review carry the rotation facts.

const base = reportData();
const version: ProgramVersion = {
  ...base.program,
  style: "seed_full_body",
  days_per_week: 4,
  params: null,
  generated_by: "seed",
  created_at: "2026-09-01T00:00:00.000Z",
  approved_at: null,
  archived_at: null,
  status: "active",
  activations: [{ id: "a1", program_id: base.program.id, started_at: "2026-09-14T06:00:00.000Z", ended_at: null }],
};
const data = (): CoachData => ({
  ...base,
  // The whole library with its region tags, as loadCoachData reads it.
  exercises: libraryExercises(),
  programs: [version],
  sessions: base.sessions.filter((s) => s.status === "done"),
  today: "2026-10-16",
  now: "2026-10-16T18:00:00.000Z",
  calendar: { shifts: [], plans: [], settings: DEFAULT_CALENDAR_SETTINGS },
});
type Suggestions = {
  exercise: { exercise_id: string; role: string; days: { day_id: string }[]; main_focus: { region: string; label: string }[]; equipment_role: string };
  rotation: { weeks: number; due: boolean; changes_by: number } | null;
  block: { letter: string };
  replacements: { exercise_id: string; name: string; equipment: string; main_focus: { region: string }[]; fills_gap: string[]; change: string; equipment_role: string; done_before: boolean }[];
};
const suggest = (d: CoachData, exercise_id: string) => {
  const r = runTool(d, "suggest_replacements", { exercise_id });
  if (!r.ok) throw new Error(r.error);
  return r.result as Suggestions;
};
const propose = (d: CoachData, input: unknown) => runTool(d, "propose_exercise", input, undefined, () => "01DRAFT00000000000000000000");
const ok = (r: ReturnType<typeof runTool>): ExerciseChange => {
  if (!r.ok) throw new Error(r.error);
  return r.result as ExerciseChange;
};

describe("suggest_replacements", () => {
  const d = data();
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  const programIds = new Set(base.program.days.flatMap((x) => x.exercises.map((y) => y.exercise_id)));
  const recent = new Set(d.sessions.flatMap((s) => s.sets.map((x) => x.exercise_id)));

  it("an isolation exercise: 2–3 options for other regions of the same muscle, a gap first, none in the program or used in 8 weeks", () => {
    const r = suggest(d, "fly");
    expect(r.exercise).toMatchObject({ exercise_id: "fly", role: "accessory work", days: [{ day_id: "D3" }] });
    expect(r.exercise.main_focus.map((x) => x.region)).toEqual(["chest_mid"]);
    expect(r.rotation).toMatchObject({ weeks: 2, due: false, changes_by: 4 });
    expect(r.block.letter).toBe("A");
    expect(r.replacements.length).toBeGreaterThanOrEqual(2);
    expect(r.replacements.length).toBeLessThanOrEqual(3);
    for (const x of r.replacements) {
      const e = ex.get(x.exercise_id)!;
      expect(groupOf(e.muscle_primary), e.name_en).toBe("chest");
      expect(programIds.has(e.id) || recent.has(e.id), e.name_en).toBe(false);
      expect(e.mechanic === "compound" && e.pattern !== "isolation", e.name_en).toBe(false);
      expect(x.change, e.name_en).toBe("different region");
      expect(x.main_focus.some((m) => m.region !== "chest_mid"), e.name_en).toBe(true);
      expect(x.equipment_role.length).toBeGreaterThan(0);
    }
    // The seed program has no lower-chest exercise: that gap comes first.
    expect(r.replacements[0].fills_gap).toContain("Lower chest");
    // Options differ from each other in region or equipment.
    expect(new Set(r.replacements.map((x) => `${x.main_focus.map((m) => m.region).join("+")}|${x.equipment}`)).size).toBe(r.replacements.length);
  });

  it("a main lift stays a barbell variation that can be loaded heavy", () => {
    const r = suggest(d, "bench");
    expect(r.exercise.role).toBe("main lift");
    expect(r.replacements.length).toBeGreaterThanOrEqual(2);
    for (const x of r.replacements) {
      const e = ex.get(x.exercise_id)!;
      expect(e.equipment, e.name_en).toBe("barbell");
      expect(e.pattern, e.name_en).toBe("h_push");
      expect(mainLiftOk({ ex: e, regions: x.main_focus.map((m) => m.region) } as never), e.name_en).toBe(true);
    }
    expect(r.exercise.equipment_role).toMatch(/strength and easy load progression/);
  });

  it("a muscle with one region keeps the region and changes the equipment", () => {
    const r = suggest(d, "lateral");
    expect(r.exercise.days.map((x) => x.day_id)).toEqual(["D1", "D4"]);
    expect(r.replacements.length).toBeGreaterThanOrEqual(2);
    for (const x of r.replacements) {
      expect(x.change).toBe("different equipment");
      expect(x.main_focus.map((m) => m.region)).toEqual(["shoulders_side"]);
      expect(equipKind(ex.get(x.exercise_id)!)).not.toBe("dumbbell");
    }
    // Block A's side-delt mix (dumbbell + cable) comes first.
    expect(blockMix("side_delts", 1)).toContain(equipKind(ex.get(r.replacements[0].exercise_id)!));
  });

  it("an exercise not in the program is an error the model can correct", () => {
    const r = runTool(d, "suggest_replacements", { exercise_id: "pec_deck_missing" });
    expect(r.ok).toBe(false);
    expect(runTool(d, "suggest_replacements", {}).ok).toBe(false);
  });

  it("equipment roles follow the approved table; a barbell is never 'better for growth'", () => {
    expect(equipmentRole(ex.get("bench")!)).toBe("heavy press, progression (strength and easy load progression)");
    expect(equipmentRole(ex.get("fly")!)).toBe("fly at any angle (upper/lower) (a specific region, angle or stretch)");
    expect(COACH_SYSTEM).toMatch(/never call a barbell better for growth/);
    expect(COACH_SYSTEM).toMatch(/suggest_replacements/);
  });
});

describe("propose_exercise in replace mode", () => {
  const d = data();
  const flyEntry = base.program.days.find((x) => x.id === "D3")!.exercises.find((x) => x.exercise_id === "fly")!;

  it("takes the place's sets, reps, rest and RIR; lists every day that has the replaced exercise", () => {
    const pick = suggest(d, "fly").replacements[0];
    const c = ok(propose(d, { program_day_id: "D3", exercise_id: pick.exercise_id, replaces_exercise_id: "fly", prefer: "session" }));
    expect(c.replaces).toEqual({ exercise_id: "fly", name: "Cable Chest Fly", days: [{ id: "D3", name: base.program.days.find((x) => x.id === "D3")!.name_en, position: 3 }] });
    expect(c.exercise).toMatchObject({ exercise_id: pick.exercise_id, sets: flyEntry.sets, reps_min: flyEntry.reps_min, reps_max: flyEntry.reps_max, rest_sec: flyEntry.rest_sec, basis: "program" });
    expect(c.after).toBeNull();
    expect(c.prefer).toBe("session");
    // Filling the lower-chest gap: the program check's coverage note does not get worse, nothing else is added.
    expect(c.notes.some((n) => /No main-focus exercise/.test(n))).toBe(false);
  });

  it("Whole program: the draft has the new exercise in its place on every day, with each place's numbers", () => {
    const pick = suggest(d, "lateral").replacements[0];
    const c = ok(propose(d, { program_day_id: "D1", exercise_id: pick.exercise_id, replaces_exercise_id: "lateral" }));
    expect(c.replaces!.days.map((x) => x.id)).toEqual(["D1", "D4"]);
    const draft = exerciseDraft(d, c)!;
    expect(draft.name).toBe(`Full body · 4 days · ${pick.name} for Dumbbell Lateral Raise`);
    const before = base.program.days.map((day) => day.exercises.filter((x) => x.exercise_id === "lateral"));
    draft.days.forEach((day, i) => {
      expect(day.exercises.some((x) => x.exercise_id === "lateral")).toBe(false);
      const place = before[i][0];
      const now = day.exercises.find((x) => x.exercise_id === pick.exercise_id);
      if (place) expect(now).toMatchObject({ sets: place.sets, reps_min: place.reps_min, reps_max: place.reps_max, rest_sec: place.rest_sec, group: place.superset_tag ? place.superset_tag[0] : null });
      else expect(now).toBeUndefined();
    });
    // Once the program has the new exercise, the saved card no longer builds a draft.
    const later = { ...d, programs: [{ ...version, days: draft.days.map((x, i) => ({ ...base.program.days[i], exercises: base.program.days[i].exercises.map((y) => (y.exercise_id === "lateral" ? { ...y, exercise_id: pick.exercise_id } : y)) })) }] };
    expect(exerciseDraft(later, c)).toBeNull();
  });

  it("refuses a replaced exercise that is not on the day, one already in the program, and both a place and a replacement", () => {
    expect(propose(d, { program_day_id: "D1", exercise_id: "pec_deck", replaces_exercise_id: "fly" })).toMatchObject({ ok: false });
    const pick = suggest(d, "fly").replacements[0].exercise_id;
    expect(propose(d, { program_day_id: "D3", exercise_id: "bench", replaces_exercise_id: "fly" })).toMatchObject({ ok: false, error: expect.stringMatching(/already in/) });
    expect(propose(d, { program_day_id: "D3", exercise_id: pick, replaces_exercise_id: "fly", after_exercise_id: "curl" })).toMatchObject({ ok: false });
  });
});

describe("rotation facts for the coach and the weekly review", () => {
  it("the due line's CONTEXT lines: role, weeks, due and region tags", () => {
    const d = data();
    const f = rotationFacts(d, "bench", d.today)!;
    const lines = rotationLines(f);
    expect(lines[0]).toBe("He tapped Ask Coach on the due line of the Program screen for Barbell Bench Press (bench, barbell); the app wrote his question. Answer in Persian.");
    expect(lines[1]).toBe("Rotation: a main or secondary lift (the 6–8 week rule); 2 training weeks in his program since 2026-09-14; not due yet (2 of at most 8 weeks).");
    expect(lines[2]).toMatch(/^Its main focus \(region tags\): Middle chest \(strong evidence\)\. Also trained: Upper chest \(moderate evidence\), Lower chest \(moderate evidence\)/);
    expect(contextBlock({ today: d.today, timezone: "America/Denver", unit: "lb", week_start: "mon", program: null, rotation: f })).toContain(lines[1]);
    expect(rotationFacts(d, "not_in_program", d.today)).toBeNull();
  });

  it("get_program marks each exercise's rotation and main focus, the block and the regions without a main-focus exercise", () => {
    const p = getProgram(data());
    const bench = p.days[0].exercises.find((x) => x.exercise_id === "bench")!;
    expect(bench.main_focus).toEqual(["Middle chest"]);
    expect(bench.rotation).toMatchObject({ weeks: 2, keeps_at_least: 6, changes_by: 8, weeks_until_changes_by: 6, due: false, reason: null });
    expect(p.block).toEqual({ block: 1, letter: "A" });
    expect(p.regions_without_main_focus).toContain("Lower chest");
    expect(p.regions_without_main_focus).toContain("Neck flexors (front)");
  });

  it("the weekly review gets what is due now and next week", () => {
    const d = data();
    const due = buildOverviewInput({ ...d, sessions: [...d.sessions] }, [], "2026-10-16", "seed_full_body").rotation;
    expect(due).toEqual({ due_now: [], due_next_week: [] });
    // Two more training weeks: the accessories reach 4 weeks.
    const more = [...d.sessions, ...["2026-09-29", "2026-10-06"].map((date) => ({ ...d.sessions[0], id: `X${date}`, local_date: date, started_at: `${date}T23:00:00.000Z` }))];
    const r = buildOverviewInput({ ...d, sessions: more }, [], "2026-10-16", "seed_full_body").rotation;
    expect(r.due_now.map((x) => x.name)).toContain("Cable Chest Fly");
    expect(r.due_now.find((x) => x.name === "Cable Chest Fly")!.reason).toBe("4 weeks in the program");
    expect(r.due_next_week).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { buildReportInput, nextTime, normalizeReport, ReportOutput, type ReportInput } from "../../worker/lib/ai/report";
import { suggest } from "../../worker/lib/progression";
import type { ReportData } from "../../worker/lib/reports";
import type { Exercise, SetEntry, WorkoutSession } from "../../worker/lib/types";
import { reportData } from "../fixtures/report-data";

// SPEC-v3 M9a: the AI session report's input, built server-side. Fixture: the seed program and history of
// tests/fixtures/report-data.ts plus one more Day 1 session on Monday 2026-09-28.

const stretch: Exercise = {
  id: "pec_stretch",
  name_fa: "",
  name_en: "Doorway Pec Stretch",
  muscle_primary: "chest",
  is_lower: false,
  equipment: "bodyweight",
  cue_fa: "",
  cue_en: null,
  source: "fedb",
  muscles_secondary: [],
  pattern: null,
  mechanic: null,
  level: null,
  media: [],
  instructions_en: [],
  archived_at: null,
  category: "stretching",
};

let k = 0;
const set = (exercise_id: string, set_index: number, weight: number | null, reps: number | null, done = true, extra: Partial<SetEntry> = {}): SetEntry => ({
  id: `T-${k++}`,
  exercise_id,
  set_index,
  weight,
  reps,
  seconds: null,
  done,
  rir: null,
  updated_at: "2026-09-29T00:30:00.000Z",
  ...extra,
});

/** Day 1 on Monday 2026-09-28: bench 3 of 4 sets, incline press skipped, an extra curl and a stretch (0 volume). */
function today(): WorkoutSession {
  return {
    id: "T1",
    program_day_id: "D1",
    local_date: "2026-09-28",
    started_at: "2026-09-28T23:00:00.000Z",
    ended_at: "2026-09-29T00:05:00.000Z",
    status: "done",
    unit: "lb",
    note: "Shoulder felt fine.",
    created_at: "2026-09-28T23:00:00.000Z",
    updated_at: "2026-09-29T00:05:00.000Z",
    source: "app",
    sets: [
      set("bench", 0, 140, 5),
      set("bench", 1, 140, 5),
      set("bench", 2, 140, 5),
      set("bench", 3, 140, null, false),
      set("rdl", 0, 160, 8),
      set("rdl", 1, 160, 8),
      set("rdl", 2, 160, 8),
      set("cable_row", 0, 100, 10),
      set("cable_row", 1, 100, 10),
      set("cable_row", 2, 100, 10),
      set("lateral", 0, 15, 12),
      set("lateral", 1, 15, 12),
      set("lateral", 2, 15, 12),
      set("facepull", 0, 40, 15),
      set("facepull", 1, 40, 15),
      set("facepull", 2, 40, 15),
      set("curl", 0, 30, 10, true, { is_extra: true, position: 0 }),
      set("curl", 1, 30, 9, true, { is_extra: true, position: 0 }),
      set("pec_stretch", 0, null, null, true, { is_extra: true, position: 1, seconds: 30 }),
    ],
  };
}

function data(): ReportData {
  const d = reportData();
  d.exercises.push(stretch);
  d.sessions.push(today());
  d.watch.push({ id: "W9", activity_type: null, started_at: "", ended_at: null, duration_sec: null, active_kcal: 310, total_kcal: null, hr_avg: 125, hr_max: 160, matched_session_id: "T1", kind: "session" });
  d.body.push({ local_date: "2026-09-28", kind: "body_mass", value: 180, unit: "lb", source: "manual" });
  return d;
}

const vol = (input: ReportInput, key: string) => input.week_so_far.volume.find((v) => v.key === key);

describe("buildReportInput", () => {
  const input = buildReportInput(data(), "T1", null);

  it("covers the session: day, local times, duration, unit and note", () => {
    expect(input.session).toEqual({ date: "2026-09-28", program_day: "Day 1 · Chest", start: "17:00", end: "18:05", duration_min: 65, unit: "lb", note: "Shoulder felt fine." });
  });

  it("lists the planned exercises in order, then the extras, with done sets only", () => {
    expect(input.exercises.map((x) => [x.exercise_id, x.is_extra])).toEqual([
      ["bench", false],
      ["incline_db", false],
      ["rdl", false],
      ["cable_row", false],
      ["lateral", false],
      ["facepull", false],
      ["curl", true],
      ["pec_stretch", true],
    ]);
    const bench = input.exercises[0];
    expect(bench.planned).toEqual({ sets: 4, reps: "5", seconds: null, per_leg: false, target_rir: null });
    expect(bench.done_sets).toHaveLength(3);
    expect(bench.not_done_sets).toBe(1);
    expect(input.exercises.find((x) => x.exercise_id === "lateral")!.group).toBe("A1");
  });

  it("includes the extra exercise with its sets and no planned target", () => {
    const curl = input.exercises.find((x) => x.exercise_id === "curl")!;
    expect(curl).toMatchObject({ is_extra: true, planned: null, counts_volume: true, not_done_sets: 0, app_next_time: null });
    expect(curl.done_sets).toEqual([
      { weight: 30, reps: 10, seconds: null, rir: null },
      { weight: 30, reps: 9, seconds: null, rir: null },
    ]);
  });

  it("includes a 0-volume exercise, marked as not counted in volume", () => {
    const st = input.exercises.find((x) => x.exercise_id === "pec_stretch")!;
    expect(st).toMatchObject({ is_extra: true, category: "stretching", counts_volume: false });
    expect(st.done_sets).toEqual([{ weight: null, reps: null, seconds: 30, rir: null }]);
    // Its chest set adds nothing: chest today is the 3 bench sets only.
    expect(vol(input, "chest")!.today).toBe(3);
  });

  it("lists missed exercises and missed sets", () => {
    expect(input.missed).toEqual({ exercises_not_done: ["Incline Dumbbell Press"], partly_done: [{ name: "Barbell Bench Press", planned_sets: 4, done_sets: 3 }] });
    expect(input.exercises.find((x) => x.exercise_id === "incline_db")).toMatchObject({ done_sets: [], not_done_sets: 3 });
  });

  it("compares with the previous session of the same day and finds today's records", () => {
    const bench = input.exercises[0];
    expect(bench.previous_same_day).toMatchObject({ date: "2026-09-21", best_e1rm: 157.5 });
    expect(bench.previous_same_day!.sets).toHaveLength(4);
    expect(bench.best_e1rm_today).toBe(163.3);
    expect(input.prs_today).toContainEqual({ name: "Barbell Bench Press", weight: 140, reps: 5, e1rm: 163.3, previous_best_e1rm: 157.5 });
  });

  it("gives the app's own progression for next time", () => {
    // Bench: 3 of 4 planned sets done → same weight. RDL (lower body): 3 × 8 at 160 lb, all at the top → +10 lb.
    expect(input.exercises[0].app_next_time).toEqual({ kind: "weight", weight: 140, unit: "lb", seconds: null, reps: "5", change: "same", step: 0 });
    expect(input.exercises.find((x) => x.exercise_id === "rdl")!.app_next_time).toEqual({ kind: "weight", weight: 170, unit: "lb", seconds: null, reps: "8", change: "up", step: 10 });
    // Lateral raise (dumbbell): 3 × 12 at 15 lb, all at the top → +5 lb per dumbbell. Extras get none.
    expect(input.exercises.find((x) => x.exercise_id === "lateral")!.app_next_time).toMatchObject({ weight: 20, change: "up", step: 5 });
    expect(input.exercises.find((x) => x.exercise_id === "curl")!.app_next_time).toBeNull();
  });

  it("counts each set at most once per group (cable row: upper back + lats are both Back)", () => {
    // 3 cable rows count 3 for Back (not 4.5); 3 face pulls add 0.5 each through their upper-back secondary.
    expect(vol(input, "back")!.today).toBe(4.5);
    expect(vol(input, "biceps")!.today).toBe(2 + 1.5);
  });

  it("has the week so far against the targets, and the session count", () => {
    expect(input.week_so_far).toMatchObject({ start: "2026-09-28", end: "2026-10-04", sessions_done: 1, sessions_planned: 4 });
    const chest = vol(input, "chest")!;
    expect(chest).toMatchObject({ group: "Chest", today: 3, week: 3, status: "under" });
    expect(chest.target).toBeGreaterThan(0);
    // Every targeted group is listed; untargeted ones only when trained.
    expect(input.week_so_far.volume.map((v) => v.key)).toEqual(expect.arrayContaining(["chest", "back", "quads", "calves", "core", "forearms", "lower_back"]));
    expect(input.week_so_far.volume.map((v) => v.key)).not.toContain("neck");
  });

  it("adds the watch numbers and body weight when present", () => {
    expect(input.watch).toEqual({ hr_avg: 125, hr_max: 160, active_kcal: 310 });
    expect(input.body_weight).toMatchObject({ unit: "lb", today: 180 });
    expect(input.body_weight!.weekly_avg_last_4_weeks.map((w) => w.week_start)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
  });

  it("follows the session's plan when it has one (order, sets, added exercises)", () => {
    const d = data();
    const plan = {
      id: "T1",
      program_day_id: "D1",
      status: "started" as const,
      started_at: "2026-09-28T23:00:00.000Z",
      created_at: "2026-09-28T22:00:00.000Z",
      updated_at: "2026-09-28T23:00:00.000Z",
      items: ["rdl", "bench", "cable_row"].map((x, i) => ({
        id: `T1-${i + 1}`,
        exercise_id: x,
        position: i,
        sets: 3,
        reps_min: 5,
        reps_max: 8,
        per_leg: false,
        is_time: false,
        rest_sec: 120,
        target_rir_min: 1,
        target_rir_max: 2,
        origin: "program" as const,
        replaced_exercise_id: null,
        group_tag: null,
        group_rest_sec: null,
        removed_at: null,
        created_at: "2026-09-28T22:00:00.000Z",
        updated_at: "2026-09-28T22:00:00.000Z",
      })),
    };
    const p = buildReportInput(d, "T1", plan);
    expect(p.exercises.slice(0, 3).map((x) => x.exercise_id)).toEqual(["rdl", "bench", "cable_row"]);
    expect(p.exercises[1].planned).toEqual({ sets: 3, reps: "5–8", seconds: null, per_leg: false, target_rir: "1–2" });
    // Not in the plan: logged exercises count as extras, and the skipped incline press is no longer "missed".
    expect(p.exercises.find((x) => x.exercise_id === "lateral")!.is_extra).toBe(true);
    expect(p.missed.exercises_not_done).toEqual([]);
  });
});

describe("Next time comes from the progression function, never the model", () => {
  const d = data();
  const input = buildReportInput(d, "T1", null);
  const day1 = d.program.days.find((x) => x.id === "D1")!;
  const session = d.sessions.find((x) => x.id === "T1")!;
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  /** The progression function's own answer for an exercise of today's session, computed here independently. */
  const expected = (id: string) => {
    const plan = day1.exercises.find((x) => x.exercise_id === id)!;
    const s = suggest(plan, ex.get(id)!, { session_id: "T1", local_date: session.local_date, unit: session.unit, sets: session.sets.filter((x) => x.exercise_id === id) });
    return { s, row: nextTime(s, plan.is_time ? null : plan.reps_min === plan.reps_max ? String(plan.reps_min) : `${plan.reps_min}–${plan.reps_max}`, session.unit) };
  };

  it("the report's next-time weights equal the progression function's output, whatever the model writes", () => {
    const out = ReportOutput.parse({
      summary_fa: "خوب بود.",
      highlights: [],
      extras_note_fa: null,
      missed_note_fa: null,
      // The model tries numbers and an exercise the app has no progression for: both are ignored.
      next_time: [
        { exercise_id: "bench", note_fa: "دفعهٔ بعد ۱۵۰ پوند بزن." },
        { exercise_id: "rdl", note_fa: "همین روند را ادامه بده و فرم را حفظ کن." },
        { exercise_id: "curl", note_fa: "بیشتر وزنه بزن." },
      ],
      warnings: [],
      where_fa: [],
      motivation_fa: "ادامه بده.",
    });
    const r = normalizeReport(out, input);
    const ids = ["bench", "rdl", "cable_row", "lateral", "facepull"];
    expect(r.next_time.map((n) => n.exercise_id)).toEqual(ids);
    for (const n of r.next_time) {
      const { s, row } = expected(n.exercise_id);
      expect(s.kind).toBe("weight");
      if (s.kind !== "weight") continue;
      expect(n.weight).toBe(s.weight);
      expect(n.unit).toBe(s.unit);
      expect(n).toMatchObject(row!);
    }
    expect(r.next_time.map((n) => [n.exercise_id, n.weight, n.change])).toEqual([
      ["bench", 140, "same"],
      ["rdl", 170, "up"],
      ["cable_row", 105, "up"],
      ["lateral", 20, "up"],
      ["facepull", 45, "up"],
    ]);
    // A note with any number (Persian digits too) is not shown; a note without numbers is.
    expect(r.next_time.find((n) => n.exercise_id === "bench")!.note_fa).toBeNull();
    expect(r.next_time.find((n) => n.exercise_id === "rdl")!.note_fa).toBe("همین روند را ادامه بده و فرم را حفظ کن.");
  });

  it("RIR 3+ on every planned set doubles the increment", () => {
    const d2 = data();
    const t = d2.sessions.find((x) => x.id === "T1")!;
    t.sets = t.sets.map((x) => (x.exercise_id === "rdl" ? { ...x, rir: 3 } : x));
    const n = normalizeReport(ReportOutput.parse({ summary_fa: "x", highlights: [], extras_note_fa: null, missed_note_fa: null, next_time: [], warnings: [], where_fa: [], motivation_fa: "x" }), buildReportInput(d2, "T1", null));
    expect(n.next_time.find((x) => x.exercise_id === "rdl")).toMatchObject({ weight: 180, change: "up2", step: 20 });
  });
});

describe("normalizeReport", () => {
  const where = { weeks: [{ start: "2026-09-28", this_week: true, sessions_done: 2, sessions_planned: 4 }], totals: { since: "2026-09-01", sessions_done: 9, sessions_planned: 16 }, unit: "lb" as const, lifts: [{ name: "Barbell Bench Press", sessions: 3, first_e1rm: 150, latest_e1rm: 157.5, change_pct: 5 }], stalls: [], drops: [] };
  const reply = (over: Partial<ReportOutput> = {}) =>
    ReportOutput.parse({
      summary_fa: "جلسهٔ خوبی بود.",
      highlights: Array.from({ length: 10 }, (_, i) => `نکتهٔ ${i + 1}`),
      extras_note_fa: null,
      missed_note_fa: "پرس بالاسینه انجام نشد.",
      next_time: [],
      warnings: [],
      where_fa: [],
      motivation_fa: "همین مسیر را ادامه بده.",
      ...over,
    });

  it("keeps the prose; the volume rows are the input's own, every group of the week (the model writes none)", () => {
    const input = buildReportInput(data(), "T1", null);
    const r = normalizeReport(reply(), input);
    expect(r.volume).toEqual(input.week_so_far.volume.map(({ group, today, week, target, status }) => ({ group, today, week, target, status })));
    expect(r.volume.some((v) => v.today === 0)).toBe(true);
    expect(r.summary_fa).toBe("جلسهٔ خوبی بود.");
    // List lengths are not enforced by the API: over-long lists are cut, not rejected.
    expect(r.highlights).toHaveLength(8);
  });

  it("Where you are: at most 4 lines, each with only where_you_are's numbers (rounded as prose rounds; 1RM is a term)", () => {
    const input = { ...buildReportInput(data(), "T1", null), where_you_are: where };
    const r = normalizeReport(
      reply({
        where_fa: ["از ۱۶ جلسهٔ برنامه ۹ جلسه انجام شد.", "پرس سینه 5٪ بهتر شد و 1RM تخمینی به ۱۵۷٫۵ رسید.", "هفتهٔ بعد ۲۰ ست بزن.", "روند خوب است.", "ادامه بده.", "ثابت بمان."],
      }),
      input
    );
    expect(r.where_fa).toEqual(["از ۱۶ جلسهٔ برنامه ۹ جلسه انجام شد.", "پرس سینه 5٪ بهتر شد و 1RM تخمینی به ۱۵۷٫۵ رسید.", "روند خوب است.", "ادامه بده."]);
    expect(r.where_dropped).toBe(1);
    // A percentage must be one the app computed: 9 is a count, not a change.
    expect(normalizeReport(reply({ where_fa: ["پرس سینه ۹٪ بهتر شد."] }), input).where_fa).toEqual([]);
    // No where_you_are (or no input): no number passes.
    expect(normalizeReport(reply({ where_fa: ["۹ جلسه انجام شد.", "روند خوب است."] }), { ...input, where_you_are: null }).where_fa).toEqual(["روند خوب است."]);
  });

  it("the motivational line is kept without numbers or with the input's own; a number from nowhere drops it", () => {
    const input = { ...buildReportInput(data(), "T1", null), where_you_are: where, recent_motivation: ["امروز ۴۴۴ بار قوی‌تر بودی."] };
    expect(normalizeReport(reply(), input).motivation_fa).toBe("همین مسیر را ادامه بده.");
    expect(normalizeReport(reply({ motivation_fa: "  ۹ جلسه از ۱۶ جلسه؛ ادامه بده.  " }), input).motivation_fa).toBe("۹ جلسه از ۱۶ جلسه؛ ادامه بده.");
    expect(normalizeReport(reply({ motivation_fa: "امروز ۹۹۹ بار قوی‌تر بودی." }), input).motivation_fa).toBeNull();
    // An earlier line's numbers are not the input's facts.
    expect(normalizeReport(reply({ motivation_fa: "امروز ۴۴۴ بار قوی‌تر بودی." }), input).motivation_fa).toBeNull();
  });
});

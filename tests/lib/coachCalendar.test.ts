import { describe, expect, it } from "vitest";
import { reportData } from "../fixtures/report-data";
import { DEFAULT_CALENDAR_SETTINGS, toMin, type GymPlan, type WorkShift } from "../../worker/lib/calendar";
import { COACH_TOOLS, getTrainingPattern, runTool, type CoachData } from "../../worker/lib/coach/tools";
import { MAX_CALENDAR_DAYS } from "../../worker/lib/coach/calendarTools";
import { draftSpacing, proposeProgram } from "../../worker/lib/coach/draft";
import { COACH_SYSTEM } from "../../worker/lib/coach/prompt";

// SPEC-v10 M13 §6 and §10 with Payam's change of 2026-10-15: the coach reads the calendar and the finder, proposes only
// the finder's times, and everything is advice. Today is Monday 2026-10-19, 06:00 in Denver (UTC−6).
const shift = (id: string, date: string, from: string, to: string): WorkShift => ({ id, date, start_min: toMin(from), end_min: toMin(to), note: "", created_at: "x", updated_at: "x" });
const plan = (id: string, date: string, start: string, day: string, more: Partial<GymPlan> = {}): GymPlan => ({
  id,
  date,
  start_min: toMin(start),
  end_min: toMin(start) + 60,
  program_day_id: day,
  source: "manual",
  session_id: null,
  status: "planned",
  reminder_at: null,
  created_at: "x",
  updated_at: "x",
  ...more,
});
const data = (shifts: WorkShift[] = [shift("w1", "2026-10-19", "12:00", "20:00")], plans: GymPlan[] = []): CoachData => ({
  ...reportData(),
  today: "2026-10-19",
  now: "2026-10-19T12:00:00.000Z",
  calendar: { shifts, plans, settings: DEFAULT_CALENDAR_SETTINGS },
});
type Slots = { week_start: string; need: number; slots: { date: string; start: string; end: string; selected: boolean; before_shift_at: string | null; day: string | null; days_in_a_row: number }[] };
type Schedule = { shown: boolean; week_start: string; sessions: { date: string; start: string; end: string; program_day_id: string; day: string; reason_fa: string }[]; dropped: { date: string; start: string; reason: string }[] };
const ok = <T>(r: ReturnType<typeof runTool>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.result as T;
};

describe("coach calendar tools", () => {
  it("are offered to the model", () => {
    expect(COACH_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["get_calendar", "find_free_slots", "propose_schedule"]));
  });

  it("find_free_slots: the week holding week_start, one suggestion a day, the app's own times (12:00–20:00 → 08:00)", () => {
    const r = ok<Slots>(runTool(data(), "find_free_slots", { week_start: "2026-10-21" }));
    expect(r.week_start).toBe("2026-10-19");
    expect(r.need).toBe(4);
    const mon = r.slots.find((x) => x.date === "2026-10-19")!;
    expect([mon.start, mon.before_shift_at, mon.selected]).toEqual(["08:00", "12:00", true]);
    expect(mon.day).toMatch(/^Day \d · /);
    expect(new Set(r.slots.map((x) => x.date)).size).toBe(r.slots.length);
    expect(runTool(data(), "find_free_slots", { week_start: "next week" })).toMatchObject({ ok: false });
  });

  it("propose_schedule keeps the finder's times, drops anything else and says why", () => {
    const r = ok<Schedule>(
      runTool(data(), "propose_schedule", {
        sessions: [
          { date: "2026-10-19", start: "08:00", reason_fa: "قبل از شیفت طولانی" },
          { date: "2026-10-20", start: "13:37", reason_fa: "ساعت دلخواه" },
          { date: "2026-10-19", start: "08:00", reason_fa: "دوباره" },
        ],
      })
    );
    expect(r.shown).toBe(true);
    expect(r.week_start).toBe("2026-10-19");
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ date: "2026-10-19", start: "08:00", reason_fa: "قبل از شیفت طولانی" });
    expect(r.dropped).toEqual([
      { date: "2026-10-20", start: "13:37", reason: "not a find_free_slots time for that week" },
      { date: "2026-10-19", start: "08:00", reason: "a second session on the same day" },
    ]);
  });

  it("propose_schedule: a program day he names is kept with its length; only invented times is an error to fix", () => {
    const r = ok<Schedule>(runTool(data(), "propose_schedule", { sessions: [{ date: "2026-10-19", start: "08:00", program_day_id: "D4", reason_fa: "x" }] }));
    expect(r.sessions[0]).toMatchObject({ program_day_id: "D4", day: "Day 4 · Deadlift", end: "08:55" });
    const bad = runTool(data(), "propose_schedule", { sessions: [{ date: "2026-10-20", start: "06:30", reason_fa: "x" }] });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/Call find_free_slots and use its times/);
    expect(runTool(data(), "propose_schedule", { sessions: [] })).toMatchObject({ ok: false });
  });

  it("get_calendar: shifts, plans with their state and logged sessions; at most 31 days", () => {
    const d = data([shift("w1", "2026-10-19", "12:00", "20:00")], [plan("p1", "2026-10-16", "17:00", "D1"), plan("p2", "2026-10-21", "08:00", "D2")]);
    const r = ok<{ shifts: unknown[]; plans: { date: string; status: string; day: string }[] }>(runTool(d, "get_calendar", { from: "2026-10-12", to: "2026-10-25" }));
    expect(r.shifts).toEqual([{ date: "2026-10-19", weekday: "Mon", start: "12:00", end: "20:00", note: "" }]);
    expect(r.plans.map((p) => [p.date, p.status, p.day])).toEqual([
      ["2026-10-16", "missed", "Day 1 · Chest"],
      ["2026-10-21", "planned", "Day 2 · Legs"],
    ]);
    expect(runTool(d, "get_calendar", { from: "2026-10-01", to: "2026-11-15" })).toMatchObject({ ok: false, error: `At most ${MAX_CALENDAR_DAYS} days per call.` });
  });
});

describe("§10: planned dates replace the 4-week pattern", () => {
  it("get_training_pattern gives this week's plans and says so", () => {
    const r = getTrainingPattern(data(undefined, [plan("p1", "2026-10-20", "08:00", "D1"), plan("p2", "2026-10-22", "17:30", "D2")]));
    expect(r.source).toBe("calendar");
    expect(r.planned_this_week.map((p) => [p.weekday, p.start, p.day])).toEqual([
      ["Tue", "08:00", "Day 1 · Chest"],
      ["Thu", "17:30", "Day 2 · Legs"],
    ]);
    expect(r.summary).toBe("Planned this week: Tue 08:00 Day 1 · Chest, Thu 17:30 Day 2 · Legs");
    expect(getTrainingPattern(data()).source).toBe("pattern");
  });

  it("draft spacing: a pair planned on consecutive days gets a plain warning, a pair planned apart none", () => {
    const d = data();
    const ex = new Map(d.exercises.map((e) => [e.id, e]));
    const x = (id: string, more: object = {}) => ({ exercise_id: id, sets: 3, reps_min: 8, reps_max: 10, rest_sec: 90, group: null, is_main: false, ...more });
    const days = [
      { name: "Day 1 · A", exercises: [x("bench", { is_main: true }), x("rdl")] },
      { name: "Day 2 · B", exercises: [x("incline_bb", { is_main: true }), x("deadlift")] },
    ];
    expect(draftSpacing(days, ex, new Map([[1, "2026-10-20"], [2, "2026-10-21"]]))).toEqual([
      "Day 1 (Tue) and Day 2 (Wed) are planned on consecutive days: that is two heavy hinges within 24 h.",
      "Day 1 (Tue) and Day 2 (Wed) are planned on consecutive days: Chest has a main lift on both days.",
      "Day 1 (Tue) and Day 2 (Wed) are planned on consecutive days: Hamstrings & glutes is trained on both days.",
    ]);
    expect(draftSpacing(days, ex, new Map([[1, "2026-10-20"], [2, "2026-10-22"]]))).toEqual([]);
    // Without plans: the conditional advice as before.
    expect(draftSpacing(days, ex)[0]).toBe("If you train Day 1 and Day 2 back to back, that is two heavy hinges within 24 h.");
  });

  it("the coach's propose_program uses this week's planned dates", () => {
    const d = data(undefined, [plan("p1", "2026-10-20", "08:00", "D1"), plan("p2", "2026-10-22", "08:00", "D2")]);
    const r = runTool(d, "propose_program", {
      name: "X",
      days: [
        { name: "Day 1 · A", exercises: [{ exercise_id: "bench", sets: 3, reps_min: 5, reps_max: 5, rest_sec: 180, is_main: true }] },
        { name: "Day 2 · B", exercises: [{ exercise_id: "incline_bb", sets: 3, reps_min: 5, reps_max: 5, rest_sec: 180, is_main: true }] },
      ],
    });
    if (!r.ok) throw new Error(r.error);
    expect((r.result as { warnings: string[] }).warnings.filter((w) => /back to back|consecutive/.test(w))).toEqual([]);
    expect(proposeProgram(d, { name: "Y", days: [] }, "x").ok).toBe(false);
  });
});

describe("coach prompt (calendar)", () => {
  it("times only from the tools, nothing saved without his tap, advice only", () => {
    expect(COACH_SYSTEM).toContain("Never invent a time or compute one yourself");
    expect(COACH_SYSTEM).toContain('Nothing goes on his calendar until he taps "Add to calendar"');
    expect(COACH_SYSTEM).toContain("never say a day or time is not allowed");
    expect(COACH_SYSTEM).not.toContain("at most two training days in a row");
  });
});

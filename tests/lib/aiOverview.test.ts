import { describe, expect, it } from "vitest";
import { buildOverviewInput, checkOverview, normalizeOverview, numbersIn, OverviewOutput, percentsIn, suppliedNumbers } from "../../worker/lib/ai/overview";
import type { ReportData } from "../../worker/lib/reports";
import type { WorkoutSession } from "../../worker/lib/types";
import { reportData } from "../fixtures/report-data";

// SPEC-v7 M9d: the training overview's input (this week and the previous 4, approved 2026-10-13) is raw training data
// computed by the app; the model's prose keeps only numbers the app supplied.

const TODAY = "2026-09-28"; // a Monday; weeks start on Monday in the fixture

let n = 0;
function session(id: string, day: string, date: string, sets: [string, number, number, number][], note = ""): WorkoutSession {
  return {
    id,
    program_day_id: day,
    local_date: date,
    started_at: `${date}T23:00:00.000Z`,
    ended_at: `${date}T23:55:00.000Z`,
    status: "done",
    unit: "lb",
    note,
    created_at: `${date}T23:00:00.000Z`,
    updated_at: `${date}T23:55:00.000Z`,
    source: "app",
    sets: sets.flatMap(([ex, count, w, r]) =>
      Array.from({ length: count }, (_, i) => ({ id: `${id}-${n++}`, exercise_id: ex, set_index: i, weight: w, reps: r, seconds: null, done: true, rir: 1, updated_at: `${date}T23:30:00.000Z` }))
    ),
  };
}

function data(): ReportData {
  const d = reportData();
  // Bench stays at 135 × 5 for three more sessions (a stall); squat falls from 185 × 5 to 150 × 5 (a drop).
  d.sessions.push(
    session("X1", "D1", "2026-09-24", [["bench", 4, 135, 5]]),
    session("X2", "D1", "2026-09-25", [["bench", 4, 135, 5]]),
    session("X3", "D1", "2026-09-28", [["bench", 4, 135, 5], ["squat", 3, 150, 5]], "Left shoulder a bit sore.")
  );
  return d;
}

describe("buildOverviewInput", () => {
  const input = buildOverviewInput(data(), [], TODAY, "seed_full_body");

  it("covers this week and the previous 4, this week marked", () => {
    expect(input.window).toEqual({ start: "2026-08-31", end: TODAY, today: TODAY, weeks: 5, unit: "lb" });
    expect(input.weeks.map((w) => [w.start, w.this_week, w.sessions_done, w.sessions_planned])).toEqual([
      ["2026-08-31", false, 0, 4],
      ["2026-09-07", false, 0, 4],
      ["2026-09-14", false, 2, 4],
      ["2026-09-21", false, 5, 4],
      ["2026-09-28", true, 1, 4],
    ]);
    // No activation in the data: every week plans the program's 4 days.
    expect(input.program.started).toBeNull();
    expect(input.totals).toEqual({ since: "2026-08-31", sessions_done: 8, sessions_planned: 20 });
    // Sessions before the window (Aug 20) and unfinished ones are left out.
    expect(input.sessions.map((s) => s.date)).toEqual(["2026-09-15", "2026-09-18", "2026-09-21", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-28"]);
  });

  it("counts planned sessions only from the active program's start when it started mid-window (Payam, 2026-10-13)", () => {
    // Activated on Thursday 2026-09-17 at noon in Denver: the week of Sep 14 plans its last 4 days (4 × 4/7 = 2.3, shown
    // as 2), the weeks before plan none, and the totals count done sessions from the same day (Sep 15 is before it).
    // Planned counts are whole sessions (round(10.3) = 10).
    const d = data();
    const info = (acts: [string, string | null][]) => ({
      id: "fullbody4", name: "Full body", style: null, days_per_week: 4, params: null, generated_by: null, created_at: "2026-08-01T00:00:00.000Z", approved_at: null, archived_at: null,
      status: "active" as const, activations: acts.map(([started_at, ended_at], i) => ({ id: `a${i}`, program_id: "fullbody4", started_at, ended_at })),
      days: d.program.days,
    });
    const mid = buildOverviewInput({ ...d, programs: [info([["2026-09-17T18:00:00.000Z", null]])] }, [], TODAY, null);
    expect(mid.program.started).toBe("2026-09-17");
    expect(mid.weeks.map((w) => [w.start, w.sessions_planned, w.sessions_done])).toEqual([
      ["2026-08-31", 0, 0],
      ["2026-09-07", 0, 0],
      ["2026-09-14", 2, 2],
      ["2026-09-21", 4, 5],
      ["2026-09-28", 4, 1],
    ]);
    expect(mid.totals).toEqual({ since: "2026-09-17", sessions_done: 7, sessions_planned: 10 });
    // Activated on the Sunday ending a week (like production, Sep 27): that week plans 4/7, the totals 12.6 → 13.
    const sunday = buildOverviewInput({ ...d, programs: [info([["2026-09-27T06:00:00.000Z", null]])] }, [], TODAY, null);
    expect(sunday.weeks.map((w) => w.sessions_planned)).toEqual([0, 0, 0, 1, 4]);
    expect(sunday.totals).toMatchObject({ since: "2026-09-27", sessions_planned: 5 });
    // Activated before the window: the whole window plans the program's days.
    const before = buildOverviewInput({ ...d, programs: [info([["2026-08-01T18:00:00.000Z", null]])] }, [], TODAY, null);
    expect(before.program.started).toBe("2026-08-01");
    expect(before.totals).toEqual({ since: "2026-08-31", sessions_done: 8, sessions_planned: 20 });
  });

  it("a program switch and a re-activation never reset the count: each day plans the program active then (option A, 2026-10-14)", () => {
    const d = data();
    const version = (id: string, dpw: number, acts: [string, string | null][], days = d.program.days) => ({
      id, name: id, style: null, days_per_week: dpw, params: null, generated_by: null, created_at: "2026-08-01T00:00:00.000Z", approved_at: null, archived_at: null,
      status: "active" as const, activations: acts.map(([started_at, ended_at], i) => ({ id: `${id}-${i}`, program_id: id, started_at, ended_at })), days,
    });
    // Full body (4 a week) from Sep 3; a 3-day program from Wed Sep 16; Full body again from Wed Sep 23 (noon in Denver).
    const programs = [
      version("fullbody4", 4, [["2026-09-03T18:00:00.000Z", "2026-09-16T18:00:00.000Z"], ["2026-09-23T18:00:00.000Z", null]]),
      version("gen3", 3, [["2026-09-16T18:00:00.000Z", "2026-09-23T18:00:00.000Z"]], d.program.days.slice(0, 3)),
    ];
    const input = buildOverviewInput({ ...d, programs }, [], TODAY, null);
    // The active program was re-activated Sep 23, but the count runs from the first activation (Sep 3).
    expect(input.program.started).toBe("2026-09-23");
    expect(input.weeks.map((w) => [w.start, w.sessions_planned])).toEqual([
      ["2026-08-31", 2], // Sep 3–6 at 4 a week: 16/7
      ["2026-09-07", 4],
      ["2026-09-14", 3], // Sep 14–15 at 4, Sep 16–20 at 3: 23/7
      ["2026-09-21", 4], // Sep 21–22 at 3, Sep 23–27 at 4: 26/7
      ["2026-09-28", 4],
    ]);
    // Every session since Sep 3 counts, including the ones before the re-activation.
    expect(input.totals).toEqual({ since: "2026-09-03", sessions_done: 8, sessions_planned: 17 });
  });

  it("has the raw sets and Payam's own notes, and no AI text", () => {
    const x3 = input.sessions.at(-1)!;
    expect(x3).toMatchObject({ day: "Day 1 · Chest", note: "Left shoulder a bit sore.", duration_min: 55 });
    expect(x3.exercises[0]).toEqual({ name: "Barbell Bench Press", counts_volume: true, sets: ["135×5 RIR 1 lb", "135×5 RIR 1 lb", "135×5 RIR 1 lb", "135×5 RIR 1 lb"] });
    const json = JSON.stringify(input);
    for (const key of ["summary_fa", "highlights", "report", "overview", "next_time", "assessment"]) expect(json).not.toContain(`"${key}`);
  });

  it("computes the main lifts' e1RM trend in code", () => {
    const bench = input.lifts.find((l) => l.exercise_id === "bench")!;
    expect(bench.points.map((p) => [p.date, p.e1rm])).toEqual([
      ["2026-09-15", 151.7],
      ["2026-09-21", 157.5],
      ["2026-09-24", 157.5],
      ["2026-09-25", 157.5],
      ["2026-09-28", 157.5],
    ]);
    expect(bench).toMatchObject({ first_e1rm: 151.7, latest_e1rm: 157.5, change_pct: 3.8 });
  });

  it("finds stalls (3 exposures without beating the best before) and drops (10% or more)", () => {
    expect(input.stalls).toEqual([{ exercise_id: "bench", name: "Barbell Bench Press", exposures: 3, best_e1rm: 157.5, last_e1rm: 157.5 }]);
    expect(input.drops).toEqual([{ exercise_id: "squat", name: "Barbell Back Squat", best_e1rm: 215.8, latest_e1rm: 175, change_pct: -18.9 }]);
  });

  it("counts skipped planned exercises per day", () => {
    // Day 1 ran 5 times; only the Sep 21 session did the whole day.
    expect(input.skipped.find((s) => s.name === "Incline Dumbbell Press")).toEqual({ name: "Incline Dumbbell Press", day: "Day 1 · Chest", skipped: 4, of: 5 });
    expect(input.skipped.find((s) => s.name === "Barbell Bench Press")).toBeUndefined();
  });

  it("has weekly volume against the targets for every targeted group", () => {
    const thisWeek = input.weeks.at(-1)!;
    expect(thisWeek.volume.map((v) => v.group)).toEqual(["Chest", "Back", "Quads", "Hamstrings & glutes", "Shoulders", "Rear delts", "Calves", "Core", "Biceps", "Triceps"]);
    expect(thisWeek.volume[0]).toMatchObject({ group: "Chest", sets: 4, status: "under" });
  });
});

describe("numbers from the app only", () => {
  const input = buildOverviewInput(data(), [], TODAY, null);
  const supplied = suppliedNumbers(input);

  it("reads Latin, Persian and Arabic-Indic digits and decimals", () => {
    expect(numbersIn("پرس سینه ۳٫۸٪ بالا رفت و اسکوات 18.9 درصد افت کرد؛ ٤ جلسه")).toEqual([3.8, 18.9, 4]);
    expect(percentsIn("بنچ ۴٪ و اسکوات ۱۸٫۹ درصد، ۳ جلسه")).toEqual([4, 18.9]);
    // Percentages: only those the app computed (change_pct), as given or rounded.
    expect([...supplied.pct].sort((a, b) => a - b)).toEqual([4, 18.9, 19, 3.8].sort((a, b) => a - b));
    expect(supplied.all.has(157.5)).toBe(true);
    expect(supplied.all.has(9999)).toBe(false);
  });

  const out = (o: Partial<OverviewOutput>) =>
    OverviewOutput.parse({ summary_fa: "روند خوب است.", trends: [], volume_fa: null, consistency_fa: null, focus_next: [], warnings: [], ...o });

  it("keeps prose with the app's numbers and drops prose with others", () => {
    const r = normalizeOverview(
      out({
        trends: ["پرس سینه حدود ۴٪ در این پنج هفته بالا رفت.", "پرس سینه ۱۲٪ بالا رفت."],
        volume_fa: "سینه این هفته ۴ ست از ۱۳ ست هدف است.",
        consistency_fa: "این هفته ۹۹۹۹ جلسه زدی.",
        focus_next: ["روی پشت بازو بیشتر کار کن."],
        warnings: ["اسکوات ۱۸٫۹٪ افت کرده است."],
      }),
      input
    );
    expect(r.trends).toEqual(["پرس سینه حدود ۴٪ در این پنج هفته بالا رفت."]);
    expect(r.consistency_fa).toBeNull();
    expect(r.warnings).toEqual(["اسکوات ۱۸٫۹٪ افت کرده است."]);
    expect(r.dropped).toBe(2);
    // The lift table is the app's.
    expect(r.lifts.find((l) => l.exercise_id === "bench")).toEqual({ exercise_id: "bench", name: "Barbell Bench Press", latest_e1rm: 157.5, change_pct: 3.8, sessions: 5 });
  });

  it("a summary with a number the app did not supply makes the reply invalid (retried, then an error)", () => {
    expect(checkOverview(out({ summary_fa: "۵ هفته خوب بود." }), input)).toBeNull();
    expect(checkOverview(out({ summary_fa: "۷۰ درصد جلسات انجام شد." }), input)).toMatch(/numbers the app did not supply/);
  });
});

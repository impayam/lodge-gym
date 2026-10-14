import { describe, expect, it } from "vitest";
import { buildMotivation, phaseOf } from "../../worker/lib/ai/motivation";
import { buildOverviewInput, checkMotivation, normalizeOverview, OverviewOutput, suppliedNumbers } from "../../worker/lib/ai/overview";
import type { ReportData } from "../../worker/lib/reports";
import type { WorkoutSession } from "../../worker/lib/types";
import { reportData } from "../fixtures/report-data";

// The overview's weekly motivational line (Payam, 2026-10-14): weeks run Monday–Sunday; Monday–Tuesday start, Wednesday–
// Friday progress so far, Saturday–Sunday the week's result; the first overview of a week also gives last week's result
// when none was written last weekend; a week is bad only with fewer than half its planned sessions.
//
// The fixture (4 planned sessions a week, no activation): week of Sep 14 has 2 sessions (Tue D1, Fri D4), week of
// Sep 21 has 3 (Mon D1, Wed D2, Sat D3).

let n = 0;
function session(id: string, day: string, date: string, sets: [string, number, number, number][]): WorkoutSession {
  return {
    id,
    program_day_id: day,
    local_date: date,
    started_at: `${date}T23:00:00.000Z`,
    ended_at: `${date}T23:55:00.000Z`,
    status: "done",
    unit: "lb",
    note: "",
    created_at: `${date}T23:00:00.000Z`,
    updated_at: `${date}T23:55:00.000Z`,
    source: "app",
    sets: sets.flatMap(([ex, count, w, r]) =>
      Array.from({ length: count }, (_, i) => ({ id: `${id}-${n++}`, exercise_id: ex, set_index: i, weight: w, reps: r, seconds: null, done: true, rir: 1, updated_at: `${date}T23:30:00.000Z` }))
    ),
  };
}
const withSessions = (...extra: WorkoutSession[]): ReportData => {
  const d = reportData();
  d.sessions.push(...extra);
  return d;
};
// Saturday Sep 26, 18:00 in Denver: an overview written on the weekend before the week of Sep 28.
const LAST_SATURDAY = "2026-09-27T00:00:00.000Z";

describe("motivation phases", () => {
  it("Monday–Tuesday start, Wednesday–Friday mid, Saturday–Sunday end", () => {
    expect(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"].map((x) => phaseOf(x).phase)).toEqual([
      "start",
      "start",
      "mid",
      "mid",
      "mid",
      "end",
      "end",
    ]);
    expect(phaseOf("2026-10-03").weekday).toBe("Saturday");
  });

  it("start (Monday): last week's numbers, records and main lifts, today's session and the next day", () => {
    const d = withSessions(session("T1", "D4", "2026-09-28", [["deadlift", 3, 245, 5]]));
    const m = buildMotivation(d, "2026-09-28", [LAST_SATURDAY])!;
    expect(m).toMatchObject({ phase: "start", weekday: "Monday", announce_last_week: false, cover: ["last_week"] });
    expect(m.last_week).toMatchObject({ start: "2026-09-21", end: "2026-09-27", through: "2026-09-27", sessions_done: 3, sessions_planned: 4, bad: false });
    // Records beat the best before the week: bench 135×5 over 130×5, squat 185×5 over 180×5.
    expect(m.last_week.records.map((r) => [r.name, r.weight, r.reps])).toEqual(
      expect.arrayContaining([
        ["Barbell Bench Press", 135, 5],
        ["Barbell Back Squat", 185, 5],
      ])
    );
    expect(m.last_week.main_lifts.find((l) => l.name === "Barbell Bench Press")).toEqual({ name: "Barbell Bench Press", e1rm: 157.5, previous_week_e1rm: 151.7, change_pct: 3.8 });
    // Today's deadlift beats Sep 18's 225×5.
    expect(m.today_session).toMatchObject({ day: "Day 4 · Deadlift", sets_done: 3, records: [{ name: "Conventional Deadlift", weight: 245, reps: 5 }] });
    // After Day 4 comes Day 1.
    expect(m.next_session).toBe("Day 1 · Chest");
  });

  it("mid (Thursday): progress counts plans up to today; 1 of 2 is not bad, 0 of 2 is", () => {
    const d = withSessions(session("T1", "D4", "2026-09-28", [["deadlift", 3, 225, 5]]));
    const m = buildMotivation(d, "2026-10-01", [LAST_SATURDAY])!;
    expect(m).toMatchObject({ phase: "mid", cover: ["this_week"] });
    // Monday to Thursday: 4 × 4/7 = 2.3 → 2 planned.
    expect(m.this_week).toMatchObject({ start: "2026-09-28", through: "2026-10-01", sessions_done: 1, sessions_planned: 2, bad: false });
    const none = buildMotivation(reportData(), "2026-10-01", [LAST_SATURDAY])!;
    expect(none.this_week).toMatchObject({ sessions_done: 0, sessions_planned: 2, bad: true });
  });

  it("end (Saturday): the week's result counts the whole week's plan; fewer than half is bad, half is not", () => {
    const one = buildMotivation(withSessions(session("T1", "D4", "2026-09-28", [["deadlift", 3, 225, 5]])), "2026-10-03", [LAST_SATURDAY])!;
    expect(one).toMatchObject({ phase: "end", cover: ["this_week"] });
    expect(one.this_week).toMatchObject({ through: "2026-10-04", sessions_done: 1, sessions_planned: 4, bad: true });
    const two = buildMotivation(
      withSessions(session("T1", "D4", "2026-09-28", [["deadlift", 3, 225, 5]]), session("T2", "D1", "2026-10-01", [["bench", 4, 130, 5]])),
      "2026-10-03",
      [LAST_SATURDAY]
    )!;
    expect(two.this_week).toMatchObject({ sessions_done: 2, sessions_planned: 4, bad: false });
  });

  it("the first overview of a week gives last week's result when none was written last weekend", () => {
    const d = reportData();
    // None at all: Thursday reports both weeks.
    expect(buildMotivation(d, "2026-10-01", [])!.cover).toEqual(["last_week", "this_week"]);
    // Written last Sunday: no.
    expect(buildMotivation(d, "2026-10-01", ["2026-09-28T03:00:00.000Z"])!).toMatchObject({ announce_last_week: false, cover: ["this_week"] });
    // Written last Friday only: yes.
    expect(buildMotivation(d, "2026-10-01", ["2026-09-25T18:00:00.000Z"])!.announce_last_week).toBe(true);
    // Already written on Tuesday this week: not the first any more.
    expect(buildMotivation(d, "2026-10-01", ["2026-09-29T18:00:00.000Z"])!.announce_last_week).toBe(false);
    // A Regenerate later the same day keeps the announcement (that day's overviews do not count).
    expect(buildMotivation(d, "2026-10-01", ["2026-10-01T18:00:00.000Z"])!.announce_last_week).toBe(true);
    // Saturday's first overview also reports last week.
    expect(buildMotivation(d, "2026-10-03", [])!.cover).toEqual(["last_week", "this_week"]);
  });

  it("a week with nothing planned is not reported; with no week to report there is no line", () => {
    // Activated Wednesday Sep 30: last week planned nothing, so Thursday reports this week only.
    const d = reportData();
    d.programs = [
      {
        id: "fullbody4", name: "Full body", style: null, days_per_week: 4, params: null, generated_by: null, created_at: "2026-09-01T00:00:00.000Z", approved_at: null, archived_at: null,
        status: "active", activations: [{ id: "a", program_id: "fullbody4", started_at: "2026-09-30T18:00:00.000Z", ended_at: null }], days: d.program.days,
      },
    ];
    d.sessions = d.sessions.filter((s) => s.local_date < "2026-09-14");
    const m = buildMotivation(d, "2026-10-01", [])!;
    expect(m.cover).toEqual(["this_week"]);
    expect(m.last_week).toMatchObject({ sessions_done: 0, sessions_planned: 0, bad: false });
    // Monday Sep 28: the start reports last week only, which had nothing: no line.
    expect(buildMotivation(d, "2026-09-28", [])).toBeNull();
  });
});

describe("the motivational line keeps the app's rules", () => {
  const d = withSessions(session("T1", "D4", "2026-09-28", [["deadlift", 3, 225, 5]]));
  const good = buildOverviewInput(d, [], "2026-10-03", null, [LAST_SATURDAY]);
  const out = (motivation_fa: string | null) =>
    OverviewOutput.parse({ summary_fa: "روند خوب است.", trends: [], volume_fa: null, consistency_fa: null, focus_next: [], warnings: [], motivation_fa });

  it("states the sessions done and planned of every week it reports, with the app's numbers only", () => {
    const m = good.motivation!;
    expect(m.this_week).toMatchObject({ sessions_done: 1, sessions_planned: 4, bad: true });
    const s = suppliedNumbers(good);
    const line = "این هفته فقط ۱ جلسه از ۴ جلسه انجام شد؛ کمتر از نصف برنامه. قدم بعدی: فردا Day 1 · Chest را انجام بده.";
    expect(checkMotivation(line, m, s)).toBeNull();
    expect(checkMotivation("این هفته کمتر از نصف برنامه انجام شد.", m, s)).toBe("this_week: sessions done and planned not stated");
    expect(checkMotivation("این هفته 1 جلسه از 4 جلسه و 9999 ست زدی.", m, s)).toBe("a number the app did not supply");
    // No praise on a bad week, with or without the zero-width non-joiner.
    expect(checkMotivation("عالی! این هفته 1 جلسه از 4 جلسه انجام شد.", m, s)).toBe("praise on a bad week");
    expect(checkMotivation("فوقالعاده: 1 جلسه از 4.", m, s)).toBe("praise on a bad week");

    const kept = normalizeOverview(out(line), good);
    expect(kept.motivation).toEqual({
      phase: "end",
      announce_last_week: false,
      cover: [{ week: "this_week", sessions_done: 1, sessions_planned: 4, bad: true }],
      bad: true,
      text_fa: line,
    });
    const dropped = normalizeOverview(out("هفتهٔ خوبی بود، ادامه بده!"), good);
    expect(dropped.motivation).toBeNull();
    expect(dropped.dropped).toBe(1);
  });

  it("number-backed praise is fine on a week that went well", () => {
    const fine = buildOverviewInput(
      withSessions(session("T1", "D4", "2026-09-28", [["deadlift", 3, 225, 5]]), session("T2", "D1", "2026-09-30", [["bench", 4, 140, 5]]), session("T3", "D2", "2026-10-02", [["squat", 4, 190, 5]])),
      [],
      "2026-10-03",
      null,
      [LAST_SATURDAY]
    );
    expect(fine.motivation!.this_week).toMatchObject({ sessions_done: 3, sessions_planned: 4, bad: false });
    expect(checkMotivation("عالی: 3 جلسه از 4 جلسه با رکورد تازه در Barbell Bench Press.", fine.motivation!, suppliedNumbers(fine))).toBeNull();
  });
});

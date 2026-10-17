import { describe, expect, it } from "vitest";
import {
  balanceStatus,
  convertWeight,
  directTargets,
  epley,
  liftTrends,
  mainLifts,
  monthKeyOf,
  monthRange,
  monthlyReport,
  muscleRows,
  muscleTargets,
  programOn,
  volumePerMuscle,
  progressReport,
  setsCsv,
  setsPerMuscle,
  shiftMonth,
  weeklyReport,
} from "../../worker/lib/reports";
import { reportData } from "../fixtures/report-data";

describe("building blocks", () => {
  it("Epley 1RM", () => {
    expect(epley(100, 0)).toBe(100);
    expect(epley(135, 5)).toBeCloseTo(157.5);
    expect(epley(100, 10)).toBeCloseTo(133.333, 2);
    expect(epley(225, 1)).toBeCloseTo(232.5);
  });
  it("unit conversion for reports only", () => {
    expect(convertWeight(100, "kg", "lb")).toBeCloseTo(220.462, 2);
    expect(convertWeight(220.462262, "lb", "kg")).toBeCloseTo(100, 4);
    expect(convertWeight(50, "lb", "lb")).toBe(50);
    expect(convertWeight(50, null, "kg")).toBe(50);
  });
  it("targets are the program's fractional volume per group (SPEC-v2 §7.4)", () => {
    // Primary 1 + each secondary group 0.5 per planned set, e.g. back: 13 direct + pulls and deadlift secondaries = 17.5.
    expect(muscleTargets(reportData())).toEqual({ chest: 13, back: 17.5, quads: 11.5, hamstrings_glutes: 14, shoulders: 15.5, rear_delts: 11, calves: 6, core: 6, biceps: 9.5, triceps: 9.5 });
    expect(mainLifts(reportData())).toEqual(["bench", "squat", "cs_row", "deadlift", "ohp"]);
  });
  it("Gregorian months", () => {
    expect(monthRange("2026-02")).toEqual({ key: "2026-02", start: "2026-02-01", end: "2026-02-28" });
    expect(monthRange("2028-02").end).toBe("2028-02-29");
    expect(monthRange("2026-12")).toMatchObject({ start: "2026-12-01", end: "2026-12-31" });
    expect(monthKeyOf("2026-09-28")).toBe("2026-09");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
  it("balance thresholds", () => {
    expect(balanceStatus(0, 5)).toBe("none");
    expect(balanceStatus(3, 5)).toBe("under");
    expect(balanceStatus(4, 5)).toBe("on");
    expect(balanceStatus(6, 5)).toBe("on");
    expect(balanceStatus(7, 5)).toBe("over");
  });
});

describe("forearm and neck direct-set targets (SPEC-v11 Phase B)", () => {
  // The program trains forearms (4 sets) and neck (2 sets) directly; done this week: 3 wrist-curl sets, no neck work.
  const withDirect = () => {
    const d = reportData();
    const ex = (id: string, name_en: string, muscle_primary: string) => ({ ...d.exercises.find((e) => e.id === "curl")!, id, name_en, muscle_primary, muscles_secondary: [], pattern: "isolation" as const, mechanic: "isolation" as const });
    d.exercises.push(ex("wrist_curl", "Palms-Up Barbell Wrist Curl", "forearms"), ex("neck_ext", "Lying Neck Extension", "neck"));
    const day = d.program.days[0];
    const item = (exercise_id: string, sets: number) => ({ ...day.exercises[day.exercises.length - 1], id: `${day.id}_${exercise_id}`, exercise_id, sets, is_main: false, superset_tag: null });
    day.exercises.push(item("wrist_curl", 4), item("neck_ext", 2));
    const s1 = d.sessions.find((s) => s.id === "S1")!;
    for (let i = 0; i < 3; i++) s1.sets.push({ ...s1.sets[0], id: `S1-w${i}`, exercise_id: "wrist_curl", set_index: i, weight: 45, reps: 15 });
    return d;
  };

  it("the target is the program's direct sets for each group it trains directly; no direct work, no target", () => {
    expect(directTargets(reportData())).toEqual({});
    expect(directTargets(withDirect())).toEqual({ forearms: 4, neck: 2 });
    // The fractional targets the AI reports read stay the ten groups.
    expect(Object.keys(muscleTargets(withDirect()))).toEqual(Object.keys(muscleTargets(reportData())));
  });

  it("weekly rows compare direct sets with it; the other groups keep the fractional rule", () => {
    const rows = weeklyReport(withDirect(), "2026-09-23").muscles;
    // 3 of 4 direct sets is under (below 80 %), though the fractional count (curls and pulls add half sets) is 6.5.
    expect(rows.find((m) => m.muscle === "forearms")).toEqual({ muscle: "forearms", sets: 3, fractional: 6.5, target: 4, status: "under", basis: "direct" });
    expect(rows.find((m) => m.muscle === "neck")).toEqual({ muscle: "neck", sets: 0, fractional: 0, target: 2, status: "none", basis: "direct" });
    expect(rows.find((m) => m.muscle === "chest")!.basis).toBeUndefined();
    // Half sets from pulls and curls do not count toward the direct target.
    expect(muscleRows({ forearms: { direct: 1, fractional: 6.5 } }, {}, { forearms: 4 }).find((m) => m.muscle === "forearms")!.status).toBe("under");
    expect(weeklyReport(reportData(), "2026-09-23").muscles.find((m) => m.muscle === "forearms")!.target).toBeNull();
    expect(progressReport(withDirect(), "2026-09-23").balance.muscles.find((m) => m.muscle === "neck")!.target).toBe(2);
    expect(monthlyReport(withDirect(), "2026-09", "2026-09-30").muscles.find((m) => m.muscle === "forearms")!.basis).toBe("direct");
  });
});

describe("weekly report", () => {
  const r = weeklyReport(reportData(), "2026-09-23");

  it("sessions done vs target, days, total time", () => {
    expect(r.range).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(r.sessions).toEqual({
      done: 3,
      target: 4,
      days: [
        { date: "2026-09-21", day_id: "D1", name_en: "Day 1 · Chest" },
        { date: "2026-09-23", day_id: "D2", name_en: "Day 2 · Legs" },
        { date: "2026-09-26", day_id: "D3", name_en: "Day 3 · Back" },
      ],
      total_minutes: 180,
      program: { id: "fullbody4", name: expect.any(String) },
    });
  });

  it("sets per muscle group vs targets: direct (primary) and fractional (secondary 0.5), SPEC-v2 §7.4", () => {
    // Hand-computed from the week's sets and seed/library/seed-matches.json: [direct, fractional, target, status].
    expect(Object.fromEntries(r.muscles.map((m) => [m.muscle, [m.sets, m.fractional, m.target, m.status]]))).toEqual({
      chest: [13, 13, 13, "on"],
      back: [13, 14.5, 17.5, "on"],
      quads: [10, 10, 11.5, "on"],
      hamstrings_glutes: [3, 8, 14, "under"],
      shoulders: [3, 9.5, 15.5, "under"],
      rear_delts: [3, 8, 11, "under"],
      calves: [3, 3, 6, "under"],
      core: [3, 3, 6, "under"],
      biceps: [3, 9.5, 9.5, "on"],
      triceps: [3, 8, 9.5, "on"],
      traps: [0, 0, null, "none"],
      forearms: [0, 3.5, null, "untracked"],
      lower_back: [0, 3.5, null, "untracked"],
      adductors: [0, 1.5, null, "untracked"],
      abductors: [0, 0, null, "none"],
      neck: [0, 0, null, "none"],
    });
  });

  it("main lifts: best set, Epley 1RM (converted to the report unit), change vs previous week", () => {
    const by = Object.fromEntries(r.lifts.map((l) => [l.exercise_id, l]));
    expect(by.bench).toMatchObject({ best: { weight: 135, reps: 5, e1rm: 157.5 }, prev_e1rm: 151.7, change_pct: 3.8 });
    expect(by.squat).toMatchObject({ best: { weight: 185, reps: 5, e1rm: 215.8 }, prev_e1rm: null, change_pct: null });
    expect(by.cs_row.best).toEqual({ weight: 55.1, reps: 8, e1rm: 69.8 });
    expect(by.deadlift).toMatchObject({ best: null, prev_e1rm: 262.5, change_pct: null });
    expect(by.ohp).toMatchObject({ best: null, prev_e1rm: 114 });
  });

  it("new personal records need an earlier best to beat", () => {
    expect(r.prs.map((p) => [p.exercise_id, p.e1rm, p.previous_e1rm])).toEqual([
      ["bench", 157.5, 151.7],
      ["squat", 215.8, 210],
    ]);
  });

  it("Apple Watch totals prefer per-session sample stats", () => {
    expect(r.watch).toEqual({ active_kcal: 560, hr_avg: 116, matched: 2, unmatched: 1 });
  });

  it("body-mass average and change vs previous week (all sources, converted)", () => {
    expect(r.body).toEqual({ avg: 178.8, prev_avg: 180.5, change: -1.7 });
  });

  it("notes", () => {
    expect(r.notes).toEqual([{ date: "2026-09-21", name_en: "Day 1 · Chest", note: "خوب بود" }]);
  });

  it("week boundaries follow each week-start setting", () => {
    const days = (ws: "sat" | "sun" | "mon") => weeklyReport(reportData({ week_start: ws }), "2026-09-23").sessions.days.map((d) => d.date);
    expect(days("mon")).toEqual(["2026-09-21", "2026-09-23", "2026-09-26"]);
    expect(days("sun")).toEqual(["2026-09-21", "2026-09-23", "2026-09-26"]);
    expect(days("sat")).toEqual(["2026-09-21", "2026-09-23"]);
    expect(weeklyReport(reportData({ week_start: "sat" }), "2026-09-23").range).toEqual({ start: "2026-09-19", end: "2026-09-25" });
    expect(weeklyReport(reportData({ week_start: "sun" }), "2026-09-26").range).toEqual({ start: "2026-09-20", end: "2026-09-26" });
    // Previous-week comparison moves with the setting: with a Sunday start the week of the 19th holds P2 only.
    const sun = weeklyReport(reportData({ week_start: "sun" }), "2026-09-19");
    expect(sun.sessions.days.map((d) => d.date)).toEqual(["2026-09-15", "2026-09-18"]);
  });

  it("reports in kg when the setting says so", () => {
    const kg = weeklyReport(reportData({ unit: "kg" }), "2026-09-23");
    expect(kg.lifts.find((l) => l.exercise_id === "bench")!.best).toEqual({ weight: 61.2, reps: 5, e1rm: 71.4 });
    expect(kg.body.avg).toBe(81.1);
  });
});

describe("monthly report", () => {
  const r = monthlyReport(reportData(), "2026-09");

  it("sessions per week and adherence", () => {
    expect(r.range).toMatchObject({ start: "2026-09-01", end: "2026-09-30" });
    expect(r.sessions).toBe(5);
    expect(r.target).toBe(17.1);
    expect(r.adherence_pct).toBe(29);
    expect(r.weeks.map((w) => [w.start, w.sessions])).toEqual([
      ["2026-08-31", 0],
      ["2026-09-07", 0],
      ["2026-09-14", 2],
      ["2026-09-21", 3],
      ["2026-09-28", 0],
    ]);
  });

  it("estimated 1RM trend per main lift and OHP", () => {
    const by = Object.fromEntries(r.e1rm.map((l) => [l.exercise_id, l.points.map((p) => [p.date, p.e1rm])]));
    expect(by.bench).toEqual([["2026-09-15", 151.7], ["2026-09-21", 157.5]]);
    expect(by.squat).toEqual([["2026-09-23", 215.8]]);
    expect(by.ohp).toEqual([["2026-09-18", 114]]);
  });

  it("volume per muscle group month over month", () => {
    const by = Object.fromEntries(r.volume.map((v) => [v.muscle, [v.current, v.previous]]));
    expect(by.chest).toEqual([10450, 0]); // 2600 + 2700 + 1200 + 2760 + 1190.5 (fly in kg)
    expect(by.quads[1]).toBe(3600);
    expect(by.core).toEqual([0, 0]);
  });

  it("body-mass trend with a 7-day moving average", () => {
    expect(r.body).toEqual([
      { date: "2026-09-15", value: 180, ma7: 180 },
      { date: "2026-09-17", value: 181, ma7: 180.5 },
      { date: "2026-09-22", value: 179, ma7: 180 },
      { date: "2026-09-24", value: 178.6, ma7: 178.8 },
    ]);
  });

  it("records, by the weekly rule: the month's best against the best before the month (Reports tiles, 2026-10-16)", () => {
    // Squat 185 × 5 (215.8) beats August's 180 × 5 (210); bench was first logged this month, so it has no record yet.
    expect(r.prs.map((p) => [p.exercise_id, p.e1rm, p.previous_e1rm])).toEqual([["squat", 215.8, 210]]);
  });

  it("each group's average week against its weekly target: a past month counts all its days, the current one its days so far", () => {
    const d = reportData();
    const sep = d.sessions.filter((s) => s.status === "done" && s.local_date.startsWith("2026-09"));
    const total = setsPerMuscle(sep, new Map(d.exercises.map((e) => [e.id, e])));
    const avg = (days: number) => Math.round(((total.chest.fractional * 7) / days) * 10) / 10;
    const chest = r.muscles.find((m) => m.muscle === "chest")!;
    expect(chest.fractional).toBe(avg(30));
    expect(chest.status).toBe(balanceStatus(chest.fractional, chest.target!));
    expect(monthlyReport(d, "2026-09", "2026-09-27").muscles.find((m) => m.muscle === "chest")!.fractional).toBe(avg(27));
    // A day after the month: the whole month.
    expect(monthlyReport(d, "2026-09", "2026-10-03").muscles.find((m) => m.muscle === "chest")!.fractional).toBe(avg(30));
  });

  it("first vs last photo of the month per pose, averages", () => {
    expect(r.photos.map((p) => [p!.pose, p!.first.id, p!.last.id])).toEqual([["front", "F1", "F2"]]);
    expect(r.avg_minutes).toBe(60);
    expect(r.avg_active_kcal).toBe(280);
  });
});

describe("progress page", () => {
  const p = progressReport(reportData(), "2026-09-27");

  it("since the first session and over the last 4 weeks", () => {
    const since = Object.fromEntries(p.since.lifts.map((l) => [l.exercise_id, l]));
    expect(since.squat).toMatchObject({ first: { date: "2026-08-20", weight: 180, reps: 5, e1rm: 210 }, current: { date: "2026-09-23", e1rm: 215.8 }, change_pct: 2.8 });
    expect(since.bench.change_pct).toBe(3.8);
    const last4 = Object.fromEntries(p.last4.lifts.map((l) => [l.exercise_id, l]));
    expect(last4.squat).toMatchObject({ first: { date: "2026-09-23" }, change_pct: 0 });
    expect(p.since).toMatchObject({ from: "2026-08-20", to: "2026-09-27", sessions: 6 });
    expect(p.last4).toMatchObject({ from: "2026-08-31", sessions: 5 });
    expect(p.last4.adherence_pct).toBe(31);
  });

  it("record moments: each session in which an exercise beat its best of every earlier session (the All tiles)", () => {
    // Bench 135 × 5 on Sep 21 beat Sep 15; squat 185 × 5 on Sep 23 beat Aug 20; every other exercise was logged once.
    expect(p.since.records).toBe(2);
    expect(p.last4.records).toBe(2);
    expect(progressReport(reportData(), "2026-09-20").since.records).toBe(0);
  });

  it("volume trend and body weight first/current/change", () => {
    expect(p.last4.volume_weeks.map((w) => w.start)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"]);
    expect(p.last4.volume_weeks[2].volume).toBe(2600 + 3375 + 1710);
    expect(p.since.body).toEqual({ first: { date: "2026-09-15", value: 180 }, current: { date: "2026-09-24", value: 178.6 }, change: -1.4 });
  });

  it("muscle balance for this week", () => {
    expect(p.balance.week).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    // The 80 % / 120 % thresholds apply to the fractional number (SPEC-v2 §7.4).
    expect(Object.fromEntries(p.balance.muscles.map((m) => [m.muscle, m.status]))).toEqual({
      chest: "on", back: "on", quads: "on", hamstrings_glutes: "under", shoulders: "under", rear_delts: "under", calves: "under", core: "under", biceps: "on", triceps: "on",
      traps: "none", forearms: "untracked", lower_back: "untracked", adductors: "untracked", abductors: "none", neck: "none",
    });
  });
});

describe("only strength work counts toward volume (SPEC-v2 §7.4, decided 2026-10-12)", () => {
  // Face pull marked as stretching: its 3 done sets this week (40 lb × 15) and its 6 planned sets drop out.
  const d = reportData();
  const asStretching = { ...d, exercises: d.exercises.map((e) => (e.id === "facepull" ? { ...e, category: "stretching" as const } : e)) };
  const row = (r: ReturnType<typeof weeklyReport>, m: string) => r.muscles.find((x) => x.muscle === m)!;

  it("sets, fractional sets and targets", () => {
    const r = weeklyReport(asStretching, "2026-09-23");
    // Rear delts: face pull was the only direct work (3) and 6 of the 11 target; the rows' 0.5 stays: 8 − 3 = 5 of 11 − 6 = 5.
    expect(row(r, "rear_delts")).toMatchObject({ sets: 0, fractional: 5, target: 5, status: "on" });
    // Back: face pull's back_upper secondary was 3 × 0.5 done and 6 × 0.5 planned: 14.5 − 1.5 of 17.5 − 3.
    expect(row(r, "back")).toMatchObject({ sets: 13, fractional: 13, target: 14.5, status: "on" });
    expect(row(r, "chest")).toMatchObject({ sets: 13, fractional: 13, target: 13 });
  });

  it("volume (weight × reps) per muscle", () => {
    const week = d.sessions.filter((s) => s.status === "done" && s.local_date >= "2026-09-21" && s.local_date <= "2026-09-27");
    expect(volumePerMuscle(week, new Map(d.exercises.map((e) => [e.id, e])), "lb").rear_delts).toBe(1800);
    expect(volumePerMuscle(week, new Map(asStretching.exercises.map((e) => [e.id, e])), "lb").rear_delts).toBe(0);
  });

  it("an exercise without a category never counts", () => {
    const none = { ...d, exercises: d.exercises.map((e) => (e.id === "facepull" ? { ...e, category: null } : e)) };
    expect(row(weeklyReport(none, "2026-09-23"), "rear_delts")).toMatchObject({ sets: 0, fractional: 5 });
  });
});

describe("CSV export", () => {
  it("raw sets of done sessions in the period", () => {
    const csv = setsCsv(reportData(), "2026-09-21", "2026-09-27");
    expect(csv.startsWith("﻿date,day,exercise,exercise_fa,set,weight,unit,reps,seconds,rir,done\r\n")).toBe(true);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(1 + 19 + 19 + 19);
    expect(lines).toContain("2026-09-21,Day 1 · Chest,Barbell Bench Press,پرس سینه هالتر,1,135,lb,5,,2,1");
    expect(lines).toContain("2026-09-26,Day 3 · Back,Pull-Up / Assisted Pull-Up,بارفیکس,2,-10,kg,8,,,1");
    expect(csv).not.toContain("500");
  });
});

describe("past weeks stay scored against the program active then (SPEC-v2 §8.6)", () => {
  const base = reportData();
  const three = {
    ...base.program,
    id: "gen3",
    name: "Full body · 3 days",
    days: base.program.days.slice(0, 3).map((d) => ({ ...d, id: `gen3-${d.id}`, program_id: "gen3", name_en: `New ${d.name_en}` })),
  };
  const info = (id: string, dpw: number, acts: [string, string | null][]) => ({
    id, name: id, style: null, days_per_week: dpw, params: null, generated_by: null, created_at: "2026-09-01T00:00:00.000Z", approved_at: null, archived_at: null,
    status: "archived" as const, activations: acts.map(([started_at, ended_at], i) => ({ id: `${id}-${i}`, program_id: id, started_at, ended_at })),
  });
  // Switched on Thursday 2026-09-24 at noon in Denver (18:00 UTC).
  const d = {
    ...base,
    program: three,
    programs: [
      { ...info("fullbody4", 4, [["2026-08-01T06:00:00.000Z", "2026-09-24T18:00:00.000Z"]]), days: base.program.days },
      { ...info("gen3", 3, [["2026-09-24T18:00:00.000Z", null]]), days: three.days },
    ],
  };
  it("the program active on a local date; dates before any activation use the first program", () => {
    expect(programOn(d, "2026-09-23").program.id).toBe("fullbody4");
    expect(programOn(d, "2026-09-24")).toMatchObject({ program: { id: "gen3" }, days_per_week: 3 });
    expect(programOn(d, "2026-07-01").program.id).toBe("fullbody4");
    expect(programOn(base, "2026-09-23")).toMatchObject({ program: { id: "fullbody4" }, days_per_week: 4 });
  });
  it("weekly: targets and planned sessions of the program active at the week's end; old day names stay", () => {
    const before = weeklyReport(d, "2026-09-16");
    expect(before.sessions).toMatchObject({ target: 4, program: { id: "fullbody4" } });
    expect(before.muscles.find((m) => m.muscle === "chest")!.target).toBe(13);
    const after = weeklyReport(d, "2026-09-23");
    expect(after.sessions).toMatchObject({ target: 3, program: { id: "gen3" } });
    // The week's sessions ran on the old program's days and keep their names.
    expect(after.sessions.days.map((x) => x.name_en)).toEqual(["Day 1 · Chest", "Day 2 · Legs", "Day 3 · Back"]);
    expect(after.muscles.find((m) => m.muscle === "chest")!.target).toBe(muscleTargets({ program: three, exercises: base.exercises }).chest);
    expect(after.lifts.map((l) => l.exercise_id)).toEqual(["bench", "squat", "cs_row", "ohp"]);
  });
  it("monthly and progress adherence follow each day's program", () => {
    // September: 23 days at 4 a week, 7 days at 3 a week.
    expect(monthlyReport(d, "2026-09").target).toBe(Math.round(((23 * 4 + 7 * 3) / 7) * 10) / 10);
    expect(monthlyReport(base, "2026-09").target).toBe(Math.round(((30 * 4) / 7) * 10) / 10);
  });
});

describe("main lifts' e1RM trend (the report's Where you are, Step 3)", () => {
  it("the best set per session, first to latest, and the change; lifts never done are left out", () => {
    const sets = (sid: string, w: number) => [0, 1].map((i) => ({ id: `${sid}-${i}`, exercise_id: "bench", set_index: i, weight: w, reps: 5, seconds: null, done: true, rir: 1, updated_at: "2026-10-01T00:00:00.000Z" }));
    const s = (id: string, date: string, w: number, unit: "lb" | "kg" = "lb") => ({
      id,
      program_day_id: "D1",
      local_date: date,
      started_at: `${date}T23:00:00.000Z`,
      ended_at: `${date}T23:55:00.000Z`,
      status: "done" as const,
      unit,
      note: "",
      created_at: `${date}T23:00:00.000Z`,
      updated_at: `${date}T23:55:00.000Z`,
      source: "app" as const,
      sets: sets(id, w),
    });
    const name = (id: string) => (id === "bench" ? "Barbell Bench Press" : id);
    const [bench] = liftTrends([s("a", "2026-09-20", 130), s("b", "2026-10-01", 60, "kg"), s("c", "2026-10-12", 135)], ["bench", "squat"], name, "lb");
    // Epley: 130 × (1 + 5/30) = 151.7; 60 kg = 132.3 lb → 154.3; 135 → 157.5.
    expect(bench).toMatchObject({ exercise_id: "bench", name: "Barbell Bench Press", first_e1rm: 151.7, latest_e1rm: 157.5, change_pct: 3.8 });
    expect(bench.points.map((p) => p.e1rm)).toEqual([151.7, 154.3, 157.5]);
    // One session: no change yet.
    expect(liftTrends([s("a", "2026-09-20", 130)], ["bench"], name, "lb")[0]).toMatchObject({ first_e1rm: 151.7, latest_e1rm: 151.7, change_pct: null });
  });
});

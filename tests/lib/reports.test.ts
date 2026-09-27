import { describe, expect, it } from "vitest";
import {
  balanceStatus,
  convertWeight,
  epley,
  mainLifts,
  monthKeyOf,
  monthRange,
  monthlyReport,
  muscleTargets,
  progressReport,
  setsCsv,
  shiftMonth,
  weeklyReport,
} from "../../worker/lib/reports";
import { gregorianToJalali, jalaliToGregorian } from "../../worker/lib/jalali";
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
  it("targets from the program match SPEC §10", () => {
    expect(muscleTargets(reportData())).toEqual({ chest: 13, back: 13, quads: 10, hamstrings_glutes: 9, shoulders: 9, rear_delts: 6, calves: 6, core: 6, biceps: 3, triceps: 3 });
    expect(mainLifts(reportData())).toEqual(["bench", "squat", "cs_row", "deadlift", "ohp"]);
  });
  it("Jalali months", () => {
    expect(gregorianToJalali(2026, 9, 28)).toEqual([1405, 7, 6]);
    expect(jalaliToGregorian(1405, 7, 6)).toEqual([2026, 9, 28]);
    expect(monthRange("1405-06", "jalali")).toEqual({ key: "1405-06", calendar: "jalali", start: "2026-08-23", end: "2026-09-22" });
    expect(monthRange("1405-12", "jalali").end).toBe("2027-03-20");
    expect(monthRange("2026-02", "gregorian")).toMatchObject({ start: "2026-02-01", end: "2026-02-28" });
    expect(monthKeyOf("2026-09-28", "jalali")).toBe("1405-07");
    expect(monthKeyOf("2026-09-28", "gregorian")).toBe("2026-09");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("1405-12", 1)).toBe("1406-01");
  });
  it("balance thresholds", () => {
    expect(balanceStatus(0, 5)).toBe("none");
    expect(balanceStatus(3, 5)).toBe("under");
    expect(balanceStatus(4, 5)).toBe("on");
    expect(balanceStatus(6, 5)).toBe("on");
    expect(balanceStatus(7, 5)).toBe("over");
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
        { date: "2026-09-21", day_id: "D1", name_fa: "روز ۱ – سینه" },
        { date: "2026-09-23", day_id: "D2", name_fa: "روز ۲ – پا" },
        { date: "2026-09-26", day_id: "D3", name_fa: "روز ۳ – پشت" },
      ],
      total_minutes: 180,
    });
  });

  it("sets per muscle group vs targets (primary muscle only)", () => {
    expect(Object.fromEntries(r.muscles.map((m) => [m.muscle, [m.sets, m.target]]))).toEqual({
      chest: [13, 13], back: [13, 13], quads: [10, 10], hamstrings_glutes: [3, 9], shoulders: [3, 9], rear_delts: [3, 6], calves: [3, 6], core: [3, 6], biceps: [3, 3], triceps: [3, 3],
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
    expect(r.notes).toEqual([{ date: "2026-09-21", name_fa: "روز ۱ – سینه", note: "خوب بود" }]);
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

  it("first vs last photo of the month per pose, averages", () => {
    expect(r.photos.map((p) => [p!.pose, p!.first.id, p!.last.id])).toEqual([["front", "F1", "F2"]]);
    expect(r.avg_minutes).toBe(60);
    expect(r.avg_active_kcal).toBe(280);
  });

  it("uses the Jalali month when set", () => {
    const j = monthlyReport(reportData({ month_calendar: "jalali" }), "1405-06");
    expect(j.range).toMatchObject({ start: "2026-08-23", end: "2026-09-22" });
    expect(j.sessions).toBe(3);
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

  it("volume trend and body weight first/current/change", () => {
    expect(p.last4.volume_weeks.map((w) => w.start)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"]);
    expect(p.last4.volume_weeks[2].volume).toBe(2600 + 3375 + 1710);
    expect(p.since.body).toEqual({ first: { date: "2026-09-15", value: 180 }, current: { date: "2026-09-24", value: 178.6 }, change: -1.4 });
  });

  it("muscle balance for this week", () => {
    expect(p.balance.week).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(Object.fromEntries(p.balance.muscles.map((m) => [m.muscle, m.status]))).toEqual({
      chest: "on", back: "on", quads: "on", hamstrings_glutes: "under", shoulders: "under", rear_delts: "under", calves: "under", core: "under", biceps: "on", triceps: "on",
    });
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

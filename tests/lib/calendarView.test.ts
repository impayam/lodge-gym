import { describe, expect, it } from "vitest";
import { DEFAULT_CALENDAR_SETTINGS, hm, toMin, type GymPlan, type WorkShift } from "../../worker/lib/calendar";
import type { WorkoutSession } from "../../worker/lib/types";
import {
  blockLabel,
  calendarWeek,
  dayChips,
  gridPlace,
  monthDates,
  nextLine,
  nextPlan,
  todayPlan,
  upcomingDays,
  upcomingFor,
  weekLabel,
  weekStartOf,
  whenLabel,
  type CalendarSource,
} from "../../web/src/lib/calendarView";

// SPEC-v10 M13 on the device: the Home strip, the week grid and the month strip from local data. Week Mon 2026-10-19.
const DAYS = [
  { id: "D1", name_en: "Day 1 · Chest", position: 1, est_minutes: 60 },
  { id: "D2", name_en: "Day 2 · Legs", position: 2, est_minutes: 75 },
  { id: "D3", name_en: "Day 3 · Back", position: 3, est_minutes: 60 },
  { id: "D4", name_en: "Day 4 · Shoulders", position: 4, est_minutes: 60 },
];
const TZ = "America/Denver";
const shift = (id: string, date: string, from: string, to: string, note = ""): WorkShift => ({ id, date, start_min: toMin(from), end_min: toMin(to), note, created_at: "x", updated_at: "x" });
const plan = (id: string, date: string, start: string, more: Partial<GymPlan> = {}): GymPlan => ({
  id,
  date,
  start_min: toMin(start),
  end_min: toMin(start) + 60,
  program_day_id: "D3",
  source: "manual",
  session_id: null,
  status: "planned",
  reminder_at: null,
  created_at: "x",
  updated_at: "x",
  ...more,
});
// 12:00–13:00 Denver (UTC−6 in October).
const session = (id: string, date: string, more: Partial<WorkoutSession> = {}): WorkoutSession =>
  ({ id, local_date: date, started_at: `${date}T18:00:00.000Z`, ended_at: `${date}T19:00:00.000Z`, program_day_id: "D1", status: "done", ...more }) as WorkoutSession;
const src = (more: Partial<CalendarSource> = {}): CalendarSource => ({
  shifts: [],
  plans: [],
  sessions: [],
  settings: DEFAULT_CALENDAR_SETTINGS,
  tz: TZ,
  today: "2026-10-21",
  now: "2026-10-21T16:00:00.000Z",
  ...more,
});
const name = (id: string) => DAYS.find((d) => d.id === id)!.name_en;

describe("program days for the next plans", () => {
  it("start at the next day on Home and keep the program order", () => {
    expect(upcomingDays(DAYS, "D3").map((d) => d.id)).toEqual(["D3", "D4", "D1", "D2"]);
    expect(upcomingDays(DAYS, "D3")[0]).toEqual({ id: "D3", name: "Day 3 · Back", minutes: 60 });
  });

  it("continue after the last open plan from today on", () => {
    const plans = [plan("a", "2026-10-22", "17:00", { program_day_id: "D3" }), plan("b", "2026-10-24", "09:00", { program_day_id: "D4" }), plan("old", "2026-10-15", "17:00", { program_day_id: "D2" })];
    expect(upcomingFor(DAYS, "D3", plans, "2026-10-21").map((d) => d.id)).toEqual(["D1", "D2", "D3", "D4"]);
    expect(upcomingFor(DAYS, "D3", [], "2026-10-21").map((d) => d.id)).toEqual(["D3", "D4", "D1", "D2"]);
    // A linked (done) plan is history: the order comes from Home.
    expect(upcomingFor(DAYS, "D4", [plan("c", "2026-10-21", "06:00", { session_id: "s1", status: "done" })], "2026-10-21").map((d) => d.id)[0]).toBe("D4");
  });
});

describe("Home week strip", () => {
  it("marks a shift with a bar and training with a dot: done, planned or missed; today highlighted", () => {
    const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
    const chips = dayChips(
      src({
        shifts: [shift("w1", "2026-10-20", "07:00", "15:30"), shift("w2", "2026-10-22", "12:00", "20:00")],
        plans: [plan("p1", "2026-10-19", "17:00"), plan("p2", "2026-10-20", "17:00"), plan("p3", "2026-10-23", "17:30")],
        sessions: [session("s1", "2026-10-20")],
      }),
      week
    );
    expect(chips.map((c) => [c.date.slice(8), c.shift, c.mark, c.today])).toEqual([
      ["19", false, "missed", false],
      ["20", true, "done", false],
      ["21", false, null, true],
      ["22", true, null, false],
      ["23", false, "planned", false],
      ["24", false, null, false],
      ["25", false, null, false],
    ]);
  });

  it("names the next planned session, or says none is planned", () => {
    const s = src({ plans: [plan("p1", "2026-10-23", "17:30", { program_day_id: "D3" }), plan("p0", "2026-10-21", "08:00"), plan("x", "2026-10-22", "06:00", { status: "cancelled" })] });
    // 10:00 local: today's 08:00 plan has ended, Thursday's was cancelled.
    const next = nextPlan(s, toMin("10:00"));
    expect(next?.id).toBe("p1");
    expect(nextLine(next, name, s.today)).toBe("Next: Fri 17:30 · Day 3 · Back");
    expect(nextLine(null, name, s.today)).toBe("No gym time planned this week");
    // Today's plan counts until it ends; the hero card shows it.
    expect(todayPlan(s, toMin("08:30"))?.id).toBe("p0");
    expect(nextLine(nextPlan(s, toMin("08:30")), name, s.today)).toBe("Next: Today 08:00 · Day 3 · Back");
    expect(todayPlan(s, toMin("10:00"))).toBeNull();
  });

  it("dates further than six days ahead carry the month", () => {
    expect(whenLabel("2026-10-27", "2026-10-21")).toBe("Tue");
    expect(whenLabel("2026-10-28", "2026-10-21")).toBe("Wed, Oct 28");
    expect(whenLabel("2026-10-21", "2026-10-21")).toBe("Today");
  });
});

describe("week grid", () => {
  it("lays out each day: shifts, open plans, sessions (a done plan shows as its session)", () => {
    const s = src({
      shifts: [shift("w1", "2026-10-20", "07:00", "15:30", "Store")],
      plans: [plan("p1", "2026-10-20", "12:30"), plan("p2", "2026-10-23", "17:30"), plan("p3", "2026-10-19", "17:00")],
      sessions: [session("s1", "2026-10-20")],
    });
    const { days, finder } = calendarWeek(s, "2026-10-19", null);
    expect(finder).toBeNull();
    expect(days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(days[0].plans.map((p) => [p.id, p.state])).toEqual([["p3", "missed"]]);
    expect(days[1].plans).toEqual([]);
    expect(days[1].sessions.map((b) => [b.id, hm(b.start_min), hm(b.end_min)])).toEqual([["s1", "12:00", "13:00"]]);
    expect(days[1].shifts.map((x) => x.id)).toEqual(["w1"]);
    expect(days[4].plans.map((p) => [p.id, p.state])).toEqual([["p2", "planned"]]);
    expect(days[2].today).toBe(true);
  });

  it("free times come from the shared finder with the days around the week", () => {
    const s = src({ shifts: [shift("w1", "2026-10-22", "12:00", "20:00")], sessions: [session("s0", "2026-10-18"), session("s1", "2026-10-17")] });
    const { days, finder } = calendarWeek(s, "2026-10-19", { upcoming: upcomingDays(DAYS, "D3"), days_per_week: 4, now_min: toMin("10:00") });
    // Monday would be the third day in a row after Sat 17 + Sun 18; Tuesday is before today.
    expect(days[0].free).toEqual([]);
    expect(days[1].free).toEqual([]);
    // Today from 10:00 + 20 min travel, rounded up to 10:30.
    expect(days[2].free.map((x) => hm(x.start_min))).toEqual(["10:30"]);
    // Thursday: before the 12:00 shift (back by 12:00) and after it (20:00 + 30 min + 20 min = 20:50, rounded to 21:00).
    expect(days[3].free.map((x) => hm(x.start_min))).toEqual(["04:00", "21:00"]);
    expect(finder?.need).toBe(4);
  });

  it("places a block by its minutes on the 04:00–24:00 axis", () => {
    expect(gridPlace({ start_min: toMin("07:00"), end_min: toMin("15:30") }, 240, 1440, 44)).toEqual({ top: 132, height: 374 });
    // A block before the axis starts is clipped to it.
    expect(gridPlace({ start_min: toMin("03:00"), end_min: toMin("05:00") }, 240, 1440, 44)).toEqual({ top: 0, height: 44 });
  });

  it("every block has an accessible name", () => {
    expect(blockLabel.shift(shift("w", "2026-10-20", "07:00", "15:30"))).toBe("Work, Tuesday 07:00–15:30");
    const p = { ...plan("p", "2026-10-22", "17:30"), state: "planned" as const };
    expect(blockLabel.plan(p, "Day 3 · Back")).toBe("Planned: Day 3 · Back, Thursday 17:30–18:30");
    expect(blockLabel.plan({ ...p, state: "missed" }, "Day 3 · Back")).toBe("Missed: Day 3 · Back, Thursday 17:30–18:30");
  });
});

describe("week and month", () => {
  it("weeks start on the day set in Settings", () => {
    expect(weekStartOf("2026-10-21", "mon")).toBe("2026-10-19");
    expect(weekStartOf("2026-10-21", "sun")).toBe("2026-10-18");
    expect(weekStartOf("2026-10-21", "sat")).toBe("2026-10-17");
  });

  it("labels a week, across months and years", () => {
    expect(weekLabel("2026-10-19", "2026-10-21")).toBe("Oct 19 – 25");
    expect(weekLabel("2026-09-28", "2026-10-21")).toBe("Sep 28 – Oct 4");
    expect(weekLabel("2026-12-28", "2026-10-21")).toBe("Dec 28 – Jan 3, 2027");
  });

  it("the month strip holds the month's dates", () => {
    expect(monthDates("2026-10-21")).toHaveLength(31);
    expect(monthDates("2026-02-10")).toHaveLength(28);
    expect(monthDates("2026-10-21")[0]).toBe("2026-10-01");
  });
});

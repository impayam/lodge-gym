import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR_SETTINGS,
  findFreeSlots,
  hm,
  planForSession,
  planState,
  planStates,
  reminderText,
  sessionBlock,
  toMin,
  weekDates,
  type CalendarSettings,
  type FinderInput,
  type GymPlan,
} from "../../worker/lib/calendar";

// SPEC-v10 M13 §3 as changed by Payam on 2026-10-15 (he enters his shifts, the app suggests the time; nothing blocks), and
// the plan ↔ session rules. The week is Mon 2026-10-19 … Sun 2026-10-25.
const WEEK = weekDates("2026-10-19");
const UPCOMING = [
  { id: "D3", name: "Day 3 · Back", minutes: 60 },
  { id: "D4", name: "Day 4 · Legs", minutes: 75 },
  { id: "D1", name: "Day 1 · Chest", minutes: 60 },
  { id: "D2", name: "Day 2 · Shoulders", minutes: 60 },
];
const input = (more: Partial<FinderInput> = {}): FinderInput => ({
  week: WEEK,
  today: "2026-10-19",
  now_min: 0,
  shifts: [],
  plans: [],
  sessions: [],
  settings: DEFAULT_CALENDAR_SETTINGS,
  upcoming: UPCOMING,
  days_per_week: 4,
  ...more,
});
const shift = (date: string, from: string, to: string) => ({ date, start_min: toMin(from), end_min: toMin(to) });
const startsOn = (r: ReturnType<typeof findFreeSlots>, date: string) => r.slots.filter((x) => x.date === date).map((x) => hm(x.start_min));

describe("findFreeSlots: what fits (Payam's defaults, untouched)", () => {
  it("a 12:00–20:00 shift: the suggestion is 08:00–09:00, before the shift", () => {
    const r = findFreeSlots(input({ shifts: [shift("2026-10-19", "12:00", "20:00")] }));
    const mon = r.slots.find((x) => x.date === "2026-10-19")!;
    expect([hm(mon.start_min), hm(mon.end_min)]).toEqual(["08:00", "09:00"]);
    expect(mon.before_shift_at).toBe(toMin("12:00"));
    expect(mon.long_shift_day).toBe(true);
  });

  it("never before the earliest start (08:00) nor wake-up plus travel; a day off starts at 08:00", () => {
    const r = findFreeSlots(input());
    expect(r.slots.map((x) => [x.date.slice(8), hm(x.start_min)]).sort()).toEqual([
      ["19", "08:00"],
      ["20", "08:00"],
      ["21", "08:00"],
      ["22", "08:00"],
      ["23", "08:00"],
      ["24", "08:00"],
      ["25", "08:00"],
    ]);
    const early = findFreeSlots(input({ settings: { ...DEFAULT_CALENDAR_SETTINGS, earliest_start_min: toMin("05:00"), wake_time_min: toMin("05:30") } }));
    // Wake 05:30 + 20 min travel = 05:50, rounded to 06:00; Sunday opens at 07:00.
    expect(startsOn(early, "2026-10-19")).toEqual(["06:00"]);
    expect(startsOn(early, "2026-10-25")).toEqual(["07:00"]);
  });

  it("the session ends at least 60 min before a shift starts", () => {
    // 08:00–09:00 + 60 min = 10:00: fits a 10:00 shift, not a 09:45 one (then after the shift: 14:00 + 30 + 20 → 15:00).
    expect(startsOn(findFreeSlots(input({ shifts: [shift("2026-10-20", "10:00", "14:00")] })), "2026-10-20")).toEqual(["08:00"]);
    expect(startsOn(findFreeSlots(input({ shifts: [shift("2026-10-20", "09:45", "14:00")] })), "2026-10-20")).toEqual(["15:00"]);
  });

  it("rest after a shift: 30 min, 90 min after a long one (8 h or more), then travel", () => {
    // 06:00–13:00 (7 h): 13:00 + 30 + 20 = 13:50 → 14:00. 06:00–14:00 (8 h): 14:00 + 90 + 20 = 15:50 → 16:00.
    expect(startsOn(findFreeSlots(input({ shifts: [shift("2026-10-21", "06:00", "13:00")] })), "2026-10-21")).toEqual(["14:00"]);
    const long = findFreeSlots(input({ shifts: [shift("2026-10-21", "06:00", "14:00")], days_per_week: 0 }));
    const wed = long.slots.find((x) => x.date === "2026-10-21")!;
    expect([hm(wed.leave_min), hm(wed.start_min), hm(wed.end_min), hm(wed.back_min)]).toEqual(["15:40", "16:00", "17:00", "17:20"]);
    expect(wed.after_shift_at).toBe(toMin("14:00"));
  });

  it("inside the gym's hours for that weekday, finished with travel before closing", () => {
    // Saturday closes at 22:00: after a 06:00–20:00 shift (14 h) 20:00 + 90 + 20 → 22:00 is too late.
    const r = findFreeSlots(input({ shifts: [shift("2026-10-24", "06:00", "20:00")] }));
    expect(startsOn(r, "2026-10-24")).toEqual([]);
    const closed = findFreeSlots(input({ settings: { ...DEFAULT_CALENDAR_SETTINGS, gym_hours: { ...DEFAULT_CALENDAR_SETTINGS.gym_hours, sun: null } } }));
    expect(startsOn(closed, "2026-10-25")).toEqual([]);
  });

  it("one suggestion a day; a day that already has a plan or a session gets none", () => {
    const r = findFreeSlots(
      input({
        plans: [{ date: "2026-10-21", start_min: toMin("17:00"), end_min: toMin("18:00"), status: "planned" }],
        sessions: [{ date: "2026-10-19", start_min: toMin("12:00"), end_min: toMin("13:00") }],
      })
    );
    expect(startsOn(r, "2026-10-19")).toEqual([]);
    expect(startsOn(r, "2026-10-21")).toEqual([]);
    expect(new Set(r.slots.map((x) => x.date)).size).toBe(r.slots.length);
    expect(r.need).toBe(2);
  });

  it("never in the past: earlier days are skipped, today starts after now plus travel, rounded to 15 minutes", () => {
    const r = findFreeSlots(input({ today: "2026-10-21", now_min: toMin("10:02") }));
    expect(r.slots.some((x) => x.date < "2026-10-21")).toBe(false);
    expect(startsOn(r, "2026-10-21")).toEqual(["10:30"]);
  });

  it("two training days in a row never hide a slot: a third day still gets one, ranked last, with its streak", () => {
    const r = findFreeSlots(
      input({
        sessions: [
          { date: "2026-10-17", start_min: 720, end_min: 780 },
          { date: "2026-10-18", start_min: 720, end_min: 780 },
        ],
        days_per_week: 7,
      })
    );
    const mon = r.slots.find((x) => x.date === "2026-10-19")!;
    expect(hm(mon.start_min)).toBe("08:00");
    expect(r.slots).toHaveLength(7);
    // Seven a week: every day is pre-selected, and Monday is the third (and the week the ninth) training day in a row.
    expect(r.slots.every((x) => x.selected)).toBe(true);
    expect(mon.streak).toBe(9);
    expect(r.slots.at(-1)!.date).not.toBe("2026-10-23");
  });
});

describe("findFreeSlots: ranking and selection", () => {
  it("selects what is still needed this week: days per week minus days done or planned", () => {
    const r = findFreeSlots(input({ plans: [{ date: "2026-10-22", start_min: 1020, end_min: 1080, status: "planned" }], sessions: [{ date: "2026-10-19", start_min: 720, end_min: 780 }] }));
    expect(r.need).toBe(2);
    expect(r.slots.filter((x) => x.selected)).toHaveLength(2);
    // Best first: the pre-selected ones lead the list.
    expect(r.slots.slice(0, 2).every((x) => x.selected)).toBe(true);
  });

  it("spreads the week: the picks stay apart from each other and from the days already trained", () => {
    const r = findFreeSlots(input());
    // Four a week, no shifts: Monday, Friday (four days on), Wednesday, Sunday; Tue / Thu / Sat would each be the
    // middle of three training days in a row, so they come after, with that streak.
    expect(r.slots.map((x) => x.date.slice(8))).toEqual(["19", "23", "21", "25", "20", "22", "24"]);
    expect(r.slots.slice(4).map((x) => x.streak)).toEqual([3, 3, 3]);
    const picked = r.slots.filter((x) => x.selected).sort((a, b) => a.date.localeCompare(b.date));
    expect(picked.map((x) => [x.date, hm(x.start_min)])).toEqual([
      ["2026-10-19", "08:00"],
      ["2026-10-21", "08:00"],
      ["2026-10-23", "08:00"],
      ["2026-10-25", "08:00"],
    ]);
    expect(picked.every((x) => x.streak === 1)).toBe(true);
  });

  it("a third training day in a row ranks below a spread-out day, but stays in the list", () => {
    // Mon + Tue trained, Thu + Fri planned: Wed would be the third in a row (both sides), Sat the third after Thu + Fri.
    const r = findFreeSlots(
      input({
        sessions: [
          { date: "2026-10-19", start_min: 720, end_min: 780 },
          { date: "2026-10-20", start_min: 720, end_min: 780 },
        ],
        plans: [
          { date: "2026-10-22", start_min: 720, end_min: 780, status: "planned" },
          { date: "2026-10-23", start_min: 720, end_min: 780, status: "planned" },
        ],
        days_per_week: 5,
      })
    );
    expect(r.need).toBe(1);
    expect(r.slots.map((x) => x.date)).toEqual(["2026-10-25", "2026-10-21", "2026-10-24"]);
    expect(r.slots[0].selected).toBe(true);
    expect(r.slots.find((x) => x.date === "2026-10-21")!.streak).toBe(5);
  });

  it("on a long-shift day the slot before the shift ranks first, even over a preferred window", () => {
    const windows: CalendarSettings = { ...DEFAULT_CALENDAR_SETTINGS, preferred_windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start_min: toMin("18:00"), end_min: toMin("22:00") }] };
    const r = findFreeSlots(
      input({
        settings: windows,
        shifts: [shift("2026-10-19", "10:00", "18:00"), shift("2026-10-20", "12:00", "16:00")],
      })
    );
    // Monday (8 h): 08:00 before the shift, not 20:00 in the window (18:00 + 90 + 20 → 20:00).
    expect(startsOn(r, "2026-10-19")).toEqual(["08:00"]);
    // Tuesday (4 h): the preferred window wins over 08:00.
    const tue = r.slots.find((x) => x.date === "2026-10-20")!;
    expect([hm(tue.start_min), tue.preferred, tue.long_shift_day]).toEqual(["18:00", true, false]);
  });

  it("preferred windows first across the week", () => {
    const evenings: CalendarSettings = { ...DEFAULT_CALENDAR_SETTINGS, preferred_windows: [{ days: ["tue", "thu"], start_min: toMin("17:00"), end_min: toMin("21:00") }] };
    const r = findFreeSlots(input({ settings: evenings, days_per_week: 2 }));
    expect(r.slots.slice(0, 2).map((x) => [x.date, hm(x.start_min), x.preferred, x.selected])).toEqual([
      ["2026-10-20", "17:00", true, true],
      ["2026-10-22", "17:00", true, true],
    ]);
  });

  it("gives the selected slots the program days in date order, each with its own length", () => {
    const r = findFreeSlots(input());
    const picked = r.slots.filter((x) => x.selected).sort((a, b) => a.date.localeCompare(b.date));
    expect(picked.map((x) => x.program_day_id)).toEqual(["D3", "D4", "D1", "D2"]);
    expect(picked.map((x) => x.end_min - x.start_min)).toEqual([60, 75, 60, 60]);
    expect(r.slots.filter((x) => !x.selected).every((x) => x.program_day_id === null && x.end_min - x.start_min === 60)).toBe(true);
    expect(r.length_min).toBe(60);
  });

  it("a longer program day takes that day's best start for its length", () => {
    // Wednesday: a 10:00 shift leaves room for 60 min before it (08:00–09:00, + 60 = 10:00), not for Day 4's 75; after
    // it 14:00 + 30 + 20 → 15:00.
    const r = findFreeSlots(input({ shifts: [shift("2026-10-21", "10:00", "14:00")] }));
    const wed = r.slots.find((x) => x.date === "2026-10-21")!;
    expect([wed.program_day_id, hm(wed.start_min), hm(wed.end_min)]).toEqual(["D4", "15:00", "16:15"]);
  });

  it("the DST week (US clocks go back on Sun 2026-11-01): seven local dates, slots in local minutes", () => {
    const week = weekDates("2026-10-26");
    expect(week).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    const r = findFreeSlots(input({ week, today: "2026-10-26" }));
    expect(startsOn(r, "2026-11-01")).toEqual(["08:00"]);
    // A session at 12:00 local is 18:00Z on Saturday (UTC−6) and 19:00Z on Sunday (UTC−7).
    const at = (started: string, ended: string, date: string) => sessionBlock({ id: "s", local_date: date, started_at: started, ended_at: ended, program_day_id: "D1", status: "done" }, "America/Denver", "2026-11-02T00:00:00.000Z");
    expect(at("2026-10-31T18:00:00.000Z", "2026-10-31T19:00:00.000Z", "2026-10-31")).toMatchObject({ start_min: 720, end_min: 780 });
    expect(at("2026-11-01T19:00:00.000Z", "2026-11-01T20:00:00.000Z", "2026-11-01")).toMatchObject({ start_min: 720, end_min: 780 });
  });

  it("the reminder text names the time left, the day and the time", () => {
    expect(reminderText(60, "Day 3 · Back", toMin("17:30"))).toBe("Gym in 1 hour: Day 3 · Back, 17:30");
    expect(reminderText(30, "Day 1 · Chest", toMin("08:00"))).toBe("Gym in 30 min: Day 1 · Chest, 08:00");
    expect(reminderText(90, "Day 2 · Legs", toMin("06:15"))).toBe("Gym in 1 h 30 min: Day 2 · Legs, 06:15");
    expect(reminderText(120, "Day 2 · Legs", toMin("06:15"))).toBe("Gym in 2 hours: Day 2 · Legs, 06:15");
  });
});

describe("plans and sessions", () => {
  const plan = (id: string, date: string, start: string, more: Partial<GymPlan> = {}): GymPlan => ({
    id,
    date,
    start_min: toMin(start),
    end_min: toMin(start) + 60,
    program_day_id: "D1",
    source: "finder",
    session_id: null,
    status: "planned",
    reminder_at: null,
    created_at: "x",
    updated_at: "x",
    ...more,
  });

  it("a session links the open plan of its date closest to its start", () => {
    const plans = [plan("a", "2026-10-21", "06:00"), plan("b", "2026-10-21", "17:30"), plan("c", "2026-10-22", "17:00")];
    expect(planForSession(plans, { date: "2026-10-21", start_min: toMin("16:50") })?.id).toBe("b");
    expect(planForSession(plans, { date: "2026-10-21", start_min: toMin("07:10") })?.id).toBe("a");
    expect(planForSession(plans, { date: "2026-10-23", start_min: 600 })).toBeNull();
    expect(planForSession([plan("d", "2026-10-21", "17:30", { session_id: "s1", status: "done" })], { date: "2026-10-21", start_min: 1050 })).toBeNull();
  });

  it("a plan is missed after its day ends with no session; a linked or same-day session makes it done", () => {
    const sessions = new Set(["2026-10-20"]);
    expect(planState(plan("a", "2026-10-19", "17:00"), sessions, "2026-10-21")).toBe("missed");
    expect(planState(plan("b", "2026-10-20", "17:00", { session_id: "s1", status: "done" }), sessions, "2026-10-21")).toBe("done");
    expect(planState(plan("c", "2026-10-21", "17:00"), sessions, "2026-10-21")).toBe("planned");
    expect(planState(plan("d", "2026-10-20", "17:00", { status: "missed" }), sessions, "2026-10-21")).toBe("done");
  });

  it("on the device, an unsynced session links its date's closest open plan before the server does", () => {
    const plans = [plan("a", "2026-10-21", "06:00"), plan("b", "2026-10-21", "17:30"), plan("c", "2026-10-19", "17:00"), plan("d", "2026-10-23", "17:00")];
    const s = (id: string, date: string, start: string) => ({ id, date, start_min: toMin(start), end_min: toMin(start) + 60, program_day_id: "D2", status: "done" as const });
    const states = planStates(plans, [s("x", "2026-10-21", "17:10")], "2026-10-22");
    expect(Object.fromEntries(states)).toEqual({ a: "planned", b: "done", c: "missed", d: "planned" });
  });

  it("an open session runs until now on the calendar and never past midnight", () => {
    const open = sessionBlock({ id: "s", local_date: "2026-10-21", started_at: "2026-10-21T23:30:00.000Z", ended_at: null, program_day_id: "D1", status: "active" }, "America/Denver", "2026-10-22T00:15:00.000Z");
    expect(open).toMatchObject({ start_min: toMin("17:30"), end_min: toMin("18:15") });
  });
});

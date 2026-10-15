import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR_SETTINGS,
  findFreeSlots,
  hm,
  planForSession,
  planState,
  planStates,
  sessionBlock,
  toMin,
  weekDates,
  type CalendarSettings,
  type FinderInput,
  type GymPlan,
} from "../../worker/lib/calendar";

// SPEC-v10 M13 §3: the free-slot finder and the plan ↔ session rules. The week is Mon 2026-10-19 … Sun 2026-10-25.
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
const evenings: CalendarSettings = { ...DEFAULT_CALENDAR_SETTINGS, preferred_windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start_min: toMin("17:00"), end_min: toMin("21:00") }] };

describe("findFreeSlots: what fits", () => {
  it("a shift blocks its hours plus the gap after it; travel is added before and after the session", () => {
    // 07:00–15:30 shift: back from the gym by 07:00 at the latest, leave 30 min after the shift ends (16:00) + 20 min travel.
    const r = findFreeSlots(input({ shifts: [shift("2026-10-19", "07:00", "15:30")] }));
    expect(startsOn(r, "2026-10-19")).toEqual(["04:00", "16:30"]);
    const late = r.slots.find((x) => x.date === "2026-10-19" && x.start_min === toMin("16:30"))!;
    expect([hm(late.leave_min), hm(late.end_min), hm(late.back_min)]).toEqual(["16:10", "17:30", "17:50"]);
    // 04:00 still fits before a 05:30 shift (back home 05:20), not before a 05:00 one; after 23:00 nothing fits.
    expect(startsOn(findFreeSlots(input({ shifts: [shift("2026-10-20", "05:30", "23:00")] })), "2026-10-20")).toEqual(["04:00"]);
    expect(startsOn(findFreeSlots(input({ shifts: [shift("2026-10-20", "05:00", "23:00")] })), "2026-10-20")).toEqual([]);
  });

  it("fits the gym's hours per weekday, finished with travel before closing (Sat 05:00–22:00, Sun 07:00–16:00)", () => {
    const r = findFreeSlots(input({ shifts: [shift("2026-10-24", "06:00", "20:00")] }));
    // Saturday: 20:00 + 30 + 20 → 21:00; 21:00 + 60 + 20 = 22:20 is after closing.
    expect(startsOn(r, "2026-10-24")).toEqual([]);
    expect(startsOn(r, "2026-10-25")).toEqual(["07:00"]);
    const closed = findFreeSlots(input({ settings: { ...DEFAULT_CALENDAR_SETTINGS, gym_hours: { ...DEFAULT_CALENDAR_SETTINGS.gym_hours, sun: null } } }));
    expect(startsOn(closed, "2026-10-25")).toEqual([]);
  });

  it("does not overlap a plan or a logged session, and a day that has one gets no slot", () => {
    const r = findFreeSlots(
      input({
        plans: [{ date: "2026-10-21", start_min: toMin("17:00"), end_min: toMin("18:00"), status: "planned" }],
        sessions: [{ date: "2026-10-19", start_min: toMin("12:00"), end_min: toMin("13:00") }],
      })
    );
    expect(startsOn(r, "2026-10-19")).toEqual([]);
    expect(startsOn(r, "2026-10-21")).toEqual([]);
    expect(r.need).toBe(2);
  });

  it("never in the past: earlier days are skipped, today starts after now plus travel, rounded to 15 minutes", () => {
    const r = findFreeSlots(input({ today: "2026-10-21", now_min: toMin("10:02") }));
    expect(r.slots.some((x) => x.date < "2026-10-21")).toBe(false);
    expect(startsOn(r, "2026-10-21")).toEqual(["10:30"]);
  });

  it("keeps at most two training days in a row, also across the week boundary", () => {
    const r = findFreeSlots(
      input({
        sessions: [
          { date: "2026-10-17", start_min: 720, end_min: 780 },
          { date: "2026-10-18", start_min: 720, end_min: 780 },
          { date: "2026-10-20", start_min: 720, end_min: 780 },
          { date: "2026-10-21", start_min: 720, end_min: 780 },
        ],
      })
    );
    // Sat 17 + Sun 18 trained: Monday would be the third in a row; Tue + Wed trained: Mon and Thu would be too.
    expect(startsOn(r, "2026-10-19")).toEqual([]);
    expect(startsOn(r, "2026-10-22")).toEqual([]);
    expect(startsOn(r, "2026-10-23")).not.toEqual([]);
    for (const x of r.slots.filter((s) => s.selected)) {
      const trained = new Set(["2026-10-17", "2026-10-18", "2026-10-20", "2026-10-21", ...r.slots.filter((s) => s.selected).map((s) => s.date)]);
      const d = (n: number) => trained.has(WEEK[Math.max(0, WEEK.indexOf(x.date) + n)]);
      expect(d(-1) && d(1) && d(-2)).toBe(false);
    }
  });
});

describe("findFreeSlots: ranking and selection", () => {
  it("selects what is still needed this week: days per week minus sessions done or planned", () => {
    const r = findFreeSlots(input({ plans: [{ date: "2026-10-22", start_min: 1020, end_min: 1080, status: "planned" }], sessions: [{ date: "2026-10-19", start_min: 720, end_min: 780 }] }));
    expect(r.need).toBe(2);
    expect(r.slots.filter((x) => x.selected)).toHaveLength(2);
  });

  it("preferred windows first, then spread across the week (one a day), then earlier in the day", () => {
    const r = findFreeSlots(input({ settings: evenings }));
    const picked = r.slots.filter((x) => x.selected);
    // Weekday evenings first, spread Mon / Wed / Fri; Tue or Thu would make three in a row, so the fourth is the
    // weekend (no preferred window there): Sunday, the farthest from the others, at its earliest time.
    expect(picked.map((x) => [x.date, hm(x.start_min), x.preferred])).toEqual([
      ["2026-10-19", "17:00", true],
      ["2026-10-21", "17:00", true],
      ["2026-10-23", "17:00", true],
      ["2026-10-25", "07:00", false],
    ]);
    // Without preferred windows the earliest time of each day wins, spread the same way.
    expect(findFreeSlots(input()).slots.filter((x) => x.selected).map((x) => [x.date, hm(x.start_min)])).toEqual([
      ["2026-10-19", "04:00"],
      ["2026-10-21", "04:00"],
      ["2026-10-23", "04:00"],
      ["2026-10-25", "07:00"],
    ]);
  });

  it("gives the selected slots the program days in date order, each with its own length", () => {
    const r = findFreeSlots(input({ settings: evenings }));
    const picked = r.slots.filter((x) => x.selected);
    expect(picked.map((x) => x.program_day_id)).toEqual(["D3", "D4", "D1", "D2"]);
    expect(picked.map((x) => x.end_min - x.start_min)).toEqual([60, 75, 60, 60]);
    expect(r.length_min).toBe(60);
  });

  it("the DST week (US clocks go back on Sun 2026-11-01): seven local dates, slots in local minutes", () => {
    const week = weekDates("2026-10-26");
    expect(week).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    const r = findFreeSlots(input({ week, today: "2026-10-26", settings: evenings }));
    expect(startsOn(r, "2026-11-01")).toEqual(["07:00"]);
    // A session at 12:00 local is 18:00Z on Saturday (UTC−6) and 19:00Z on Sunday (UTC−7).
    const at = (started: string, ended: string, date: string) => sessionBlock({ id: "s", local_date: date, started_at: started, ended_at: ended, program_day_id: "D1", status: "done" }, "America/Denver", "2026-11-02T00:00:00.000Z");
    expect(at("2026-10-31T18:00:00.000Z", "2026-10-31T19:00:00.000Z", "2026-10-31")).toMatchObject({ start_min: 720, end_min: 780 });
    expect(at("2026-11-01T19:00:00.000Z", "2026-11-01T20:00:00.000Z", "2026-11-01")).toMatchObject({ start_min: 720, end_min: 780 });
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

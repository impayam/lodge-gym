import { describe, expect, it } from "vitest";
import { nextDay, restAdvised, weekRange, type CycleSession } from "../../worker/lib/cycle";

const ORDER = ["D1", "D2", "D3", "D4"];
const s = (day: string, date: string, status: "active" | "done" = "done", t = "T17:00:00.000Z"): CycleSession => ({
  program_day_id: day,
  local_date: date,
  started_at: date + t,
  status,
});

describe("next day in the cycle", () => {
  it("starts at D1 with no history", () => {
    expect(nextDay(ORDER, []).dayId).toBe("D1");
  });
  it("follows D1 → D2 → D3 → D4 → D1", () => {
    expect(nextDay(ORDER, [s("D1", "2026-09-20")]).dayId).toBe("D2");
    expect(nextDay(ORDER, [s("D1", "2026-09-20"), s("D3", "2026-09-22")]).dayId).toBe("D4");
    expect(nextDay(ORDER, [s("D4", "2026-09-25")]).dayId).toBe("D1");
  });
  it("uses the latest done session, ignoring active ones", () => {
    const r = nextDay(ORDER, [s("D2", "2026-09-26"), s("D3", "2026-09-27", "active")]);
    expect(r.dayId).toBe("D3");
  });
  it("orders same-day sessions by start time", () => {
    const r = nextDay(ORDER, [s("D2", "2026-09-26", "done", "T20:00:00.000Z"), s("D1", "2026-09-26", "done", "T08:00:00.000Z")]);
    expect(r.dayId).toBe("D3");
  });
  it("restarts at D1 after a legacy-program session", () => {
    const r = nextDay(ORDER, [s("UA", "2026-09-20")]);
    expect(r).toMatchObject({ dayId: "D1", programChanged: true });
  });
});

describe("two-days-in-a-row rule", () => {
  it("advises rest after two consecutive training days", () => {
    expect(restAdvised("2026-09-27", [s("D1", "2026-09-25"), s("D2", "2026-09-26")])).toBe(true);
  });
  it("does not advise rest otherwise", () => {
    expect(restAdvised("2026-09-27", [s("D1", "2026-09-24"), s("D2", "2026-09-26")])).toBe(false);
    expect(restAdvised("2026-09-27", [s("D2", "2026-09-26")])).toBe(false);
    expect(restAdvised("2026-09-27", [s("D1", "2026-09-25"), s("D2", "2026-09-26", "active")])).toBe(false);
  });
});

describe("week boundaries", () => {
  // 2026-09-27 is a Sunday.
  it("monday start", () => {
    expect(weekRange("2026-09-27", "mon")).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(weekRange("2026-09-28", "mon")).toEqual({ start: "2026-09-28", end: "2026-10-04" });
  });
  it("sunday start", () => {
    expect(weekRange("2026-09-27", "sun")).toEqual({ start: "2026-09-27", end: "2026-10-03" });
    expect(weekRange("2026-09-26", "sun")).toEqual({ start: "2026-09-20", end: "2026-09-26" });
  });
  it("saturday start", () => {
    expect(weekRange("2026-09-27", "sat")).toEqual({ start: "2026-09-26", end: "2026-10-02" });
    expect(weekRange("2026-09-25", "sat")).toEqual({ start: "2026-09-19", end: "2026-09-25" });
  });
  it("crosses month and year boundaries", () => {
    expect(weekRange("2027-01-01", "mon")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });
});

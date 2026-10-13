import { describe, expect, it } from "vitest";
import { nextDay, restAdvised, versionAliases, weekRange, type CycleSession } from "../../worker/lib/cycle";
import type { ProgramInfo } from "../../worker/lib/types";

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

describe("the cycle across Apply to program (SPEC-v3 M9c)", () => {
  const info = (id: string, generated_by: ProgramInfo["generated_by"], acts: [string, string | null][], status: ProgramInfo["status"]): ProgramInfo => ({
    id,
    name: id,
    style: "seed_full_body",
    days_per_week: 4,
    params: null,
    generated_by,
    created_at: acts[0][0],
    approved_at: acts[0][0],
    archived_at: null,
    status,
    activations: acts.map(([started_at, ended_at], i) => ({ id: `${id}-a${i}`, program_id: id, started_at, ended_at })),
  });
  const days = (program: string, ids: string[]) => ids.map((id, i) => ({ id, program_id: program, position: i + 1 }));
  const T1 = "2026-10-01T10:00:00.000Z";
  const T2 = "2026-10-05T10:00:00.000Z";
  // fullbody4 → v2 (applied from a session plan) → v3 (applied again).
  const programs = [
    info("fullbody4", "seed", [["2026-09-27T06:00:00.000Z", T1]], "archived"),
    info("v2", "session", [[T1, T2]], "archived"),
    info("v3", "session", [[T2, null]], "active"),
  ];
  const active = days("v3", ["v3-d1", "v3-d2", "v3-d3", "v3-d4"]);
  const old = [...days("fullbody4", ["D1", "D2", "D3", "D4"]), ...days("v2", ["v2-d1", "v2-d2", "v2-d3", "v2-d4"])];

  it("maps every earlier version's days to the active day at the same position", () => {
    const alias = versionAliases(programs, old, active);
    expect(alias.get("D2")).toBe("v3-d2");
    expect(alias.get("v2-d4")).toBe("v3-d4");
    const order = active.map((d) => d.id);
    expect(nextDay(order, [s("D2", "2026-10-04")], alias)).toMatchObject({ dayId: "v3-d3", programChanged: false });
    expect(nextDay(order, [s("v2-d4", "2026-10-06")], alias)).toMatchObject({ dayId: "v3-d1", programChanged: false });
  });

  it("a switch to another program still starts at Day 1", () => {
    const switched = [info("fullbody4", "seed", [["2026-09-27T06:00:00.000Z", T1]], "archived"), info("gen", "generator", [[T1, null]], "active")];
    const alias = versionAliases(switched, days("fullbody4", ["D1", "D2", "D3", "D4"]), days("gen", ["g1", "g2", "g3"]));
    expect(alias.size).toBe(0);
    expect(nextDay(["g1", "g2", "g3"], [s("D2", "2026-10-04")], alias)).toMatchObject({ dayId: "g1", programChanged: true });
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

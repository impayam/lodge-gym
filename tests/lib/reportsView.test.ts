import { describe, expect, it } from "vitest";
import { barScale, calendarStarts, calendarWeeks, changePct, chartFrom, chartWindow, restOfWeek, signedPct } from "../../web/src/lib/reportsView";

describe("Reports view (SPEC-v8 §6.03)", () => {
  it("1RM chart window: 8 weeks, 6 months, or since the first session", () => {
    expect(chartFrom("week", "2026-10-18", "2026-08-01")).toBe("2026-08-24");
    expect(chartFrom("month", "2026-10-31", "2026-08-01")).toBe("2026-05-01");
    expect(chartFrom("month", "2026-03-31", null)).toBe("2025-10-01");
    expect(chartFrom("all", "2026-10-18", "2026-08-01")).toBe("2026-08-01");
    expect(chartFrom("all", "2026-10-18", null)).toBe("2026-10-18");
    expect(chartWindow("week", "Sep 27")).toBe("8 weeks");
    expect(chartWindow("month", "Sep 27")).toBe("6 months");
    expect(chartWindow("all", "Sep 27")).toBe("since Sep 27");
  });

  it("consistency weeks: trained days, sessions per week (two on a day count twice), future days", () => {
    const weeks = calendarWeeks(["2026-10-05", "2026-10-07", "2026-10-07", "2026-10-13"], ["2026-10-05", "2026-10-12"], "2026-10-14");
    expect(weeks.map((w) => w.done)).toEqual([3, 1]);
    expect(weeks[0].days.filter((d) => d.trained).map((d) => d.date)).toEqual(["2026-10-05", "2026-10-07"]);
    expect(weeks[1].days.filter((d) => d.future).map((d) => d.date)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(weeks[1].days).toHaveLength(7);
  });

  it("consistency rows per period", () => {
    expect(calendarStarts("week", "2026-10-12", { start: "2026-10-12", end: "2026-10-18" }, null)).toEqual(["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
    // October 2026 starts on a Thursday: Monday weeks from Sep 28 to Oct 26.
    expect(calendarStarts("month", "2026-09-28", { start: "2026-10-01", end: "2026-10-31" }, null)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(calendarStarts("all", "2026-10-12", { start: "2026-09-27", end: "2026-10-14" }, "2026-09-21")).toEqual(["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
  });

  it("tile changes", () => {
    expect(changePct(157.5, 166.3)).toBe(5.6);
    expect(changePct(100, 100)).toBe(0);
    expect(changePct(null, 100)).toBeNull();
    expect(changePct(0, 100)).toBeNull();
    expect(signedPct(5.6)).toBe("+5.6%");
    expect(signedPct(-2)).toBe("−2%");
    expect(signedPct(0)).toBe("0%");
    expect(signedPct(null)).toBe("–");
  });

  it("bar scale is 0–20 sets, wider when needed", () => {
    expect(barScale([9, 13, 17.5])).toBe(20);
    expect(barScale([24, 13])).toBe(24);
  });
});

describe("after-session report: the rest of the week in one line (Payam, 2026-10-16)", () => {
  const row = (group: string, today: number, status: string, target: number | null = 10) => ({ group, today, week: 2, target, status });
  it("counts the groups not trained today by status, naming all but the ones on target; groups without a target are left out", () => {
    expect(
      restOfWeek([
        row("Chest", 4, "under"),
        row("Back", 0, "under"),
        row("Quads", 0, "under"),
        row("Calves", 0, "none"),
        row("Shoulders", 0, "over"),
        row("Biceps", 0, "on"),
        row("Core", 0, "on"),
        row("Neck", 0, "none", null),
        row("Forearms", 0, "untracked", null),
      ])
    ).toBe("Rest of the week: 2 groups under target (Back, Quads), 1 not trained yet (Calves), 1 over target (Shoulders), 2 on target.");
    expect(restOfWeek([row("Back", 0, "on")])).toBe("Rest of the week: 1 group on target.");
    // The first session of the week: the rest are not trained yet.
    expect(restOfWeek([row("Chest", 4, "under"), row("Back", 0, "none"), row("Quads", 0, "none")])).toBe("Rest of the week: 2 groups not trained yet (Back, Quads).");
  });

  it("is null when every group was trained today or none left has a target", () => {
    expect(restOfWeek([row("Chest", 4, "under")])).toBeNull();
    expect(restOfWeek([row("Neck", 0, "none", null)])).toBeNull();
    expect(restOfWeek([])).toBeNull();
  });
});

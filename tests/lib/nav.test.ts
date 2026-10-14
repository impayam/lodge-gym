import { describe, expect, it } from "vitest";
import { backTarget, edgeSwipeOutcome, isTabRoot, showsCoachButton, showsTabBar, tabAfter, tabIndex, TABS, type ViewName } from "../../web/src/lib/nav";

// SPEC-v8 §5 and §10: five icon tabs, the indicator's index, pushed screens and Back, the edge-swipe rule.
describe("tabs", () => {
  it("are Train, History, Library, Reports and Me, in that order", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Train", "History", "Library", "Reports", "Me"]);
  });

  it("the indicator index follows the tab order", () => {
    expect(TABS.map((t) => tabIndex(t.name))).toEqual([0, 1, 2, 3, 4]);
    expect(tabIndex("reports")).toBe(3);
  });

  it("a tab's root screen selects it; a pushed screen keeps the current tab", () => {
    expect(tabAfter("history", "home")).toBe("history");
    expect(tabAfter("me", "reports")).toBe("me");
    expect(tabAfter("report", "reports")).toBe("reports");
    expect(tabAfter("settings", "me")).toBe("me");
    expect(tabAfter("session", "home")).toBe("home");
  });
});

describe("back", () => {
  it("goes to Me from the screens that moved into it", () => {
    for (const v of ["program", "settings", "ai", "backup", "photos"] as ViewName[]) expect(backTarget(v, "me"), v).toBe("me");
  });

  it("goes to the tab a report, plan or the Coach was opened from", () => {
    expect(backTarget("report", "history")).toBe("history");
    expect(backTarget("report", "reports")).toBe("reports");
    expect(backTarget("plan", "home")).toBe("home");
    expect(backTarget("coach", "library")).toBe("library");
  });

  it("goes to Settings from Apple Watch and the program editor, to History from a saved report", () => {
    expect(backTarget("watch", "me")).toBe("settings");
    expect(backTarget("newprogram", "me")).toBe("settings");
    expect(backTarget("saved", "history")).toBe("history");
  });

  it("is null on tab roots and the active session", () => {
    for (const t of TABS) expect(backTarget(t.name, "home"), t.name).toBeNull();
    expect(backTarget("session", "home")).toBeNull();
  });
});

describe("chrome", () => {
  it("the tab bar hides on the full-screen session and Coach", () => {
    expect(showsTabBar("session")).toBe(false);
    expect(showsTabBar("coach")).toBe(false);
    expect(showsTabBar("report")).toBe(true);
    expect(showsTabBar("home")).toBe(true);
  });

  it("the Coach button is on the five tab screens only", () => {
    expect(TABS.every((t) => showsCoachButton(t.name) && isTabRoot(t.name))).toBe(true);
    for (const v of ["session", "coach", "report", "settings"] as ViewName[]) expect(showsCoachButton(v), v).toBe(false);
  });
});

describe("edge swipe", () => {
  it("completes past 35% of the width, otherwise springs back", () => {
    expect(edgeSwipeOutcome(137, 390, 0.1)).toBe("back");
    expect(edgeSwipeOutcome(130, 390, 0.1)).toBe("cancel");
  });

  it("a fast flick completes even when short", () => {
    expect(edgeSwipeOutcome(60, 390, 0.8)).toBe("back");
    expect(edgeSwipeOutcome(10, 390, 2)).toBe("cancel");
  });
});

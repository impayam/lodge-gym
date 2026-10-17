import { describe, expect, it } from "vitest";
import { backTarget, edgeSwipeOutcome, isTabRoot, showsCoachButton, showsTabBar, tabAfter, tabIndex, TABS, type ViewName } from "../../web/src/lib/nav";

// SPEC-v8 §5 and §10, SPEC-v12 M15 §3.0: four icon tabs, the indicator's index, pushed screens and Back, the edge-swipe
// rule.
describe("tabs", () => {
  it("are Train, History, Library and Profile, in that order", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Train", "History", "Library", "Profile"]);
  });

  it("the indicator index follows the tab order", () => {
    expect(TABS.map((t) => tabIndex(t.name))).toEqual([0, 1, 2, 3]);
    expect(tabIndex("profile")).toBe(3);
  });

  it("a tab's root screen selects it; a pushed screen keeps the current tab", () => {
    expect(tabAfter("history", "home")).toBe("history");
    expect(tabAfter("profile", "library")).toBe("profile");
    expect(tabAfter("report", "profile")).toBe("profile");
    expect(tabAfter("settings", "profile")).toBe("profile");
    expect(tabAfter("goal", "profile")).toBe("profile");
    expect(tabAfter("session", "home")).toBe("home");
  });
});

describe("back", () => {
  it("goes to Profile from its gear list (Program, Photos, Settings), Set goal and the sizes list", () => {
    for (const v of ["program", "settings", "photos", "goal", "sizes"] as ViewName[]) expect(backTarget(v, "profile"), v).toBe("profile");
  });

  it("goes to the tab a report, plan, the Coach or the Calendar was opened from", () => {
    expect(backTarget("report", "history")).toBe("history");
    expect(backTarget("report", "profile")).toBe("profile");
    expect(backTarget("plan", "home")).toBe("home");
    expect(backTarget("coach", "library")).toBe("library");
    expect(backTarget("calendar", "home")).toBe("home");
  });

  it("goes to Settings from AI reports, Backup, Apple Watch and the program editor; a saved report back to All reports, and that to its tab", () => {
    for (const v of ["ai", "backup", "watch", "newprogram"] as ViewName[]) expect(backTarget(v, "profile"), v).toBe("settings");
    expect(backTarget("saved", "profile")).toBe("allreports");
    expect(backTarget("allreports", "profile")).toBe("profile");
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
    expect(showsTabBar("calendar")).toBe(true);
    expect(showsTabBar("home")).toBe(true);
  });

  it("the Coach button is on the four tab screens only", () => {
    expect(TABS.every((t) => showsCoachButton(t.name) && isTabRoot(t.name))).toBe(true);
    for (const v of ["session", "coach", "report", "settings", "calendar"] as ViewName[]) expect(showsCoachButton(v), v).toBe(false);
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

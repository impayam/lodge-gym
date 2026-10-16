import { describe, expect, it } from "vitest";
import { cardIndex, cardSwipeOutcome, currentSetIndex, groupCurrent, restShare, sessionEffort, sessionUnits } from "../../web/src/lib/session";

const sets = (...done: boolean[]) => done.map((d) => ({ done: d }));

describe("active session (SPEC-v8 §6.02)", () => {
  it("effort is the share of the session's sets that are done", () => {
    expect(sessionEffort([])).toEqual({ done: 0, planned: 0, e: 0 });
    expect(sessionEffort(sets(true, false, false, false))).toEqual({ done: 1, planned: 4, e: 0.25 });
    expect(sessionEffort(sets(true, true))).toEqual({ done: 2, planned: 2, e: 1 });
  });

  it("the current set is the first one not done", () => {
    expect(currentSetIndex(sets(true, false, false))).toBe(1);
    expect(currentSetIndex(sets(false, true))).toBe(0);
    expect(currentSetIndex(sets(true, true))).toBe(-1);
    expect(currentSetIndex([])).toBe(-1);
  });

  it("the card keeps the exercise last shown, else opens the first with a set left", () => {
    const blocks = [
      { id: "bench", sets: sets(true, true) },
      { id: "row", sets: sets(true, false) },
      { id: "fly", sets: sets(false) },
    ];
    expect(cardIndex(blocks, null)).toBe(1);
    expect(cardIndex(blocks, "fly")).toBe(2);
    expect(cardIndex(blocks, "removed")).toBe(1);
    expect(cardIndex([{ id: "bench", sets: sets(true) }], null)).toBe(0);
    expect(cardIndex([], null)).toBe(0);
  });

  it("card swipe: left is next, right is previous; past 35% or a flick; never past the ends", () => {
    expect(cardSwipeOutcome(-140, 358, 0, true, true)).toBe("next");
    expect(cardSwipeOutcome(140, 358, 0, true, true)).toBe("prev");
    expect(cardSwipeOutcome(-100, 358, 0.1, true, true)).toBe("cancel");
    expect(cardSwipeOutcome(-30, 358, -0.8, true, true)).toBe("next");
    expect(cardSwipeOutcome(30, 358, 0.8, true, true)).toBe("prev");
    // A flick against the drag (the finger came back) does not count.
    expect(cardSwipeOutcome(-30, 358, 0.8, true, true)).toBe("cancel");
    expect(cardSwipeOutcome(-20, 358, -0.9, true, true)).toBe("cancel");
    expect(cardSwipeOutcome(-200, 358, 0, true, false)).toBe("cancel");
    expect(cardSwipeOutcome(200, 358, 0, false, true)).toBe("cancel");
  });

  it("rest ring share runs from 1 down to 0", () => {
    expect(restShare(90, 90)).toBe(1);
    expect(restShare(45, 90)).toBe(0.5);
    expect(restShare(-5, 90)).toBe(0);
    expect(restShare(120, 90)).toBe(1);
    expect(restShare(10, 0)).toBe(0);
  });

  it("cards: a superset or tri-set is one card with its members in order; Prev / Next move between cards", () => {
    const b = (id: string, tag: string | null) => ({ ex: { id }, group: tag ? { tag } : null });
    const units = sessionUnits([b("bench", null), b("incline_db", null), b("lateral", "A"), b("facepull", "A"), b("fly", "B"), b("dip", "B"), b("pec", "B"), b("curl", null)]);
    expect(units.map((u) => [u.key, u.blocks.map((x) => x.ex.id)])).toEqual([
      ["bench", ["bench"]],
      ["incline_db", ["incline_db"]],
      ["group:lateral", ["lateral", "facepull"]],
      ["group:fly", ["fly", "dip", "pec"]],
      ["curl", ["curl"]],
    ]);
    // A group left with one member is an exercise alone.
    expect(sessionUnits([b("lateral", "A"), b("curl", null)]).map((u) => u.key)).toEqual(["lateral", "curl"]);
    expect(sessionUnits([])).toEqual([]);
  });

  it("a group card's current set goes round by round; extra sets are rounds at the end", () => {
    const m = (id: string, done: boolean[]) => ({ id, sets: done.map((d) => ({ done: d })) });
    expect(groupCurrent([m("a", [false, false]), m("b", [false, false])])).toEqual({ exerciseId: "a", set: 0 });
    expect(groupCurrent([m("a", [true, false]), m("b", [false, false])])).toEqual({ exerciseId: "b", set: 0 });
    expect(groupCurrent([m("a", [true, false]), m("b", [true, false])])).toEqual({ exerciseId: "a", set: 1 });
    // A1 has a fourth set: its own round after the third.
    expect(groupCurrent([m("a", [true, true, true, false]), m("b", [true, true, true])])).toEqual({ exerciseId: "a", set: 3 });
    // A skipped set comes back first.
    expect(groupCurrent([m("a", [true, true]), m("b", [false, true])])).toEqual({ exerciseId: "b", set: 0 });
    expect(groupCurrent([m("a", [true]), m("b", [true])])).toBeNull();
  });
});

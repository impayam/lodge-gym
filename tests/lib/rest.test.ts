import { describe, expect, it } from "vitest";
import { REST_DEFAULTS, restAfterSet, restLabel, restPushBody, roundRows, type RestUnit } from "../../worker/lib/rest";

// The session's rest timer (Payam, 2026-10-16): 30 s between sets of one exercise, 2 min before the next exercise;
// a superset or tri-set rests by its own group rest after each round (no timer inside a round), 2 min after the last.
const flags = (n: number, done: number[]) => Array.from({ length: n }, (_, i) => done.includes(i));
const single = (id: string, name: string, sets: number, done: number[] = []): RestUnit => ({ members: [{ id, name, done: flags(sets, done) }], groupRest: null });
const group = (rest: number, members: [string, string, number, number[]][]): RestUnit => ({ members: members.map(([id, name, n, done]) => ({ id, name, done: flags(n, done) })), groupRest: rest });

describe("rest after a set", () => {
  it("an exercise alone: 30 s while it has a set left, then 2 min before the next exercise", () => {
    const units = [single("bench", "Barbell Bench Press", 4, [0]), single("row", "Seated Cable Row", 3)];
    expect(restAfterSet(units, 0, "bench", 0, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 30, next: { kind: "set", set: 2, of: 4 } });
    const last = [single("bench", "Barbell Bench Press", 4, [0, 1, 2, 3]), single("row", "Seated Cable Row", 3)];
    expect(restAfterSet(last, 0, "bench", 3, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 120, next: { kind: "exercise", name: "Seated Cable Row" } });
  });

  it("the next set is the first one not done, also when he checked them out of order", () => {
    const units = [single("bench", "Barbell Bench Press", 4, [0, 2])];
    expect(restAfterSet(units, 0, "bench", 2, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 30, next: { kind: "set", set: 2, of: 4 } });
  });

  it("the next exercise is the next card with a set left, wrapping round to one he skipped; none when all is done", () => {
    const units = [single("a", "A", 2), single("b", "B", 2, [0, 1]), single("c", "C", 2, [0, 1])];
    expect(restAfterSet(units, 1, "b", 1, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 120, next: { kind: "exercise", name: "A" } });
    const all = [single("a", "A", 2, [0, 1]), single("b", "B", 2, [0, 1])];
    expect(restAfterSet(all, 1, "b", 1, REST_DEFAULTS)).toEqual({ kind: "none" });
  });

  it("a superset: no timer inside a round, the group's rest after each round, 2 min after the last round", () => {
    const after = (a: number[], b: number[]) => [group(75, [["lat", "Lateral Raise", 3, a], ["face", "Face Pull", 3, b]]), single("curl", "Curl", 3)];
    // A1 set 1 done: A2's set 1 is next, no timer.
    expect(restAfterSet(after([0], []), 0, "lat", 0, REST_DEFAULTS)).toEqual({ kind: "in_round", exerciseId: "face", set: 0 });
    // A2 checked first: A1 is next in the round.
    expect(restAfterSet(after([], [0]), 0, "face", 0, REST_DEFAULTS)).toEqual({ kind: "in_round", exerciseId: "lat", set: 0 });
    // Round 1 complete: the group's 75 s, then round 2.
    expect(restAfterSet(after([0], [0]), 0, "face", 0, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 75, next: { kind: "round", round: 2, of: 3 } });
    // The last round: 2 min, then the next exercise.
    expect(restAfterSet(after([0, 1, 2], [0, 1, 2]), 0, "face", 2, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 120, next: { kind: "exercise", name: "Curl" } });
  });

  it("a tri-set: the round waits for all three members", () => {
    const units = [group(90, [["a", "A", 2, [0]], ["b", "B", 2, [0]], ["c", "C", 2, []]])];
    expect(restAfterSet(units, 0, "b", 0, REST_DEFAULTS)).toEqual({ kind: "in_round", exerciseId: "c", set: 0 });
    const full = [group(90, [["a", "A", 2, [0]], ["b", "B", 2, [0]], ["c", "C", 2, [0]]])];
    expect(restAfterSet(full, 0, "c", 0, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 90, next: { kind: "round", round: 2, of: 2 } });
  });

  it("a member's extra sets are rounds of their own at the end, each followed by the group's rest", () => {
    // A1 has 4 sets, A2 3: round 4 is A1 alone.
    const units = (a: number[], b: number[]) => [group(75, [["a", "A", 4, a], ["b", "B", 3, b]]), single("c", "C", 3)];
    expect(restAfterSet(units([0, 1, 2], [0, 1, 2]), 0, "b", 2, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 75, next: { kind: "round", round: 4, of: 4 } });
    expect(restAfterSet(units([0, 1, 2, 3], [0, 1, 2]), 0, "a", 3, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 120, next: { kind: "exercise", name: "C" } });
    // A round he skipped comes back first.
    expect(restAfterSet(units([0, 2], [0, 2]), 0, "b", 2, REST_DEFAULTS)).toEqual({ kind: "rest", seconds: 75, next: { kind: "round", round: 2, of: 4 } });
  });

  it("uses his Settings → Training values", () => {
    const rules = { rest_between_sets_sec: 60, rest_next_exercise_sec: 180 };
    expect(restAfterSet([single("a", "A", 3, [0]), single("b", "B", 3)], 0, "a", 0, rules)).toMatchObject({ seconds: 60 });
    expect(restAfterSet([single("a", "A", 1, [0]), single("b", "B", 3)], 0, "a", 0, rules)).toMatchObject({ seconds: 180 });
    // A group keeps its own rest after a round.
    expect(restAfterSet([group(75, [["a", "A", 2, [0]], ["b", "B", 2, [0]]])], 0, "b", 0, rules)).toMatchObject({ seconds: 75 });
  });

  it("the group card's rows go round by round; the label says what comes next", () => {
    expect(roundRows([{ id: "a", sets: 3 }, { id: "b", sets: 2 }]).map((r) => `${r.exerciseId}${r.set + 1}`)).toEqual(["a1", "b1", "a2", "b2", "a3"]);
    expect(restLabel({ kind: "set", set: 3, of: 4 })).toBe("Rest · next: set 3 of 4");
    expect(restLabel({ kind: "round", round: 2, of: 3 })).toBe("Rest · next: round 2 of 3");
    expect(restLabel({ kind: "exercise", name: "Pull-Up" })).toBe("Rest · next: Pull-Up");
  });

  it("the push at the end of the rest says what is next", () => {
    expect(restPushBody("Rest · next: set 3 of 4")).toBe("Next: set 3 of 4");
    expect(restPushBody("Rest · next: Pull-Up")).toBe("Next: Pull-Up");
    expect(restPushBody("")).toBe("Time for the next set.");
    expect(restPushBody(undefined)).toBe("Time for the next set.");
  });
});

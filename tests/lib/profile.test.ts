import { describe, expect, it } from "vitest";
import { BODY_GOAL_BADGE, goalsFromSettings, paceSentence, paceStatus, slotGoal, trainingLabel, type Goals } from "../../worker/lib/goals";
import { latestSizes, sizeChange, type BodyMeasurement } from "../../worker/lib/measurements";
import { afterSessionLine, baselineWindow, bodyLine, diamond, profile, regionsDone, type ProfileData } from "../../worker/lib/profile";
import { beforeAfter, photoGroups } from "../../worker/lib/photoGroups";
import type { Exercise, Photo, SetEntry, WorkoutSession } from "../../worker/lib/types";
import { FRAMING_STREAK, framingOf, framingStart, LM, nextFraming, poseHint, readPose, type Landmark } from "../../web/src/lib/pose";
import { exercises, reportData } from "../fixtures/report-data";
import { cameraSettings, clipBelow, DEFAULT_CAMERA, FRAME_H, isLevel, outline, tilt, WAIST_Y } from "../../web/src/lib/camera";

// SPEC-v12 M15 (decisions by Payam 2026-10-17): goals, the pace of the body goal, body sizes, the Living Diamond's
// normalization and the after-session line; and the guide camera's pure parts (SPEC-v10.1).

let n = 0;
function session(id: string, date: string, sets: [string, number, number | null, number | null][]): WorkoutSession {
  const list: SetEntry[] = sets.flatMap(([ex, count, w, r]) =>
    Array.from({ length: count }, (_, i) => ({ id: `${id}-${n++}`, exercise_id: ex, set_index: i, weight: w, reps: r, seconds: null, done: true, updated_at: `${date}T20:00:00.000Z` }))
  );
  return { id, program_day_id: "D1", local_date: date, started_at: `${date}T18:00:00.000Z`, ended_at: `${date}T19:00:00.000Z`, status: "done", unit: "lb", note: "", created_at: `${date}T18:00:00.000Z`, updated_at: `${date}T19:00:00.000Z`, source: "app", sets: list };
}

function size(date: string, f: Partial<BodyMeasurement>, deleted = false): BodyMeasurement {
  return { id: `m-${date}-${n++}`, local_date: date, arm_cm: null, chest_cm: null, waist_cm: null, hips_cm: null, thigh_cm: null, calf_cm: null, neck_cm: null, shoulders_cm: null, note: "", created_at: `${date}T10:00:00.000Z`, updated_at: `${date}T10:00:00.000Z`, deleted_at: deleted ? `${date}T11:00:00.000Z` : null, ...f };
}

/** The seed exercises with chest regions on the bench press (the library carries region tags; the fixture has none). */
function exs(): Exercise[] {
  return exercises().map((e) =>
    e.id === "bench"
      ? { ...e, regions: [{ region: "chest_mid", emphasis: "primary", evidence: "strong" }, { region: "chest_lower", emphasis: "primary", evidence: "moderate" }] }
      : e.id === "squat"
        ? { ...e, regions: [{ region: "quads_squat", emphasis: "primary", evidence: "strong" }] }
        : e
  ) as Exercise[];
}

function data(sessions: WorkoutSession[], over: Partial<ProfileData> = {}): ProfileData {
  const d = reportData();
  return { ...d, exercises: exs(), sessions, body: [], goals: null, measurements: [], ...over };
}

const goal = (set_at: string, training: Goals["training"] = ["strength"], body: Goals["body"] = "gain"): Goals => ({ training, body, set_at });

describe("goals", () => {
  it("parse from the settings keys; anything invalid is no goal", () => {
    expect(goalsFromSettings({ goal_training: '["growth","strength"]', goal_body: "gain", goal_set_at: "2026-10-17T10:00:00Z" })).toEqual({ training: ["growth", "strength"], body: "gain", set_at: "2026-10-17T10:00:00Z" });
    for (const bad of ['["growth","growth"]', '["a"]', "[]", '["growth","strength","power"]', "nope"]) expect(goalsFromSettings({ goal_training: bad, goal_body: "gain", goal_set_at: "x" })).toBeNull();
    expect(goalsFromSettings({ goal_training: '["growth"]', goal_body: "bulk", goal_set_at: "x" })).toBeNull();
    expect(goalsFromSettings({})).toBeNull();
  });
  it("a pair: main and secondary follow the heavier goal (Strength > Power > Growth > Endurance), the rest the other", () => {
    expect(slotGoal("main", ["endurance", "growth"])).toBe("growth");
    expect(slotGoal("accessory", ["endurance", "growth"])).toBe("endurance");
    expect(slotGoal("secondary", ["growth", "power"])).toBe("power");
    expect(slotGoal("core", ["strength", "power"])).toBe("power");
    expect(slotGoal("main", ["growth"])).toBe("growth");
    expect(slotGoal("main", null)).toBeNull();
    expect(trainingLabel(["growth", "strength"])).toBe("Growth + Strength");
    expect(BODY_GOAL_BADGE).toEqual({ gain: "GAIN", maintain: "HOLD", cut: "CUT" });
  });
  it("the pace: Gain 0.25–0.5 %/week, Cut 0.5–1 %/week, Maintain within 0.5 kg over four weeks", () => {
    expect(paceStatus("gain", 0.003, 1)).toBe("on");
    expect(paceStatus("gain", 0.001, 0.3)).toBe("slow");
    expect(paceStatus("gain", 0.008, 2.5)).toBe("fast");
    expect(paceStatus("cut", -0.007, -2.2)).toBe("on");
    expect(paceStatus("cut", -0.002, -0.6)).toBe("slow");
    expect(paceStatus("cut", -0.015, -4.8)).toBe("fast");
    expect(paceStatus("maintain", 0.001, 0.4)).toBe("holding");
    expect(paceStatus("maintain", 0.004, -0.6)).toBe("drifting");
    expect(paceStatus("gain", null, null)).toBe("no_data");
    expect(paceSentence("cut", "fast")).toContain("muscle is at risk");
  });
});

describe("body sizes", () => {
  const list = [size("2026-09-01", { arm_cm: 37.5, chest_cm: 100 }), size("2026-09-20", { arm_cm: 38, waist_cm: 85 }), size("2026-10-10", { arm_cm: 38.5 }), size("2026-10-12", { arm_cm: 50 }, true)];
  it("the latest value of each field with its change since the entry before; deleted entries left out", () => {
    expect(latestSizes(list)).toEqual([
      { field: "arm", value: 38.5, date: "2026-10-10", change: 0.5, since: "2026-09-20" },
      { field: "chest", value: 100, date: "2026-09-01", change: null, since: null },
      { field: "waist", value: 85, date: "2026-09-20", change: null, since: null },
    ]);
  });
  it("the change over a window needs two entries", () => {
    expect(sizeChange(list, "arm", "2026-09-01", "2026-10-17")).toBe(1);
    expect(sizeChange(list, "chest", "2026-09-01", "2026-10-17")).toBeNull();
  });
});

describe("Living Diamond", () => {
  const today = "2026-10-17";
  it("baseline: the 28 days up to the goal when two weeks of training precede it, otherwise the first 14 days", () => {
    const done = [session("a", "2026-09-01", [["bench", 1, 100, 5]])];
    expect(baselineWindow(done, goal("2026-10-01T12:00:00Z"), "America/Denver")).toEqual({ from: "2026-09-04", to: "2026-10-01", kind: "goal" });
    expect(baselineWindow(done, goal("2026-09-10T12:00:00Z"), "America/Denver")).toEqual({ from: "2026-09-01", to: "2026-09-14", kind: "first_data" });
    expect(baselineWindow([], null, "America/Denver")).toBeNull();
  });

  it("Strength: +10 % on the main lifts' summed best e1RM is a full corner; a lift not done keeps its baseline", () => {
    // Baseline (first 14 days): bench 200×5 → 233.3, squat 300×5 → 350. Now: bench 250×5 → 291.7, squat not done.
    const d = data([session("b1", "2026-09-01", [["bench", 1, 200, 5], ["squat", 1, 300, 5]]), session("b2", "2026-10-15", [["bench", 1, 250, 5]])]);
    const r = diamond(d, today);
    const bench = r.strength.find((l) => l.exercise_id === "bench")!;
    const squat = r.strength.find((l) => l.exercise_id === "squat")!;
    expect(bench).toMatchObject({ e1rm: 291.7, baseline: 233.3, change_pct: 25, kept: false });
    expect(squat).toMatchObject({ e1rm: 350, baseline: 350, change_pct: 0, kept: true });
    // (291.7 + 350) / (233.3 + 350) − 1 = +10.0 % → full.
    expect(r.corners.strength).toMatchObject({ value: 1, label: "+10 %", has_data: true });
  });

  it("Growth: the regions share alone with under two size entries; half regions, half sizes with them", () => {
    const sessions = [session("g1", "2026-10-14", [["bench", 3, 135, 8], ["squat", 3, 185, 5]])];
    const plain = diamond(data(sessions), today);
    // Week of Oct 12 (Monday start): chest middle, chest lower, quads vasti = 3 of 30.
    expect(plain.growth).toMatchObject({ regions_done: 3, regions_total: 30, uses_sizes: false });
    expect(plain.corners.growth.value).toBeCloseTo(0.1, 5);
    const sizes = [size("2026-09-01", { arm_cm: 37, chest_cm: 100, shoulders_cm: 118, thigh_cm: 58 }), size("2026-10-10", { arm_cm: 38, chest_cm: 101, shoulders_cm: 119, thigh_cm: 59 })];
    const withSizes = diamond(data(sessions, { measurements: sizes }), today);
    expect(withSizes.growth.uses_sizes).toBe(true);
    // ½ × 0.1 + ½ × (mean +1.0 cm ÷ 1.0) = 0.55.
    expect(withSizes.corners.growth.value).toBeCloseTo(0.55, 5);
    expect(withSizes.growth.missing).toHaveLength(27);
  });

  it("Endurance: reps at the same weight on non-main work with 12+ reps; +25 % is full; nothing to measure is 0 and no data", () => {
    const first = session("e1", "2026-09-25", [["lateral", 3, 15, 12]]);
    const later = session("e2", "2026-10-15", [["lateral", 3, 15, 15]]);
    const r = diamond(data([first, later]), today);
    expect(r.endurance).toEqual([{ exercise_id: "lateral", name: expect.any(String), weight: 15, first_reps: 12, best_reps: 15, first_date: "2026-09-25", gain_pct: 25 }]);
    expect(r.corners.endurance).toMatchObject({ value: 1, label: "+25 %", has_data: true });
    // Main lifts never count, and one session alone has nothing to compare.
    const none = diamond(data([session("e3", "2026-10-15", [["bench", 3, 100, 15], ["lateral", 3, 15, 12]])]), today);
    expect(none.corners.endurance).toEqual({ value: 0, label: "0 %", has_data: false });
  });

  it("Power is always shown: 0, no data; the ghost is the same numbers four weeks ago", () => {
    const d = data([session("p1", "2026-09-01", [["bench", 1, 200, 5]]), session("p2", "2026-10-15", [["bench", 1, 220, 5], ["lateral", 3, 15, 12]])]);
    const r = diamond(d, today);
    expect(r.corners.power).toEqual({ value: 0, label: "0", has_data: false });
    expect(r.ghost.power).toBe(0);
    // Four weeks ago (Sep 19) the best bench in the window is the baseline itself: 0.
    expect(r.ghost.strength).toBe(0);
    expect(r.corners.strength.value).toBeGreaterThan(0.9);
  });
});

describe("body goal line", () => {
  const today = "2026-10-17";
  const kg = (date: string, value: number) => ({ local_date: date, kind: "body_mass" as const, value, unit: "kg" as const, source: "manual" as const });
  it("a 7-day average, the change since the goal (8 weeks at most) and the pace", () => {
    // 80 kg four weeks ago, 81 kg now: +1 kg / 4 weeks = 0.31 %/week of 81 → on pace for Gain.
    const body = [kg("2026-09-19", 80), kg("2026-10-16", 81), kg("2026-10-17", 81)];
    const line = bodyLine({ ...data([]), body, goals: goal("2026-09-19T12:00:00Z", ["growth"], "gain"), settings: { ...reportData().settings, unit: "kg" } }, today)!;
    expect(line).toMatchObject({ badge: "GAIN", goal: "Gain", unit: "kg", avg7: 81, change: 1, since: "2026-09-19", rate_pct: 0.3, status: "on" });
    expect(line.sentence).toBe("Right on pace for Gain: 0.25–0.5 % of body weight a week.");
    // Without weights: no data; without a goal: no line.
    expect(bodyLine({ ...data([]), goals: goal("2026-09-19T12:00:00Z", ["growth"], "cut") }, today)!.status).toBe("no_data");
    expect(bodyLine(data([]), today)).toBeNull();
  });
});

describe("after-session line", () => {
  it("before any session; after today's; after an earlier day's, with records and the regions this week", () => {
    expect(afterSessionLine(data([]), "2026-10-17")).toBe("Your first session lights up the body.");
    const old = session("a1", "2026-10-10", [["bench", 3, 135, 5]]);
    const now = session("a2", "2026-10-17", [["bench", 3, 145, 5], ["rope_pushdown", 3, 40, 12]]);
    expect(afterSessionLine(data([old, now]), "2026-10-17")).toBe("After today: Chest and triceps lit up. New best estimated 1RM: Barbell Bench Press 169 lb. 2 of 30 regions trained this week.");
    expect(afterSessionLine(data([old, now]), "2026-10-19")).toMatch(/^After Saturday's session: Chest and triceps lit up\./);
  });
  it("regions count only main-focus tags that cover them", () => {
    const ex = new Map(exs().map((e) => [e.id, e]));
    expect([...regionsDone([session("r", "2026-10-17", [["bench", 1, 100, 5]])], ex)].sort()).toEqual(["chest_lower", "chest_mid"]);
  });
  it("profile bundles the line, the diamond and the goal label", () => {
    const p = profile(data([], { goals: goal("2026-10-17T12:00:00Z", ["growth", "strength"], "maintain") }), "2026-10-17");
    expect(p.goal_label).toBe("Growth + Strength · Maintain");
    expect(p.body?.badge).toBe("HOLD");
  });
});

describe("guide camera (pure parts)", () => {
  it("settings fall back to the defaults when missing or out of range", () => {
    expect(cameraSettings(null)).toEqual(DEFAULT_CAMERA);
    expect(cameraSettings({ facing: "user", timer: 10, ghost: false, framing: "upper", fit: { full: { scale: 2, offset: -1 }, upper: { scale: 0.75, offset: 0.02 } } })).toEqual({
      facing: "user",
      timer: 10,
      ghost: false,
      framing: "upper",
      fit: { full: { scale: 0.95, offset: -0.08 }, upper: { scale: 0.75, offset: 0.02 } },
    });
    expect(cameraSettings({ timer: 7, framing: "half" })).toMatchObject({ timer: DEFAULT_CAMERA.timer, framing: "full" });
  });
  it("settings saved before the pose check (one scale and offset) become the full-body fit", () => {
    expect(cameraSettings({ facing: "user", timer: 3, scale: 0.9, offset: 0.04, ghost: true })).toEqual({
      facing: "user",
      timer: 3,
      ghost: true,
      framing: "full",
      fit: { full: { scale: 0.9, offset: 0.04 }, upper: DEFAULT_CAMERA.fit.upper },
    });
  });
  it("tilt: upright is beta 90; past 3° is not level; no reading is null", () => {
    expect(tilt(90)).toBe(0);
    expect(tilt(87.5)).toBe(2.5);
    expect(tilt(-95)).toBe(5);
    expect(isLevel(tilt(88))).toBe(true);
    expect(isLevel(tilt(84))).toBe(false);
    expect(tilt(null)).toBeNull();
    expect(isLevel(null)).toBe(false);
  });
  it("the outline sits between the head line and the feet line, centred, and follows size and position", () => {
    const o = outline("front", { scale: 0.8, offset: 0 });
    expect(o.headY).toBe(40);
    expect(o.baseY).toBe(360);
    expect(o.base).toBe("feet");
    expect(o.head.cx).toBe(150);
    expect(o.head.cy - o.head.r).toBeCloseTo(o.headY + 0.005 * 320, 1);
    const lower = outline("front", { scale: 0.8, offset: 0.05 });
    expect(lower.headY).toBe(60);
    expect(outline("side", { scale: 0.8, offset: 0 }).d).not.toBe(o.d);
    expect(outline("back", { scale: 0.8, offset: 0 }).d).toBe(o.d);
  });
  it("upper body: the head and waist lines span the fit; the outline is cut at the waist and drawn larger", () => {
    const up = outline("front", { scale: 0.8, offset: 0 }, "upper");
    expect([up.headY, up.baseY, up.base]).toEqual([40, 360, "waist"]);
    const ys = [...up.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
    expect(Math.max(...ys)).toBeCloseTo(360, 0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(40);
    // The head is drawn for a body of (0.8 × 400) / 0.42 = 762 px, against 320 px for the full body.
    expect(up.head.r).toBeCloseTo(0.06 * ((0.8 * FRAME_H) / WAIST_Y), 0);
    expect(up.head.r).toBeGreaterThan(outline("front", { scale: 0.8, offset: 0 }).head.r * 2);
    expect(outline("side", { scale: 0.8, offset: 0 }, "upper").d).not.toBe(up.d);
  });
  it("clipBelow keeps the part of a polygon above the cut, with the crossing points", () => {
    expect(clipBelow([[0, 0], [1, 0], [1, 1], [0, 1]], 0.5)).toEqual([[0, 0], [1, 0], [1, 0.5], [0, 0.5]]);
  });
});

/** 33 landmarks of a standing body: head top at `top`, soles at `top + h`, centred on `cx`; ankles out of view if `upper`. */
function body({ top = 0.07, h = 0.86, cx = 0.5, upper = false }: { top?: number; h?: number; cx?: number; upper?: boolean } = {}): Landmark[] {
  const lms: Landmark[] = Array.from({ length: 33 }, () => ({ x: cx, y: top + 0.5 * h, visibility: 0.9 }));
  const at = (i: number, dx: number, y: number, visibility = 0.9) => (lms[i] = { x: cx + dx, y: top + y * h, visibility });
  at(LM.nose, 0, 0.075);
  at(LM.shoulderL, 0.06, 0.185);
  at(LM.shoulderR, -0.06, 0.185);
  at(LM.hipL, 0.04, 0.5);
  at(LM.hipR, -0.04, 0.5);
  for (const [i, dx, y] of [
    [LM.ankleL, 0.03, 0.96],
    [LM.ankleR, -0.03, 0.96],
    [LM.heelL, 0.03, 0.985],
    [LM.heelR, -0.03, 0.985],
    [LM.toeL, 0.04, 1],
    [LM.toeR, -0.04, 1],
  ] as const)
    at(i, dx, y, upper ? 0.1 : 0.9);
  return lms;
}

describe("pose check (PR #26 review): framing, head, feet and waist, hints", () => {
  it("ankles in the frame: full body; ankles out of view or below the frame: upper body", () => {
    expect(framingOf(body())).toBe("full");
    expect(framingOf(body({ upper: true }))).toBe("upper");
    // A mirror shot from close: the model guesses the ankles far below the picture.
    expect(framingOf(body({ top: 0.05, h: 1.9 }))).toBe("upper");
  });
  it("reads the head top, the soles or the waist, and the centre line", () => {
    const full = readPose(body())!;
    expect(full.framing).toBe("full");
    expect(full.top).toBeCloseTo(0.07, 2);
    expect(full.base).toBeCloseTo(0.93, 2);
    expect(full.cx).toBeCloseTo(0.5, 3);
    const upper = readPose(body({ top: 0.1, h: 0.8 / 0.42, upper: true }))!;
    expect(upper.framing).toBe("upper");
    expect(upper.top).toBeCloseTo(0.1, 2);
    expect(upper.base).toBeCloseTo(0.9, 1);
  });
  it("no body: no landmarks, too few, or no head", () => {
    expect(readPose(null)).toBeNull();
    expect(readPose(body().slice(0, 20))).toBeNull();
    const headless = body();
    headless[LM.nose] = { ...headless[LM.nose], visibility: 0.1 };
    expect(readPose(headless)).toBeNull();
  });
  it("the framing switches only after three readings in a row; nobody in the frame keeps it", () => {
    const up = readPose(body({ upper: true }));
    const full = readPose(body());
    let s = framingStart("full");
    s = nextFraming(s, up);
    s = nextFraming(s, up);
    expect(s.framing).toBe("full");
    s = nextFraming(s, null);
    s = nextFraming(s, up);
    s = nextFraming(s, up);
    expect(s.framing).toBe("full");
    s = nextFraming(s, up);
    expect(s).toEqual({ framing: "upper", detected: true, streak: null });
    s = nextFraming(s, full);
    expect(s.framing).toBe("upper");
    expect(nextFraming(framingStart("upper"), null)).toEqual(framingStart("upper"));
    expect(nextFraming(framingStart("full"), full)).toEqual({ framing: "full", detected: true, streak: null });
    expect(FRAMING_STREAK).toBe(3);
  });
  it("one hint at a time: nobody, framing, distance, left / right, then the phone's height", () => {
    const guide = { framing: "full" as const, headY: 0.07, baseY: 0.93 };
    expect(poseHint(null, guide).key).toBe("none");
    expect(poseHint(readPose(body()), guide)).toEqual({ key: "ok", text: "On the lines." });
    expect(poseHint(readPose(body({ upper: true })), guide).key).toBe("framing");
    expect(poseHint(readPose(body({ top: 0.02, h: 0.98 })), guide)).toEqual({ key: "back", text: "Step back a bit: head and feet on the lines." });
    expect(poseHint(readPose(body({ top: 0.15, h: 0.7 })), guide).key).toBe("closer");
    expect(poseHint(readPose(body({ cx: 0.62 })), guide).key).toBe("left");
    expect(poseHint(readPose(body({ cx: 0.38 })), guide).key).toBe("right");
    expect(poseHint(readPose(body({ top: 0.0 })), guide).key).toBe("raise");
    expect(poseHint(readPose(body({ top: 0.12 })), guide).key).toBe("lower");
    const upperGuide = { framing: "upper" as const, headY: 0.1, baseY: 0.9 };
    expect(poseHint(readPose(body({ top: 0.1, h: 0.8 / 0.42, upper: true })), upperGuide).key).toBe("ok");
    expect(poseHint(readPose(body({ top: 0.05, h: 1.1 / 0.42, upper: true })), upperGuide).text).toBe("Step back a bit: head and waist on the lines.");
  });
});

describe("which photos are compared (PR #26 review)", () => {
  const ph = (id: string, date: string, pose: Photo["pose"], framing: Photo["framing"]): Photo => ({ id, session_id: null, local_date: date, pose, framing, width: 1, height: 1, bytes: 1, created_at: `${date}T10:00:00.000Z` });
  it("Before · After: the newest two of one pose AND one framing; no framing pairs only with no framing", () => {
    expect(beforeAfter([ph("a", "2026-10-01", "front", "full"), ph("b", "2026-10-10", "front", "upper")])).toBeNull();
    expect(beforeAfter([ph("a", "2026-10-01", "front", null), ph("b", "2026-10-10", "front", "full")])).toBeNull();
    const list = [ph("a", "2026-09-01", "front", "upper"), ph("b", "2026-10-01", "front", "upper"), ph("c", "2026-10-05", "front", "full"), ph("d", "2026-10-12", "front", "upper")];
    expect(beforeAfter(list)!.map((p) => p.id)).toEqual(["b", "d"]);
    expect(beforeAfter([ph("a", "2026-10-01", "side", "full"), ph("b", "2026-10-03", "side", "full"), ph("c", "2026-10-02", "front", null), ph("d", "2026-10-04", "front", null)])!.map((p) => p.id)).toEqual(["c", "d"]);
    expect(photoGroups(list).map((g) => [g.pose, g.framing, g.photos.length])).toEqual([
      ["front", "full", 1],
      ["front", "upper", 3],
    ]);
  });
});

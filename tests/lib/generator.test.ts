import { describe, expect, it } from "vitest";
import {
  ALLOWED_DAYS,
  EQUIPMENT_CHOICES,
  FLOORS,
  NECK_SCHEME,
  blockMix,
  equipKind,
  mainRegions,
  mixFamilyOf,
  GeneratorInputError,
  REAR_DELT_MIN,
  SEED_PRIORITY,
  SESSION_MINUTES,
  checkPlan,
  dayMinutes,
  generateProgram,
  isHeavyHinge,
  isOlympicLift,
  programVolume,
  resolveStyle,
  weeklyTargets,
  type GeneratorInput,
  type Plan,
  type PlanExercise,
  type ResolvedStyle,
  type TargetGroup,
} from "../../worker/lib/generator";
import { TARGET_GROUPS, groupOf } from "../../worker/lib/muscles";
import { REGIONS } from "../../worker/lib/regions";
import type { RotationStatus } from "../../worker/lib/rotation";
import { currentProgram, libraryExercises } from "../fixtures/generator/pool";

const exercises = libraryExercises();
const exMap = new Map(exercises.map((e) => [e.id, e]));
const { current, historyIds } = currentProgram();
const ctx = { exercises, historyIds, current, currentPriority: SEED_PRIORITY };
const payam: GeneratorInput = { days_per_week: 4, style: "full_body", session_minutes: 60, priority_muscles: ["chest"], avoid: [], equipment: "full_gym", seed: 1 };
const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

/** Combinations whose floors are reachable under the per-session cap, pull ≥ push and the session length (decided
 *  2026-10-12: elsewhere a floor miss is a warning, not a block). */
const FLOORS_REACHABLE: Partial<Record<ResolvedStyle, number[]>> = { full_body: [3, 4], upper_lower: [4], ppl: [6], ppl_ul: [5], strength: [3, 4] };
const floorsReachable = (style: ResolvedStyle, days: number, minutes: number) => minutes >= 60 && (FLOORS_REACHABLE[style] ?? []).includes(days);

describe("inputs and targets", () => {
  it("auto picks the style from the days (§8.3); styles only run their allowed days", () => {
    expect([2, 3, 4, 5, 6].map((d) => resolveStyle("auto", d))).toEqual(["full_body", "full_body", "upper_lower", "ppl_ul", "ppl"]);
    expect(resolveStyle("ppl", 4)).toBeNull();
    expect(resolveStyle("bro_split", 5)).toBe("bro_split");
    expect(() => generateProgram({ ...payam, style: "upper_lower", days_per_week: 3 }, ctx)).toThrow(GeneratorInputError);
  });
  it("strength needs a barbell; bodyweight-only is not an equipment choice", () => {
    expect(() => generateProgram({ ...payam, style: "strength", days_per_week: 3, equipment: "dumbbells" }, ctx)).toThrow(/barbell/);
    expect(EQUIPMENT_CHOICES).toEqual(["full_gym", "dumbbells"]);
  });
  it("weekly targets: the current program's fractional volume (T2), +3 only for added priorities, floors of 10", () => {
    const base = programVolume(current, exMap);
    expect(base).toEqual({ chest: 13, back: 17.5, quads: 11.5, hamstrings_glutes: 14, shoulders: 15.5, rear_delts: 11, calves: 6, core: 6, biceps: 9.5, triceps: 9.5 });
    expect(weeklyTargets(base, SEED_PRIORITY, ["chest"])).toEqual(base);
    expect(weeklyTargets(base, SEED_PRIORITY, ["chest", "biceps"]).biceps).toBe(12.5);
    expect(weeklyTargets({ ...base, quads: 7 }, SEED_PRIORITY, []).quads).toBe(10);
  });
});

describe("property: every style × days × session length × 50 seeds (§8.8)", () => {
  for (const equipment of EQUIPMENT_CHOICES)
    for (const [style, dayList] of Object.entries(ALLOWED_DAYS) as [ResolvedStyle, readonly number[]][])
      for (const days of dayList) {
        if (style === "strength" && equipment !== "full_gym") continue;
        // 150 generated programs per case, 1–4 s each run; a busy machine can pass the default 5 s.
        it(`${equipment} ${style} ${days} days`, { timeout: 30_000 }, () => {
          for (const session_minutes of SESSION_MINUTES)
            for (const seed of SEEDS) {
              const p = generateProgram({ days_per_week: days, style, session_minutes, priority_muscles: ["chest"], avoid: [], equipment, seed }, ctx);
              const at = `${session_minutes} min, seed ${seed}`;
              expect(p.check.violations, at).toEqual([]);
              expect(p.check.pull_sets, at).toBeGreaterThanOrEqual(p.check.push_sets);
              expect(p.check.minutes.every((m) => m <= session_minutes), at).toBe(true);
              expect(p.check.warnings.filter((w) => w.code === "unfilled" || w.code === "too_long"), at).toEqual([]);
              expect(p.days.map((d) => d.offset)).toEqual(p.days.map((d) => d.offset).sort((a, b) => a - b));
              const vol = new Map(p.check.volume.map((v) => [v.group, v.planned]));
              expect(vol.get("rear_delts")!, at).toBeGreaterThanOrEqual(REAR_DELT_MIN);
              for (const [g, floor] of Object.entries(FLOORS) as [TargetGroup, number][]) {
                const below = vol.get(g)! < floor;
                if (floorsReachable(style, days, session_minutes)) expect(below, `${g} ${at}`).toBe(false);
                // Elsewhere a floor miss is always reported to Payam as a warning.
                if (below) expect(p.check.warnings.some((w) => w.code === "floor" && w.message.startsWith(`${g === "hamstrings_glutes" ? "Hamstrings & glutes" : g[0].toUpperCase() + g.slice(1)}:`)), `${g} ${at}`).toBe(true);
              }
              // Phase B: never two exercises with the same main-focus region and the same equipment in a day.
              expect(p.check.warnings.filter((w) => w.code === "region_equipment"), at).toEqual([]);
              const roles = new Map<string, string>();
              for (const d of p.days)
                for (const x of d.exercises) {
                  const e = exMap.get(x.exercise_id)!;
                  expect(isOlympicLift(e), e.name_en).toBe(false);
                  if (equipment === "dumbbells") expect(["dumbbell", "bodyweight"]).toContain(e.equipment);
                  expect(x.sets).toBeGreaterThanOrEqual(x.set_range[0]);
                  expect(x.sets).toBeLessThanOrEqual(x.set_range[1]);
                  expect(roles.get(x.exercise_id) ?? x.slot, e.name_en).toBe(x.slot);
                  roles.set(x.exercise_id, x.slot);
                }
            }
        });
      }
});

describe("Payam's inputs: 4 days, full body, 60 min, priority chest (§8.8 snapshot)", () => {
  it("keeps the main lifts and their days; deterministic for a seed", () => {
    const p = generateProgram(payam, ctx);
    expect(p.name).toBe("Full body · 4 days");
    expect(p.days.map((d) => [d.name_en, d.offset, d.exercises.find((x) => x.slot === "main")!.exercise_id])).toEqual([
      ["Day 1 · Chest", 0, "bench"],
      ["Day 2 · Legs", 1, "squat"],
      ["Day 3 · Back", 3, "cs_row"],
      ["Day 4 · Deadlift", 4, "deadlift"],
    ]);
    expect(generateProgram(payam, ctx)).toEqual(p);
    // Exercises with history come first: every main and secondary is one Payam has logged.
    for (const d of p.days) for (const x of d.exercises.filter((y) => y.slot === "main" || y.slot === "secondary")) expect(historyIds.has(x.exercise_id)).toBe(true);
  });
  it("prescriptions follow the slot schemes (§8.4); no intro week: full sets and normal RIR from the start", () => {
    const p = generateProgram(payam, ctx);
    const bench = p.days[0].exercises[0];
    expect(bench).toMatchObject({ slot: "main", sets: 4, reps_min: 5, reps_max: 8, target_rir_min: 1, target_rir_max: 3, rest_sec: 180 });
    const deadlift = p.days[3].exercises[0];
    expect(deadlift).toMatchObject({ slot: "main", sets: 3 });
    const plank = p.days.flatMap((d) => d.exercises).find((x) => x.exercise_id === "plank");
    expect(plank).toMatchObject({ is_time: true, reps_min: 30, reps_max: 45 });
    for (const d of p.days) {
      // Order: main, secondary, accessory, then isolation and core together; a superset pair sits side by side.
      const rank = d.exercises.map((x) => Math.min(3, ["main", "secondary", "accessory", "isolation", "core"].indexOf(x.slot)));
      expect(rank).toEqual([...rank].sort((a, b) => a - b));
      for (const x of d.exercises.filter((y) => y.superset_tag?.endsWith("1"))) {
        const i = d.exercises.indexOf(x);
        expect(d.exercises[i + 1].superset_tag).toBe(x.superset_tag!.replace("1", "2"));
      }
    }
  });
  it("respects the avoid list and the priority bonus", () => {
    const p = generateProgram({ ...payam, avoid: ["bench", "squat"] }, ctx);
    const ids = p.days.flatMap((d) => d.exercises.map((x) => x.exercise_id));
    expect(ids).not.toContain("bench");
    expect(ids).not.toContain("squat");
    expect(p.days[0].exercises[0].exercise_id).not.toBe("bench");
    const arms = generateProgram({ ...payam, priority_muscles: ["chest", "biceps"] }, ctx);
    expect(arms.targets.biceps).toBe(12.5);
    expect(arms.check.volume.find((v) => v.group === "biceps")!.planned).toBeGreaterThan(generateProgram(payam, ctx).check.volume.find((v) => v.group === "biceps")!.planned);
  });
  it("strength: the four barbell lifts as main lifts, 3–5 reps at RIR 1–2", () => {
    const p = generateProgram({ ...payam, style: "strength", days_per_week: 4, session_minutes: 75 }, ctx);
    const mains = p.days.map((d) => exMap.get(d.exercises[0].exercise_id)!);
    expect(mains.map((e) => e.equipment)).toEqual(["barbell", "barbell", "barbell", "barbell"]);
    expect(mains.map((e) => e.name_en)).toEqual(["Barbell Back Squat", "Barbell Bench Press", "Conventional Deadlift", "Standing Overhead Press"]);
    expect(p.days[0].exercises[0]).toMatchObject({ reps_min: 3, reps_max: 5, target_rir_min: 1, target_rir_max: 2 });
  });
  it("bro split warns about frequency; upper/lower 2 days too", () => {
    expect(generateProgram({ ...payam, style: "bro_split", days_per_week: 5 }, ctx).check.warnings.map((w) => w.code)).toContain("frequency");
    expect(generateProgram({ ...payam, style: "upper_lower", days_per_week: 2 }, ctx).check.warnings.map((w) => w.code)).toContain("frequency");
  });
});

/** The rotation status of the seed program as of 2026-10-17 (4 training weeks): main and secondary lifts are kept
 *  (6–8 week rule), isolation and core work is due (by 4); `allDue`: every exercise 9 weeks in. */
function rotationOf(allDue = false): RotationStatus[] {
  return current.days.flatMap((d) =>
    d.exercises.map((x) => {
      const e = exMap.get(x.exercise_id)!;
      const other = !x.is_main && !(e.mechanic === "compound" && e.pattern !== "isolation" && e.pattern !== "core");
      const due = allDue || other;
      return { exercise_id: x.exercise_id, role: other ? "other" : "main", weeks: allDue ? 9 : 4, since: "2026-09-27", min: other ? 3 : 6, max: other ? 4 : 8, stalled: false, new_best: other ? null : true, due, reason: due ? "max" : null, due_next_week: false } as RotationStatus;
    })
  );
}

describe("Phase B: Payam's inputs at 75 min, block B (SPEC-v11, approved 2026-10-17)", () => {
  const b: GeneratorInput = { ...payam, session_minutes: 75, block: 2 };
  const today = { ...ctx, rotation: rotationOf() };
  const ids = (p: { days: { exercises: { exercise_id: string }[] }[] }) => new Set(p.days.flatMap((d) => d.exercises.map((x) => x.exercise_id)));

  it("every seed: all 30 regions, forearms 4 and neck 2 direct sets, within 75 min, no hard rule broken, every group on target", () => {
    for (const seed of SEEDS) {
      const p = generateProgram({ ...b, seed }, today);
      const at = `seed ${seed}`;
      expect(p.check.violations, at).toEqual([]);
      expect(p.check.coverage.filter((c) => !c.exercises.length).map((c) => c.region), at).toEqual([]);
      expect(p.check.direct, at).toEqual([
        { group: "forearms", target: 4, planned: 4 },
        { group: "neck", target: 2, planned: 2 },
      ]);
      expect(p.check.minutes.every((m) => m <= 75), at).toBe(true);
      expect(p.check.warnings.filter((w) => ["coverage", "direct_under", "unfilled", "too_long", "region_equipment", "floor", "under_target", "day_all_new"].includes(w.code)), at).toEqual([]);
      // No group under its target; region work may take some over it (Payam, 2026-10-17: longer sessions for it).
      for (const v of p.check.volume) expect(v.planned, `${v.group} ${at}`).toBeGreaterThanOrEqual(v.target - 0.5);
    }
  });

  it("rotation as of today: main and secondary lifts stay in their days, the due isolation and core work is replaced", () => {
    const p = generateProgram(b, today);
    current.days.forEach((d, i) => {
      for (const x of d.exercises.filter((y) => y.is_main || exMap.get(y.exercise_id)!.mechanic === "compound")) expect(p.days[i].exercises.some((y) => y.exercise_id === x.exercise_id), `${d.name_en} ${x.exercise_id}`).toBe(true);
    });
    const due = rotationOf().filter((s) => s.due).map((s) => s.exercise_id);
    for (const id of due) expect(ids(p).has(id), id).toBe(false);
    expect(p.block).toMatchObject({ block: 2, letter: "B", kept_due: [] });
    expect(new Set(p.block.replaced.map((r) => r.exercise_id))).toEqual(new Set(due));
    expect(p.block.replaced.every((r) => r.reason === "max" && r.weeks === 4)).toBe(true);
    expect(p.params.block).toBe(2);
    expect(generateProgram(b, today)).toEqual(p);
  });

  it("new exercises follow block B's equipment mix; neck work is light: 1 set of 15–25 reps at RIR 3–4", () => {
    const p = generateProgram(b, today);
    const old = ids(current);
    const fresh = p.days.flatMap((d) => d.exercises.filter((x) => x.slot !== "main" && !old.has(x.exercise_id)).map((x) => ({ x, e: exMap.get(x.exercise_id)! })));
    expect(fresh.length).toBeGreaterThan(10);
    for (const { e } of fresh) {
      const family = mixFamilyOf(e.muscle_primary)!;
      expect(blockMix(family, 2), `${e.name_en} (${family})`).toContain(equipKind(e));
    }
    const neck = p.days.flatMap((d) => d.exercises).filter((x) => groupOf(exMap.get(x.exercise_id)!.muscle_primary) === "neck");
    expect(neck.length).toBe(2);
    for (const x of neck) expect(x).toMatchObject({ sets: 1, reps_min: NECK_SCHEME.reps[0], reps_max: NECK_SCHEME.reps[1], target_rir_min: 3, target_rir_max: 4, set_range: [1, 3] });
    expect(new Set(neck.flatMap((x) => mainRegions(exMap.get(x.exercise_id))))).toEqual(new Set(["neck_flexors", "neck_extensors"]));
  });

  it("every main lift due (9 weeks): a barbell variation close to it or for a region the last block lacked; each day keeps one exercise", () => {
    const p = generateProgram(b, { ...ctx, rotation: rotationOf(true) });
    const missingBefore = new Set(REGIONS.filter((r) => !current.days.some((d) => d.exercises.some((x) => mainRegions(exMap.get(x.exercise_id)).includes(r)))));
    current.days.forEach((d, i) => {
      const oldMain = d.exercises.find((x) => x.is_main)!.exercise_id;
      const main = p.days[i].exercises.find((x) => x.slot === "main")!.exercise_id;
      const e = exMap.get(main)!;
      expect(main, d.name_en).not.toBe(oldMain);
      expect(e.equipment, e.name_en).toBe("barbell");
      const regions = mainRegions(e);
      expect(regions.some((r) => mainRegions(exMap.get(oldMain)).includes(r) || missingBefore.has(r)), e.name_en).toBe(true);
      expect(p.days[i].exercises.some((x) => x.slot !== "main" && d.exercises.some((y) => y.exercise_id === x.exercise_id)), d.name_en).toBe(true);
    });
    expect(p.check.violations).toEqual([]);
    expect(p.block.kept_due.length).toBe(4);
    expect(p.block.replaced.find((r) => r.exercise_id === "bench")?.by).toBe(p.days[0].exercises[0].exercise_id);
  });
});

describe("plan check: each hard rule (§8.4) and the decided rules", () => {
  const ex = (exercise_id: string, slot: PlanExercise["slot"] = "secondary", sets = 3): PlanExercise => ({
    exercise_id, slot, sets, reps_min: 6, reps_max: 10, rest_sec: 90, target_rir_min: 1, target_rir_max: 3, per_leg: false, is_time: false, superset_tag: null,
    set_range: slot === "main" ? [3, 4] : slot === "secondary" ? [3, 3] : [2, 3],
  });
  const base = programVolume(current, exMap);
  const plan = (style: Plan["style"], days: [number, PlanExercise[]][]): Plan => ({
    style, days_per_week: days.length, session_minutes: 90, days: days.map(([offset, exercises], i) => ({ name_en: `D${i + 1}`, kind: "full", offset, exercises })),
  });
  const codes = (p: Plan) => checkPlan(p, exMap, base).violations.map((v) => v.code);
  const ok: [number, PlanExercise[]][] = [
    [0, [ex("squat", "main", 4), ex("bench"), ex("cable_row", "secondary"), ex("facepull", "isolation", 3)]],
    [3, [ex("deadlift", "main", 3), ex("pulldown"), ex("incline_db", "accessory", 2), ex("facepull", "isolation", 3)]],
  ];
  it("a valid week has none", () => expect(codes(plan("full_body", ok))).toEqual([]));
  it("same muscle as a main lift on consecutive days", () => {
    expect(codes(plan("full_body", [[0, [ex("squat", "main", 4)]], [1, [ex("leg_press", "main", 4)]], [4, [ex("deadlift", "main", 3), ex("facepull", "isolation", 3), ex("cable_row"), ex("pulldown")]]]))).toContain("main_consecutive");
  });
  it("heavy hinges less than 72 h apart, also across the week's end", () => {
    expect(codes(plan("full_body", [[0, [ex("deadlift", "main", 3), ex("squat")]], [2, [ex("rdl")]]]))).toContain("hinge_72h");
    expect(codes(plan("full_body", [[1, [ex("deadlift", "main", 3), ex("squat")]], [6, [ex("rdl")]]]))).toContain("hinge_72h");
    expect(isHeavyHinge(exMap.get("rdl")!)).toBe(true);
    expect(isHeavyHinge(exMap.get("leg_curl")!)).toBe(false);
  });
  it("heavy squat and heavy deadlift as main lifts of one session", () => {
    expect(codes(plan("full_body", [[0, [ex("squat", "main", 4), ex("deadlift", "main", 3)]]]))).toContain("squat_deadlift_mains");
  });
  it("more than two days in a row (full body), back-to-back direct work (splits)", () => {
    expect(codes(plan("full_body", [[0, [ex("squat")]], [1, [ex("bench")]], [2, [ex("deadlift")]]]))).toContain("three_in_a_row");
    expect(codes(plan("ppl", [[0, [ex("bench")]], [1, [ex("incline_db")]]]))).toContain("back_to_back");
  });
  it("more than 10 fractional sets of a muscle in one session", () => {
    expect(codes(plan("full_body", [[0, [ex("bench", "main", 4), ex("incline_db", "secondary", 3), ex("incline_bb", "accessory", 3), ex("fly", "isolation", 3)]]]))).toContain("session_cap");
  });
  it("pull < push, no hinge, no squat, rear delts under 6", () => {
    const c = codes(plan("full_body", [[0, [ex("bench", "main", 4), ex("lateral", "isolation", 3)]]]));
    expect(c).toEqual(expect.arrayContaining(["pull_push", "no_hinge", "no_squat", "rear_delts"]));
  });
  it("one exercise in two roles, twice in a day, sets outside the slot range, non-strength work", () => {
    expect(codes(plan("full_body", [[0, [ex("bench", "main", 4)]], [3, [ex("bench", "accessory", 2)]]]))).toContain("two_roles");
    expect(codes(plan("full_body", [[0, [ex("bench"), ex("bench")]]]))).toContain("duplicate");
    expect(codes(plan("full_body", [[0, [ex("bench", "accessory", 5)]]]))).toContain("sets_range");
    const stretch = exercises.find((e) => e.category === "stretching")!;
    expect(codes(plan("full_body", [[0, [ex(stretch.id)]]]))).toContain("not_strength");
  });
  it("minutes: (rest + 40 s) × sets plus a 5-minute warm-up", () => {
    expect(dayMinutes({ exercises: [ex("bench", "main", 4)] })).toBe(Math.ceil((300 + 130 * 4) / 60));
  });
  it("Olympic-style lifts are recognised", () => {
    expect(["Clean", "Hang Snatch", "Split Jerk", "Push Press", "Dumbbell Clean", "Clean and Press"].every((n) => isOlympicLift({ name_en: n, category: "strength" }))).toBe(true);
    expect(isOlympicLift({ name_en: "Romanian Deadlift from Deficit", category: "olympic_weightlifting" })).toBe(true);
    expect(isOlympicLift({ name_en: "Barbell Bench Press", category: "strength" })).toBe(false);
  });
  it("every target group has a volume row", () => {
    expect(checkPlan(plan("full_body", ok), exMap, base).volume.map((v) => v.group)).toEqual([...TARGET_GROUPS]);
  });
});

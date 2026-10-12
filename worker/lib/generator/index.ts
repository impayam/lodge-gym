// Program generator (SPEC-v2 M8, decisions 2026-10-12): builds a weekly program from the inputs, the exercise library,
// the exercises with history and the current program. Pure and deterministic for a given seed.
//
// 1. The style's layout gives each day its main and secondary lifts (model.ts LAYOUTS).
// 2. Accessories and isolation fill each muscle group toward its weekly target, never above 10 fractional sets per
//    group in a session and never past the session length, spreading work over the days that may train the group.
// 3. Balance: rear delts at least 6 sets, pull sets at least push sets.
// 4. Days longer than the session length lose isolation sets first, then accessories, then secondaries; never mains.
// 5. Supersets pair non-competing isolation work; every day is ordered main → secondary → accessory → isolation/core.
//
// Weekly targets start from the current program's own fractional volume (the T2 targets); priority muscles beyond the
// current program's get +3 sets; chest, back, quads and hamstrings & glutes never go below 10. New programs start at
// full volume and normal RIR (no intro week), and progression continues from the last working weights.

import { TARGET_GROUPS } from "../muscles";
import type { DayExercise, Exercise, Pattern, Program } from "../types";
import { checkPlan, dayLoad, dayMinutes, type CheckResult, type Plan, type PlanDay, type PlanExercise } from "./check";
import { candidatePool, compareKeys, pick, preference, type Candidate } from "./pick";
import {
  DAY_GROUPS,
  FLOORS,
  HOLD_SECONDS,
  LAYOUTS,
  PRIORITY_BONUS,
  REAR_DELT_MIN,
  SESSION_CAP,
  SET_WORK_SEC,
  STYLE_NAME,
  WARMUP_SEC,
  resolveStyle,
  scheme,
  type GeneratorInput,
  type Slot,
  type TargetGroup,
} from "./model";

export * from "./model";
export * from "./check";
export { candidatePool, isHeavyHinge, isOlympicLift, pick, type Candidate } from "./pick";

export interface GeneratorContext {
  /** The library: seed, imported, manual and custom exercises. */
  exercises: Exercise[];
  /** Exercises with logged sets. */
  historyIds: ReadonlySet<string>;
  /** The active program, with its days. */
  current: Pick<Program, "days"> | null;
  /** Priority muscles the current program already carries (its volume includes them). The seed program: chest. */
  currentPriority: readonly TargetGroup[];
}

export interface Proposal extends Plan {
  name: string;
  params: GeneratorInput;
  targets: Record<TargetGroup, number>;
  check: CheckResult;
}

export class GeneratorInputError extends Error {}

const SLOT_ORDER: Readonly<Record<Slot, number>> = { main: 0, secondary: 1, accessory: 2, isolation: 3, core: 4 };
const BIG: readonly TargetGroup[] = ["chest", "back", "quads", "hamstrings_glutes"];
const ACCESSORY_PATTERNS: Readonly<Partial<Record<TargetGroup, readonly Pattern[]>>> = {
  chest: ["h_push"],
  back: ["h_pull", "v_pull"],
  quads: ["squat", "lunge"],
  hamstrings_glutes: ["hinge"],
};
const PUSH: readonly string[] = ["h_push", "v_push"];
const PULL: readonly string[] = ["h_pull", "v_pull"];
const SUPERSET_PAIRS: readonly [TargetGroup, TargetGroup][] = [
  ["shoulders", "rear_delts"],
  ["biceps", "triceps"],
  ["calves", "core"],
];
const round1 = (n: number) => Math.round(n * 10) / 10;
const zeros = () => Object.fromEntries(TARGET_GROUPS.map((g) => [g, 0])) as Record<TargetGroup, number>;

/** Fractional weekly volume per target group of a program (the T2 targets of SPEC-v2 §7.4). */
export function programVolume(p: Pick<Program, "days">, ex: ReadonlyMap<string, Exercise>): Record<TargetGroup, number> {
  const out = zeros();
  for (const d of p.days) for (const [g, v] of dayLoad(d, ex)) out[g] += v;
  for (const g of TARGET_GROUPS) out[g] = round1(out[g]);
  return out;
}

/** Weekly targets (decided 2026-10-12): the current program's volume, +3 for added priority muscles, floors of 10. */
export function weeklyTargets(base: Readonly<Record<TargetGroup, number>>, currentPriority: readonly TargetGroup[], priority: readonly TargetGroup[]): Record<TargetGroup, number> {
  const out = zeros();
  for (const g of TARGET_GROUPS) {
    let t = base[g] ?? 0;
    if (priority.includes(g) && !currentPriority.includes(g)) t += PRIORITY_BONUS;
    out[g] = round1(Math.max(t, FLOORS[g] ?? 0));
  }
  return out;
}

/** Push and pull working sets of a week (§8.4 balance rule). */
export function pushPullSets(days: readonly PlanDay[], ex: ReadonlyMap<string, Exercise>) {
  let push = 0;
  let pull = 0;
  for (const d of days)
    for (const x of d.exercises) {
      const p = ex.get(x.exercise_id)?.pattern ?? "";
      if (PUSH.includes(p)) push += x.sets;
      if (PULL.includes(p)) pull += x.sets;
    }
  return { push, pull };
}

const daySeconds = (d: PlanDay) => WARMUP_SEC + d.exercises.reduce((a, x) => a + (x.rest_sec + SET_WORK_SEC) * x.sets, 0);

export function generateProgram(input: GeneratorInput, ctx: GeneratorContext): Proposal {
  const style = resolveStyle(input.style, input.days_per_week);
  if (!style) throw new GeneratorInputError(`${input.style} does not run ${input.days_per_week} days a week.`);
  if (style === "strength" && input.equipment !== "full_gym") throw new GeneratorInputError("The strength style needs a barbell: choose the full gym.");
  const strength = style === "strength";
  const exMap = new Map(ctx.exercises.map((e) => [e.id, e]));
  const programIds = new Map<string, boolean>();
  const timedIds = new Set<string>();
  const perLegIds = new Set<string>();
  for (const d of ctx.current?.days ?? [])
    for (const x of d.exercises) {
      programIds.set(x.exercise_id, (programIds.get(x.exercise_id) ?? false) || x.is_main);
      if (x.is_time) timedIds.add(x.exercise_id);
      if (x.per_leg) perLegIds.add(x.exercise_id);
    }
  const pool = candidatePool({ exercises: ctx.exercises, historyIds: ctx.historyIds, programIds, timedIds, perLegIds }, input.equipment, input.avoid);
  const byId = new Map(pool.map((c) => [c.ex.id, c]));
  const targets = weeklyTargets(ctx.current ? programVolume(ctx.current, exMap) : zeros(), ctx.currentPriority, input.priority_muscles);
  const layout = LAYOUTS[style][input.days_per_week];
  const limitSec = input.session_minutes * 60;
  const unfilled: string[] = [];

  const entry = (c: Candidate, slot: Slot, sets?: number): PlanExercise => {
    const sc = scheme(slot, strength);
    const reps = c.timed ? HOLD_SECONDS : sc.reps;
    // A main hinge keeps the bottom of the range: the heaviest lift of the week, at most once per 72 h.
    const n = sets ?? (slot === "main" && c.ex.pattern === "hinge" ? sc.range[0] : sc.sets);
    return {
      exercise_id: c.ex.id,
      slot,
      sets: n,
      reps_min: reps[0],
      reps_max: reps[1],
      rest_sec: sc.rest,
      target_rir_min: sc.rir[0],
      target_rir_max: sc.rir[1],
      per_leg: c.perLeg,
      is_time: c.timed,
      superset_tag: null,
      set_range: sc.range,
    };
  };

  const days: PlanDay[] = layout.map((l) => ({ name_en: l.name, kind: l.kind, offset: l.offset, exercises: [] }));
  /** One exercise keeps one role in the week (decided 2026-10-12): one rep range, one progression. */
  const roleOf = (id: string): Slot | undefined => {
    for (const d of days) for (const x of d.exercises) if (x.exercise_id === id) return x.slot;
    return undefined;
  };
  // 1. Main lifts on every day first, then the secondaries.
  for (const role of ["main", "secondary"] as const) {
    layout.forEach((l, i) => {
      for (const spec of l.slots.filter((x) => x.slot === role)) {
        const dayIds = new Set(days[i].exercises.map((x) => x.exercise_id));
        const noHeavyHinge = spec.pattern === "hinge" && role === "secondary" && heavyHingeNear(days, i, byId);
        const c = pick(pool, { pattern: spec.pattern, group: spec.group, slot: role, lift: spec.lift, dayIds, noHeavyHinge, roleOf, seed: input.seed });
        if (c) days[i].exercises.push(entry(c, role));
        else unfilled.push(`${l.name}: ${role} ${spec.pattern.replace("_", " ")} (${spec.group.replace("_", " ")})`);
      }
    });
  }

  const planned = () => {
    const out = zeros();
    for (const d of days) for (const [g, v] of dayLoad(d, exMap)) out[g] += v;
    return out;
  };
  const fits = (i: number, extraSec: number) => daySeconds(days[i]) + extraSec <= limitSec;
  const capOk = (i: number, c: Candidate, sets: number) => {
    const l = dayLoad(days[i], exMap);
    for (const [g, w] of c.contrib) if ((l.get(g as TargetGroup) ?? 0) + w * sets > SESSION_CAP + 1e-9) return false;
    return true;
  };
  /** Session cap with exercise x replaced by candidate o. */
  const capOkWithout = (i: number, x: PlanExercise, o: Candidate) => {
    const l = dayLoad({ exercises: days[i].exercises.filter((y) => y !== x) }, exMap);
    for (const [g, w] of o.contrib) if ((l.get(g as TargetGroup) ?? 0) + w * x.sets > SESSION_CAP + 1e-9) return false;
    return true;
  };
  const growable = (x: PlanExercise) => (x.slot === "accessory" || x.slot === "isolation" || x.slot === "core") && x.sets < x.set_range[1];

  // Push work the fill may add keeps pull ≥ push reachable (a hard rule): during the first fills the back sets still
  // to come (the back deficit, as far as the session caps of the days that train back allow) count as pull ahead;
  // after the balance step only the pull sets already planned do.
  let strictPush = false;
  const pushRoom = () => {
    const { push, pull } = pushPullSets(days, exMap);
    if (strictPush) return pull - push;
    const capRoom = days.reduce((a, d) => a + (DAY_GROUPS[d.kind].includes("back") ? Math.max(0, SESSION_CAP - (dayLoad(d, exMap).get("back") ?? 0)) : 0), 0);
    return pull - push + Math.floor(Math.min(Math.max(0, targets.back - planned().back), capRoom));
  };
  const pushOk = (c: Candidate, sets: number) => !PUSH.includes(c.ex.pattern ?? "") || sets <= pushRoom();

  /** Adds work for a group on the day that has least of it: one more set on an exercise there, or a new exercise. */
  const addFor = (g: TargetGroup): boolean => {
    const options: { key: number[]; act: () => void }[] = [];
    days.forEach((d, i) => {
      if (!DAY_GROUPS[d.kind].includes(g)) return;
      const load = dayLoad(d, exMap).get(g) ?? 0;
      for (const x of d.exercises) {
        const c = byId.get(x.exercise_id);
        if (!c || c.group !== g || !growable(x) || !capOk(i, c, 1) || !pushOk(c, 1) || !fits(i, x.rest_sec + SET_WORK_SEC)) continue;
        options.push({ key: [load, 0, i], act: () => (x.sets += 1) });
      }
      // A new exercise: big groups may take a compound accessory or an isolation movement, chosen by the §8.4
      // preference (history, current program, compound, level); the other groups take isolation, core takes core work.
      const dayIds = new Set(d.exercises.map((x) => x.exercise_id));
      const tries: { slot: Slot; patterns: readonly Pattern[] }[] = BIG.includes(g)
        ? [{ slot: "accessory", patterns: ACCESSORY_PATTERNS[g]! }, { slot: "isolation", patterns: ["isolation"] }]
        : g === "core"
          ? [{ slot: "core", patterns: ["core"] }]
          : [{ slot: "isolation", patterns: ["isolation"] }];
      let best: { c: Candidate; slot: Slot; sets: number } | null = null;
      for (const t of tries) {
        const sc = scheme(t.slot, strength);
        const sets = sc.range[0];
        const accept = (c: Candidate) => capOk(i, c, sets) && pushOk(c, sets) && fits(i, (sc.rest + SET_WORK_SEC) * sets);
        const c = pick(pool, { patterns: t.patterns, group: g, slot: t.slot, dayIds, noHeavyHinge: true, roleOf, accept, seed: input.seed });
        if (!c) continue;
        if (!best || compareKeys(preference(c), preference(best.c)) < 0) best = { c, slot: t.slot, sets };
      }
      if (best) {
        const b = best;
        options.push({ key: [load, 1, i], act: () => days[i].exercises.push(entry(b.c, b.slot, b.sets)) });
      }
    });
    if (!options.length) return false;
    options.sort((a, b) => compareKeys(a.key, b.key))[0].act();
    return true;
  };

  /** One more pull set: on a pull exercise already in a day, or a new pull accessory. */
  const addPull = (): boolean => {
    const options: { key: number[]; act: () => void }[] = [];
    days.forEach((d, i) => {
      if (!DAY_GROUPS[d.kind].includes("back")) return;
      for (const x of d.exercises) {
        const c = byId.get(x.exercise_id);
        if (!c || !growable(x) || !PULL.includes(c.ex.pattern ?? "")) continue;
        if (capOk(i, c, 1) && fits(i, x.rest_sec + SET_WORK_SEC)) options.push({ key: [0, i], act: () => (x.sets += 1) });
      }
      const dayIds = new Set(d.exercises.map((x) => x.exercise_id));
      const sc = scheme("accessory", strength);
      const accept = (c: Candidate) => capOk(i, c, sc.range[0]) && fits(i, (sc.rest + SET_WORK_SEC) * sc.range[0]);
      const c = pick(pool, { patterns: ["h_pull", "v_pull"], group: "back", slot: "accessory", dayIds, roleOf, accept, seed: input.seed });
      if (c)
        options.push({ key: [1, i], act: () => days[i].exercises.push(entry(c, "accessory", sc.range[0])) });
    });
    if (!options.length) return false;
    options.sort((a, b) => compareKeys(a.key, b.key))[0].act();
    return true;
  };

  /** One push set less: from an accessory first, then a secondary; never a main lift. */
  const dropPush = (): boolean => {
    for (const slot of ["accessory", "secondary"] as const)
      for (const d of days) {
        const x = d.exercises.find((y) => y.slot === slot && PUSH.includes(exMap.get(y.exercise_id)?.pattern ?? ""));
        if (!x) continue;
        if (x.sets > x.set_range[0]) x.sets -= 1;
        else d.exercises.splice(d.exercises.indexOf(x), 1);
        return true;
      }
    return false;
  };

  const trimmable = (d: PlanDay) => d.exercises.some((x) => x.slot !== "main" && !(x.slot === "isolation" && byId.get(x.exercise_id)?.group === "rear_delts"));

  /** One set (or one exercise at its minimum) less on day i: isolation and core first, then accessories, then
   *  secondaries; never a main lift. Prefers work that keeps the hard rules and floors, from the group most over target. */
  /** What removing one set of x (or all of x at its minimum) does: hard rules, floors, and the groups it takes. */
  const removal = (x: PlanExercise) => {
    const p = planned();
    const { push, pull } = pushPullSets(days, exMap);
    const c = byId.get(x.exercise_id);
    const removeAll = x.sets <= x.set_range[0];
    const n = removeAll ? x.sets : 1;
    const after = (g: TargetGroup) => p[g] - (c?.contrib.get(g) ?? 0) * n;
    const pat = exMap.get(x.exercise_id)?.pattern ?? "";
    const pullAfter = pull - (PULL.includes(pat) ? n : 0);
    const pushAfter = push - (PUSH.includes(pat) ? n : 0);
    const lastOfPattern = removeAll && (pat === "hinge" || pat === "squat") && !days.some((o) => o.exercises.some((y) => y !== x && exMap.get(y.exercise_id)?.pattern === pat));
    const breaksHard = ((c?.contrib.get("rear_delts") ?? 0) > 0 && after("rear_delts") < REAR_DELT_MIN) || pullAfter < pushAfter || lastOfPattern;
    const breaksFloor = TARGET_GROUPS.some((g) => FLOORS[g] !== undefined && (c?.contrib.get(g) ?? 0) > 0 && after(g) < FLOORS[g]!);
    /** Groups this removal takes below their target (other than by rounding). */
    const underAfter = TARGET_GROUPS.some((g) => (c?.contrib.get(g) ?? 0) > 0 && after(g) < targets[g] - 0.5);
    const over = c ? p[c.group] - targets[c.group] : 0;
    const apply = () => {
      const d = days.find((y) => y.exercises.includes(x))!;
      if (removeAll) d.exercises.splice(d.exercises.indexOf(x), 1);
      else x.sets -= 1;
    };
    return { x, group: c?.group, breaksHard, breaksFloor, underAfter, over, apply };
  };

  /** One set (or one exercise at its minimum) less on day i: isolation and core first, then accessories, then
   *  secondaries; never a main lift. Prefers work that keeps the hard rules and floors, from the group most over target. */
  const trim = (i: number): boolean => {
    for (const tier of [["isolation", "core"], ["accessory"], ["secondary"]] as Slot[][]) {
      const o = days[i].exercises
        .filter((x) => tier.includes(x.slot))
        .map(removal)
        .filter((r) => !r.breaksHard)
        .sort((a, b) => Number(a.breaksFloor) - Number(b.breaksFloor) || b.over - a.over)[0];
      if (!o) continue;
      o.apply();
      return true;
    }
    return false;
  };

  /** Work added for one group lands secondary sets on others: takes groups more than one set over target back down,
   *  from their own accessory and isolation work, without taking any group below target, a floor or a hard rule. */
  const trimExcess = () => {
    for (let guard = 0; guard < 80; guard++) {
      const p = planned();
      const o = days
        .flatMap((d) => d.exercises)
        .filter((x) => x.slot !== "main" && x.slot !== "secondary")
        .map(removal)
        .filter((r) => r.group && p[r.group] - targets[r.group] > 1 && !r.breaksHard && !r.breaksFloor && !r.underAfter)
        .sort((a, b) => b.over - a.over)[0];
      if (!o) return;
      o.apply();
    }
  };

  /** Fills the groups toward a goal (the floors or the targets), the biggest deficit first. */
  const fill = (groups: readonly TargetGroup[], goal: Readonly<Partial<Record<TargetGroup, number>>> = targets) => {
    const blocked = new Set<TargetGroup>();
    const want = (g: TargetGroup) => goal[g] ?? 0;
    for (let guard = 0; guard < 400; guard++) {
      const p = planned();
      const next = groups.filter((g) => !blocked.has(g) && want(g) - p[g] > 0.5).sort((a, b) => want(b) - p[b] - (want(a) - p[a]))[0];
      if (!next) break;
      if (!addFor(next)) blocked.add(next);
    }
  };

  // 2. The rear-delt minimum (a hard rule) before any other work takes the time; at short sessions a lower-tier
  //    exercise makes room for it.
  for (let guard = 0; guard < 40 && planned().rear_delts < REAR_DELT_MIN; guard++) {
    if (addFor("rear_delts")) continue;
    const i = days.findIndex((d) => DAY_GROUPS[d.kind].includes("rear_delts") && trimmable(d));
    if (i < 0 || !trim(i)) break;
  }

  // 3. Fill: the big groups to their floors, then to their targets, then every group to its target.
  fill(BIG, FLOORS);
  fill(BIG);
  fill(TARGET_GROUPS);

  // 4. Balance: pull ≥ push; then refill with work that keeps the balance.
  for (let guard = 0; guard < 60; guard++) {
    const { push, pull } = pushPullSets(days, exMap);
    if (pull >= push) break;
    if (!addPull() && !dropPush()) break;
  }
  strictPush = true;
  fill(TARGET_GROUPS);
  trimExcess();

  // 5. Fit every day into the session length.
  days.forEach((d, i) => {
    for (let guard = 0; guard < 80 && dayMinutes(d) > input.session_minutes; guard++) if (!trim(i)) break;
  });

  // Short sessions can leave rear delts under the minimum with no time for more work: a pull secondary or accessory
  // without rear-delt work becomes the best pull of the same pattern and primary muscle that has it (the editor's swap rule).
  for (const d of days) {
    for (const x of d.exercises) {
      if (planned().rear_delts >= REAR_DELT_MIN) break;
      const c = byId.get(x.exercise_id);
      if (!c || x.slot === "main" || !PULL.includes(c.ex.pattern ?? "") || (c.contrib.get("rear_delts") ?? 0) > 0) continue;
      const i = days.indexOf(d);
      const dayIds = new Set(d.exercises.map((y) => y.exercise_id));
      const accept = (o: Candidate) => (o.contrib.get("rear_delts") ?? 0) > 0 && capOkWithout(i, x, o);
      const r = pick(pool, { pattern: c.ex.pattern!, group: c.group, slot: x.slot, dayIds, roleOf, accept, seed: input.seed });
      if (r) Object.assign(x, { exercise_id: r.ex.id, per_leg: r.perLeg, is_time: r.timed });
    }
  }

  // 6. Order and supersets.
  for (const d of days) {
    d.exercises.sort((a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]);
    const labels = ["A", "B", "C"];
    let n = 0;
    for (const [ga, gb] of SUPERSET_PAIRS) {
      const free = (g: TargetGroup) => d.exercises.find((x) => (x.slot === "isolation" || x.slot === "core") && !x.superset_tag && byId.get(x.exercise_id)?.group === g);
      const a = free(ga);
      const b = free(gb);
      if (!a || !b) continue;
      a.superset_tag = `${labels[n]}1`;
      b.superset_tag = `${labels[n]}2`;
      n++;
      d.exercises.splice(d.exercises.indexOf(b), 1);
      d.exercises.splice(d.exercises.indexOf(a) + 1, 0, b);
    }
  }

  const plan: Plan = { style, days_per_week: input.days_per_week, session_minutes: input.session_minutes, days };
  const check = checkPlan(plan, exMap, targets);
  for (const u of unfilled) check.warnings.push({ code: "unfilled", message: `No exercise for ${u} with this equipment and avoid list.` });
  return { ...plan, name: `${STYLE_NAME[style]} · ${input.days_per_week} days`, params: input, targets, check };
}

/** True when another day within 72 h (either way round the week) already has a heavy hinge. */
function heavyHingeNear(days: readonly PlanDay[], i: number, byId: ReadonlyMap<string, Candidate>): boolean {
  const o = days[i].offset;
  return days.some((d, j) => {
    if (j === i || !d.exercises.some((x) => byId.get(x.exercise_id)?.heavyHinge)) return false;
    return Math.min((d.offset - o + 7) % 7, (o - d.offset + 7) % 7) < 3;
  });
}

/** Day exercises of a plan day as stored rows (ids are assigned by the caller). */
export function toDayExercises(d: PlanDay): Omit<DayExercise, "id">[] {
  return d.exercises.map((x, i) => ({
    exercise_id: x.exercise_id,
    position: i + 1,
    sets: x.sets,
    reps_min: x.reps_min,
    reps_max: x.reps_max,
    per_leg: x.per_leg,
    is_time: x.is_time,
    rest_sec: x.rest_sec,
    superset_tag: x.superset_tag,
    is_main: x.slot === "main",
    target_rir_min: x.target_rir_min,
    target_rir_max: x.target_rir_max,
    slot: x.slot,
  }));
}

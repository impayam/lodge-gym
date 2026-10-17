// Program generator (SPEC-v2 M8, decisions 2026-10-12; SPEC-v11 Phase B, approved 2026-10-17): builds a weekly
// program from the inputs, the exercise library, the exercises with history, the current program and its rotation
// status. Pure and deterministic for a given seed.
//
// 1. The style's layout gives each day its main and secondary lifts (model.ts LAYOUTS). Main lifts stay barbell: a
//    due main lift changes its variation, and a region the last block lacked decides which.
// 2. Balance: rear delts at least 6 sets; chest, back, quads and hamstrings & glutes to their floors and targets
//    (their pull work keeps pull ≥ push within reach).
// 3. Exercises that are not due stay (worker/lib/rotation.ts); a new pick is never a due exercise or one used in the
//    last 8 weeks. The other exercises of each muscle follow the block's equipment mix (blocks.ts, A → B → C).
// 4. Region coverage: every region of the 30 gets a main-focus exercise. A region covered twice gives one of its
//    exercises to a missing region of the same muscle; otherwise one is added where it fits. Forearms and neck get
//    their direct weekly sets (neck work light).
// 5. Accessories and isolation fill every muscle group toward its weekly target, never above 10 fractional sets per
//    group in a session and never past the session length, spreading work over the days that may train the group.
// 6. Pull sets at least push sets.
// 7. Days longer than the session length lose isolation sets first, then accessories, then secondaries; never mains.
// 8. A day never changes its main lift and all its other exercises at once.
// 9. Supersets pair non-competing isolation work; every day is ordered main → secondary → accessory → isolation/core.
//
// A day never has two exercises with the same main-focus region and the same equipment, and at most one exercise new
// to Payam where a known one can do (region coverage may need more). Weekly targets start from the current program's
// own fractional volume (the T2 targets); priority muscles beyond the current program's get +3 sets; chest, back,
// quads and hamstrings & glutes never go below 10. New programs start at full volume and normal RIR (no intro week),
// and progression continues from the last working weights.

import { TARGET_GROUPS, groupOf, isTargetGroup, type ReportGroup } from "../muscles";
import { REGIONS, type Region } from "../regions";
import type { DueReason, RotationStatus } from "../rotation";
import type { DayExercise, Exercise, Pattern, Program } from "../types";
import { DIRECT_GROUPS, SMALL_REGIONS, blockLetter, blockMix, directRegionSets, directTarget, regionFamily, type BlockLetter, type DirectGroup, type EquipKind, type MixFamily } from "./blocks";
import { checkPlan, dayLoad, dayMinutes, mainRegions, type CheckResult, type Plan, type PlanDay, type PlanExercise } from "./check";
import { candidatePool, compareKeys, mainLiftOk, pick, preference, sourceRank, type Candidate, type PickQuery } from "./pick";
import {
  DAY_EXTRA_GROUPS,
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
  schemeFor,
  type DayKind,
  type GeneratorInput,
  type Slot,
  type TargetGroup,
} from "./model";

export * from "./model";
export * from "./check";
export * from "./blocks";
export { EQUIPMENT_OK, EXTRA_GROUPS, MAIN_LIFT_REGIONS, candidatePool, isHeavyHinge, isOlympicLift, looksPerLeg, looksTimed, mainLiftOk, pick, sourceRank, type Candidate } from "./pick";

export interface GeneratorContext {
  /** The library: seed, imported, manual and custom exercises, with their region tags. */
  exercises: Exercise[];
  /** Exercises with logged sets. */
  historyIds: ReadonlySet<string>;
  /** The active program, with its days. */
  current: Pick<Program, "days"> | null;
  /** Priority muscles the current program already carries (its volume includes them). The seed program: chest. */
  currentPriority: readonly TargetGroup[];
  /** Phase B: the rotation status of the current program's exercises. Without it every current exercise stays. */
  rotation?: readonly RotationStatus[];
  /** Phase B: exercises with done sets in the last 8 weeks; a new pick is never one of them. */
  recentIds?: ReadonlySet<string>;
}

/** A due exercise of the current program and what takes its place in the new one. */
export interface RotationChange {
  exercise_id: string;
  reason: DueReason;
  weeks: number;
  /** The new exercise on the same day for the same muscle group; null when none does. */
  by: string | null;
  /** The day of the current program it was on (0-based). */
  day: number;
}

/** What the new block changes (shown on the proposal: "replaces Barbell Bench Press: 8 weeks"). */
export interface BlockSummary {
  block: number;
  letter: BlockLetter;
  replaced: RotationChange[];
  /** Due exercises the new program keeps (a day keeps one of its exercises when its main lift changes, or nothing else
   *  fits the place), with their reason. */
  kept_due: { exercise_id: string; day: number; reason: DueReason; weeks: number }[];
}

export interface Proposal extends Plan {
  name: string;
  params: GeneratorInput;
  targets: Record<TargetGroup, number>;
  check: CheckResult;
  block: BlockSummary;
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
/** The regions the forearm and neck direct targets fill. */
const DIRECT_REGIONS: Readonly<Record<DirectGroup, readonly Region[]>> = { forearms: ["forearm_flexors", "forearm_extensors"], neck: ["neck_flexors", "neck_extensors"] };
const round1 = (n: number) => Math.round(n * 10) / 10;
const zeros = () => Object.fromEntries(TARGET_GROUPS.map((g) => [g, 0])) as Record<TargetGroup, number>;
const byPosition = <T extends { position: number }>(xs: readonly T[]) => [...xs].sort((a, b) => a.position - b.position);
/** Whether a day of this kind may train a group directly. */
const dayTrains = (kind: DayKind, g: ReportGroup) => (DAY_GROUPS[kind] as readonly string[]).includes(g) || DAY_EXTRA_GROUPS[kind].includes(g);

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

/** The block a new program starts: the latest program's block + 1 (the seed program and older programs are block 1). */
export const nextBlock = (current: Pick<GeneratorInput, "block"> | null | undefined) => Math.max(1, Math.floor(current?.block ?? 1)) + 1;

/**
 * What a new block changes against the current program (Phase B): each due exercise and the new exercise of the same
 * muscle group on the same day that takes its place, and the due exercises it keeps. The proposal and the editor (for a
 * saved draft) both show it.
 */
export function blockChanges(current: Pick<Program, "days"> | null, rotation: readonly RotationStatus[], days: readonly { exercises: readonly Pick<PlanExercise, "exercise_id">[] }[], ex: ReadonlyMap<string, Exercise>, block: number): BlockSummary {
  const cur = byPosition(current?.days ?? []);
  const curIds = new Set(cur.flatMap((d) => d.exercises.map((x) => x.exercise_id)));
  const planIds = new Set(days.flatMap((d) => d.exercises.map((x) => x.exercise_id)));
  const used = new Set<string>();
  const replaced: RotationChange[] = [];
  const keptDue: BlockSummary["kept_due"] = [];
  const group = (id: string) => groupOf(ex.get(id)?.muscle_primary);
  for (const s of rotation.filter((r) => r.due)) {
    const day = cur.findIndex((d) => d.exercises.some((x) => x.exercise_id === s.exercise_id));
    if (planIds.has(s.exercise_id)) {
      keptDue.push({ exercise_id: s.exercise_id, day: days.findIndex((d) => d.exercises.some((x) => x.exercise_id === s.exercise_id)), reason: s.reason!, weeks: s.weeks });
      continue;
    }
    // Its replacement: a new exercise of its group on the same day, else a new one of its muscle (then its group) on
    // another day; "leaves the program" only when the plan has nothing new for it.
    const fresh = (list: readonly Pick<PlanExercise, "exercise_id">[]) => list.filter((x) => !curIds.has(x.exercise_id) && !used.has(x.exercise_id));
    const sameDay = fresh(days[day]?.exercises ?? []);
    const anyDay = fresh(days.flatMap((d) => d.exercises));
    const muscle = (id: string) => ex.get(id)?.muscle_primary;
    const by = sameDay.find((x) => group(x.exercise_id) === group(s.exercise_id)) ?? anyDay.find((x) => muscle(x.exercise_id) === muscle(s.exercise_id)) ?? anyDay.find((x) => group(x.exercise_id) === group(s.exercise_id)) ?? null;
    if (by) used.add(by.exercise_id);
    replaced.push({ exercise_id: s.exercise_id, reason: s.reason!, weeks: s.weeks, by: by?.exercise_id ?? null, day });
  }
  return { block, letter: blockLetter(block), replaced, kept_due: keptDue };
}

const daySeconds = (d: PlanDay) => WARMUP_SEC + d.exercises.reduce((a, x) => a + (x.rest_sec + SET_WORK_SEC) * x.sets, 0);

export function generateProgram(input: GeneratorInput, ctx: GeneratorContext): Proposal {
  const style = resolveStyle(input.style, input.days_per_week);
  if (!style) throw new GeneratorInputError(`${input.style} does not run ${input.days_per_week} days a week.`);
  if (style === "strength" && input.equipment !== "full_gym") throw new GeneratorInputError("The strength style needs a barbell: choose the full gym.");
  const strength = style === "strength";
  const block = Math.max(2, Math.floor(input.block ?? 2));
  const params: GeneratorInput = { ...input, block };
  const exMap = new Map(ctx.exercises.map((e) => [e.id, e]));
  const currentDays = byPosition(ctx.current?.days ?? []);
  const programIds = new Map<string, boolean>();
  const timedIds = new Set<string>();
  const perLegIds = new Set<string>();
  for (const d of currentDays)
    for (const x of d.exercises) {
      programIds.set(x.exercise_id, (programIds.get(x.exercise_id) ?? false) || x.is_main);
      if (x.is_time) timedIds.add(x.exercise_id);
      if (x.per_leg) perLegIds.add(x.exercise_id);
    }
  // Rotation: exercises that are not due stay; a new pick is never due or used in the last 8 weeks.
  const status = new Map((ctx.rotation ?? []).map((s) => [s.exercise_id, s]));
  const recent = ctx.recentIds ?? new Set<string>();
  const kept = (id: string) => programIds.has(id) && !(status.get(id)?.due ?? false);
  const blocked = (id: string) => !kept(id) && (programIds.has(id) || recent.has(id));
  const pool = candidatePool({ exercises: ctx.exercises, historyIds: ctx.historyIds, programIds, timedIds, perLegIds, kept, blocked }, input.equipment, input.avoid);
  const byId = new Map(pool.map((c) => [c.ex.id, c]));
  const targets = weeklyTargets(ctx.current ? programVolume(ctx.current, exMap) : zeros(), ctx.currentPriority, input.priority_muscles);
  const layout = LAYOUTS[style][input.days_per_week];
  const limitSec = input.session_minutes * 60;
  const unfilled: string[] = [];
  // Regions the current program had no main-focus exercise for: a main lift's new variation covers one when it can.
  const lastBlockMissing = new Set(REGIONS.filter((r) => !currentDays.some((d) => d.exercises.some((x) => mainRegions(exMap.get(x.exercise_id)).includes(r)))));

  const entry = (c: Candidate, slot: Slot, sets?: number): PlanExercise => {
    const sc = schemeFor(slot, strength, c.group);
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
  const inPlan = (id: string) => days.some((d) => d.exercises.some((x) => x.exercise_id === id));
  const regionsOf = (id: string) => byId.get(id)?.regions ?? mainRegions(exMap.get(id));

  /** How many exercises of the week have each region as a main focus. */
  const covered = () => {
    const out = new Map<Region, number>();
    for (const d of days) for (const x of d.exercises) for (const r of regionsOf(x.exercise_id)) out.set(r, (out.get(r) ?? 0) + 1);
    return out;
  };
  /** Prefers exercises for a region the week lacks (as it stands now). */
  const gainNow = () => {
    const cov = covered();
    return (c: Candidate) => c.regions.some((r) => !cov.get(r));
  };
  /** The block's equipment mix (main lifts aside): 0 in the mix and new to that muscle this week, 1 in the mix, 2 not. */
  const mixNow = () => {
    const used = new Map<MixFamily, Set<EquipKind>>();
    for (const d of days)
      for (const x of d.exercises) {
        const c = byId.get(x.exercise_id);
        if (!c?.family || x.slot === "main") continue;
        if (!used.has(c.family)) used.set(c.family, new Set());
        used.get(c.family)!.add(c.kind);
      }
    return (c: Candidate) => (!c.family ? 0 : !blockMix(c.family, block).includes(c.kind) ? 2 : used.get(c.family)?.has(c.kind) ? 1 : 0);
  };
  /** A day never has two exercises with the same main-focus region and the same equipment (`without`: one replaced). */
  const noClash = (i: number, without?: PlanExercise) => {
    const taken = new Set<string>();
    for (const x of days[i].exercises) if (x !== without) for (const r of regionsOf(x.exercise_id)) taken.add(`${r}|${exMap.get(x.exercise_id)?.equipment}`);
    return (c: Candidate) => !c.regions.some((r) => taken.has(`${r}|${c.ex.equipment}`));
  };
  /** At most one exercise new to him a day, where a known one can do. */
  const freshOk = (i: number) => {
    const hasNew = days[i].exercises.some((x) => {
      const c = byId.get(x.exercise_id);
      return c && !c.history && !c.kept;
    });
    return (c: Candidate) => !hasNew || c.history || c.kept;
  };
  /** The best pick with every Phase B filter; then without the one-new-a-day preference; then, for a layout slot, with
   *  due and recently used exercises allowed (never a clash). */
  const pickFor = (i: number, q: PickQuery, layoutSlot = false): Candidate | null => {
    const clash = noClash(i);
    const fresh = freshOk(i);
    const acc = q.accept;
    const ok = (c: Candidate) => clash(c) && (!acc || acc(c));
    return pick(pool, { ...q, accept: (c) => ok(c) && fresh(c) }) ?? pick(pool, { ...q, accept: ok }) ?? (layoutSlot ? pick(pool, { ...q, accept: ok, allowBlocked: true }) : null);
  };

  // 1. Main lifts on every day first, then the secondaries.
  for (const role of ["main", "secondary"] as const) {
    layout.forEach((l, i) => {
      for (const spec of l.slots.filter((x) => x.slot === role)) {
        const dayIds = new Set(days[i].exercises.map((x) => x.exercise_id));
        const noHeavyHinge = spec.pattern === "hinge" && role === "secondary" && heavyHingeNear(days, i, byId);
        // An exercise of the current program's same day (the same layout day by name) stays in its place when not due.
        const sameDay = currentDays[i]?.name_en === l.name;
        const here = (c: Candidate) => sameDay && c.kept && currentDays[i].exercises.some((x) => x.exercise_id === c.ex.id);
        const base: PickQuery = { pattern: spec.pattern, group: spec.group, slot: role, lift: spec.lift, dayIds, noHeavyHinge, roleOf, seed: input.seed, here };
        // A new main lift: a region the last block lacked first, then the region of the day's current main lift.
        const oldMain = currentDays[i]?.exercises.find((x) => x.is_main || x.slot === "main");
        const close = new Set(mainRegions(exMap.get(oldMain?.exercise_id ?? "")));
        const q: PickQuery =
          role === "main"
            ? { ...base, barbell: input.equipment === "full_gym", gain: (c) => c.regions.some((r) => lastBlockMissing.has(r)), rank: (c) => [c.regions.some((r) => close.has(r)) ? 0 : 1, sourceRank(c)] }
            : { ...base, gain: gainNow(), mix: mixNow() };
        // A main lift is a close variation that can be loaded heavy (both sides at once, a press, row, pull, squat or hinge).
        const c = (role === "main" ? pickFor(i, { ...q, accept: mainLiftOk }, true) : null) ?? pickFor(i, q, true);
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
    for (const [g, w] of c.contrib) if (isTargetGroup(g) && (l.get(g as TargetGroup) ?? 0) + w * sets > SESSION_CAP + 1e-9) return false;
    return true;
  };
  /** Session cap with exercise x replaced by candidate o. */
  const capOkWithout = (i: number, x: PlanExercise, o: Candidate) => {
    const l = dayLoad({ exercises: days[i].exercises.filter((y) => y !== x) }, exMap);
    for (const [g, w] of o.contrib) if (isTargetGroup(g) && (l.get(g as TargetGroup) ?? 0) + w * x.sets > SESSION_CAP + 1e-9) return false;
    return true;
  };
  const growable = (x: PlanExercise) => (x.slot === "accessory" || x.slot === "isolation" || x.slot === "core") && x.sets < x.set_range[1];
  /** Replacing x with c (n sets) keeps every floor the week already reaches (a secondary muscle counts too). */
  const floorsKept = (x: PlanExercise, c: Candidate, n: number) => {
    const p = planned();
    const old = byId.get(x.exercise_id);
    return BIG.every((g) => p[g] < FLOORS[g]! || p[g] - (old?.contrib.get(g) ?? 0) * x.sets + (c.contrib.get(g) ?? 0) * n >= FLOORS[g]! - 1e-9);
  };

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
  /** Region work and the exercises that stay add only push sets the planned pull sets already cover: the time they
   *  take is not there for more pull work later. */
  const pushCovered = (c: Candidate, sets: number) => {
    if (!PUSH.includes(c.ex.pattern ?? "")) return true;
    const { push, pull } = pushPullSets(days, exMap);
    return sets <= pull - push;
  };

  /** Exercises that are not due stay (Phase B), on their day when that day may train them, with their sets. Main and
   *  secondary lifts come from the layout; this keeps the accessory, isolation and core work. */
  const keepCurrent = () =>
    currentDays.forEach((cd, ci) => {
      for (const x of byPosition(cd.exercises)) {
        const c = byId.get(x.exercise_id);
        if (!c || !c.kept || inPlan(c.ex.id) || x.is_main) continue;
        const compound = c.ex.mechanic === "compound" && c.ex.pattern !== "isolation" && c.ex.pattern !== "core";
        const slot: Slot | null = x.slot === "accessory" || x.slot === "isolation" || x.slot === "core" ? x.slot : x.slot === null && !compound ? (c.ex.pattern === "core" ? "core" : "isolation") : null;
        if (!slot) continue;
        const sc = schemeFor(slot, strength, c.group);
        const sets = Math.min(sc.range[1], Math.max(sc.range[0], x.sets));
        const load = (i: number) => (isTargetGroup(c.group) ? (dayLoad(days[i], exMap).get(c.group as TargetGroup) ?? 0) : 0);
        const order = days
          .map((_d, i) => i)
          .filter((i) => dayTrains(days[i].kind, c.group))
          .sort((a, b) => Number(b === ci) - Number(a === ci) || load(a) - load(b) || a - b);
        const i = order.find((k) => capOk(k, c, sets) && pushCovered(c, sets) && fits(k, (sc.rest + SET_WORK_SEC) * sets));
        if (i !== undefined) days[i].exercises.push(entry(c, slot, sets));
      }
    });

  /** Adds work for a group on the day that has least of it: one more set on an exercise there, or a new exercise. */
  const addFor = (g: TargetGroup): boolean => {
    const options: { key: number[]; act: () => void }[] = [];
    const gain = gainNow();
    const mix = mixNow();
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
        const sc = schemeFor(t.slot, strength, g);
        const sets = sc.range[0];
        const accept = (c: Candidate) => capOk(i, c, sets) && pushOk(c, sets) && fits(i, (sc.rest + SET_WORK_SEC) * sets);
        const c = pickFor(i, { patterns: t.patterns, group: g, slot: t.slot, dayIds, noHeavyHinge: true, roleOf, accept, seed: input.seed, gain, mix });
        if (!c) continue;
        if (!best || compareKeys(preference(c, { gain, mix }), preference(best.c, { gain, mix })) < 0) best = { c, slot: t.slot, sets };
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

  /** One more pull set: on a pull exercise already in a day, or a new pull accessory. Pull ≥ push is a hard rule: when
   *  only a pull that shares a region and the equipment with one of the day fits, it is still added (`clashOk`), and the
   *  check shows it as advice. */
  const addPull = (clashOk = false): boolean => {
    const options: { key: number[]; act: () => void }[] = [];
    const gain = gainNow();
    const mix = mixNow();
    days.forEach((d, i) => {
      if (!DAY_GROUPS[d.kind].includes("back")) return;
      for (const x of d.exercises) {
        const c = byId.get(x.exercise_id);
        if (!c || !growable(x) || !PULL.includes(c.ex.pattern ?? "")) continue;
        if (capOk(i, c, 1) && fits(i, x.rest_sec + SET_WORK_SEC)) options.push({ key: [0, i], act: () => (x.sets += 1) });
      }
      const dayIds = new Set(d.exercises.map((x) => x.exercise_id));
      const sc = schemeFor("accessory", strength, "back");
      const accept = (c: Candidate) => capOk(i, c, sc.range[0]) && fits(i, (sc.rest + SET_WORK_SEC) * sc.range[0]);
      const q: PickQuery = { patterns: ["h_pull", "v_pull"], group: "back", slot: "accessory", dayIds, roleOf, accept, seed: input.seed, gain, mix };
      const c = clashOk ? pick(pool, q) : pickFor(i, q);
      if (c) options.push({ key: [1, i], act: () => days[i].exercises.push(entry(c, "accessory", sc.range[0])) });
    });
    if (!options.length) return false;
    options.sort((a, b) => compareKeys(a.key, b.key))[0].act();
    return true;
  };

  /** Direct sets of a forearm or neck region this week (exercises of the group with the region as a main focus; one that
   *  trains both regions counts half a set for each, so the regions add up to the group's direct sets). */
  const regionSets = (g: DirectGroup, r: Region) => {
    let n = 0;
    for (const d of days)
      for (const x of d.exercises) {
        const c = byId.get(x.exercise_id);
        if (c && c.group === g && c.regions.includes(r)) n += x.sets / c.regions.filter((o) => DIRECT_REGIONS[g].includes(o)).length;
      }
    return n;
  };
  /** Removing n sets of x must not take a forearm or neck region below its share of the direct target. */
  const directOk = (x: PlanExercise, n: number) => {
    const c = byId.get(x.exercise_id);
    if (!c || !(DIRECT_GROUPS as readonly string[]).includes(c.group)) return true;
    const g = c.group as DirectGroup;
    return directRegionSets(g, block).every(([r, want]) => !c.regions.includes(r) || regionSets(g, r) - n >= want);
  };

  /** One push set less: from an accessory first, then a secondary; never a main lift; a region's last exercise last. */
  const dropPush = (): boolean => {
    const cov = covered();
    const lastCover = (x: PlanExercise) => regionsOf(x.exercise_id).some((r) => cov.get(r) === 1);
    for (const spare of [true, false])
      for (const slot of ["accessory", "secondary"] as const)
        for (const d of days) {
          const x = d.exercises.find((y) => y.slot === slot && PUSH.includes(exMap.get(y.exercise_id)?.pattern ?? "") && (!spare || y.sets > y.set_range[0] || !lastCover(y)));
          if (!x) continue;
          if (x.sets > x.set_range[0]) x.sets -= 1;
          else d.exercises.splice(d.exercises.indexOf(x), 1);
          return true;
        }
    return false;
  };

  const trimmable = (d: PlanDay) => d.exercises.some((x) => x.slot !== "main" && !(x.slot === "isolation" && byId.get(x.exercise_id)?.group === "rear_delts"));

  /** What removing one set of x (or all of x at its minimum) does: hard rules, floors, coverage and the groups it takes. */
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
    // Phase B: a region's last main-focus exercise, or forearm and neck sets below the direct target.
    const cov = covered();
    const breaksCover = (removeAll && regionsOf(x.exercise_id).some((r) => cov.get(r) === 1)) || !directOk(x, n);
    const group = c && isTargetGroup(c.group) ? (c.group as TargetGroup) : undefined;
    const over = group ? p[group] - targets[group] : 0;
    const apply = () => {
      const d = days.find((y) => y.exercises.includes(x))!;
      if (removeAll) d.exercises.splice(d.exercises.indexOf(x), 1);
      else x.sets -= 1;
    };
    return { x, group, breaksHard, breaksFloor, breaksCover, underAfter, over, apply };
  };

  /** One set (or one exercise at its minimum) less on day i: isolation and core first, then accessories, then
   *  secondaries; never a main lift. Prefers work that keeps the hard rules, floors and region coverage, from the group
   *  most over target. */
  const trim = (i: number): boolean => {
    for (const tier of [["isolation", "core"], ["accessory"], ["secondary"]] as Slot[][]) {
      const o = days[i].exercises
        .filter((x) => tier.includes(x.slot))
        .map(removal)
        .filter((r) => !r.breaksHard)
        .sort((a, b) => Number(a.breaksFloor) - Number(b.breaksFloor) || Number(a.breaksCover) - Number(b.breaksCover) || b.over - a.over)[0];
      if (!o) continue;
      o.apply();
      return true;
    }
    return false;
  };

  /** Work added for one group lands secondary sets on others: takes groups more than one set over target back down,
   *  from their own accessory and isolation work, without taking any group below target, a floor, a hard rule or a
   *  region's last main-focus exercise. */
  const trimExcess = () => {
    for (let guard = 0; guard < 80; guard++) {
      const p = planned();
      const o = days
        .flatMap((d) => d.exercises)
        .filter((x) => x.slot !== "main" && x.slot !== "secondary")
        .map(removal)
        .filter((r) => r.group && p[r.group] - targets[r.group] > 1 && !r.breaksHard && !r.breaksFloor && !r.breaksCover && !r.underAfter)
        .sort((a, b) => b.over - a.over)[0];
      if (!o) return;
      o.apply();
    }
  };

  /** Fills the groups toward a goal (the floors or the targets), the biggest deficit first. */
  const fill = (groups: readonly TargetGroup[], goal: Readonly<Partial<Record<TargetGroup, number>>> = targets) => {
    const stuck = new Set<TargetGroup>();
    const want = (g: TargetGroup) => goal[g] ?? 0;
    for (let guard = 0; guard < 400; guard++) {
      const p = planned();
      const next = groups.filter((g) => !stuck.has(g) && want(g) - p[g] > 0.5).sort((a, b) => want(b) - p[b] - (want(a) - p[a]))[0];
      if (!next) break;
      if (!addFor(next)) stuck.add(next);
    }
  };

  /** The slots region work may take: core work, a compound accessory, or isolation work. */
  const regionSlots = (c: Candidate): Slot[] => (c.ex.pattern === "core" ? ["core"] : c.ex.mechanic === "compound" && c.ex.pattern !== "isolation" ? ["accessory"] : ["isolation"]);

  /** Adds an exercise with region r as a main focus where it fits: the best exercise, on the day that may train it with
   *  the least of its group (then the shortest day); `sets` or its slot's minimum. `only`: an exercise for r alone among its muscle's regions
   *  (the forearm and neck targets count each region's sets). False when nothing fits. */
  const addRegion = (r: Region, sets?: number, only = false): boolean => {
    const mix = mixNow();
    const cov = covered();
    // One exercise for two missing regions (a plain curl trains both biceps heads) before one for each.
    const missing = (c: Candidate) => -c.regions.filter((g) => !cov.get(g)).length;
    let best: { c: Candidate; i: number; slot: Slot; sets: number; key: number[] } | null = null;
    days.forEach((d, i) => {
      const dayIds = new Set(d.exercises.map((x) => x.exercise_id));
      for (const slot of ["isolation", "core", "accessory"] as const) {
        const groups = [...new Set(pool.filter((c) => c.regions.includes(r) && regionSlots(c).includes(slot) && dayTrains(d.kind, c.group)).map((c) => c.group))];
        for (const g of groups) {
          const sc = schemeFor(slot, strength, g);
          const n = Math.min(sc.range[1], Math.max(sc.range[0], sets ?? sc.range[0]));
          const alone = (c: Candidate) => !only || c.regions.every((o) => o === r || regionFamily(o) !== regionFamily(r));
          const accept = (c: Candidate) => alone(c) && regionSlots(c).includes(slot) && capOk(i, c, n) && pushCovered(c, n) && fits(i, (sc.rest + SET_WORK_SEC) * n);
          const c = pickFor(i, { group: g, slot, dayIds, noHeavyHinge: true, roleOf, accept, seed: input.seed, region: r, mix, rank: (o) => [missing(o)] });
          if (!c) continue;
          const load = isTargetGroup(g) ? (dayLoad(d, exMap).get(g as TargetGroup) ?? 0) : d.exercises.filter((x) => byId.get(x.exercise_id)?.group === g).length;
          // Then the shorter day, so region work spreads over the week instead of filling the first days.
          const key = [missing(c), ...preference(c, { mix }), load, daySeconds(d), i];
          if (!best || compareKeys(key, best.key) < 0) best = { c, i, slot, sets: n, key };
        }
      }
    });
    if (!best) return false;
    const b = best as { c: Candidate; i: number; slot: Slot; sets: number };
    days[b.i].exercises.push(entry(b.c, b.slot, b.sets));
    return true;
  };

  /**
   * A region covered twice gives one of its exercises (not kept, not a main lift) to missing region r of the same
   * muscle (Payam, 2026-10-17: "drop one of two flat presses, add a lower-chest exercise"): the same group on the same
   * day, its sets as far as the new slot allows, no clash, within the session cap and time, and no new push debt.
   */
  const swapDouble = (r: Region): boolean => {
    const cov = covered();
    const mix = mixNow();
    const { push, pull } = pushPullSets(days, exMap);
    let best: { x: PlanExercise; c: Candidate; slot: Slot; sets: number; key: number[] } | null = null;
    days.forEach((d, i) => {
      for (const x of d.exercises) {
        const old = byId.get(x.exercise_id);
        if (x.slot === "main" || !old || old.kept || !old.regions.length || !old.regions.every((g) => (cov.get(g) ?? 0) >= 2)) continue;
        if (!old.regions.some((g) => regionFamily(g) === regionFamily(r))) continue;
        const dayIds = new Set(d.exercises.filter((y) => y !== x).map((y) => y.exercise_id));
        const clash = noClash(i, x);
        const slots: Slot[] = x.slot === "isolation" || x.slot === "core" ? [x.slot] : [x.slot, "isolation"];
        for (const slot of slots) {
          const sc = schemeFor(slot, strength, old.group);
          const sets = Math.min(sc.range[1], Math.max(sc.range[0], x.sets));
          const moved = (c: Candidate, pats: readonly string[]) => (pats.includes(c.ex.pattern ?? "") ? sets : 0) - (pats.includes(old.ex.pattern ?? "") ? x.sets : 0);
          const accept = (c: Candidate) =>
            clash(c) &&
            regionSlots(c).includes(slot === "secondary" ? "accessory" : slot) &&
            (roleOf(c.ex.id) ?? slot) === slot &&
            capOkWithout(i, x, c) &&
            floorsKept(x, c, sets) &&
            daySeconds(d) - (x.rest_sec + SET_WORK_SEC) * x.sets + (sc.rest + SET_WORK_SEC) * sets <= limitSec &&
            push + moved(c, PUSH) - pull - moved(c, PULL) <= Math.max(0, push - pull);
          const c = pick(pool, { group: old.group, slot, dayIds, noHeavyHinge: x.slot !== "secondary", roleOf: () => undefined, accept, seed: input.seed, region: r, mix });
          if (!c) continue;
          const key = [...preference(c, { mix }), i];
          if (!best || compareKeys(key, best.key) < 0) best = { x, c, slot, sets, key };
        }
      }
    });
    if (!best) return false;
    const b = best as { x: PlanExercise; c: Candidate; slot: Slot; sets: number };
    Object.assign(b.x, entry(b.c, b.slot, b.sets));
    return true;
  };

  // 2. The rear-delt minimum (a hard rule) before any other work takes the time; at short sessions a lower-tier
  //    exercise makes room for it. Then the big groups to their floors and targets.
  for (let guard = 0; guard < 40 && planned().rear_delts < REAR_DELT_MIN; guard++) {
    if (addFor("rear_delts")) continue;
    const i = days.findIndex((d) => DAY_GROUPS[d.kind].includes("rear_delts") && trimmable(d));
    if (i < 0 || !trim(i)) break;
  }
  fill(BIG, FLOORS);
  fill(BIG);

  // 3. The exercises that stay.
  keepCurrent();

  // 4. Region coverage (Phase B): every region gets a main-focus exercise; forearms and neck get their direct sets.
  const directRegions = new Set(DIRECT_GROUPS.filter((g) => directTarget(g, block) > 0).flatMap((g) => DIRECT_REGIONS[g]));
  for (const r of REGIONS) {
    if (directRegions.has(r) || covered().get(r)) continue;
    if (!swapDouble(r)) addRegion(r, SMALL_REGIONS.has(r) ? 2 : undefined);
  }
  for (const g of DIRECT_GROUPS)
    for (const [r, want] of directRegionSets(g, block))
      for (let guard = 0; guard < 8; guard++) {
        const need = want - regionSets(g, r);
        if (need <= 0) break;
        // One more set on an exercise of the region first, then a new exercise for the rest (one for this region alone,
        // so the week's direct sets reach the target).
        const grow = days
          .flatMap((d, i) => d.exercises.map((x) => ({ x, i })))
          .find(({ x, i }) => {
            const c = byId.get(x.exercise_id);
            return c && c.group === g && c.regions.includes(r) && x.sets < x.set_range[1] && fits(i, x.rest_sec + SET_WORK_SEC);
          });
        if (grow) grow.x.sets += 1;
        else if (!addRegion(r, need, true)) break;
      }

  // 5. Fill: every group to its target.
  fill(TARGET_GROUPS);

  // 6. Balance: pull ≥ push; then refill with work that keeps the balance.
  for (let guard = 0; guard < 60; guard++) {
    const { push, pull } = pushPullSets(days, exMap);
    if (pull >= push) break;
    if (!addPull() && !dropPush() && !addPull(true)) break;
  }
  strictPush = true;
  fill(TARGET_GROUPS);
  trimExcess();

  // 7. Fit every day into the session length.
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
      const clash = noClash(i, x);
      const accept = (o: Candidate) => (o.contrib.get("rear_delts") ?? 0) > 0 && capOkWithout(i, x, o) && clash(o);
      const r = pick(pool, { pattern: c.ex.pattern!, group: c.group, slot: x.slot, dayIds, roleOf, accept, seed: input.seed });
      if (r) Object.assign(x, { exercise_id: r.ex.id, per_leg: r.perLeg, is_time: r.timed });
    }
  }

  // 8. A day never changes its main lift and all its other exercises at once (Phase B): when it would, the day keeps
  //    the least overdue of its current exercises in place of a new one of the same group and slot.
  const sameDays = currentDays.length === days.length;
  const allNew = (i: number) => {
    // Only a day that is the same day of the week's plan (the same layout day by name) keeps one of its exercises.
    if (currentDays[i].name_en !== days[i].name_en) return false;
    const cur = currentDays[i].exercises;
    const curMain = cur.find((x) => x.is_main || x.slot === "main")?.exercise_id;
    const main = days[i].exercises.find((x) => x.slot === "main")?.exercise_id;
    return !!curMain && !!main && curMain !== main && !days[i].exercises.some((x) => x.slot !== "main" && cur.some((y) => y.exercise_id === x.exercise_id));
  };
  if (sameDays)
    days.forEach((d, i) => {
      if (!allNew(i)) return;
      const overdue = (id: string) => (status.get(id)?.weeks ?? 0) - (status.get(id)?.max ?? 0);
      const back = byPosition(currentDays[i].exercises)
        .filter((y) => !y.is_main && y.slot !== "main" && byId.has(y.exercise_id) && !inPlan(y.exercise_id))
        .sort((a, b) => overdue(a.exercise_id) - overdue(b.exercise_id));
      for (const y of back) {
        const c = byId.get(y.exercise_id)!;
        const x = d.exercises.find((z) => z.slot !== "main" && byId.get(z.exercise_id)?.group === c.group && regionSlots(c).includes(z.slot === "secondary" ? "accessory" : z.slot) && !byId.get(z.exercise_id)?.kept);
        if (!x || !capOkWithout(i, x, c) || !noClash(i, x)(c)) continue;
        // Never at the cost of a region's last main-focus exercise.
        const cov = covered();
        if (regionsOf(x.exercise_id).some((r) => (cov.get(r) ?? 0) < 2 && !c.regions.includes(r))) continue;
        const sc = schemeFor(x.slot, strength, c.group);
        const sets = Math.min(sc.range[1], Math.max(sc.range[0], x.sets));
        if (!floorsKept(x, c, sets)) continue;
        Object.assign(x, entry(c, x.slot, sets));
        return;
      }
    });

  // 9. Order and supersets.
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
  const check = checkPlan(plan, exMap, targets, { block });
  for (const u of unfilled) check.warnings.push({ code: "unfilled", message: `No exercise for ${u} with this equipment and avoid list.` });
  if (sameDays) days.forEach((d, i) => allNew(i) && check.warnings.push({ code: "day_all_new", message: `${d.name_en} changes its main lift and all its other exercises at once.`, day: i }));
  return { ...plan, name: `${STYLE_NAME[style]} · ${input.days_per_week} days`, params, targets, check, block: blockChanges(ctx.current, ctx.rotation ?? [], days, exMap, block) };
}

/** True when another day within 72 h (either way round the week) already has a heavy hinge. */
function heavyHingeNear(days: readonly PlanDay[], i: number, byId: ReadonlyMap<string, Candidate>): boolean {
  const o = days[i].offset;
  return days.some((d, j) => {
    if (j === i || !d.exercises.some((x) => byId.get(x.exercise_id)?.heavyHinge)) return false;
    return Math.min((d.offset - o + 7) % 7, (o - d.offset + 7) % 7) < 3;
  });
}

/** One exercise of an edited proposal: the editor changes only the exercise (a swap) and the sets. */
export interface EditedExercise {
  exercise_id: string;
  slot: Slot;
  sets: number;
  per_leg: boolean;
  is_time: boolean;
  superset_tag: string | null;
}

/**
 * Rebuilds a plan from the generator inputs and the edited days (a draft, or a program read back from the database):
 * day names, kinds and offsets come from the style's layout, and reps, rest, target RIR and set ranges from the slot
 * (neck work from its own scheme, when the library `ex` is given).
 */
export function planFromEdits(params: GeneratorInput, days: readonly { exercises: readonly EditedExercise[] }[], ex?: ReadonlyMap<string, Pick<Exercise, "muscle_primary">>): Plan {
  const style = resolveStyle(params.style, params.days_per_week);
  if (!style) throw new GeneratorInputError(`${params.style} does not run ${params.days_per_week} days a week.`);
  const layout = LAYOUTS[style][params.days_per_week];
  if (days.length !== layout.length) throw new GeneratorInputError(`This style has ${layout.length} days.`);
  const strength = style === "strength";
  return {
    style,
    days_per_week: params.days_per_week,
    session_minutes: params.session_minutes,
    days: layout.map((l, i) => ({
      name_en: l.name,
      kind: l.kind,
      offset: l.offset,
      exercises: days[i].exercises.map((x) => {
        const sc = schemeFor(x.slot, strength, groupOf(ex?.get(x.exercise_id)?.muscle_primary));
        const reps = x.is_time ? HOLD_SECONDS : sc.reps;
        return {
          exercise_id: x.exercise_id,
          slot: x.slot,
          sets: x.sets,
          reps_min: reps[0],
          reps_max: reps[1],
          rest_sec: sc.rest,
          target_rir_min: sc.rir[0],
          target_rir_max: sc.rir[1],
          per_leg: x.per_leg,
          is_time: x.is_time,
          superset_tag: x.superset_tag,
          set_range: sc.range,
        };
      }),
    })),
  };
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

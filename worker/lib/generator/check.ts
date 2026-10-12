// Program check (SPEC-v2 §8.4, §8.6): weekly volume, session length, hard-rule violations and soft warnings for a
// plan. The generator runs it on every proposal; the proposal editor runs it after every edit, and the server runs it
// again before saving and approving. Hard-rule violations block approval; warnings do not.

import { countsVolume } from "../category";
import { groupOf, isTargetGroup, setContribution, TARGET_GROUPS } from "../muscles";
import type { Exercise } from "../types";
import { isHeavyHinge } from "./pick";
import {
  FLOORS,
  MAJOR_GROUPS,
  MAX_TWO_IN_A_ROW,
  REAR_DELT_MIN,
  SESSION_CAP,
  SET_WORK_SEC,
  STYLE_NAME,
  WARMUP_SEC,
  type DayKind,
  type ResolvedStyle,
  type Slot,
  type TargetGroup,
} from "./model";

export interface PlanExercise {
  exercise_id: string;
  slot: Slot;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_sec: number;
  target_rir_min: number;
  target_rir_max: number;
  per_leg: boolean;
  is_time: boolean;
  superset_tag: string | null;
  /** Allowed sets for this slot (§8.4); edits stay inside it. */
  set_range: readonly [number, number];
}

export interface PlanDay {
  name_en: string;
  kind: DayKind;
  /** Day of the suggested week, 0–6. */
  offset: number;
  exercises: PlanExercise[];
}

export interface Plan {
  style: ResolvedStyle;
  days_per_week: number;
  session_minutes: number;
  days: PlanDay[];
}

export interface Issue {
  code: string;
  message: string;
  day?: number;
}

export interface VolumeRow {
  group: TargetGroup;
  target: number;
  /** Fractional sets (§7.4). */
  planned: number;
  /** Sets whose primary muscle is in the group. */
  direct: number;
  /** Days with direct work for the group. */
  days: number;
}

export interface CheckResult {
  volume: VolumeRow[];
  minutes: number[];
  violations: Issue[];
  warnings: Issue[];
  push_sets: number;
  pull_sets: number;
}

const GROUP_NAME: Readonly<Record<TargetGroup, string>> = {
  chest: "Chest",
  back: "Back",
  quads: "Quads",
  hamstrings_glutes: "Hamstrings & glutes",
  shoulders: "Shoulders",
  rear_delts: "Rear delts",
  calves: "Calves",
  core: "Core",
  biceps: "Biceps",
  triceps: "Triceps",
};
export const groupName = (g: TargetGroup) => GROUP_NAME[g];

const SLOT_NAME: Readonly<Record<Slot, string>> = { main: "a main lift", secondary: "a secondary lift", accessory: "an accessory", isolation: "isolation work", core: "core work" };
const slotName = (s: Slot) => SLOT_NAME[s];

const round1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => String(round1(n));

/** Estimated minutes of a day: (rest + 40 s) × sets for every exercise plus a 5-minute warm-up, rounded up. */
export const dayMinutes = (d: { exercises: readonly Pick<PlanExercise, "rest_sec" | "sets">[] }) => Math.ceil((WARMUP_SEC + d.exercises.reduce((a, x) => a + (x.rest_sec + SET_WORK_SEC) * x.sets, 0)) / 60);

/** Fractional sets per target group for one day. Only categories that count toward volume (§7.4). */
export function dayLoad(d: { exercises: readonly Pick<PlanExercise, "exercise_id" | "sets">[] }, ex: ReadonlyMap<string, Exercise>): Map<TargetGroup, number> {
  const out = new Map<TargetGroup, number>();
  for (const x of d.exercises) {
    const e = ex.get(x.exercise_id);
    if (!e || !countsVolume(e.category)) continue;
    for (const [g, w] of setContribution(e.muscle_primary, e.muscles_secondary)) if (isTargetGroup(g)) out.set(g as TargetGroup, (out.get(g as TargetGroup) ?? 0) + w * x.sets);
  }
  return out;
}

const PUSH = new Set(["h_push", "v_push"]);
const PULL = new Set(["h_pull", "v_pull"]);

/** Calendar distance from day offset a to b going forward through the week (1–7). */
const ahead = (a: number, b: number) => ((b - a + 7) % 7) || 7;

export function checkPlan(plan: Plan, ex: ReadonlyMap<string, Exercise>, targets: Readonly<Record<TargetGroup, number>>): CheckResult {
  const violations: Issue[] = [];
  const warnings: Issue[] = [];
  const days = plan.days;
  const loads = days.map((d) => dayLoad(d, ex));
  const minutes = days.map(dayMinutes);
  const groupOfEx = (id: string) => {
    const e = ex.get(id);
    const g = e ? groupOf(e.muscle_primary) : null;
    return g && isTargetGroup(g) ? (g as TargetGroup) : null;
  };

  // Exercises must exist, count toward volume and keep their sets inside the slot's range.
  days.forEach((d, i) => {
    const seen = new Set<string>();
    for (const x of d.exercises) {
      const e = ex.get(x.exercise_id);
      if (!e) violations.push({ code: "unknown_exercise", message: `${d.name_en}: an exercise is not in the library.`, day: i });
      else if (!countsVolume(e.category)) violations.push({ code: "not_strength", message: `${d.name_en}: ${e.name_en} is not strength work.`, day: i });
      if (seen.has(x.exercise_id)) violations.push({ code: "duplicate", message: `${d.name_en}: ${e?.name_en ?? "an exercise"} is in the day twice.`, day: i });
      seen.add(x.exercise_id);
      if (x.sets < x.set_range[0] || x.sets > x.set_range[1]) violations.push({ code: "sets_range", message: `${d.name_en}: ${e?.name_en ?? "an exercise"} has ${x.sets} sets; allowed ${x.set_range[0]}–${x.set_range[1]}.`, day: i });
    }
  });

  // One exercise keeps one role in the week (decided 2026-10-12), so its rep range and progression stay one.
  const roles = new Map<string, { slot: Slot; day: number }>();
  days.forEach((d, i) => {
    for (const x of d.exercises) {
      const r = roles.get(x.exercise_id);
      if (!r) roles.set(x.exercise_id, { slot: x.slot, day: i });
      else if (r.slot !== x.slot)
        violations.push({ code: "two_roles", message: `${ex.get(x.exercise_id)?.name_en ?? "An exercise"} is ${slotName(r.slot)} on ${days[r.day].name_en} and ${slotName(x.slot)} on ${d.name_en}; one exercise keeps one role a week.`, day: i });
    }
  });

  // Recovery constraints (hard rules).
  const order = days.map((d, i) => ({ d, i })).sort((a, b) => a.d.offset - b.d.offset);
  const mains = days.map((d) => d.exercises.filter((x) => x.slot === "main"));
  for (const { d, i } of order) {
    const next = order.find((o) => ahead(d.offset, o.d.offset) === 1);
    if (next) {
      const here = new Set(mains[i].map((x) => groupOfEx(x.exercise_id)).filter(Boolean));
      for (const x of mains[next.i]) {
        const g = groupOfEx(x.exercise_id);
        if (g && here.has(g)) violations.push({ code: "main_consecutive", message: `${groupName(g)} has a main lift on two consecutive days (${d.name_en}, ${next.d.name_en}).`, day: next.i });
      }
    }
    const heavyMains = mains[i].filter((x) => {
      const e = ex.get(x.exercise_id);
      return e && (e.pattern === "squat" || isHeavyHinge(e));
    });
    if (heavyMains.some((x) => ex.get(x.exercise_id)?.pattern === "squat") && heavyMains.some((x) => isHeavyHinge(ex.get(x.exercise_id)!)))
      violations.push({ code: "squat_deadlift_mains", message: `${d.name_en}: heavy squat and heavy deadlift are both main lifts.`, day: i });
  }
  const hingeDays = order.filter(({ d }) => d.exercises.some((x) => (x.slot === "main" || x.slot === "secondary" || x.slot === "accessory") && ex.get(x.exercise_id) && isHeavyHinge(ex.get(x.exercise_id)!)));
  for (let a = 0; a < hingeDays.length; a++) {
    for (let b = 0; b < hingeDays.length; b++) {
      if (a === b) continue;
      const gap = ahead(hingeDays[a].d.offset, hingeDays[b].d.offset);
      if (gap < 3 && hingeDays.length > 1) {
        violations.push({ code: "hinge_72h", message: `Heavy hinges less than 72 h apart (${hingeDays[a].d.name_en}, ${hingeDays[b].d.name_en}).`, day: hingeDays[b].i });
      }
    }
  }
  const offsets = new Set(days.map((d) => d.offset));
  if (MAX_TWO_IN_A_ROW.has(plan.style)) {
    for (const o of offsets) if (offsets.has((o + 1) % 7) && offsets.has((o + 2) % 7)) violations.push({ code: "three_in_a_row", message: "More than two training days in a row." });
  } else {
    for (const { d, i } of order) {
      const next = order.find((o) => ahead(d.offset, o.d.offset) === 1);
      if (!next) continue;
      const direct = (j: number) => new Set(days[j].exercises.map((x) => groupOfEx(x.exercise_id)).filter(Boolean));
      const a = direct(i);
      for (const g of direct(next.i)) if (a.has(g)) violations.push({ code: "back_to_back", message: `${groupName(g!)} is trained on back-to-back days (${d.name_en}, ${next.d.name_en}).`, day: next.i });
    }
  }
  // Per-session cap (decided): at most 10 fractional sets per muscle group in one session.
  loads.forEach((l, i) => {
    for (const [g, v] of l) if (v > SESSION_CAP + 1e-9) violations.push({ code: "session_cap", message: `${days[i].name_en}: ${groupName(g)} has ${fmt(v)} sets; the limit is ${SESSION_CAP} per session.`, day: i });
  });

  // Balance rules.
  let push = 0;
  let pull = 0;
  const patterns = new Set<string>();
  for (const d of days)
    for (const x of d.exercises) {
      const p = ex.get(x.exercise_id)?.pattern;
      if (!p) continue;
      patterns.add(p);
      if (PUSH.has(p)) push += x.sets;
      if (PULL.has(p)) pull += x.sets;
    }
  if (pull < push) violations.push({ code: "pull_push", message: `Pull sets (${pull}) are fewer than push sets (${push}).` });
  if (!patterns.has("hinge")) violations.push({ code: "no_hinge", message: "No hinge in the week." });
  if (!patterns.has("squat")) violations.push({ code: "no_squat", message: "No squat in the week." });

  // Weekly volume.
  const volume: VolumeRow[] = TARGET_GROUPS.map((g) => {
    let planned = 0;
    let direct = 0;
    let freq = 0;
    days.forEach((d, i) => {
      planned += loads[i].get(g) ?? 0;
      const own = d.exercises.filter((x) => groupOfEx(x.exercise_id) === g).reduce((a, x) => a + x.sets, 0);
      direct += own;
      if (own > 0) freq++;
    });
    return { group: g, target: round1(targets[g] ?? 0), planned: round1(planned), direct, days: freq };
  });
  const rear = volume.find((v) => v.group === "rear_delts")!;
  if (rear.planned < REAR_DELT_MIN) violations.push({ code: "rear_delts", message: `Rear delts get ${fmt(rear.planned)} sets; at least ${REAR_DELT_MIN} a week.` });

  // Soft warnings.
  if (plan.style === "bro_split") warnings.push({ code: "frequency", message: "Bro split: each muscle 1×/week, below the ACSM minimum of 2×/week; weaker for strength." });
  else if (volume.some((v) => MAJOR_GROUPS.includes(v.group) && v.days < 2)) warnings.push({ code: "frequency", message: `${STYLE_NAME[plan.style]} ${plan.days_per_week} days: some muscles are trained 1×/week, below the ACSM minimum of 2×/week.` });
  for (const v of volume) {
    const floor = FLOORS[v.group];
    if (floor !== undefined && v.planned < floor) warnings.push({ code: "floor", message: `${groupName(v.group)}: ${fmt(v.planned)} sets, below the floor of ${floor}.` });
    else if (v.target > 0 && v.planned < 0.8 * v.target) warnings.push({ code: "under_target", message: `${groupName(v.group)}: ${fmt(v.planned)} of ${fmt(v.target)} target sets.` });
    else if (v.target > 0 && v.planned > 1.2 * v.target) warnings.push({ code: "over_target", message: `${groupName(v.group)}: ${fmt(v.planned)} of ${fmt(v.target)} target sets.` });
  }
  minutes.forEach((mins, i) => {
    if (mins > plan.session_minutes) warnings.push({ code: "too_long", message: `${days[i].name_en}: about ${mins} min, longer than ${plan.session_minutes} min.`, day: i });
  });
  return { volume, minutes, violations: dedupe(violations), warnings, push_sets: push, pull_sets: pull };
}

function dedupe(list: Issue[]): Issue[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.message) ? false : (seen.add(x.message), true)));
}

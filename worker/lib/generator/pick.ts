// Exercise choice for the generator (SPEC-v2 §8.4 "Exercise choice"): filter by equipment, the avoid list and the
// counting categories, then prefer exercises with history, then those in the current program (in the same role),
// then compound movements, then beginner or intermediate level; a seeded hash breaks the remaining ties.

import { countsVolume } from "../category";
import { groupOf, isTargetGroup, setContribution, type ReportGroup } from "../muscles";
import type { Exercise, Pattern } from "../types";
import type { EquipmentChoice, Slot, TargetGroup } from "./model";

export interface Candidate {
  ex: Exercise;
  group: TargetGroup;
  /** Fractional sets one set adds to each report group. */
  contrib: Map<ReportGroup, number>;
  history: boolean;
  /** 2: a main lift in the current program; 1: in the current program; 0: not in it. */
  inProgram: 0 | 1 | 2;
  levelOk: boolean;
  heavyHinge: boolean;
  timed: boolean;
  perLeg: boolean;
}

const EQUIPMENT_OK: Readonly<Record<EquipmentChoice, ReadonlySet<string>>> = {
  full_gym: new Set(["barbell", "dumbbell", "cable", "machine", "bodyweight"]),
  dumbbells: new Set(["dumbbell", "bodyweight"]),
};

/** Explosive Olympic-style lifts are never picked automatically (decided 2026-10-12); they stay in the library, can be
 *  swapped in by hand and still count toward volume. */
export const isOlympicLift = (ex: Pick<Exercise, "name_en" | "category">) => ex.category === "olympic_weightlifting" || /\b(clean|snatch|jerk)\b|\bpush press\b/i.test(ex.name_en);

/** Deadlift, Romanian deadlift, stiff-legged deadlift and good morning: at most once per 72 h (§8.4). */
export const isHeavyHinge = (ex: Pick<Exercise, "pattern" | "name_en">) => ex.pattern === "hinge" && /deadlift|romanian|\brdl\b|good morning|stiff[- ]?leg/i.test(ex.name_en);
const TIMED = /plank|hold|hang\b|wall sit|l-sit|hollow/i;
const PER_LEG = /bulgarian|split squat|lunge|single[- ]leg|one[- ]leg|step[- ]?up|pistol|copenhagen/i;

export interface PoolContext {
  exercises: Exercise[];
  historyIds: ReadonlySet<string>;
  /** Exercises of the current program: true when it is a main lift there. */
  programIds: ReadonlyMap<string, boolean>;
  /** Timed and per-leg flags the current program already uses for an exercise. */
  timedIds: ReadonlySet<string>;
  perLegIds: ReadonlySet<string>;
}

export function candidatePool(ctx: PoolContext, equipment: EquipmentChoice, avoid: readonly string[]): Candidate[] {
  const okEquipment = EQUIPMENT_OK[equipment];
  const avoided = new Set(avoid);
  const out: Candidate[] = [];
  for (const ex of ctx.exercises) {
    if (ex.archived_at || avoided.has(ex.id) || !countsVolume(ex.category) || isOlympicLift(ex) || !ex.pattern || !okEquipment.has(ex.equipment)) continue;
    const group = groupOf(ex.muscle_primary);
    if (!group || !isTargetGroup(group)) continue;
    const main = ctx.programIds.get(ex.id);
    out.push({
      ex,
      group: group as TargetGroup,
      contrib: setContribution(ex.muscle_primary, ex.muscles_secondary),
      history: ctx.historyIds.has(ex.id),
      inProgram: main === undefined ? 0 : main ? 2 : 1,
      levelOk: ex.level === null || ex.level === "beginner" || ex.level === "intermediate",
      heavyHinge: isHeavyHinge(ex),
      timed: ctx.timedIds.has(ex.id) || (ex.pattern === "core" && TIMED.test(ex.name_en)),
      perLeg: ctx.perLegIds.has(ex.id) || PER_LEG.test(ex.name_en),
    });
  }
  return out;
}

/** FNV-1a over the seed and the id: a stable, seed-dependent tie-break. */
export function seededHash(seed: number, id: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface PickQuery {
  pattern?: Pattern;
  patterns?: readonly Pattern[];
  group: TargetGroup;
  slot: Slot;
  /** Strength style: the barbell lift a main or secondary slot must be. */
  lift?: "squat" | "bench" | "deadlift" | "ohp";
  /** Exercise ids already on the day (never twice in one session). */
  dayIds: ReadonlySet<string>;
  /** Leave heavy hinges out (accessory hinge slots, or a day too close to another heavy hinge). */
  noHeavyHinge?: boolean;
  /** The role an exercise already has this week: one exercise keeps one role (one rep range, one progression). */
  roleOf?: (id: string) => Slot | undefined;
  /** Extra condition (session cap, time, the push/pull balance): the best candidate that meets it. */
  accept?: (c: Candidate) => boolean;
  seed: number;
}

const LIFT: Readonly<Record<NonNullable<PickQuery["lift"]>, { pattern: Pattern; name: RegExp; not?: RegExp }>> = {
  squat: { pattern: "squat", name: /squat/i, not: /front|split|goblet|hack|box|smith|pistol|overhead|zercher/i },
  bench: { pattern: "h_push", name: /bench press/i, not: /incline|decline|close|dumbbell|floor|board/i },
  deadlift: { pattern: "hinge", name: /deadlift/i, not: /romanian|stiff|sumo|single|trap|rack|deficit|snatch/i },
  ohp: { pattern: "v_push", name: /overhead press|military press|shoulder press/i, not: /dumbbell|seated|machine|arnold|behind/i },
};

/** §8.4 preference between candidates of different slots: history, the current program, compound, level. */
export const preference = (c: Candidate): number[] => [c.history ? 0 : 1, c.inProgram === 0 ? 1 : 0, c.ex.mechanic === "compound" ? 0 : 1, c.levelOk ? 0 : 1];

/** Lexicographic comparison of two preference keys. */
export function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The best candidate for a slot, or null when the library has none for the equipment and avoid list. */
export function pick(pool: readonly Candidate[], q: PickQuery): Candidate | null {
  const patterns = q.patterns ?? (q.pattern ? [q.pattern] : []);
  const lift = q.lift ? LIFT[q.lift] : null;
  const wantCompound = q.slot === "main" || q.slot === "secondary" || q.slot === "accessory";
  const list = pool.filter((c) => {
    if (c.group !== q.group || q.dayIds.has(c.ex.id)) return false;
    const role = q.roleOf?.(c.ex.id);
    if (role && role !== q.slot) return false;
    if (lift) return c.ex.pattern === lift.pattern && c.ex.equipment === "barbell" && lift.name.test(c.ex.name_en) && !(lift.not && lift.not.test(c.ex.name_en)) && (!q.accept || q.accept(c));
    if (patterns.length && !patterns.includes(c.ex.pattern!)) return false;
    if (q.noHeavyHinge && c.heavyHinge) return false;
    if (wantCompound && c.ex.mechanic === "isolation") return false;
    if (q.slot === "main" && c.ex.pattern === "hinge" && !c.heavyHinge) return false;
    return !q.accept || q.accept(c);
  });
  if (!list.length) return null;
  // §8.4 order: history, the current program (a main lift there for a main slot), compound (isolation for an isolation
  // slot), beginner or intermediate level; then the seeded tie-break.
  const key = (c: Candidate): number[] => [
    c.history ? 0 : 1,
    c.inProgram === 0 ? 1 : 0,
    q.slot === "main" ? (c.inProgram === 2 ? 0 : 1) : c.inProgram === 2 ? 1 : 0,
    (c.ex.mechanic === "compound") === wantCompound ? 0 : 1,
    c.levelOk ? 0 : 1,
    seededHash(q.seed, c.ex.id),
  ];
  let best = list[0];
  let bestKey = key(best);
  for (const c of list.slice(1)) {
    const k = key(c);
    if (compareKeys(k, bestKey) < 0) {
      best = c;
      bestKey = k;
    }
  }
  return best;
}

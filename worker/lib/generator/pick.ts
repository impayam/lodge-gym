// Exercise choice for the generator (SPEC-v2 §8.4 "Exercise choice"): filter by equipment, the avoid list and the
// counting categories, then prefer exercises with history, then those in the current program (in the same role),
// then compound movements, then beginner or intermediate level; a seeded hash breaks the remaining ties.
//
// Phase B (SPEC-v11, approved 2026-10-17) puts four preferences first: an exercise that is not due stays (rotation);
// one that covers a region the week lacks; a main lift on a barbell; and, for the other exercises, the block's
// equipment mix. A new pick is never a due exercise or one used in the last 8 weeks, and never shares a main-focus
// region and the equipment with another exercise of the day.

import { countsVolume } from "../category";
import { groupOf, isTargetGroup, setContribution, type ReportGroup } from "../muscles";
import type { Region } from "../regions";
import type { Exercise, Pattern } from "../types";
import { equipKind, mixFamilyOf, type EquipKind, type MixFamily } from "./blocks";
import type { EquipmentChoice, Slot, TargetGroup } from "./model";

/** Groups without a volume target the generator adds for region coverage and the forearm and neck targets (Phase B). */
export const EXTRA_GROUPS: ReadonlySet<ReportGroup> = new Set<ReportGroup>(["traps", "forearms", "neck", "adductors", "abductors"]);

export interface Candidate {
  ex: Exercise;
  /** A target group, or one of EXTRA_GROUPS. */
  group: ReportGroup;
  /** Fractional sets one set adds to each report group. */
  contrib: Map<ReportGroup, number>;
  history: boolean;
  /** 2: a main lift in the current program; 1: in the current program; 0: not in it. */
  inProgram: 0 | 1 | 2;
  levelOk: boolean;
  heavyHinge: boolean;
  timed: boolean;
  perLeg: boolean;
  /** Main-focus regions (primary tags). */
  regions: Region[];
  /** The equipment as the block table names it, and the table row of its main muscle. */
  kind: EquipKind;
  family: MixFamily | null;
  /** In the current program and not due: it stays (rotation). */
  kept: boolean;
  /** Due, or used in the last 8 weeks without being kept: never a new pick. */
  blocked: boolean;
}

export const EQUIPMENT_OK: Readonly<Record<EquipmentChoice, ReadonlySet<string>>> = {
  full_gym: new Set(["barbell", "dumbbell", "cable", "machine", "bodyweight"]),
  dumbbells: new Set(["dumbbell", "bodyweight"]),
};

/** Explosive Olympic-style lifts are never picked automatically (decided 2026-10-12); they stay in the library, can be
 *  swapped in by hand and still count toward volume. */
export const isOlympicLift = (ex: Pick<Exercise, "name_en" | "category">) => ex.category === "olympic_weightlifting" || /\b(clean|snatch|jerk)\b|\bpush press\b/i.test(ex.name_en);

/** Regions a main lift can train: a heavy press, row, pull, squat or hinge (Phase B: its variation is chosen by region). */
export const MAIN_LIFT_REGIONS: ReadonlySet<Region> = new Set<Region>(["chest_upper", "chest_mid", "chest_lower", "back_upper", "back_lats", "shoulders_front", "quads_squat", "hamstrings_hinge", "glutes_ext"]);
const NOT_A_MAIN_LIFT = /\b(single|one)[- ]?(arm|leg)\b|kickstand|sissy|kneeling|isometric|jump|\bbands?\b|\bchains?\b|speed|thruster|jefferson|plate movers?|to press|meadows/i;
/** A lift that can be loaded heavy and progressed as a main lift: both sides at once, for one of the main-lift regions. */
export const mainLiftOk = (c: Pick<Candidate, "ex" | "regions">) => !looksPerLeg(c.ex) && !NOT_A_MAIN_LIFT.test(c.ex.name_en) && c.regions.some((r) => MAIN_LIFT_REGIONS.has(r));

/** Deadlift, Romanian deadlift, stiff-legged deadlift and good morning: at most once per 72 h (§8.4). */
export const isHeavyHinge = (ex: Pick<Exercise, "pattern" | "name_en">) => ex.pattern === "hinge" && /deadlift|romanian|\brdl\b|good morning|stiff[- ]?leg/i.test(ex.name_en);
const TIMED = /plank|hold|hang\b|wall sit|l-sit|hollow/i;
const PER_LEG = /bulgarian|split squat|lunge|single[- ]leg|one[- ]leg|step[- ]?up|pistol|copenhagen/i;
/** A core hold logged in seconds (plank, hollow hold). */
export const looksTimed = (ex: Pick<Exercise, "pattern" | "name_en">) => ex.pattern === "core" && TIMED.test(ex.name_en);
/** Logged per leg (split squat, lunge, single-leg work). */
export const looksPerLeg = (ex: Pick<Exercise, "name_en">) => PER_LEG.test(ex.name_en);

export interface PoolContext {
  exercises: Exercise[];
  historyIds: ReadonlySet<string>;
  /** Exercises of the current program: true when it is a main lift there. */
  programIds: ReadonlyMap<string, boolean>;
  /** Timed and per-leg flags the current program already uses for an exercise. */
  timedIds: ReadonlySet<string>;
  perLegIds: ReadonlySet<string>;
  /** Phase B rotation: kept and blocked exercises (default: neither). */
  kept?: (id: string) => boolean;
  blocked?: (id: string) => boolean;
}

export function candidatePool(ctx: PoolContext, equipment: EquipmentChoice, avoid: readonly string[]): Candidate[] {
  const okEquipment = EQUIPMENT_OK[equipment];
  const avoided = new Set(avoid);
  const out: Candidate[] = [];
  for (const ex of ctx.exercises) {
    if (ex.archived_at || avoided.has(ex.id) || !countsVolume(ex.category) || isOlympicLift(ex) || !ex.pattern || !okEquipment.has(ex.equipment)) continue;
    const group = groupOf(ex.muscle_primary);
    if (!group || (!isTargetGroup(group) && !EXTRA_GROUPS.has(group))) continue;
    const main = ctx.programIds.get(ex.id);
    out.push({
      ex,
      group,
      contrib: setContribution(ex.muscle_primary, ex.muscles_secondary),
      history: ctx.historyIds.has(ex.id),
      inProgram: main === undefined ? 0 : main ? 2 : 1,
      levelOk: ex.level === null || ex.level === "beginner" || ex.level === "intermediate",
      heavyHinge: isHeavyHinge(ex),
      timed: ctx.timedIds.has(ex.id) || looksTimed(ex),
      perLeg: ctx.perLegIds.has(ex.id) || looksPerLeg(ex),
      regions: ex.regions.filter((r) => r.emphasis === "primary").map((r) => r.region),
      kind: equipKind(ex),
      family: mixFamilyOf(ex.muscle_primary),
      kept: ctx.kept?.(ex.id) ?? false,
      blocked: ctx.blocked?.(ex.id) ?? false,
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
  group: ReportGroup;
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
  /** Only exercises with this region as a main focus (region coverage). */
  region?: Region;
  /** Prefer exercises that cover a region the week (or, for a main lift, the last block) lacks. */
  gain?: (c: Candidate) => boolean;
  /** Main lifts stay barbell (Phase B): prefer the barbell. */
  barbell?: boolean;
  /** The block's equipment mix for the exercise's muscle: 0 in the mix and new to that muscle this week, 1 in the mix, 2 not. */
  mix?: (c: Candidate) => number;
  /** Allow due and recently used exercises (the fallback when nothing else fits a slot). */
  allowBlocked?: boolean;
  /** Prefer the exercise the current program has in this place (that day): a kept exercise stays where it is. */
  here?: (c: Candidate) => boolean;
  /** Further preference keys right after history (a main lift: close to the lift it replaces, curated sources first). */
  rank?: (c: Candidate) => number[];
}

/** Curated exercises first among equals: his own and the seed program's, the hand-written gap fill, free-exercise-db,
 *  then the M14 sources. */
const SOURCE_RANK: Readonly<Record<string, number>> = { seed: 0, custom: 0, manual: 1, fedb: 2 };
export const sourceRank = (c: Pick<Candidate, "ex">) => SOURCE_RANK[c.ex.source] ?? 3;

const LIFT: Readonly<Record<NonNullable<PickQuery["lift"]>, { pattern: Pattern; name: RegExp; not?: RegExp }>> = {
  squat: { pattern: "squat", name: /squat/i, not: /front|split|goblet|hack|box|smith|pistol|overhead|zercher/i },
  bench: { pattern: "h_push", name: /bench press/i, not: /incline|decline|close|dumbbell|floor|board/i },
  deadlift: { pattern: "hinge", name: /deadlift/i, not: /romanian|stiff|sumo|single|trap|rack|deficit|snatch/i },
  ohp: { pattern: "v_push", name: /overhead press|military press|shoulder press/i, not: /dumbbell|seated|machine|arnold|behind/i },
};

/** Preference between candidates of different slots: Phase B's kept, region and mix keys, then §8.4's history, the
 *  current program, compound, level. */
export const preference = (c: Candidate, q?: Pick<PickQuery, "gain" | "mix">): number[] => [
  c.kept ? 0 : 1,
  q?.gain?.(c) ? 0 : 1,
  q?.mix ? q.mix(c) : 0,
  c.history ? 0 : 1,
  c.inProgram === 0 ? 1 : 0,
  c.ex.mechanic === "compound" ? 0 : 1,
  c.levelOk ? 0 : 1,
];

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
    // The strength style's four barbell lifts are the lifts themselves: rotation does not change them.
    if (lift) return c.ex.pattern === lift.pattern && c.ex.equipment === "barbell" && lift.name.test(c.ex.name_en) && !(lift.not && lift.not.test(c.ex.name_en)) && (!q.accept || q.accept(c));
    if (c.blocked && !q.allowBlocked) return false;
    if (q.region && !c.regions.includes(q.region)) return false;
    if (patterns.length && !patterns.includes(c.ex.pattern!)) return false;
    if (q.noHeavyHinge && c.heavyHinge) return false;
    if (wantCompound && c.ex.mechanic === "isolation") return false;
    if (q.slot === "main" && c.ex.pattern === "hinge" && !c.heavyHinge) return false;
    return !q.accept || q.accept(c);
  });
  if (!list.length) return null;
  // Phase B first: kept in its place, kept, a region the week lacks, the barbell for a main lift, the block's equipment
  // mix. Then §8.4: history, the current program (a main lift there for a main slot), compound (isolation for an
  // isolation slot), beginner or intermediate level; then curated sources and the seeded tie-break.
  const key = (c: Candidate): number[] => [
    q.here?.(c) ? 0 : 1,
    c.kept ? 0 : 1,
    q.gain?.(c) ? 0 : 1,
    q.barbell ? (c.ex.equipment === "barbell" ? 0 : 1) : 0,
    q.mix ? q.mix(c) : 0,
    c.history ? 0 : 1,
    ...(q.rank ? q.rank(c) : []),
    c.inProgram === 0 ? 1 : 0,
    q.slot === "main" ? (c.inProgram === 2 ? 0 : 1) : c.inProgram === 2 ? 1 : 0,
    (c.ex.mechanic === "compound") === wantCompound ? 0 : 1,
    c.levelOk ? 0 : 1,
    sourceRank(c),
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

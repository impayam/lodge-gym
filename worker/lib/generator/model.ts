// Program generator (SPEC-v2 M8): inputs, styles, weekly layouts and slot schemes. Pure data, no I/O.
//
// Every style has fixed weekly layouts: which days of a 7-day week are training days and which main and secondary
// lifts each day carries. The layouts are chosen so the hard recovery rules hold by construction (§8.4): no muscle has
// a main lift on two consecutive calendar days, heavy hinges are at least 72 h apart, heavy squat and heavy deadlift
// are never both main lifts of one session, full-body and strength weeks have at most two training days in a row, and
// split days never repeat a muscle's direct work on back-to-back days.

import { TARGET_GROUPS } from "../muscles";
import type { Pattern } from "../types";

export type TargetGroup = (typeof TARGET_GROUPS)[number];

export const STYLES = ["auto", "full_body", "upper_lower", "ppl", "ppl_ul", "bro_split", "strength"] as const;
export type Style = (typeof STYLES)[number];
export type ResolvedStyle = Exclude<Style, "auto">;
export const SESSION_MINUTES = [45, 60, 75, 90] as const;
export const EQUIPMENT_CHOICES = ["full_gym", "dumbbells", "bodyweight"] as const;
export type EquipmentChoice = (typeof EQUIPMENT_CHOICES)[number];
export const SLOTS = ["main", "secondary", "accessory", "isolation", "core"] as const;
export type Slot = (typeof SLOTS)[number];

export interface GeneratorInput {
  days_per_week: number;
  style: Style;
  session_minutes: (typeof SESSION_MINUTES)[number];
  priority_muscles: TargetGroup[];
  /** Exercise ids to leave out (an injury, a machine the gym lacks). */
  avoid: string[];
  equipment: EquipmentChoice;
  /** Deterministic tie-break between equally good exercises. */
  seed: number;
}

/** Allowed days per style (§8.3). */
export const ALLOWED_DAYS: Readonly<Record<ResolvedStyle, readonly number[]>> = {
  full_body: [2, 3, 4],
  upper_lower: [2, 4],
  ppl: [3, 6],
  ppl_ul: [5],
  bro_split: [5],
  strength: [3, 4],
};

/** `auto` (§8.3): 2–3 days full body, 4 upper/lower, 5 PPL + upper/lower, 6 PPL. */
export function resolveStyle(style: Style, days: number): ResolvedStyle | null {
  if (style === "auto") return days >= 2 && days <= 3 ? "full_body" : days === 4 ? "upper_lower" : days === 5 ? "ppl_ul" : days === 6 ? "ppl" : null;
  return ALLOWED_DAYS[style].includes(days) ? style : null;
}

export const STYLE_NAME: Readonly<Record<ResolvedStyle, string>> = {
  full_body: "Full body",
  upper_lower: "Upper/lower",
  ppl: "Push/pull/legs",
  ppl_ul: "PPL + upper/lower",
  bro_split: "Bro split",
  strength: "Strength",
};

/** Styles whose consecutive-day rule is "at most two training days in a row"; the others use split sequencing. */
export const MAX_TWO_IN_A_ROW: ReadonlySet<ResolvedStyle> = new Set(["full_body", "strength"]);

export type DayKind = "full" | "upper" | "lower" | "push" | "pull" | "legs" | "chest" | "back" | "shoulders" | "arms";

/** Groups a day may train directly (its accessories and isolation). Adjacent split days share none of them. */
export const DAY_GROUPS: Readonly<Record<DayKind, readonly TargetGroup[]>> = {
  full: TARGET_GROUPS,
  upper: ["chest", "back", "shoulders", "rear_delts", "biceps", "triceps"],
  lower: ["quads", "hamstrings_glutes", "calves", "core"],
  push: ["chest", "shoulders", "triceps"],
  pull: ["back", "rear_delts", "biceps"],
  legs: ["quads", "hamstrings_glutes", "calves", "core"],
  chest: ["chest"],
  back: ["back", "rear_delts"],
  shoulders: ["shoulders", "rear_delts"],
  arms: ["biceps", "triceps"],
};

/** A main or secondary slot of a layout day: the movement pattern and the primary muscle group it trains. */
export interface SlotSpec {
  slot: "main" | "secondary";
  pattern: Pattern;
  group: TargetGroup;
  /** Strength style: one of the four barbell lifts. */
  lift?: "squat" | "bench" | "deadlift" | "ohp";
}

export interface LayoutDay {
  name: string;
  kind: DayKind;
  /** Day of the suggested week, 0–6 (0 = the first training day). */
  offset: number;
  slots: SlotSpec[];
}

const m = (pattern: Pattern, group: TargetGroup, lift?: SlotSpec["lift"]): SlotSpec => ({ slot: "main", pattern, group, ...(lift ? { lift } : {}) });
const s = (pattern: Pattern, group: TargetGroup, lift?: SlotSpec["lift"]): SlotSpec => ({ slot: "secondary", pattern, group, ...(lift ? { lift } : {}) });

/** Weekly layouts per style and day count. Offsets put heavy hinges ≥ 3 days apart, also across the week's end. */
export const LAYOUTS: Readonly<Record<ResolvedStyle, Readonly<Record<number, LayoutDay[]>>>> = {
  full_body: {
    2: [
      { name: "Day 1 · Squat", kind: "full", offset: 0, slots: [m("squat", "quads"), s("h_push", "chest"), s("h_pull", "back"), s("hinge", "hamstrings_glutes")] },
      { name: "Day 2 · Deadlift", kind: "full", offset: 3, slots: [m("hinge", "hamstrings_glutes"), s("h_push", "chest"), s("v_pull", "back"), s("lunge", "quads")] },
    ],
    3: [
      { name: "Day 1 · Squat", kind: "full", offset: 0, slots: [m("squat", "quads"), s("h_push", "chest"), s("h_pull", "back")] },
      { name: "Day 2 · Chest", kind: "full", offset: 2, slots: [m("h_push", "chest"), s("v_pull", "back"), s("lunge", "quads")] },
      { name: "Day 3 · Deadlift", kind: "full", offset: 4, slots: [m("hinge", "hamstrings_glutes"), s("v_push", "shoulders"), s("h_pull", "back")] },
    ],
    4: [
      { name: "Day 1 · Chest", kind: "full", offset: 0, slots: [m("h_push", "chest"), s("h_push", "chest"), s("hinge", "hamstrings_glutes"), s("h_pull", "back")] },
      { name: "Day 2 · Legs", kind: "full", offset: 1, slots: [m("squat", "quads"), s("squat", "quads"), s("h_push", "chest"), s("v_pull", "back")] },
      { name: "Day 3 · Back", kind: "full", offset: 3, slots: [m("h_pull", "back"), s("v_pull", "back"), s("lunge", "quads")] },
      { name: "Day 4 · Deadlift", kind: "full", offset: 4, slots: [m("hinge", "hamstrings_glutes"), s("v_push", "shoulders")] },
    ],
  },
  upper_lower: {
    2: [
      { name: "Upper", kind: "upper", offset: 0, slots: [m("h_push", "chest"), s("h_pull", "back"), s("v_push", "shoulders"), s("v_pull", "back")] },
      { name: "Lower", kind: "lower", offset: 3, slots: [m("squat", "quads"), s("hinge", "hamstrings_glutes"), s("lunge", "quads")] },
    ],
    4: [
      { name: "Upper A", kind: "upper", offset: 0, slots: [m("h_push", "chest"), s("h_pull", "back"), s("v_push", "shoulders")] },
      { name: "Lower A", kind: "lower", offset: 1, slots: [m("squat", "quads"), s("hinge", "hamstrings_glutes")] },
      { name: "Upper B", kind: "upper", offset: 3, slots: [m("h_pull", "back"), s("h_push", "chest"), s("v_pull", "back")] },
      { name: "Lower B", kind: "lower", offset: 4, slots: [m("hinge", "hamstrings_glutes"), s("lunge", "quads")] },
    ],
  },
  ppl: {
    3: [
      { name: "Push", kind: "push", offset: 0, slots: [m("h_push", "chest"), s("v_push", "shoulders"), s("h_push", "chest")] },
      { name: "Pull", kind: "pull", offset: 2, slots: [m("h_pull", "back"), s("v_pull", "back")] },
      { name: "Legs", kind: "legs", offset: 4, slots: [m("squat", "quads"), s("hinge", "hamstrings_glutes")] },
    ],
    6: [
      { name: "Push A", kind: "push", offset: 0, slots: [m("h_push", "chest"), s("v_push", "shoulders")] },
      { name: "Pull A", kind: "pull", offset: 1, slots: [m("h_pull", "back"), s("v_pull", "back")] },
      { name: "Legs A", kind: "legs", offset: 2, slots: [m("squat", "quads"), s("hinge", "hamstrings_glutes")] },
      { name: "Push B", kind: "push", offset: 3, slots: [m("v_push", "shoulders"), s("h_push", "chest")] },
      { name: "Pull B", kind: "pull", offset: 4, slots: [m("v_pull", "back"), s("h_pull", "back")] },
      { name: "Legs B", kind: "legs", offset: 5, slots: [m("hinge", "hamstrings_glutes"), s("squat", "quads")] },
    ],
  },
  ppl_ul: {
    5: [
      { name: "Push", kind: "push", offset: 0, slots: [m("h_push", "chest"), s("v_push", "shoulders")] },
      { name: "Pull", kind: "pull", offset: 1, slots: [m("h_pull", "back"), s("v_pull", "back")] },
      { name: "Legs", kind: "legs", offset: 2, slots: [m("squat", "quads"), s("hinge", "hamstrings_glutes")] },
      { name: "Upper", kind: "upper", offset: 4, slots: [m("h_push", "chest"), s("h_pull", "back"), s("v_push", "shoulders")] },
      { name: "Lower", kind: "lower", offset: 5, slots: [m("hinge", "hamstrings_glutes"), s("squat", "quads")] },
    ],
  },
  bro_split: {
    5: [
      { name: "Chest", kind: "chest", offset: 0, slots: [m("h_push", "chest"), s("h_push", "chest")] },
      { name: "Back", kind: "back", offset: 1, slots: [m("h_pull", "back"), s("v_pull", "back")] },
      { name: "Legs", kind: "legs", offset: 2, slots: [m("squat", "quads"), s("hinge", "hamstrings_glutes")] },
      { name: "Shoulders", kind: "shoulders", offset: 3, slots: [m("v_push", "shoulders")] },
      { name: "Arms", kind: "arms", offset: 4, slots: [] },
    ],
  },
  strength: {
    3: [
      { name: "Day 1 · Squat", kind: "full", offset: 0, slots: [m("squat", "quads", "squat"), s("h_push", "chest", "bench"), s("h_pull", "back"), s("hinge", "hamstrings_glutes")] },
      { name: "Day 2 · Bench", kind: "full", offset: 2, slots: [m("h_push", "chest", "bench"), s("v_push", "shoulders", "ohp"), s("v_pull", "back")] },
      { name: "Day 3 · Deadlift", kind: "full", offset: 4, slots: [m("hinge", "hamstrings_glutes", "deadlift"), s("squat", "quads", "squat"), s("v_push", "shoulders", "ohp")] },
    ],
    4: [
      { name: "Day 1 · Squat", kind: "lower", offset: 0, slots: [m("squat", "quads", "squat"), s("hinge", "hamstrings_glutes")] },
      { name: "Day 2 · Bench", kind: "upper", offset: 1, slots: [m("h_push", "chest", "bench"), s("v_push", "shoulders", "ohp"), s("h_pull", "back")] },
      { name: "Day 3 · Deadlift", kind: "lower", offset: 3, slots: [m("hinge", "hamstrings_glutes", "deadlift"), s("squat", "quads", "squat")] },
      { name: "Day 4 · Press", kind: "upper", offset: 4, slots: [m("v_push", "shoulders", "ohp"), s("h_push", "chest", "bench"), s("v_pull", "back")] },
    ],
  },
};

/** Sets, reps, target RIR and rest per slot (§8.4 "Rep and load schemes"). */
export interface Scheme {
  sets: number;
  range: readonly [number, number];
  reps: readonly [number, number];
  rir: readonly [number, number];
  rest: number;
}

export function scheme(slot: Slot, strength: boolean): Scheme {
  switch (slot) {
    case "main":
      return strength ? { sets: 4, range: [3, 5], reps: [3, 5], rir: [1, 2], rest: 180 } : { sets: 4, range: [3, 4], reps: [5, 8], rir: [1, 3], rest: 180 };
    case "secondary":
      return { sets: 3, range: [3, 3], reps: [6, 10], rir: [1, 3], rest: 120 };
    case "accessory":
      return { sets: 3, range: [2, 3], reps: strength ? [6, 12] : [8, 12], rir: [1, 2], rest: 90 };
    case "isolation":
      return { sets: 3, range: [2, 3], reps: [10, 15], rir: [0, 2], rest: 75 };
    case "core":
      return { sets: 3, range: [2, 3], reps: [10, 15], rir: [0, 2], rest: 60 };
  }
}

/** Seconds of a timed core hold, used instead of reps. */
export const HOLD_SECONDS: readonly [number, number] = [30, 45];

/** Session length estimate (§8.4): (rest + 40 s) × sets for every exercise, plus a 5-minute warm-up. */
export const WARMUP_SEC = 300;
export const SET_WORK_SEC = 40;

/** Per-session cap (§8.4, decided): fractional sets per muscle group in one session. */
export const SESSION_CAP = 10;
/** Weekly floors (§8.4) for the big groups. */
export const FLOORS: Readonly<Partial<Record<TargetGroup, number>>> = { chest: 10, back: 10, quads: 10, hamstrings_glutes: 10 };
/** Balance rule: rear delts at least this many sets a week in every style. */
export const REAR_DELT_MIN = 6;
/** Priority muscles get this many extra weekly sets. */
export const PRIORITY_BONUS = 3;
/** Groups whose direct training frequency the 2×/week guideline is about. */
export const MAJOR_GROUPS: readonly TargetGroup[] = ["chest", "back", "quads", "hamstrings_glutes", "shoulders"];

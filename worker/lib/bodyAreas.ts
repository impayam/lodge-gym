// Body areas of the body-map exercise picker (SPEC-v3 M9b): the eight areas Payam taps on the figure, and the canonical
// muscle keys (./muscles.ts) each one opens. Every drawn muscle belongs to exactly one area; abductors are not drawn
// and are reached through their area's chips. Neck has no area (no exercise in the library trains it as primary).

import { countsVolume, type Category } from "./category";
import type { Muscle } from "./muscles";
import type { Equipment, Exercise } from "./types";

export type BodyArea = "chest" | "shoulders" | "arms" | "back" | "core" | "glutes_hips" | "thighs" | "calves";
export type FigureView = "front" | "back";

export interface AreaDef {
  key: BodyArea;
  label: string;
  /** Muscles in chip order. */
  muscles: readonly Muscle[];
  /** Figures that show the area's muscles; the first one opens first. */
  views: readonly FigureView[];
}

export const BODY_AREAS: readonly AreaDef[] = [
  { key: "chest", label: "Chest", muscles: ["chest"], views: ["front"] },
  { key: "shoulders", label: "Shoulders", muscles: ["shoulders_front", "shoulders_side", "rear_delts"], views: ["front", "back"] },
  { key: "arms", label: "Arms", muscles: ["biceps", "triceps", "forearms"], views: ["front", "back"] },
  { key: "back", label: "Back", muscles: ["back_lats", "back_upper", "traps", "lower_back"], views: ["back", "front"] },
  { key: "core", label: "Core", muscles: ["core"], views: ["front"] },
  { key: "glutes_hips", label: "Glutes & hips", muscles: ["glutes", "adductors", "abductors"], views: ["back", "front"] },
  { key: "thighs", label: "Thighs", muscles: ["quads", "hamstrings"], views: ["front", "back"] },
  { key: "calves", label: "Calves", muscles: ["calves"], views: ["back", "front"] },
];

const BY_KEY = new Map(BODY_AREAS.map((a) => [a.key, a]));
const BY_MUSCLE = new Map(BODY_AREAS.flatMap((a) => a.muscles.map((m) => [m, a.key] as const)));

export const areaDef = (key: BodyArea): AreaDef => BY_KEY.get(key)!;
/** The area a muscle belongs to (null for neck). */
export const areaOfMuscle = (m: string): BodyArea | null => BY_MUSCLE.get(m as Muscle) ?? null;
export const isBodyArea = (v: unknown): v is BodyArea => typeof v === "string" && BY_KEY.has(v as BodyArea);

/* ---------------- step 3: the exercise list for one muscle ---------------- */

/** "counted": strength, powerlifting and olympic weightlifting (the default); "all"; or one category. */
export type CategoryFilter = "counted" | "all" | Category;

export interface MusclePickOptions {
  equipment: Equipment | "";
  category: CategoryFilter;
  /** Exercise id → when it was last done (any sortable string, e.g. local date + start time). */
  lastDone: ReadonlyMap<string, string>;
  /** Exercises of the active program. */
  programIds: ReadonlySet<string>;
}

export interface MusclePicks {
  /** Exercises with the muscle as primary. */
  primary: Exercise[];
  /** "Also works this muscle": the muscle is a secondary one. */
  secondary: Exercise[];
}

/**
 * The exercise list of a muscle (SPEC-v3 M9b step 3): primary first, then secondary; inside each, exercises done
 * before (most recent first), then those in the current program, then compound before isolation, then by name.
 */
export function musclePicks(exercises: readonly Exercise[], muscle: string, o: MusclePickOptions): MusclePicks {
  const keep = (e: Exercise) =>
    !e.archived_at &&
    (!o.equipment || e.equipment === o.equipment) &&
    (o.category === "all" || (o.category === "counted" ? countsVolume(e.category) : e.category === o.category));
  const rank = (a: Exercise, b: Exercise) => {
    const la = o.lastDone.get(a.id) ?? "";
    const lb = o.lastDone.get(b.id) ?? "";
    if (la !== lb) return la && lb ? lb.localeCompare(la) : la ? -1 : 1;
    const pa = o.programIds.has(a.id) ? 0 : 1;
    const pb = o.programIds.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ca = a.mechanic === "compound" ? 0 : 1;
    const cb = b.mechanic === "compound" ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return a.name_en.localeCompare(b.name_en);
  };
  const list = exercises.filter(keep);
  return {
    primary: list.filter((e) => e.muscle_primary === muscle).sort(rank),
    secondary: list.filter((e) => e.muscle_primary !== muscle && e.muscles_secondary.includes(muscle)).sort(rank),
  };
}

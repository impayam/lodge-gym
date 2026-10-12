// Canonical muscle keys (SPEC-v2 §7.2), the one table that maps each source's muscle names onto them, and the
// roll-up into the report groups that carry the weekly program targets (SPEC §6 / §10).

export const CANONICAL_MUSCLES = [
  "chest",
  "back_lats",
  "back_upper",
  "quads",
  "hamstrings",
  "glutes",
  "shoulders_front",
  "shoulders_side",
  "rear_delts",
  "biceps",
  "triceps",
  "calves",
  "core",
  "forearms",
  "traps",
  "adductors",
  "abductors",
  "lower_back",
  "neck",
] as const;
export type Muscle = (typeof CANONICAL_MUSCLES)[number];

export const isMuscle = (m: unknown): m is Muscle => typeof m === "string" && (CANONICAL_MUSCLES as readonly string[]).includes(m);

/** Report groups with a weekly program target, in SPEC §10 order. */
export const TARGET_GROUPS = ["chest", "back", "quads", "hamstrings_glutes", "shoulders", "rear_delts", "calves", "core", "biceps", "triceps"] as const;
/** Muscles without a program target: shown on the muscle map with their sets and no target. */
export const UNTARGETED_GROUPS = ["traps", "forearms", "lower_back", "adductors", "abductors", "neck"] as const;
export const REPORT_GROUPS = [...TARGET_GROUPS, ...UNTARGETED_GROUPS] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

const GROUP_OF: Record<Muscle, ReportGroup> = {
  chest: "chest",
  back_lats: "back",
  back_upper: "back",
  quads: "quads",
  hamstrings: "hamstrings_glutes",
  glutes: "hamstrings_glutes",
  shoulders_front: "shoulders",
  shoulders_side: "shoulders",
  rear_delts: "rear_delts",
  biceps: "biceps",
  triceps: "triceps",
  calves: "calves",
  core: "core",
  forearms: "forearms",
  traps: "traps",
  adductors: "adductors",
  abductors: "abductors",
  lower_back: "lower_back",
  neck: "neck",
};

/**
 * Report group of a stored `muscle_primary` value. Canonical keys roll up; the pre-SPEC-v2 group keys
 * (`back`, `hamstrings_glutes`, `shoulders`) are themselves groups, so rows written before the switch still count.
 */
export function groupOf(muscle: string | null | undefined): ReportGroup | null {
  if (!muscle) return null;
  if (isMuscle(muscle)) return GROUP_OF[muscle];
  return (REPORT_GROUPS as readonly string[]).includes(muscle) ? (muscle as ReportGroup) : null;
}

export const isTargetGroup = (g: string): boolean => (TARGET_GROUPS as readonly string[]).includes(g);

/** Lower-body muscles: their exercises use the lower-body weight increment (SPEC §6). */
const LOWER: ReadonlySet<Muscle> = new Set(["quads", "hamstrings", "glutes", "calves", "adductors", "abductors"]);
export const isLowerBody = (m: Muscle) => LOWER.has(m);

/**
 * Per-set contribution of one exercise to each report group (SPEC-v2 §7.4, fractional method): 1 for the primary
 * muscle's group, 0.5 for each other group reached by a secondary muscle. A group never counts twice for one set.
 */
export function setContribution(primary: string | null | undefined, secondary: readonly string[] = []): Map<ReportGroup, number> {
  const out = new Map<ReportGroup, number>();
  for (const m of secondary) {
    const g = groupOf(m);
    if (g) out.set(g, 0.5);
  }
  const p = groupOf(primary);
  if (p) out.set(p, 1);
  return out;
}

/* ---------------- free-exercise-db (github.com/yuhonas/free-exercise-db) ---------------- */

const FEDB: Record<string, Muscle | "shoulders"> = {
  abdominals: "core",
  abductors: "abductors",
  adductors: "adductors",
  biceps: "biceps",
  calves: "calves",
  chest: "chest",
  forearms: "forearms",
  glutes: "glutes",
  hamstrings: "hamstrings",
  lats: "back_lats",
  "lower back": "lower_back",
  "middle back": "back_upper",
  neck: "neck",
  quadriceps: "quads",
  shoulders: "shoulders",
  traps: "traps",
  triceps: "triceps",
};

const REAR_DELT_NAME = /\b(rear|reverse fly|reverse flye|face pull|back fly|back flye|bent[- ]over (low-pulley )?(side )?lateral|band pull apart)/i;
const SIDE_DELT_NAME = /\b(lateral|side raise|upright|deltoid raise|y-raise)/i;

/**
 * free-exercise-db only says "shoulders". For the primary muscle the exercise name decides: rear-delt work
 * (rear/reverse fly, face pull, bent-over lateral) → rear_delts, raises to the side and upright rows →
 * shoulders_side, everything else (presses, front raises) → shoulders_front. As a secondary muscle, pulls work the
 * rear delts and pushes the front delts.
 */
export function fedbMuscle(name: string, role: "primary" | "secondary", exercise: { name: string; force?: string | null }): Muscle | null {
  const m = FEDB[name.trim().toLowerCase()];
  if (!m) return null;
  if (m !== "shoulders") return m;
  if (role === "secondary") return exercise.force === "pull" ? "rear_delts" : "shoulders_front";
  if (REAR_DELT_NAME.test(exercise.name)) return "rear_delts";
  if (SIDE_DELT_NAME.test(exercise.name)) return "shoulders_side";
  return "shoulders_front";
}

/** Primary key (first mappable primary muscle) and secondary keys (other primaries + secondaries, deduplicated). */
export function fedbMuscles(ex: { name: string; force?: string | null; primaryMuscles: string[]; secondaryMuscles: string[] }): { primary: Muscle | null; secondary: Muscle[] } {
  const primaries = ex.primaryMuscles.map((m) => fedbMuscle(m, "primary", ex)).filter((m): m is Muscle => m !== null);
  const primary = primaries[0] ?? null;
  const secondary: Muscle[] = [];
  for (const m of [...primaries.slice(1), ...ex.secondaryMuscles.map((s) => fedbMuscle(s, "secondary", ex))]) {
    if (m && m !== primary && !secondary.includes(m)) secondary.push(m);
  }
  return { primary, secondary };
}

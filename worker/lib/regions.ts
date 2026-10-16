// Muscle regions (SPEC-v11 M14 A3, approved by Payam 2026-10-16): the 26 region keys, and the reviewed rule table that
// tags each exercise with the regions it emphasises and how well research supports that ("evidence"). Ideas without
// support (inner or outer chest, a biceps "peak", shaping where a muscle inserts) are never tagged. Pure: used by the
// library import, by the Worker when a custom exercise is saved, and by the Library screen.
//
// Evidence levels:
// - strong: growth studies (weeks of training, measured), or consistent, unambiguous anatomy and EMG findings, show
//   the exercise trains that region;
// - moderate: EMG and biomechanics agree, little growth data;
// - weak: anatomy alone (fibre direction, muscle length), or mixed findings.

import { countsVolume } from "./category";
import type { Muscle } from "./muscles";

export const REGIONS = [
  "chest_upper",
  "chest_mid",
  "chest_lower",
  "shoulders_front",
  "shoulders_side",
  "rear_delts",
  "back_lats",
  "back_upper",
  "traps",
  "triceps_long",
  "triceps_lateral_medial",
  "biceps_long",
  "biceps_short",
  "brachialis",
  "quads_squat",
  "quads_knee_ext",
  "hamstrings_hinge",
  "hamstrings_curl",
  "glutes_ext",
  "glutes_abd",
  "calves_gastroc",
  "calves_soleus",
  "adductors",
  "core_anti_ext",
  "core_flexion",
  "core_anti_rot",
] as const;
export type Region = (typeof REGIONS)[number];
export const isRegion = (v: unknown): v is Region => typeof v === "string" && (REGIONS as readonly string[]).includes(v);

export type Emphasis = "primary" | "secondary";
export type Evidence = "strong" | "moderate" | "weak";

/** One tag of exercise_regions (migration 0013). `note` names the rule (or reviewed override) that set it. */
export interface RegionTag {
  region: Region;
  emphasis: Emphasis;
  evidence: Evidence;
  note: string;
}

/** Each region's muscle family (the muscle chip it sits under) and its label. */
export const REGION_INFO: Readonly<Record<Region, { muscle: string; label: string; short: string }>> = {
  chest_upper: { muscle: "chest", label: "Upper chest", short: "Upper" },
  chest_mid: { muscle: "chest", label: "Middle chest", short: "Middle" },
  chest_lower: { muscle: "chest", label: "Lower chest", short: "Lower" },
  shoulders_front: { muscle: "shoulders", label: "Front delts", short: "Front" },
  shoulders_side: { muscle: "shoulders", label: "Side delts", short: "Side" },
  rear_delts: { muscle: "shoulders", label: "Rear delts", short: "Rear" },
  back_lats: { muscle: "back", label: "Lats (vertical pull)", short: "Lats" },
  back_upper: { muscle: "back", label: "Upper back (horizontal pull)", short: "Upper back" },
  traps: { muscle: "back", label: "Traps", short: "Traps" },
  triceps_long: { muscle: "triceps", label: "Triceps long head", short: "Long head" },
  triceps_lateral_medial: { muscle: "triceps", label: "Triceps lateral and medial heads", short: "Lateral/medial" },
  biceps_long: { muscle: "biceps", label: "Biceps long head", short: "Long head" },
  biceps_short: { muscle: "biceps", label: "Biceps short head", short: "Short head" },
  brachialis: { muscle: "biceps", label: "Brachialis", short: "Brachialis" },
  quads_squat: { muscle: "quads", label: "Quads (squat pattern)", short: "Squat" },
  quads_knee_ext: { muscle: "quads", label: "Quads (knee extension)", short: "Knee extension" },
  hamstrings_hinge: { muscle: "hamstrings", label: "Hamstrings (hip hinge)", short: "Hinge" },
  hamstrings_curl: { muscle: "hamstrings", label: "Hamstrings (leg curl)", short: "Curl" },
  glutes_ext: { muscle: "glutes", label: "Glutes (hip extension)", short: "Extension" },
  glutes_abd: { muscle: "glutes", label: "Glutes (abduction)", short: "Abduction" },
  calves_gastroc: { muscle: "calves", label: "Calves, gastrocnemius (straight knee)", short: "Straight knee" },
  calves_soleus: { muscle: "calves", label: "Calves, soleus (bent knee)", short: "Bent knee" },
  adductors: { muscle: "adductors", label: "Adductors", short: "Adductors" },
  core_anti_ext: { muscle: "core", label: "Core, anti-extension", short: "Anti-extension" },
  core_flexion: { muscle: "core", label: "Core, flexion", short: "Flexion" },
  core_anti_rot: { muscle: "core", label: "Core, anti-rotation and obliques", short: "Anti-rotation" },
};

/** The facts the rules read. `secondary` muscles tag only through meaningful synergies (see SECONDARY_TAGGED). */
export interface RegionInput {
  name_en: string;
  muscle_primary: string;
  muscles_secondary: readonly string[];
  pattern: string | null;
  category: string | null;
}

interface Rule {
  id: string;
  when: (n: string, pattern: string | null) => boolean;
  tags: [Region, Emphasis, Evidence][];
}

/* ---------------- name matching ---------------- */

/** Lower-case name with the spellings the rules test unified (push-ups → pushup, flyes → fly, pull-downs → pulldown …). */
export function ruleText(name: string): string {
  return ` ${name
    .toLowerCase()
    .replace(/\bpush[- ]?ups?\b/g, "pushup")
    .replace(/\bpress[- ]?ups?\b/g, "pushup")
    .replace(/\bpull[- ]?ups?\b/g, "pullup")
    .replace(/\bchin[- ]?ups?\b/g, "chinup")
    .replace(/\bsit[- ]?ups?\b/g, "situp")
    .replace(/\b(flyes|flies|flys|flye)\b/g, "fly")
    .replace(/\bpull[- ]?downs?\b/g, "pulldown")
    .replace(/\bpush[- ]?downs?\b/g, "pushdown")
    .replace(/\bcross[- ]?overs?\b/g, "crossover")
    .replace(/\bskull ?crushers?\b/g, "skullcrusher")
    .replace(/\bdead[- ]?lifts?\b/g, "deadlift")
    .replace(/\brdl\b/g, "romanian deadlift")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}
const has = (...words: string[]) => (n: string) => words.every((w) => n.includes(` ${w} `) || n.includes(` ${w}s `) || n.includes(` ${w}es `));
const any = (...words: string[]) => (n: string) => words.some((w) => n.includes(` ${w} `) || n.includes(` ${w}s `) || n.includes(` ${w}es `));
const all =
  (...fs: ((n: string) => boolean)[]) =>
  (n: string) =>
    fs.every((f) => f(n));
const always = () => true;
const PRESS = any("press", "pushup", "bench");
const FLY = any("fly", "crossover");
/** A fly sweeping upward ("low-to-high", or from a low pulley) or downward ("high-to-low", from a high pulley). */
const lowToHigh = (n: string) => n.includes(" low to high ") || (any("low")(n) && !any("high")(n));
const highToLow = (n: string) => n.includes(" high to low ") || (any("high")(n) && !any("low")(n));

/* ---------------- the rule table (STOP 3, approved 2026-10-16) ---------------- */

/** Rules per muscle, tried in order; the first that matches wins for that muscle. */
export const RULES: Readonly<Partial<Record<Muscle, Rule[]>>> = {
  chest: [
    { id: "chest-incline-press", when: all(has("incline"), PRESS), tags: [["chest_upper", "primary", "moderate"], ["chest_mid", "secondary", "moderate"]] },
    { id: "chest-reverse-grip-press", when: all(any("reverse", "underhand"), any("press", "bench")), tags: [["chest_upper", "primary", "weak"], ["chest_mid", "secondary", "weak"]] },
    { id: "chest-low-to-high-fly", when: all(lowToHigh, FLY), tags: [["chest_upper", "primary", "weak"], ["chest_mid", "secondary", "weak"]] },
    { id: "chest-incline-fly", when: all(has("incline"), any("fly", "crossover", "pec")), tags: [["chest_upper", "primary", "weak"], ["chest_mid", "secondary", "weak"]] },
    { id: "chest-decline-press", when: all(has("decline"), PRESS), tags: [["chest_lower", "primary", "moderate"], ["chest_mid", "secondary", "moderate"]] },
    { id: "chest-decline-fly", when: all(has("decline"), any("fly", "crossover", "pec")), tags: [["chest_lower", "primary", "weak"], ["chest_mid", "secondary", "weak"]] },
    { id: "chest-high-to-low-fly", when: all(highToLow, FLY), tags: [["chest_lower", "primary", "weak"], ["chest_mid", "secondary", "weak"]] },
    { id: "chest-dip", when: any("dip"), tags: [["chest_lower", "primary", "weak"], ["chest_mid", "secondary", "weak"]] },
    { id: "chest-flat-press", when: PRESS, tags: [["chest_mid", "primary", "strong"], ["chest_upper", "secondary", "moderate"], ["chest_lower", "secondary", "moderate"]] },
    { id: "chest-flat-fly", when: any("fly", "crossover", "pec", "deck", "butterfly", "squeeze"), tags: [["chest_mid", "primary", "moderate"], ["chest_upper", "secondary", "weak"], ["chest_lower", "secondary", "weak"]] },
    { id: "chest-pullover", when: any("pullover"), tags: [["chest_mid", "secondary", "weak"]] },
    { id: "chest-default", when: always, tags: [["chest_mid", "primary", "weak"]] },
  ],
  shoulders_front: [{ id: "front-delt", when: always, tags: [["shoulders_front", "primary", "strong"]] }],
  shoulders_side: [{ id: "side-delt", when: always, tags: [["shoulders_side", "primary", "strong"]] }],
  rear_delts: [{ id: "rear-delt", when: always, tags: [["rear_delts", "primary", "strong"]] }],
  back_lats: [
    { id: "lats-straight-arm", when: any("straight arm", "pullover"), tags: [["back_lats", "primary", "moderate"]] },
    { id: "lats-vertical-pull", when: (n, p) => p === "v_pull" || any("pulldown", "pullup", "chinup", "muscle up")(n), tags: [["back_lats", "primary", "strong"], ["back_upper", "secondary", "moderate"]] },
    { id: "row", when: (n, p) => p === "h_pull" || any("row")(n), tags: [["back_upper", "primary", "strong"], ["back_lats", "secondary", "moderate"]] },
    { id: "lats-default", when: always, tags: [["back_lats", "primary", "weak"]] },
  ],
  back_upper: [
    { id: "lats-vertical-pull", when: (n, p) => p === "v_pull" || any("pulldown", "pullup", "chinup")(n), tags: [["back_lats", "primary", "strong"], ["back_upper", "secondary", "moderate"]] },
    { id: "row", when: always, tags: [["back_upper", "primary", "strong"], ["back_lats", "secondary", "moderate"]] },
  ],
  traps: [{ id: "traps", when: always, tags: [["traps", "primary", "strong"]] }],
  // Presses, push-ups and dips tag the lateral and medial heads only, not the long head (Payam, 2026-10-16): by their
  // pattern first, then by name for those without one (the overhead and lying extensions keep their own rules).
  triceps: [
    { id: "triceps-press", when: (_n, p) => p === "h_push" || p === "v_push", tags: [["triceps_lateral_medial", "primary", "moderate"]] },
    { id: "triceps-overhead", when: all(any("overhead", "french", "behind"), any("extension", "press")), tags: [["triceps_long", "primary", "strong"], ["triceps_lateral_medial", "secondary", "moderate"]] },
    { id: "triceps-lying", when: any("skullcrusher", "lying", "jm", "tate"), tags: [["triceps_long", "primary", "weak"], ["triceps_lateral_medial", "secondary", "moderate"]] },
    { id: "triceps-press", when: any("press", "pushup", "bench", "dip"), tags: [["triceps_lateral_medial", "primary", "moderate"]] },
    { id: "triceps-pushdown", when: any("pushdown", "kickback", "extension"), tags: [["triceps_lateral_medial", "primary", "moderate"], ["triceps_long", "secondary", "moderate"]] },
    { id: "triceps-default", when: always, tags: [["triceps_lateral_medial", "primary", "weak"]] },
  ],
  biceps: [
    { id: "biceps-hammer", when: any("hammer", "reverse", "zottman", "pronated", "cross body", "crossbody"), tags: [["brachialis", "primary", "moderate"], ["biceps_long", "secondary", "weak"]] },
    { id: "biceps-incline", when: any("incline", "bayesian", "behind", "drag"), tags: [["biceps_long", "primary", "moderate"], ["biceps_short", "secondary", "moderate"]] },
    { id: "biceps-preacher", when: any("preacher", "spider", "concentration", "scott"), tags: [["biceps_short", "primary", "weak"], ["biceps_long", "secondary", "weak"]] },
    { id: "biceps-curl", when: any("curl"), tags: [["biceps_long", "primary", "moderate"], ["biceps_short", "primary", "moderate"], ["brachialis", "secondary", "moderate"]] },
    { id: "biceps-pull", when: (_n, p) => p === "v_pull" || p === "h_pull", tags: [["biceps_long", "secondary", "moderate"], ["biceps_short", "secondary", "moderate"]] },
    { id: "biceps-default", when: always, tags: [["biceps_long", "primary", "weak"], ["biceps_short", "primary", "weak"]] },
  ],
  forearms: [{ id: "forearms-brachialis", when: any("hammer", "reverse"), tags: [["brachialis", "primary", "moderate"]] }],
  quads: [
    { id: "quads-knee-ext", when: any("extension", "sissy", "nordic"), tags: [["quads_knee_ext", "primary", "strong"]] },
    { id: "quads-squat", when: (n, p) => p === "squat" || any("squat")(n), tags: [["quads_squat", "primary", "strong"], ["adductors", "secondary", "moderate"]] },
    { id: "quads-squat", when: always, tags: [["quads_squat", "primary", "strong"]] },
  ],
  hamstrings: [
    { id: "hams-curl", when: any("curl", "nordic", "glute ham", "ham raise"), tags: [["hamstrings_curl", "primary", "strong"]] },
    { id: "hams-hinge", when: always, tags: [["hamstrings_hinge", "primary", "strong"]] },
  ],
  glutes: [
    { id: "glutes-abduction", when: any("abduction", "abductor", "clam", "fire hydrant", "lateral walk"), tags: [["glutes_abd", "primary", "moderate"]] },
    { id: "glutes-ext", when: always, tags: [["glutes_ext", "primary", "strong"]] },
  ],
  abductors: [{ id: "abductors", when: always, tags: [["glutes_abd", "primary", "moderate"]] }],
  calves: [
    { id: "calves-bent-knee", when: any("seated", "bent knee"), tags: [["calves_soleus", "primary", "moderate"], ["calves_gastroc", "secondary", "moderate"]] },
    { id: "calves-straight-knee", when: always, tags: [["calves_gastroc", "primary", "moderate"], ["calves_soleus", "secondary", "moderate"]] },
  ],
  adductors: [{ id: "adductors", when: always, tags: [["adductors", "primary", "strong"]] }],
  lower_back: [{ id: "lower-back-hinge", when: always, tags: [["glutes_ext", "secondary", "moderate"], ["hamstrings_hinge", "secondary", "moderate"]] }],
  core: [
    { id: "core-anti-rotation", when: any("pallof", "side", "suitcase", "woodchop", "wood chop", "chop", "twist", "rotation", "oblique", "windmill", "landmine"), tags: [["core_anti_rot", "primary", "moderate"]] },
    { id: "core-anti-extension", when: any("plank", "rollout", "roll out", "dead bug", "hollow", "body saw", "ab wheel", "wheel", "bird dog", "stir"), tags: [["core_anti_ext", "primary", "moderate"]] },
    { id: "core-flexion", when: always, tags: [["core_flexion", "primary", "strong"]] },
  ],
};

/**
 * Secondary muscles tag only through meaningful synergies; the hamstrings only in a hinge (in a growth study squats did
 * not grow the hamstrings). Calves, core, lower back, forearms, neck and abductors never tag as secondary.
 */
export const SECONDARY_TAGGED: ReadonlySet<string> = new Set(["chest", "shoulders_front", "shoulders_side", "rear_delts", "back_lats", "back_upper", "traps", "triceps", "biceps", "glutes", "quads", "adductors", "hamstrings"]);

/** Primary muscles without regions in the approved list: their exercises carry no region (wrist curls, neck work). */
export const NO_REGION_MUSCLES: ReadonlySet<string> = new Set(["forearms", "neck"]);

/** Rules allowed to tag two primary regions of one muscle (reviewed: a plain curl trains both biceps heads). */
export const TWO_PRIMARY_RULES: ReadonlySet<string> = new Set(["biceps-curl", "biceps-default"]);

/** Reviewed exceptions for named exercises (seed/library/region-overrides.json): their tags replace the rules'. */
export type RegionOverrides = Record<string, { tags: { region: Region; emphasis: Emphasis; evidence: Evidence }[]; reason: string }>;

/**
 * The region tags of one exercise. Only exercises that count toward volume (strength, powerlifting, olympic
 * weightlifting) are tagged; stretching, cardio, plyometrics and strongman carry none (Payam, 2026-10-16).
 */
export function regionTags(ex: RegionInput & { id?: string }, overrides: RegionOverrides = {}): RegionTag[] {
  if (!countsVolume(ex.category)) return [];
  const o = ex.id ? overrides[ex.id] : undefined;
  if (o) return o.tags.map((t) => ({ ...t, note: "reviewed" }));
  const n = ruleText(ex.name_en);
  const out = new Map<Region, RegionTag>();
  const muscles = [ex.muscle_primary, ...ex.muscles_secondary.filter((m) => m !== ex.muscle_primary)];
  for (const m of muscles) {
    const primary = m === ex.muscle_primary;
    if (!primary && (!SECONDARY_TAGGED.has(m) || (m === "hamstrings" && ex.pattern !== "hinge"))) continue;
    const rule = RULES[m as Muscle]?.find((r) => r.when(n, ex.pattern));
    if (!rule) continue;
    for (const [region, emphasis, evidence] of rule.tags) {
      const e: Emphasis = primary ? emphasis : "secondary";
      const old = out.get(region);
      if (!old || (old.emphasis === "secondary" && e === "primary")) out.set(region, { region, emphasis: e, evidence, note: rule.id });
    }
  }
  return [...out.values()].sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region));
}

/** The regions of one muscle chip, in the order the chips show them. */
export function regionsOf(muscle: string): Region[] {
  return REGIONS.filter((r) => REGION_INFO[r].muscle === muscle);
}

// Exercise sources beyond free-exercise-db (SPEC-v11 M14 Phase A, approved by Payam 2026-10-16): wger, everkinetic,
// the ExerciseDB v1 dataset, Liftosaur and exercemus, each pinned to a commit. From the open-licence sources (wger,
// everkinetic) we keep the licence and author per row and, for images, only those whose own licence allows it; from
// the others we take exercise names and facts only (muscles, equipment), never descriptions, instructions or media.
// This module maps each source onto our keys and screens the records: automatic exclusions (category, equipment,
// language, missing facts), exact duplicates of the library, and the candidates left for review, with the closest
// existing exercise when there is one. Pure: no I/O.

import { countsVolume, type Category } from "./category";
import { isMuscle, type Muscle } from "./muscles";
import type { Equipment } from "./types";

export type SourceKey = "wger" | "everkinetic" | "exercisedb" | "liftosaur" | "exercemus";
/** Screening order: an exact duplicate is credited to the earlier source. */
export const SOURCE_ORDER: readonly SourceKey[] = ["wger", "everkinetic", "exercisedb", "liftosaur", "exercemus"];

export interface SourceInfo {
  key: SourceKey;
  label: string;
  /** GitHub repository and the commit the import is pinned to. */
  repo: string;
  sha: string;
  /** Files read from the repository, by role. */
  files: Record<string, string>;
  /** Exercise id prefix of the rows this source adds. */
  prefix: string;
  /** What the source's licence lets us keep. */
  licence: string;
  /** Only names and facts are taken (no licensed content is stored). */
  factsOnly: boolean;
  site: string;
}

export const SOURCES: Readonly<Record<SourceKey, SourceInfo>> = {
  wger: {
    key: "wger",
    label: "wger",
    repo: "wger-project/wger",
    sha: "8f72cb2feba9f5f1cc40aa9855b185ab315a3cd8",
    files: { base: "wger/exercises/fixtures/exercise-base-data.json", translations: "wger/exercises/fixtures/translations.json" },
    prefix: "wger-",
    licence: "Per record: CC-BY-SA 3.0, CC-BY-SA 4.0 or CC0",
    factsOnly: false,
    site: "https://wger.de",
  },
  everkinetic: {
    key: "everkinetic",
    label: "everkinetic",
    repo: "everkinetic/data",
    sha: "446bb9a3d0c3beb6b84f7c9d77dfc8af707a2ab6",
    files: { exercises: "dist/exercises.json" },
    prefix: "ek-",
    licence: "CC-BY-SA 4.0",
    factsOnly: false,
    site: "https://github.com/everkinetic/data",
  },
  exercisedb: {
    key: "exercisedb",
    label: "ExerciseDB",
    repo: "hasaneyldrm/exercises-dataset",
    sha: "7455efae41b330c265e7cd4b78dfa848e7ce5ebd",
    files: { exercises: "data/exercises.json" },
    prefix: "edb-",
    licence: "Names and facts only (media © Gym visual, not used)",
    factsOnly: true,
    site: "https://exercisedb.dev",
  },
  liftosaur: {
    key: "liftosaur",
    label: "Liftosaur",
    repo: "astashov/liftosaur",
    sha: "a7a402c28b89db9b022d717e86a27ec2bd88eaea",
    files: { exercises: "src/models/exercise.ts" },
    prefix: "lift-",
    licence: "Names and facts only (app code AGPL-3.0, not used)",
    factsOnly: true,
    site: "https://www.liftosaur.com",
  },
  exercemus: {
    key: "exercemus",
    label: "exercemus",
    repo: "exercemus/exercises",
    sha: "0ee5b742928b0c910883fa1c0c2cfaf26c4ee180",
    files: { exercises: "exercises.json" },
    prefix: "exm-",
    licence: "Names and facts only",
    factsOnly: true,
    site: "https://exercem.us",
  },
};

/** Exercise id of a source record (fits ID_RE: at most 64 of [0-9A-Za-z_-]). */
export const sourceExerciseId = (s: SourceKey, sid: string) => `${SOURCES[s].prefix}${sid.replace(/[^0-9A-Za-z_-]/g, "-")}`.slice(0, 64);

export const sourceFileUrl = (s: SourceKey, role: string) => `https://raw.githubusercontent.com/${SOURCES[s].repo}/${SOURCES[s].sha}/${SOURCES[s].files[role]}`;
export const sourceRawUrl = (s: SourceKey, path: string) => `https://raw.githubusercontent.com/${SOURCES[s].repo}/${SOURCES[s].sha}/${path}`;

/** Licence ids stored in exercises.license (migration 0013). */
export const LICENCES = ["Unlicense", "CC-BY-SA-3.0", "CC-BY-SA-4.0", "CC0-1.0", "CC-BY-4.0"] as const;
export type Licence = (typeof LICENCES)[number];
export const LICENCE_URL: Readonly<Record<Licence, string>> = {
  Unlicense: "https://unlicense.org/",
  "CC-BY-SA-3.0": "https://creativecommons.org/licenses/by-sa/3.0/",
  "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
};
/** wger's licence table (wger/core/fixtures/licenses.json); ODbL (5) has no exercise or image under it. */
export const WGER_LICENCE: Readonly<Record<number, Licence>> = { 1: "CC-BY-SA-3.0", 2: "CC-BY-SA-4.0", 3: "CC0-1.0", 4: "CC-BY-4.0" };

/** An image a row may store: the URL to copy it from, and its own licence and author. */
export interface SourceImage {
  url: string;
  license: Licence;
  author: string;
}

/** One source record, its facts mapped onto our keys (not reviewed yet). */
export interface SourceRecord {
  source: SourceKey;
  /** Stable id within the source. */
  sid: string;
  name: string;
  /** Mapped equipment; null when the source gives none we can map. */
  equipment: Equipment | null;
  /** The source's own equipment value(s), for the report. */
  equipmentFrom: string;
  /** Kettlebell, bands, balls, foam roller (excluded 2026-10-13, kept excluded 2026-10-16). */
  excludedEquipment: boolean;
  /** Mapped category, or the source's category we do not import (plyometrics, strongman). */
  category: Category;
  primary: Muscle | null;
  secondary: Muscle[];
  license: Licence | null;
  licenseAuthor: string | null;
  images: SourceImage[];
}

/* ---------------- names ---------------- */

const SYN: [RegExp, string][] = [
  [/\bdbs?\b/g, "dumbbell"],
  [/\bbb\b/g, "barbell"],
  [/\bkb\b/g, "kettlebell"],
  [/\be-?z[- ]?(curl )?bar\b/g, "ezbar"],
  [/\bsz[- ]?bar\b/g, "ezbar"],
  [/\bez barbell\b/g, "ezbar"],
  [/\bpush[- ]?ups?\b/g, "pushup"],
  [/\bpress[- ]?ups?\b/g, "pushup"],
  [/\bpull[- ]?ups?\b/g, "pullup"],
  [/\bchin[- ]?ups?\b/g, "chinup"],
  [/\bsit[- ]?ups?\b/g, "situp"],
  [/\bstep[- ]?ups?\b/g, "stepup"],
  [/\bdead[- ]?lifts?\b/g, "deadlift"],
  [/\b(flyes|flies|flys|flye)\b/g, "fly"],
  [/\brdl\b/g, "romanian deadlift"],
  [/\bohp\b/g, "overhead press"],
  [/\bt[- ]bar\b/g, "tbar"],
  [/\bv[- ]bar\b/g, "vbar"],
  [/\bjm press\b/g, "jmpress"],
  [/\bskull ?crushers?\b/g, "skullcrusher"],
  [/\blying triceps? extensions?\b/g, "skullcrusher"],
  [/\bpull[- ]?downs?\b/g, "pulldown"],
  [/\bpush[- ]?downs?\b/g, "pushdown"],
  [/\bcross[- ]?overs?\b/g, "crossover"],
  [/\bhyper[- ]?extensions?\b/g, "hyperextension"],
  [/\bgood[- ]?mornings?\b/g, "goodmorning"],
  [/\b45 ?°|\b45[- ]degrees?\b/g, "45"],
  [/°/g, ""],
  [/\b(one|single|1)[- ]arm(ed)?\b|\bunilateral\b/g, "onearm"],
  [/\b(one|single)[- ]leg(ged)?\b/g, "oneleg"],
  [/\balternat(e|ing)\b/g, "alternating"],
  [/\blever(age)?\b/g, "machine"],
  [/\bsmith machine\b/g, "smith"],
  [/\bplate[- ]loaded\b/g, "plateloaded"],
];
const STOP_WORDS = new Set(["with", "the", "a", "an", "on", "of", "to", "and", "exercise", "version", "variation", "using", "in", "for", "your", "from", "at"]);
const EQUIPMENT_WORDS = new Set(["barbell", "barbells", "dumbbell", "dumbbells", "cable", "cables", "machine", "machines", "bodyweight", "body", "only", "none", "weighted"]);
const SINGULAR: Record<string, string> = {
  squats: "squat",
  presses: "press",
  raises: "raise",
  curls: "curl",
  rows: "row",
  lunges: "lunge",
  dips: "dip",
  crunches: "crunch",
  extensions: "extension",
  kickbacks: "kickback",
  shrugs: "shrug",
  thrusts: "thrust",
  bridges: "bridge",
  twists: "twist",
  rollouts: "rollout",
  pullovers: "pullover",
  pulls: "pull",
  swings: "swing",
  cleans: "clean",
  snatches: "snatch",
  jerks: "jerk",
  walks: "walk",
  carries: "carry",
  planks: "plank",
  deadlifts: "deadlift",
  lifts: "lift",
  calves: "calf",
  legs: "leg",
  arms: "arm",
  hamstrings: "hamstring",
  glutes: "glute",
  abs: "ab",
  delts: "delt",
  lats: "lat",
  traps: "trap",
  steps: "step",
  jumps: "jump",
  hops: "hop",
  touches: "touch",
  circles: "circle",
  rotations: "rotation",
  holds: "hold",
  pushes: "push",
  grips: "grip",
  drags: "drag",
  climbers: "climber",
  wipers: "wiper",
  kicks: "kick",
  reaches: "reach",
  bends: "bend",
  stretches: "stretch",
};

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|’/g, "'")
    .replace(/&quot;/g, '"');

/** Name words after unifying spellings (DB/dumbbell, push-ups/pushup, flyes/fly …), singular, without filler words. */
export function nameTokens(name: string): string[] {
  let s = decodeEntities(name).toLowerCase();
  s = s.replace(/\(([^)]*)\)/g, " $1 ");
  for (const [re, rep] of SYN) s = s.replace(re, rep);
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  const out: string[] = [];
  for (const raw of s.split(/\s+/)) {
    if (!raw) continue;
    const t = SINGULAR[raw] ?? raw;
    if (!STOP_WORDS.has(t)) out.push(t);
  }
  return out;
}

/** The words that identify a movement: the name words without equipment words (the equipment is compared on its own). */
export function keyTokens(name: string): Set<string> {
  return new Set(nameTokens(name).filter((t) => !EQUIPMENT_WORDS.has(t)));
}

/** Exact-duplicate key: same movement words and same equipment. */
export function dedupeKey(name: string, equipment: Equipment): string {
  return `${equipment}|${[...keyTokens(name)].sort().join(" ")}`;
}

/** Similarity of two names' movement words (Jaccard), and whether one holds all but one word of the other. */
export function similarity(a: Set<string>, b: Set<string>): { score: number; near: boolean } {
  if (!a.size || !b.size) return { score: 0, near: false };
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  const union = a.size + b.size - both;
  const score = both / union;
  const subset = both === Math.min(a.size, b.size);
  return { score, near: score >= 0.75 || (subset && union - both <= 1) };
}

/* ---------------- shared mapping ---------------- */

const EXCLUDED_IN_NAME =
  /\b(stability ball|exercise ball|swiss ball|bosu|medicine ball|med ball|slam ball|wall ball|resistance band|mini band|bands?|banded|kettlebells?|kb|foam roll(er|ing)?|trx|suspension)\b/i;
const FOREIGN =
  /[áéíóúñüöäßçãõâêîôûàèìòù]|\b(jal[oó]n|estiramiento|extensi[oó]n de|sentadilla|remo|prensa|curl de|press de|polea|alta|baja|zancadas?|flexiones|abdominales|piernas|brazos|hombros|pecho|espalda|elevaci[oó]n(es)?|aperturas|fondos|dominadas|peso muerto|übung|kniebeuge|liegestütz|bankdrücken|seitheben|rudern|klimmzug|beinpresse|bauch|rücken|schulter|brust|isometria|trazion[ei]|impugnatura|arco|femorale|una gamba|panca|manubri|bilanciere|spinte|piegamenti|addominali)\b/i;
const STRETCH = /\bstretch(es|ing)?\b/i;
const PLYO = /\b(jumps?|jumping|hops?|hopping|bounds?|bounding|plyo|plyometric|depth jump|skips?|skipping|leaps?)\b/i;
const CARDIO = /\b(run|running|jog|jogging|sprint|bike|biking|cycling|cycle|elliptical|rowing machine|rower|ergometer|skierg|stair ?master|stairs?|stepmill|treadmill|swim|swimming|jump rope|skipping rope|rope skip|burpees?|jumping jacks?|mountain climbers?)\b/i;
const STRONGMAN = /\b(tire|tyre|sledgehammer|atlas stone|log press|yoke|sandbag|keg|axle)\b/i;

/** Category from the name when the source has none: stretching, then plyometrics (not imported), cardio, else strength. */
function categoryFromName(name: string): Category {
  if (STRETCH.test(name)) return "stretching";
  if (CARDIO.test(name) && !/\bclimbers?\b/i.test(name)) return "cardio";
  if (PLYO.test(name) && !/\bjump rope\b/i.test(name)) return "plyometrics";
  if (STRONGMAN.test(name)) return "strongman";
  return "strength";
}

const REAR_DELT = /\b(rear|reverse fly|reverse flye|face pull|back fly|back flye|bent[- ]over (low-pulley )?(side )?lateral|posterior)/i;
const SIDE_DELT = /\b(lateral raise|side raise|upright|deltoid raise|y[- ]raise|lateral)/i;
/** Which deltoid a source's generic "shoulders" means, as for free-exercise-db (worker/lib/muscles.ts). */
function deltoid(name: string, role: "primary" | "secondary", pull: boolean): Muscle {
  if (role === "secondary") return pull ? "rear_delts" : "shoulders_front";
  if (REAR_DELT.test(name)) return "rear_delts";
  if (SIDE_DELT.test(name)) return "shoulders_side";
  return "shoulders_front";
}
const PULLING = /\b(row|pull|pulldown|chin|fly|flye|raise|shrug|face)\b/i;

function muscles(name: string, primary: (Muscle | "DELT" | null)[], secondary: (Muscle | "DELT" | null)[]) {
  const pull = PULLING.test(name);
  const p = primary.map((m) => (m === "DELT" ? deltoid(name, "primary", pull) : m)).filter((m): m is Muscle => m !== null);
  const first = p[0] ?? null;
  const rest: Muscle[] = [];
  for (const m of [...p.slice(1), ...secondary.map((s) => (s === "DELT" ? deltoid(name, "secondary", pull) : s))]) {
    if (m && m !== first && !rest.includes(m)) rest.push(m);
  }
  return { primary: first, secondary: rest };
}

/** Equipment named in an exercise's name, when the source gives none. */
export function equipmentFromName(name: string): Equipment | null {
  const n = name.toLowerCase();
  if (/\b(smith|machine|lever(age)?|leg press|hack squat|pec deck|leg extension|leg curl|seated calf|belt squat|chest press|assisted|pendulum)\b/.test(n)) return "machine";
  if (/\b(cable|pulley|pulldown|pull-down|pushdown|push-down|crossover|face pull)\b/.test(n)) return "cable";
  if (/\b(barbell|e-?z[- ]?bar|sz[- ]?bar|trap bar|landmine|t-bar)\b/.test(n)) return "barbell";
  if (/\b(dumbbells?|db)\b/.test(n)) return "dumbbell";
  return null;
}

/* ---------------- wger ---------------- */

interface Fixture<T> {
  model: string;
  pk: number;
  fields: T;
}
interface WgerBase {
  license: number;
  license_author: string;
  category: number;
  muscles: number[];
  muscles_secondary: number[];
  equipment: number[];
}
interface WgerTranslation {
  exercise: number;
  language: number;
  name: string;
  license: number;
  license_author: string;
}
/** wger's English language id (wger/core/fixtures/languages.json). */
export const WGER_ENGLISH = 2;
const WGER_MUSCLE: Record<number, Muscle | "DELT" | null> = {
  1: "biceps",
  2: "DELT",
  3: null, // serratus anterior: no key
  4: "chest",
  5: "triceps",
  6: "core",
  7: "calves",
  8: "glutes",
  9: "traps",
  10: "quads",
  11: "hamstrings",
  12: "back_lats",
  13: "biceps",
  14: "core",
  15: "calves",
  16: "lower_back",
};
const WGER_EQUIPMENT: Record<number, Equipment | "excluded" | null> = {
  1: "barbell",
  2: "barbell",
  3: "dumbbell",
  4: "bodyweight",
  5: "excluded",
  6: "bodyweight",
  7: "bodyweight",
  8: null,
  9: null,
  10: "excluded",
  11: "excluded",
  12: "cable",
};
const WGER_EQUIPMENT_NAME: Record<number, string> = {
  1: "Barbell",
  2: "SZ-Bar",
  3: "Dumbbell",
  4: "Gym mat",
  5: "Swiss Ball",
  6: "Pull-up bar",
  7: "none",
  8: "Bench",
  9: "Incline bench",
  10: "Kettlebell",
  11: "Resistance band",
  12: "Cable machine",
};
/** wger's image list (api/v2/exerciseimage), as snapshotted with the decisions. */
export interface WgerImage {
  exercise: number;
  image: string;
  is_main: boolean;
  license: number;
  license_author: string;
  is_ai_generated: boolean;
}

/**
 * wger records: the English name (exercises without one are skipped), the record's own licence and author, and its
 * images whose own licence allows storing them. AI-generated images are left out (they may show the wrong form).
 */
export function readWger(base: Fixture<WgerBase>[], items: Fixture<WgerTranslation>[], images: WgerImage[] = []): SourceRecord[] {
  const english = new Map<number, WgerTranslation>();
  for (const t of items) if (t.model === "exercises.translation" && t.fields.language === WGER_ENGLISH && !english.has(t.fields.exercise)) english.set(t.fields.exercise, t.fields);
  const out: SourceRecord[] = [];
  for (const b of base) {
    if (b.model !== "exercises.exercise") continue;
    const t = english.get(b.pk);
    if (!t) continue;
    const name = decodeEntities(t.name).trim();
    const eqs = b.fields.equipment.map((e) => WGER_EQUIPMENT[e] ?? null);
    const named = equipmentFromName(name);
    let equipment: Equipment | null;
    if (named === "machine") equipment = "machine";
    else equipment = eqs.find((e): e is Equipment => e !== null && e !== "excluded") ?? named ?? (b.fields.equipment.length === 0 || b.fields.equipment.includes(7) ? "bodyweight" : null);
    const m = muscles(
      name,
      b.fields.muscles.map((x) => WGER_MUSCLE[x] ?? null),
      b.fields.muscles_secondary.map((x) => WGER_MUSCLE[x] ?? null)
    );
    const license = WGER_LICENCE[b.fields.license] ?? null;
    out.push({
      source: "wger",
      sid: String(b.pk),
      name,
      equipment,
      equipmentFrom: b.fields.equipment.map((e) => WGER_EQUIPMENT_NAME[e] ?? String(e)).join(", ") || "none given",
      excludedEquipment: eqs.includes("excluded") || EXCLUDED_IN_NAME.test(name),
      category: b.fields.category === 15 ? (STRETCH.test(name) ? "stretching" : "cardio") : categoryFromName(name),
      primary: m.primary,
      secondary: m.secondary,
      license,
      licenseAuthor: b.fields.license_author?.trim() || t.license_author?.trim() || "wger.de",
      images: images
        .filter((i) => i.exercise === b.pk && !i.is_ai_generated && WGER_LICENCE[i.license])
        .sort((x, y) => Number(y.is_main) - Number(x.is_main) || x.image.localeCompare(y.image))
        .map((i) => ({ url: i.image, license: WGER_LICENCE[i.license], author: i.license_author?.trim() || "wger.de" })),
    });
  }
  return out;
}

/* ---------------- everkinetic ---------------- */

interface EverkineticExercise {
  id: string;
  title: string;
  type: string;
  primary: string[];
  secondary: string[];
  equipment: string[];
  png: string[];
}
const EK_MUSCLE: Record<string, Muscle | "DELT"> = {
  "biceps brachii": "biceps",
  bicpes: "biceps",
  "triceps brachii": "triceps",
  "pectoralis major": "chest",
  quadriceps: "quads",
  deltoid: "DELT",
  should: "DELT",
  abdominals: "core",
  "latissimus dorsi": "back_lats",
  gastrocnemius: "calves",
  soleus: "calves",
  "ischiocrural muscles": "hamstrings",
  "erector spinae": "lower_back",
  trapezius: "traps",
  "glutaeus maximus": "glutes",
  obliques: "core",
  forearm: "forearms",
  forerm: "forearms",
  core: "core",
  "hip abductors": "abductors",
  "upper back": "back_upper",
  back: "back_upper",
  "deltoideus (clavicula)": "shoulders_front",
};

export function readEverkinetic(list: EverkineticExercise[]): SourceRecord[] {
  return list.map((e) => {
    const name = e.title.trim();
    let equipment: Equipment | null = null;
    let excluded = false;
    for (const raw of e.equipment) {
      const x = raw.toLowerCase();
      if (/band|ball|bosu/.test(x)) excluded = true;
      else if (/smith|machine/.test(x)) equipment = "machine";
      else if (/cable|v-bar/.test(x)) equipment = equipment ?? "cable";
      else if (/^(barbell|wide bar|weight plate)$/.test(x) || (x === "bar" && !/pull/i.test(name))) equipment = equipment ?? "barbell";
      else if (/^(dumbbells?|weight)$/.test(x)) equipment = equipment ?? "dumbbell";
      else if (/^(body|pull-up bar|parallel bars|towel)$/.test(x) || x === "bar") equipment = equipment ?? "bodyweight";
    }
    equipment = equipment ?? equipmentFromName(name) ?? "bodyweight";
    const m = muscles(
      name,
      e.primary.map((p) => EK_MUSCLE[p.toLowerCase()] ?? null),
      e.secondary.map((p) => EK_MUSCLE[p.toLowerCase()] ?? null)
    );
    return {
      source: "everkinetic" as const,
      sid: e.id,
      name,
      equipment,
      equipmentFrom: e.equipment.join(", ") || "none given",
      excludedEquipment: excluded || EXCLUDED_IN_NAME.test(name),
      category: categoryFromName(name),
      primary: m.primary,
      secondary: m.secondary,
      license: "CC-BY-SA-4.0" as const,
      licenseAuthor: "everkinetic",
      images: e.png.map((p) => ({ url: sourceRawUrl("everkinetic", `dist/${p}`), license: "CC-BY-SA-4.0" as const, author: "everkinetic" })),
    };
  });
}

/* ---------------- ExerciseDB (v1 dataset) ---------------- */

interface ExerciseDbExercise {
  id: string;
  name: string;
  equipment: string;
  target: string;
  secondary_muscles: string[];
}
const EDB_TARGET: Record<string, Muscle | "DELT" | null> = {
  abs: "core",
  pectorals: "chest",
  biceps: "biceps",
  glutes: "glutes",
  delts: "DELT",
  triceps: "triceps",
  "upper back": "back_upper",
  lats: "back_lats",
  calves: "calves",
  quads: "quads",
  forearms: "forearms",
  "cardiovascular system": null,
  hamstrings: "hamstrings",
  spine: "lower_back",
  traps: "traps",
  adductors: "adductors",
  "serratus anterior": null,
  abductors: "abductors",
  "levator scapulae": "traps",
};
const EDB_SECONDARY: Record<string, Muscle | "DELT" | null> = {
  shoulders: "DELT",
  deltoids: "DELT",
  hamstrings: "hamstrings",
  forearms: "forearms",
  triceps: "triceps",
  biceps: "biceps",
  quadriceps: "quads",
  calves: "calves",
  glutes: "glutes",
  core: "core",
  chest: "chest",
  "upper chest": "chest",
  "hip flexors": "core",
  obliques: "core",
  abdominals: "core",
  "lower abs": "core",
  "lower back": "lower_back",
  rhomboids: "back_upper",
  "upper back": "back_upper",
  back: "back_upper",
  trapezius: "traps",
  traps: "traps",
  "rear deltoids": "rear_delts",
  "rotator cuff": "rear_delts",
  brachialis: "biceps",
  "latissimus dorsi": "back_lats",
  lats: "back_lats",
  soleus: "calves",
  "inner thighs": "adductors",
  groin: "adductors",
  sternocleidomastoid: "neck",
  "wrist flexors": "forearms",
  "wrist extensors": "forearms",
  "grip muscles": "forearms",
  wrists: "forearms",
  hands: "forearms",
  ankles: null,
  "ankle stabilizers": null,
  feet: null,
  shins: null,
};
const EDB_EQUIPMENT: Record<string, Equipment | "excluded"> = {
  "body weight": "bodyweight",
  dumbbell: "dumbbell",
  cable: "cable",
  barbell: "barbell",
  "leverage machine": "machine",
  "smith machine": "machine",
  "sled machine": "machine",
  assisted: "machine",
  "ez barbell": "barbell",
  "olympic barbell": "barbell",
  "trap bar": "barbell",
  weighted: "bodyweight",
  "wheel roller": "bodyweight",
  rope: "bodyweight",
  "stationary bike": "machine",
  "elliptical machine": "machine",
  "stepmill machine": "machine",
  "skierg machine": "machine",
  "upper body ergometer": "machine",
  band: "excluded",
  "resistance band": "excluded",
  kettlebell: "excluded",
  "stability ball": "excluded",
  "medicine ball": "excluded",
  "bosu ball": "excluded",
  roller: "excluded",
  hammer: "excluded",
  tire: "excluded",
};

/** ExerciseDB names are lower case: shown in Title Case (the review may still fix a name). */
export const titleCase = (s: string) => s.replace(/\b([a-z])([a-z]*)/g, (_, a: string, b: string) => a.toUpperCase() + b);

export function readExerciseDb(list: ExerciseDbExercise[]): SourceRecord[] {
  return list.map((e) => {
    const name = titleCase(e.name.trim());
    const target = EDB_TARGET[e.target];
    const m = muscles(name, [target ?? null], e.secondary_muscles.map((s) => EDB_SECONDARY[s] ?? null));
    const eq = EDB_EQUIPMENT[e.equipment];
    // A cardio exercise has no target muscle in ExerciseDB: its first secondary muscle stands in (cardio counts 0 sets).
    const cardio = e.target === "cardiovascular system";
    const primary = m.primary ?? (cardio ? (m.secondary[0] ?? "quads") : null);
    return {
      source: "exercisedb" as const,
      sid: e.id,
      name,
      equipment: eq === "excluded" || eq === undefined ? null : eq,
      equipmentFrom: e.equipment,
      excludedEquipment: eq === "excluded" || EXCLUDED_IN_NAME.test(name),
      category: cardio ? (STRETCH.test(name) ? "stretching" : "cardio") : categoryFromName(name),
      primary,
      secondary: m.secondary.filter((x) => x !== primary),
      license: null,
      licenseAuthor: null,
      images: [],
    };
  });
}

/* ---------------- Liftosaur ---------------- */

const LIFT_MUSCLE: Record<string, Muscle | null> = {
  "Gluteus Maximus": "glutes",
  "Latissimus Dorsi": "back_lats",
  Quadriceps: "quads",
  "Deltoid Anterior": "shoulders_front",
  "Trapezius Lower Fibers": "back_upper",
  "Trapezius Middle Fibers": "back_upper",
  "Trapezius Upper Fibers": "traps",
  "Pectoralis Major Sternal Head": "chest",
  "Pectoralis Major Clavicular Head": "chest",
  "Pectoralis Minor": "chest",
  "Rectus Abdominis": "core",
  "Deltoid Posterior": "rear_delts",
  Hamstrings: "hamstrings",
  "Biceps Femoris": "hamstrings",
  "Deltoid Lateral": "shoulders_side",
  Deltoid: "shoulders_front",
  "Triceps Brachii": "triceps",
  Obliques: "core",
  "Erector Spinae": "lower_back",
  "Quadratus Lumborum": "lower_back",
  Iliopsoas: "core",
  Gastrocnemius: "calves",
  Soleus: "calves",
  "Biceps Brachii": "biceps",
  Brachialis: "biceps",
  Brachioradialis: "forearms",
  "Wrist Flexors": "forearms",
  "Wrist Extensors": "forearms",
  Supinator: "forearms",
  "Pronator Teres": "forearms",
  Infraspinatus: "rear_delts",
  "Teres Minor": "rear_delts",
  "Teres Major": "back_lats",
  Rhomboids: "back_upper",
  "Gluteus Medius": "abductors",
  "Gluteus Minimus": "abductors",
  "Tensor Fasciae Latae": "abductors",
  "Adductor Magnus": "adductors",
  "Adductor Brevis": "adductors",
  "Adductor Longus": "adductors",
  Pectineous: "adductors",
  Gracilis: "adductors",
  "Levator Scapulae": "traps",
  Splenius: "neck",
  Sternocleidomastoid: "neck",
  "Tibialis Anterior": null,
  "Serratus Anterior": null,
  Sartorius: null,
  Popliteus: null,
  Coracobrachialis: null,
  Subscapularis: null,
};
const LIFT_EQUIPMENT: Record<string, [Equipment | "excluded", string]> = {
  bodyweight: ["bodyweight", ""],
  barbell: ["barbell", "Barbell"],
  dumbbell: ["dumbbell", "Dumbbell"],
  cable: ["cable", "Cable"],
  leverageMachine: ["machine", "Machine"],
  smith: ["machine", "Smith Machine"],
  ezbar: ["barbell", "EZ-Bar"],
  trapbar: ["barbell", "Trap Bar"],
  band: ["excluded", "Band"],
  kettlebell: ["excluded", "Kettlebell"],
  medicineball: ["excluded", "Medicine Ball"],
};

/** One Liftosaur exercise × equipment, as parsed from src/models/exercise.ts. */
export interface LiftosaurExercise {
  id: string;
  name: string;
  defaultEquipment: string | null;
  target: string[];
  synergist: string[];
  equipment: string[];
}

/** Parses the two object literals of Liftosaur's src/models/exercise.ts (exercise list and muscle metadata). */
export function parseLiftosaur(src: string): LiftosaurExercise[] {
  const a = src.indexOf("export const allExercisesList");
  const m = src.indexOf("export const metadata");
  const end = src.indexOf("export type IExerciseKind");
  if (a < 0 || m < 0 || end < 0) throw new Error("Liftosaur exercise.ts: unexpected layout");
  const blocks = (text: string) => [...text.matchAll(/\n {2}(\w+): \{\n([\s\S]*?)\n {2}\},/g)].map((x) => [x[1], x[2]] as const);
  const arr = (b: string, k: string) => {
    const x = new RegExp(`${k}: \\[([\\s\\S]*?)\\]`).exec(b);
    return x ? [...x[1].matchAll(/"([^"]+)"/g)].map((y) => y[1]) : [];
  };
  const meta = new Map(blocks(src.slice(m, end)).map(([id, b]) => [id, { target: arr(b, "targetMuscles"), synergist: arr(b, "synergistMuscles"), equipment: arr(b, "sortedEquipment") }]));
  return blocks(src.slice(a, m)).map(([id, b]) => {
    const md = meta.get(id) ?? { target: [], synergist: [], equipment: [] };
    return { id, name: /name: "([^"]+)"/.exec(b)?.[1] ?? id, defaultEquipment: /defaultEquipment: "([^"]+)"/.exec(b)?.[1] ?? null, ...md };
  });
}

export function readLiftosaur(list: LiftosaurExercise[]): SourceRecord[] {
  const out: SourceRecord[] = [];
  for (const x of list) {
    const p = x.target.map((t) => LIFT_MUSCLE[t] ?? null).filter((t): t is Muscle => t !== null);
    const s = x.synergist.map((t) => LIFT_MUSCLE[t] ?? null).filter((t): t is Muscle => t !== null);
    const primary = p[0] ?? null;
    const secondary = [...new Set([...p.slice(1), ...s])].filter((t) => t !== primary);
    for (const e of x.equipment.length ? x.equipment : x.defaultEquipment ? [x.defaultEquipment] : []) {
      const [eq, word] = LIFT_EQUIPMENT[e] ?? [null, e];
      const name = !word || x.name.toLowerCase().includes(word.toLowerCase()) ? x.name : `${word} ${x.name}`;
      out.push({
        source: "liftosaur",
        sid: `${x.id}:${e}`,
        name,
        equipment: eq === "excluded" ? null : eq,
        equipmentFrom: e,
        excludedEquipment: eq === "excluded" || EXCLUDED_IN_NAME.test(name),
        category: categoryFromName(name),
        primary,
        secondary,
        license: null,
        licenseAuthor: null,
        images: [],
      });
    }
  }
  return out;
}

/* ---------------- exercemus ---------------- */

interface ExercemusExercise {
  name: string;
  category: string;
  equipment: string[];
  primary_muscles: string[];
  secondary_muscles: string[];
}
const EXM_MUSCLE: Record<string, Muscle | "DELT" | null> = {
  forearms: "forearms",
  abductors: "abductors",
  adductors: "adductors",
  "middle back": "back_upper",
  neck: "neck",
  biceps: "biceps",
  shoulders: "DELT",
  "serratus anterior": null,
  chest: "chest",
  triceps: "triceps",
  abs: "core",
  calves: "calves",
  glutes: "glutes",
  traps: "traps",
  quads: "quads",
  hamstrings: "hamstrings",
  lats: "back_lats",
  brachialis: "biceps",
  obliques: "core",
  soleus: "calves",
  "lower back": "lower_back",
};
const EXM_EQUIPMENT: Record<string, Equipment | "excluded" | null> = {
  none: "bodyweight",
  "ez curl bar": "barbell",
  barbell: "barbell",
  dumbbell: "dumbbell",
  "gym mat": "bodyweight",
  "pull-up bar": "bodyweight",
  machine: "machine",
  cable: "cable",
  bench: null,
  "incline bench": null,
  other: null,
  "exercise ball": "excluded",
  "medicine ball": "excluded",
  kettlebell: "excluded",
  bands: "excluded",
  "foam roll": "excluded",
};
const EXM_CATEGORY: Record<string, Category> = {
  strength: "strength",
  calisthenics: "strength",
  stretching: "stretching",
  cardio: "cardio",
  plyometrics: "plyometrics",
  strongman: "strongman",
  "olympic weightlifting": "olympic_weightlifting",
  crossfit: "strength",
};
/** exercemus has no ids: a slug of the name stands in (names are unique there). */
export const exercemusSid = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function readExercemus(data: { exercises: ExercemusExercise[] }): SourceRecord[] {
  return data.exercises.map((e) => {
    const name = e.name.trim();
    const eqs = e.equipment.map((x) => EXM_EQUIPMENT[x] ?? null);
    const m = muscles(
      name,
      e.primary_muscles.map((x) => EXM_MUSCLE[x] ?? null),
      e.secondary_muscles.map((x) => EXM_MUSCLE[x] ?? null)
    );
    return {
      source: "exercemus" as const,
      sid: exercemusSid(name),
      name,
      equipment: eqs.find((x): x is Equipment => x !== null && x !== "excluded") ?? equipmentFromName(name) ?? (e.equipment.length === 0 ? "bodyweight" : null),
      equipmentFrom: e.equipment.join(", ") || "none given",
      excludedEquipment: eqs.includes("excluded") || EXCLUDED_IN_NAME.test(name),
      category: EXM_CATEGORY[e.category] ?? categoryFromName(name),
      primary: m.primary,
      secondary: m.secondary,
      license: null,
      licenseAuthor: null,
      images: [],
    };
  });
}

/* ---------------- screening ---------------- */

/** Categories imported from the new sources (Payam, 2026-10-16): stretching and cardio too, not plyometrics or strongman. */
export const IMPORTED_CATEGORIES: ReadonlySet<Category> = new Set<Category>(["strength", "powerlifting", "olympic_weightlifting", "stretching", "cardio"]);

export type ScreenKind = "category" | "equipment" | "language" | "no_muscle" | "no_equipment" | "duplicate" | "candidate";
export interface Match {
  id: string;
  name: string;
  score: number;
}
export interface Screened {
  source: SourceKey;
  sid: string;
  name: string;
  kind: ScreenKind;
  /** Why it was not imported automatically (category, equipment …). */
  detail?: string;
  /** Exact duplicate: the exercise it repeats. Candidate: the closest library or earlier-source exercise, if any. */
  match?: Match;
}

/** An exercise already in the library (or a seeded one), for duplicate checks. */
export interface LibraryName {
  id: string;
  name_en: string;
  equipment: Equipment;
}

export const recordKey = (r: { source: SourceKey; sid: string }) => `${r.source}:${r.sid}`;

/**
 * Screens every record in SOURCE_ORDER, then by source id: category, excluded equipment, language, missing muscle or
 * equipment, then exact duplicates of the library or of an earlier record (same movement words and equipment), and
 * the candidates left, each with its closest match (same equipment, similar words) for the duplicate review.
 */
export function screenSources(records: SourceRecord[], library: LibraryName[]): Screened[] {
  const exact = new Map<string, Match>();
  const byEquipment = new Map<Equipment, { tokens: Set<string>; id: string; name: string }[]>();
  const index = (equipment: Equipment, id: string, name: string) => {
    exact.set(dedupeKey(name, equipment), { id, name, score: 1 });
    const list = byEquipment.get(equipment) ?? [];
    list.push({ tokens: keyTokens(name), id, name });
    byEquipment.set(equipment, list);
  };
  for (const l of library) {
    const k = dedupeKey(l.name_en, l.equipment);
    if (!exact.has(k)) index(l.equipment, l.id, l.name_en);
    else byEquipment.get(l.equipment)!.push({ tokens: keyTokens(l.name_en), id: l.id, name: l.name_en });
  }
  const ordered = [...records].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.sid.localeCompare(b.sid, "en", { numeric: true }));
  const out: Screened[] = [];
  for (const r of ordered) {
    const base = { source: r.source, sid: r.sid, name: r.name };
    if (!IMPORTED_CATEGORIES.has(r.category)) out.push({ ...base, kind: "category", detail: r.category });
    else if (r.excludedEquipment) out.push({ ...base, kind: "equipment", detail: r.equipmentFrom });
    else if (FOREIGN.test(r.name)) out.push({ ...base, kind: "language" });
    // Stretching and cardio count no sets: when the source names no muscle, the review names the main one.
    else if ((!r.primary || !isMuscle(r.primary)) && countsVolume(r.category)) out.push({ ...base, kind: "no_muscle" });
    else if (!r.equipment) out.push({ ...base, kind: "no_equipment", detail: r.equipmentFrom });
    else {
      const dup = exact.get(dedupeKey(r.name, r.equipment));
      if (dup) {
        out.push({ ...base, kind: "duplicate", match: dup });
        continue;
      }
      const tokens = keyTokens(r.name);
      let best: Match | undefined;
      for (const c of byEquipment.get(r.equipment) ?? []) {
        const s = similarity(tokens, c.tokens);
        if (s.near && (!best || s.score > best.score)) best = { id: c.id, name: c.name, score: Math.round(s.score * 100) / 100 };
      }
      out.push({ ...base, kind: "candidate", ...(best ? { match: best } : {}) });
      index(r.equipment, sourceExerciseId(r.source, r.sid), r.name);
    }
  }
  return out;
}

/* ---------------- pattern and mechanic suggestions ---------------- */

/** A first guess at the movement pattern from the name, for the review (never stored without review). */
export function suggestPattern(name: string, primary: Muscle | null): string | null {
  const n = nameTokens(name).join(" ");
  const w = (...xs: string[]) => xs.some((x) => new RegExp(`\\b${x}\\b`).test(n));
  if (w("carry", "farmer", "suitcase", "yoke")) return "carry";
  if (w("deadlift", "romanian", "goodmorning", "hip thrust", "thrust", "bridge", "hyperextension", "back extension", "pull through", "swing", "rack pull", "clean", "snatch") && !w("curl", "row")) return "hinge";
  if (w("lunge", "split squat", "stepup", "bulgarian", "pistol")) return "lunge";
  if (w("squat", "leg press", "hack", "belt squat", "pendulum") && !w("calf")) return "squat";
  if (w("pulldown", "pullup", "chinup", "muscle up")) return "v_pull";
  if (w("row") && !w("upright")) return "h_pull";
  if (w("overhead press", "shoulder press", "military", "push press", "arnold", "landmine press", "handstand", "z press", "jerk") || (w("press") && (primary === "shoulders_front" || primary === "shoulders_side"))) return "v_push";
  if (w("bench", "pushup", "chest press", "floor press", "dip") || (w("press") && (primary === "chest" || primary === "triceps"))) return "h_push";
  if (primary === "core") return "core";
  if (w("curl", "extension", "raise", "fly", "kickback", "shrug", "pushdown", "crossover", "pullover", "abduction", "adduction", "pec deck", "face pull", "upright", "skullcrusher", "calf")) return "isolation";
  return null;
}

export const COMPOUND_PATTERNS: ReadonlySet<string> = new Set(["squat", "hinge", "lunge", "h_push", "v_push", "h_pull", "v_pull", "carry"]);

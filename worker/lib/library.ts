// Exercise library (SPEC-v2 M7): turns the free-exercise-db dataset, the reviewed pattern file, the seed matches
// and the hand-written gap fill into exercise rows, the SQL that upserts them, and the import report.
// Pure: no I/O. The import script (seed/import-exercises.ts) does the fetching and writing.

import { countsVolume, fedbCategory, isCategory, type Category } from "./category";
import { fedbMuscles, isLowerBody, isMuscle, type Muscle } from "./muscles";
import type { Equipment } from "./types";

/** free-exercise-db commit the import is pinned to (github.com/yuhonas/free-exercise-db, Unlicense). */
export const FEDB_SHA = "f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5";
export const FEDB_RAW = `https://raw.githubusercontent.com/yuhonas/free-exercise-db/${FEDB_SHA}`;
/** R2 prefix of everything the import stores (snapshot, manifest, images). */
export const FEDB_PREFIX = "library/free-exercise-db/";
export const fedbImageKey = (path: string) => `${FEDB_PREFIX}images/${path}`;
/** Exercise id of an imported free-exercise-db entry (fits ID_RE: at most 64 of [0-9A-Za-z_-]). */
export const fedbExerciseId = (fedbId: string) => `fedb-${fedbId}`;

export const PATTERNS = ["squat", "hinge", "lunge", "h_push", "v_push", "h_pull", "v_pull", "isolation", "core", "carry"] as const;
export type Pattern = (typeof PATTERNS)[number];
export type Mechanic = "compound" | "isolation";
export type Level = "beginner" | "intermediate" | "expert";
export const EQUIPMENT: readonly Equipment[] = ["barbell", "dumbbell", "cable", "machine", "bodyweight"];

export interface FedbExercise {
  id: string;
  name: string;
  force: string | null;
  level: string | null;
  mechanic: string | null;
  equipment: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  instructions: string[];
  category: string | null;
  images: string[];
}

/**
 * The exercises table allows five equipment values (SQL CHECK in 0001), and it is never rebuilt. Decisions
 * 2026-10-13: map honestly onto the five values; "other" and missing equipment are mapped one by one in the reviewed
 * file seed/library/fedb-equipment.json; only the equipment types below are excluded.
 */
export const FEDB_EQUIPMENT: Readonly<Record<string, Equipment>> = {
  barbell: "barbell",
  "e-z curl bar": "barbell",
  dumbbell: "dumbbell",
  cable: "cable",
  machine: "machine",
  "body only": "bodyweight",
};
export const FEDB_EXCLUDED_EQUIPMENT: readonly string[] = ["kettlebells", "bands", "medicine ball", "exercise ball", "foam roll"];

/**
 * seed/library/fedb-equipment.json: reviewed mapping of every "other" and every missing-equipment entry, plus the
 * entries Payam excluded on review (dataset id → reason), whatever their equipment.
 */
export interface EquipmentReview {
  other: Record<string, Equipment>;
  missing: Record<string, Equipment>;
  excluded: Record<string, string>;
}

/** Equipment of a dataset entry, or null when its equipment type is excluded. Throws for an unreviewed entry. */
export function resolveEquipment(x: Pick<FedbExercise, "id" | "equipment">, review: EquipmentReview): Equipment | null {
  if (x.equipment === null) {
    const e = review.missing[x.id];
    if (!e) throw new Error(`${x.id}: no equipment in the dataset and none in fedb-equipment.json`);
    return e;
  }
  if (x.equipment === "other") {
    const e = review.other[x.id];
    if (!e) throw new Error(`${x.id}: equipment "other" is not reviewed in fedb-equipment.json`);
    return e;
  }
  if (FEDB_EXCLUDED_EQUIPMENT.includes(x.equipment)) return null;
  const e = FEDB_EQUIPMENT[x.equipment];
  if (!e) throw new Error(`${x.id}: unknown equipment "${x.equipment}"`);
  return e;
}

export interface Media {
  kind: "image" | "gif";
  r2_key?: string;
  url?: string;
}

/** One row of the exercises table as the library writes it. */
export interface LibraryRow {
  id: string;
  name_en: string;
  muscle_primary: Muscle;
  is_lower: boolean;
  equipment: Equipment;
  source: "fedb" | "manual";
  source_id: string;
  muscles_secondary: Muscle[];
  pattern: Pattern | null;
  mechanic: Mechanic | null;
  level: Level | null;
  media: Media[];
  instructions_en: string[];
  category: Category;
}

/** Enrichment of a seeded exercise from its matched library entry (the row keeps its id, SPEC-v2 §7.2). */
export interface SeedUpdate {
  id: string;
  muscles_secondary: Muscle[];
  pattern: Pattern;
  mechanic: Mechanic;
  level: Level | null;
  media: Media[];
  instructions_en: string[];
}

/** seed/library/seed-matches.json */
export interface SeedMatch {
  id: string;
  /** free-exercise-db id, or null when the dataset has no faithful match. */
  fedb: string | null;
  pattern: Pattern;
  mechanic: Mechanic;
  /** Secondary muscles (reviewed): taken from the matched entry, written by hand for an unmatched one. */
  muscles_secondary: Muscle[];
}

/** seed/library/manual.json: gap fill written by hand from general training knowledge (no media). */
export interface ManualExercise {
  id: string;
  name_en: string;
  equipment: Equipment;
  muscle_primary: Muscle;
  muscles_secondary: Muscle[];
  pattern: Pattern;
  mechanic: Mechanic;
}

/**
 * seed/library/fedb-patterns.json: reviewed pattern (and missing mechanic) per free-exercise-db id, and the category
 * where Payam overrode the dataset's (decided 2026-10-12: Axle Deadlift, Farmer's Walk and Crucifix count as strength).
 */
export type PatternFile = Record<string, { pattern: Pattern | null; mechanic?: Mechanic; category?: Category }>;

export interface ImportReport {
  dataset: { sha: string; total: number };
  imported: number;
  seed_matches: { id: string; fedb: string | null; name: string | null }[];
  manual: { id: string; name_en: string; muscle_primary: Muscle; equipment: Equipment; pattern: Pattern }[];
  /** Dataset entries (seed matches and review exclusions left out) per equipment value: how many were mapped and to what. */
  equipment: { from: string; to: Equipment | "excluded"; count: number }[];
  excluded_equipment: { id: string; name: string; equipment: string | null }[];
  excluded_review: { id: string; name: string; reason: string }[];
  excluded_no_muscle: { id: string; name: string; muscles: string[] }[];
  unmapped_pattern: { id: string; name: string; category: string | null }[];
  unmapped_mechanic: { id: string; name: string }[];
  /** Every "other" and missing-equipment mapping, for review. */
  reviewed_equipment: { id: string; name: string; from: "other" | "missing"; to: Equipment }[];
  /** Rows written per stored category, and whether that category counts toward muscle volume. */
  categories: { category: Category; counted: boolean; count: number }[];
  category_overrides: { id: string; name: string; from: string | null; to: Category }[];
  /** Imported rows that count 0 sets: the strongman ones, listed by name (the other categories are listed by count). */
  not_counted_strongman: { id: string; name: string }[];
}

const asLevel = (v: string | null): Level | null => (v === "beginner" || v === "intermediate" || v === "expert" ? v : null);
const asMechanic = (v: string | null | undefined): Mechanic | null => (v === "compound" || v === "isolation" ? v : null);
const media = (images: string[]): Media[] => images.map((p) => ({ kind: "image" as const, r2_key: fedbImageKey(p) }));

export function validateInputs(seedMatches: SeedMatch[], manual: ManualExercise[], patterns: PatternFile, review: EquipmentReview): string[] {
  const errors: string[] = [];
  for (const [id, e] of [...Object.entries(review.other), ...Object.entries(review.missing)]) if (!EQUIPMENT.includes(e)) errors.push(`equipment ${id}: ${e}`);
  for (const [id, reason] of Object.entries(review.excluded)) {
    if (typeof reason !== "string" || !reason.trim()) errors.push(`excluded ${id}: a reason is required`);
    if (id in review.other || id in review.missing) errors.push(`excluded ${id}: also has an equipment mapping`);
    if (seedMatches.some((s) => s.fedb === id)) errors.push(`excluded ${id}: matched to a seeded exercise`);
  }
  const ids = new Set<string>();
  for (const s of seedMatches) {
    if (!PATTERNS.includes(s.pattern)) errors.push(`seed ${s.id}: pattern ${s.pattern}`);
    if (!asMechanic(s.mechanic)) errors.push(`seed ${s.id}: mechanic ${s.mechanic}`);
    if (!Array.isArray(s.muscles_secondary)) errors.push(`seed ${s.id}: muscles_secondary is required`);
    for (const m of s.muscles_secondary ?? []) if (!isMuscle(m)) errors.push(`seed ${s.id}: muscle ${m}`);
  }
  for (const m of manual) {
    if (!/^manual-[a-z0-9-]{1,57}$/.test(m.id) || ids.has(m.id)) errors.push(`manual ${m.id}: bad or duplicate id`);
    ids.add(m.id);
    if (!EQUIPMENT.includes(m.equipment)) errors.push(`manual ${m.id}: equipment ${m.equipment}`);
    if (!isMuscle(m.muscle_primary)) errors.push(`manual ${m.id}: muscle ${m.muscle_primary}`);
    for (const x of m.muscles_secondary) if (!isMuscle(x) || x === m.muscle_primary) errors.push(`manual ${m.id}: secondary ${x}`);
    if (!PATTERNS.includes(m.pattern)) errors.push(`manual ${m.id}: pattern ${m.pattern}`);
    if (!asMechanic(m.mechanic)) errors.push(`manual ${m.id}: mechanic ${m.mechanic}`);
  }
  for (const [id, p] of Object.entries(patterns)) {
    if (p.pattern !== null && !PATTERNS.includes(p.pattern)) errors.push(`patterns ${id}: ${p.pattern}`);
    if (p.mechanic !== undefined && !asMechanic(p.mechanic)) errors.push(`patterns ${id}: mechanic ${p.mechanic}`);
    if (p.category !== undefined && !isCategory(p.category)) errors.push(`patterns ${id}: category ${p.category}`);
  }
  return errors;
}

/** Ids in the review file that the dataset does not have (a typo or a dataset change); the import refuses to run with any. */
export function unknownReviewIds(dataset: Pick<FedbExercise, "id">[], review: EquipmentReview): string[] {
  const ids = new Set(dataset.map((x) => x.id));
  return [...Object.keys(review.other), ...Object.keys(review.missing), ...Object.keys(review.excluded)].filter((id) => !ids.has(id)).sort();
}

/** @param seedPrimary primary muscle of each seeded exercise (seed/program.json); never repeated as a secondary. */
export function buildLibrary(
  dataset: FedbExercise[],
  patterns: PatternFile,
  seedMatches: SeedMatch[],
  manual: ManualExercise[],
  seedPrimary: Record<string, string>,
  review: EquipmentReview
) {
  const errors = validateInputs(seedMatches, manual, patterns, review);
  if (errors.length) throw new Error("library inputs are invalid:\n" + errors.join("\n"));
  const byId = new Map(dataset.map((x) => [x.id, x]));
  const matched = new Set(seedMatches.map((s) => s.fedb).filter((x): x is string => x !== null));
  const report: ImportReport = {
    dataset: { sha: FEDB_SHA, total: dataset.length },
    imported: 0,
    seed_matches: [],
    manual: manual.map((m) => ({ id: m.id, name_en: m.name_en, muscle_primary: m.muscle_primary, equipment: m.equipment, pattern: m.pattern })),
    equipment: [],
    excluded_equipment: [],
    excluded_review: [],
    excluded_no_muscle: [],
    unmapped_pattern: [],
    unmapped_mechanic: [],
    reviewed_equipment: [],
    categories: [],
    category_overrides: [],
    not_counted_strongman: [],
  };
  const tally = new Map<string, { from: string; to: Equipment | "excluded"; count: number }>();

  const seedUpdates: SeedUpdate[] = seedMatches.map((s) => {
    const src = s.fedb ? byId.get(s.fedb) : undefined;
    if (s.fedb && !src) throw new Error(`seed ${s.id}: free-exercise-db has no ${s.fedb}`);
    report.seed_matches.push({ id: s.id, fedb: s.fedb, name: src?.name ?? null });
    const own = seedPrimary[s.id];
    if (!own) throw new Error(`seed ${s.id}: not in seed/program.json`);
    if (s.muscles_secondary.includes(own as Muscle)) throw new Error(`seed ${s.id}: primary muscle ${own} repeated as a secondary`);
    if (!src) return { id: s.id, muscles_secondary: s.muscles_secondary, pattern: s.pattern, mechanic: s.mechanic, level: null, media: [], instructions_en: [] };
    return {
      id: s.id,
      muscles_secondary: s.muscles_secondary,
      pattern: s.pattern,
      mechanic: s.mechanic,
      level: asLevel(src.level),
      media: media(src.images),
      instructions_en: src.instructions,
    };
  });

  const rows: LibraryRow[] = [];
  for (const x of [...dataset].sort((a, b) => a.id.localeCompare(b.id))) {
    if (matched.has(x.id)) continue;
    if (x.id in review.excluded) {
      report.excluded_review.push({ id: x.id, name: x.name, reason: review.excluded[x.id] });
      continue;
    }
    const equipment = resolveEquipment(x, review);
    const from = x.equipment ?? "missing";
    const t = `${from}→${equipment ?? "excluded"}`;
    tally.set(t, { from, to: equipment ?? "excluded", count: (tally.get(t)?.count ?? 0) + 1 });
    if (!equipment) {
      report.excluded_equipment.push({ id: x.id, name: x.name, equipment: x.equipment });
      continue;
    }
    if (x.equipment === "other" || x.equipment === null) report.reviewed_equipment.push({ id: x.id, name: x.name, from: x.equipment === null ? "missing" : "other", to: equipment });
    const m = fedbMuscles(x);
    if (!m.primary) {
      report.excluded_no_muscle.push({ id: x.id, name: x.name, muscles: x.primaryMuscles });
      continue;
    }
    const p = patterns[x.id];
    const pattern = p?.pattern ?? null;
    if (!pattern) report.unmapped_pattern.push({ id: x.id, name: x.name, category: x.category });
    const mechanic = asMechanic(x.mechanic) ?? p?.mechanic ?? null;
    if (!mechanic) report.unmapped_mechanic.push({ id: x.id, name: x.name });
    const category = p?.category ?? fedbCategory(x.category);
    if (p?.category) report.category_overrides.push({ id: x.id, name: x.name, from: x.category, to: p.category });
    if (category === "strongman") report.not_counted_strongman.push({ id: x.id, name: x.name });
    rows.push({
      id: fedbExerciseId(x.id),
      name_en: x.name,
      muscle_primary: m.primary,
      is_lower: isLowerBody(m.primary),
      equipment,
      source: "fedb",
      source_id: x.id,
      muscles_secondary: m.secondary,
      pattern,
      mechanic,
      level: asLevel(x.level),
      media: media(x.images),
      instructions_en: x.instructions,
      category,
    });
  }
  for (const g of manual) {
    rows.push({
      id: g.id,
      name_en: g.name_en,
      muscle_primary: g.muscle_primary,
      is_lower: isLowerBody(g.muscle_primary),
      equipment: g.equipment,
      source: "manual",
      source_id: g.id,
      muscles_secondary: g.muscles_secondary,
      pattern: g.pattern,
      mechanic: g.mechanic,
      level: null,
      media: [],
      instructions_en: [],
      category: "strength",
    });
  }
  report.imported = rows.length;
  const perCategory = new Map<Category, number>();
  for (const r of rows) perCategory.set(r.category, (perCategory.get(r.category) ?? 0) + 1);
  report.categories = [...perCategory].map(([category, count]) => ({ category, counted: countsVolume(category), count })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  report.equipment = [...tally.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
  return { rows, seedUpdates, report };
}

/* ---------------- SQL ---------------- */

const q = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const json = (v: unknown) => q(JSON.stringify(v));

/**
 * Upserts for the library rows and updates for the seeded rows. Every statement only writes when a value differs,
 * so running the import again changes nothing (SPEC-v2 §7 acceptance).
 */
export function librarySql(rows: LibraryRow[], seedUpdates: SeedUpdate[]): string[] {
  const out: string[] = [];
  const cols = ["name_en", "muscle_primary", "is_lower", "equipment", "source", "source_id", "muscles_secondary", "pattern", "mechanic", "level", "media", "instructions_en", "category"];
  const changed = cols.map((c) => `exercises.${c} IS NOT excluded.${c}`).join(" OR ");
  for (const r of rows) {
    const vals = [
      q(r.id),
      q(""),
      q(r.name_en),
      q(r.muscle_primary),
      q(r.is_lower ? 1 : 0),
      q(r.equipment),
      q(""),
      "NULL",
      q(r.source),
      q(r.source_id),
      json(r.muscles_secondary),
      q(r.pattern),
      q(r.mechanic),
      q(r.level),
      json(r.media),
      json(r.instructions_en),
      q(r.category),
    ];
    out.push(
      `INSERT INTO exercises (id, name_fa, name_en, muscle_primary, is_lower, equipment, cue_fa, cue_en, source, source_id, muscles_secondary, pattern, mechanic, level, media, instructions_en, category) VALUES (${vals.join(", ")})` +
        ` ON CONFLICT (id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")} WHERE ${changed};`
    );
  }
  for (const s of seedUpdates) {
    const set: [string, string][] = [
      ["muscles_secondary", json(s.muscles_secondary)],
      ["pattern", q(s.pattern)],
      ["mechanic", q(s.mechanic)],
      ["level", q(s.level)],
      ["media", json(s.media)],
      ["instructions_en", json(s.instructions_en)],
    ];
    out.push(
      `UPDATE exercises SET ${set.map(([c, v]) => `${c} = ${v}`).join(", ")} WHERE id = ${q(s.id)} AND source = 'seed' AND (${set.map(([c, v]) => `${c} IS NOT ${v}`).join(" OR ")});`
    );
  }
  return out;
}

/** R2 keys of every image the library rows and the seed updates reference. */
export function imageKeys(rows: LibraryRow[], seedUpdates: SeedUpdate[]): string[] {
  const keys = new Set<string>();
  for (const r of [...rows, ...seedUpdates]) for (const m of r.media) if (m.r2_key) keys.add(m.r2_key);
  return [...keys].sort();
}

/** Markdown import report for Payam's review (seed/library/IMPORT-REPORT.md). */
export function reportMarkdown(r: ImportReport): string {
  const lines: string[] = [];
  const list = <T>(title: string, items: T[], fmt: (x: T) => string) => {
    lines.push(`## ${title} (${items.length})`, "");
    if (!items.length) lines.push("None.");
    for (const x of items) lines.push(`- ${fmt(x)}`);
    lines.push("");
  };
  const mapped = r.equipment.filter((e) => e.to !== "excluded").reduce((n, e) => n + e.count, 0);
  const excluded = r.equipment.filter((e) => e.to === "excluded").reduce((n, e) => n + e.count, 0);
  lines.push(
    "# Exercise library import report",
    "",
    `Generated by \`npm run library:report\`. Source: free-exercise-db (Unlicense) at commit \`${r.dataset.sha}\`.`,
    "",
    `- Exercises in the dataset: ${r.dataset.total}`,
    `- Matched to the seeded exercises (enriched in place, ids unchanged): ${r.seed_matches.filter((s) => s.fedb).length}`,
    `- Equipment mapped onto the five allowed values: ${mapped}`,
    `- Excluded by equipment (kettlebell, bands, medicine ball, exercise ball, foam roll): ${excluded}`,
    `- Excluded on review (strongman-only and others, seed/library/fedb-equipment.json): ${r.excluded_review.length}`,
    `- Excluded for having no primary muscle key: ${r.excluded_no_muscle.length}`,
    `- Rows written by the import: ${r.imported} (free-exercise-db ${r.imported - r.manual.length} + manual ${r.manual.length})`,
    "",
    "## Equipment mapping",
    "",
    "| Dataset equipment | Stored as | Exercises |",
    "|---|---|---|",
    ...r.equipment.map((e) => `| ${e.from} | ${e.to} | ${e.count} |`),
    ""
  );
  const other = r.reviewed_equipment.filter((x) => x.from === "other");
  const missing = r.reviewed_equipment.filter((x) => x.from === "missing");
  list("Equipment \"other\": mapping for review (seed/library/fedb-equipment.json)", other, (x) => `${x.name} → ${x.to}`);
  list("No equipment in the dataset: mapping for review", missing, (x) => `${x.name} → ${x.to}`);
  list("Seeded exercises and their library match", r.seed_matches, (s) => (s.fedb ? `\`${s.id}\` ← ${s.name} (\`${s.fedb}\`)` : `\`${s.id}\`: no faithful match; pattern and muscles written by hand, no media`));
  list("Manual gap fill, for review (source 'manual', no media)", r.manual, (m) => `\`${m.id}\` ${m.name_en}: ${m.muscle_primary}, ${m.equipment}, ${m.pattern}`);
  lines.push(
    "## Categories and volume counting (SPEC-v2 §7.4)",
    "",
    "Only strength, powerlifting and olympic weightlifting count toward weekly muscle volume and the muscle map. The other rows stay in the library and can be logged, but count 0 sets.",
    "",
    "| Category | Counts toward volume | Rows |",
    "|---|---|---|",
    ...r.categories.map((c) => `| ${c.category} | ${c.counted ? "yes" : "no"} | ${c.count} |`),
    ""
  );
  list("Category set on review (fedb-patterns.json)", r.category_overrides, (x) => `${x.name}: ${x.from ?? "none"} → ${x.to}`);
  list("Strongman rows that count 0 sets", r.not_counted_strongman, (x) => x.name);
  list("Not imported: excluded equipment", r.excluded_equipment, (x) => `${x.name} (${x.equipment})`);
  list("Not imported: excluded on review", r.excluded_review, (x) => `${x.name} (${x.reason})`);
  list("Not imported: no primary muscle key", r.excluded_no_muscle, (x) => `${x.name} (${x.muscles.join(", ")})`);
  list("Imported without a pattern (not guessed)", r.unmapped_pattern, (x) => `${x.name}${x.category ? ` (${x.category})` : ""}`);
  list("Imported without a mechanic (not guessed)", r.unmapped_mechanic, (x) => x.name);
  return lines.join("\n");
}

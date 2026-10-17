// Reviewed decisions for the M14 sources (SPEC-v11 A2, approved by Payam 2026-10-16): each source's decision file
// (seed/library/m14/<source>.json) and the duplicate review (seed/library/m14/dedupe-review.json) become library rows;
// every library exercise's region tags become exercise_regions SQL; and the M14 import report is written from both.
// Existing exercise ids never change and nothing is merged: a reviewed duplicate is simply not added. Pure: no I/O.

import { countsVolume, isCategory, type Category } from "./category";
import { EQUIPMENT, PATTERNS, type LibraryRow, type Mechanic, type Media, type Pattern, type SeedUpdate } from "./library";
import {
  IMPORTED_CATEGORIES,
  LICENCES,
  SOURCES,
  SOURCE_ORDER,
  dedupeKey,
  sourceExerciseId,
  type Licence,
  type Match,
  type ScreenKind,
  type SourceImage,
  type SourceKey,
} from "./librarySources";
import { isLowerBody, isMuscle, type Muscle } from "./muscles";
import { REGIONS, REGION_INFO, TWO_PRIMARY_RULES, isRegion, regionTags, type Region, type RegionOverrides, type RegionTag } from "./regions";
import type { Equipment } from "./types";

/** The clean row a reviewer wrote for an included record. */
export interface SourceRow {
  name_en: string;
  category: Category;
  equipment: Equipment;
  muscle_primary: Muscle;
  muscles_secondary: Muscle[];
  pattern: Pattern | null;
  mechanic: Mechanic | null;
  /** Our own short steps (never copied from a source). */
  instructions_en: string[];
}

export interface Decision {
  sid: string;
  /** The source's own name, for reading the file. */
  name: string;
  decision: "include" | "exclude" | "duplicate";
  reason?: string;
  duplicate_of?: string;
  row?: SourceRow;
  /** Open-licence sources: the record's licence and author, and the images whose own licence allows storing them. */
  license?: Licence | null;
  license_author?: string | null;
  images?: SourceImage[];
}

export interface DecisionFile {
  source: SourceKey;
  sha: string;
  decisions: Decision[];
}

/** One probable duplicate, decided: "same" is not added; "different" is added (if its decision includes it). */
export interface DedupeEntry {
  candidate: string;
  name: string;
  closest: Match | null;
  decision: "same" | "different";
  duplicate_of?: string;
  reason: string;
}

/** Screening outcome of every source record (seed/library/m14/screening.json), for the report and the tests. */
export interface ScreeningFile {
  sources: Record<SourceKey, string>;
  records: Record<SourceKey, { sid: string; name: string; kind: ScreenKind; detail?: string; match?: Match }[]>;
}

export const SOURCE_MEDIA_PREFIX = "library/sources/";

/** R2 key of a source image: wger keeps its folder and file name, everkinetic its file name. */
export function sourceImageKey(source: SourceKey, url: string): string {
  const path = new URL(url).pathname;
  const tail = source === "wger" ? path.replace(/^.*\/exercise-images\//, "") : path.split("/").pop()!;
  return `${SOURCE_MEDIA_PREFIX}${source}/images/${tail.replace(/[^A-Za-z0-9._/-]/g, "_")}`;
}

export const IMAGE_TYPES: Readonly<Record<string, string>> = { jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
export const imageType = (key: string) => IMAGE_TYPES[key.split(".").pop()!.toLowerCase()] ?? null;

const MECHANICS: readonly Mechanic[] = ["compound", "isolation"];

/** Everything wrong with the decision files and the duplicate review; the import refuses to run with any. Without
 *  libraryIds (a sample of the dataset, in the e2e fixtures) the duplicate targets are not checked. */
export function validateDecisions(files: DecisionFile[], dedupe: DedupeEntry[], libraryIds: ReadonlySet<string> | null): string[] {
  const errors: string[] = [];
  const seen = new Map<string, Decision & { source: SourceKey }>();
  for (const f of files) {
    if (!SOURCES[f.source]) {
      errors.push(`unknown source ${f.source}`);
      continue;
    }
    if (f.sha !== SOURCES[f.source].sha) errors.push(`${f.source}: decisions are for commit ${f.sha}, the import is pinned to ${SOURCES[f.source].sha}`);
    for (const d of f.decisions) {
      const key = `${f.source}:${d.sid}`;
      if (seen.has(key)) errors.push(`${key}: decided twice`);
      seen.set(key, { ...d, source: f.source });
      if (d.decision === "exclude" && !d.reason?.trim()) errors.push(`${key}: an exclusion needs a reason`);
      if (d.decision === "duplicate" && !d.duplicate_of) errors.push(`${key}: a duplicate names what it repeats`);
      if (d.decision !== "include") continue;
      const r = d.row;
      if (!r) {
        errors.push(`${key}: included without a row`);
        continue;
      }
      const at = `${key} (${r.name_en})`;
      if (!r.name_en?.trim() || r.name_en.length > 80) errors.push(`${at}: name`);
      if (!isCategory(r.category) || !IMPORTED_CATEGORIES.has(r.category)) errors.push(`${at}: category ${r.category}`);
      if (!EQUIPMENT.includes(r.equipment)) errors.push(`${at}: equipment ${r.equipment}`);
      if (!isMuscle(r.muscle_primary)) errors.push(`${at}: muscle ${r.muscle_primary}`);
      if (!Array.isArray(r.muscles_secondary) || r.muscles_secondary.length > 6) errors.push(`${at}: secondary muscles`);
      for (const m of r.muscles_secondary ?? []) if (!isMuscle(m) || m === r.muscle_primary) errors.push(`${at}: secondary ${m}`);
      const counted = countsVolume(r.category);
      if (r.pattern === null ? counted : !PATTERNS.includes(r.pattern)) errors.push(`${at}: pattern ${r.pattern}`);
      if (r.mechanic === null ? counted : !MECHANICS.includes(r.mechanic)) errors.push(`${at}: mechanic ${r.mechanic}`);
      if (!Array.isArray(r.instructions_en) || r.instructions_en.length < 2 || r.instructions_en.length > 3 || r.instructions_en.some((s) => typeof s !== "string" || !s.trim() || s.length > 220))
        errors.push(`${at}: two or three instruction steps`);
      if (SOURCES[f.source].factsOnly) {
        if (d.license || d.license_author || d.images?.length) errors.push(`${at}: a facts-only source stores no licensed content`);
      } else if (!d.license || !(LICENCES as readonly string[]).includes(d.license)) errors.push(`${at}: licence ${d.license}`);
      for (const i of d.images ?? []) if (!(LICENCES as readonly string[]).includes(i.license) || !i.author || !imageType(sourceImageKey(f.source, i.url))) errors.push(`${at}: image ${i.url}`);
    }
  }
  const byCandidate = new Map<string, DedupeEntry>();
  for (const e of dedupe) {
    if (byCandidate.has(e.candidate)) errors.push(`dedupe ${e.candidate}: listed twice`);
    byCandidate.set(e.candidate, e);
    const d = seen.get(e.candidate);
    if (!d) errors.push(`dedupe ${e.candidate}: no decision for this record`);
    if (e.decision !== "same" && e.decision !== "different") errors.push(`dedupe ${e.candidate}: decision ${e.decision}`);
    if (!e.reason?.trim()) errors.push(`dedupe ${e.candidate}: a reason is required`);
    if (e.decision === "same" && !e.duplicate_of) errors.push(`dedupe ${e.candidate}: "same" names what it repeats`);
    if (e.decision === "different" && d?.decision === "duplicate") errors.push(`dedupe ${e.candidate}: marked different, so its decision needs a row (include) or an exclusion`);
  }
  for (const [key, d] of seen) if (d.decision === "duplicate" && byCandidate.get(key)?.decision !== "same") errors.push(`${key}: a duplicate must be listed as "same" in dedupe-review.json`);
  // What a duplicate repeats must exist: the library, or a row this import adds.
  const added = new Set([...seen].filter(([k, d]) => d.decision === "include" && byCandidate.get(k)?.decision !== "same").map(([, d]) => sourceExerciseId(d.source, d.sid)));
  if (libraryIds)
    for (const e of dedupe) if (e.decision === "same" && e.duplicate_of && !libraryIds.has(e.duplicate_of) && !added.has(e.duplicate_of)) errors.push(`dedupe ${e.candidate}: ${e.duplicate_of} is not in the library`);
  return errors;
}

/** Region tags (SPEC-v11 A3) of every exercise the import manages: the seeded exercises, with the secondary muscles and
 *  pattern their library match gives them, and the library rows. Seeds are strength. */
export function libraryRegionTags(
  seeds: readonly { id: string; name_en: string; muscle_primary: string }[],
  seedUpdates: readonly SeedUpdate[],
  rows: readonly LibraryRow[],
  overrides: RegionOverrides
): Map<string, RegionTag[]> {
  const tags = new Map<string, RegionTag[]>();
  for (const e of seeds) {
    const s = seedUpdates.find((u) => u.id === e.id);
    tags.set(e.id, regionTags({ id: e.id, name_en: e.name_en, muscle_primary: e.muscle_primary, muscles_secondary: s?.muscles_secondary ?? [], pattern: s?.pattern ?? null, category: "strength" }, overrides));
  }
  for (const r of rows) tags.set(r.id, regionTags(r, overrides));
  return tags;
}

/** The rows the decisions add, in source order; the reviewed duplicates and the exclusions are left out. */
export function sourceRows(files: DecisionFile[], dedupe: DedupeEntry[]): LibraryRow[] {
  const same = new Set(dedupe.filter((e) => e.decision === "same").map((e) => e.candidate));
  const rows: LibraryRow[] = [];
  for (const s of SOURCE_ORDER) {
    const f = files.find((x) => x.source === s);
    if (!f) continue;
    for (const d of [...f.decisions].sort((a, b) => a.sid.localeCompare(b.sid, "en", { numeric: true }))) {
      if (d.decision !== "include" || same.has(`${s}:${d.sid}`) || !d.row) continue;
      const r = d.row;
      const media: Media[] = (d.images ?? []).map((i) => ({ kind: "image", r2_key: sourceImageKey(s, i.url), license: i.license, author: i.author }));
      rows.push({
        id: sourceExerciseId(s, d.sid),
        name_en: r.name_en.trim(),
        muscle_primary: r.muscle_primary,
        is_lower: isLowerBody(r.muscle_primary),
        equipment: r.equipment,
        source: s,
        source_id: d.sid,
        muscles_secondary: r.muscles_secondary,
        pattern: r.pattern,
        mechanic: r.mechanic,
        level: null,
        media,
        instructions_en: r.instructions_en,
        category: r.category,
        license: d.license ?? null,
        license_author: d.license_author ?? null,
      });
    }
  }
  return rows;
}

/** Added rows that repeat another library row exactly (same movement words and equipment): the review must decide. */
export function exactRepeats(added: LibraryRow[], library: { id: string; name_en: string; equipment: Equipment }[]): string[] {
  const keys = new Map<string, string>();
  for (const l of library) keys.set(dedupeKey(l.name_en, l.equipment), l.id);
  const out: string[] = [];
  for (const r of added) {
    const k = dedupeKey(r.name_en, r.equipment);
    const other = keys.get(k);
    if (other && other !== r.id) out.push(`${r.id} (${r.name_en}) repeats ${other}`);
    else keys.set(k, r.id);
  }
  return out;
}

/* ---------------- regions ---------------- */

const q = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

/**
 * Writes each exercise's region tags and removes tags its rules no longer give. Every statement only writes when a
 * value differs, so running the import again changes nothing.
 */
export function regionsSql(tags: ReadonlyMap<string, RegionTag[]>): string[] {
  const out: string[] = [];
  for (const id of [...tags.keys()].sort()) {
    const list = tags.get(id)!;
    for (const t of list) {
      if (!isRegion(t.region)) throw new Error(`${id}: unknown region ${t.region}`);
      out.push(
        `INSERT INTO exercise_regions (exercise_id, region_key, emphasis, evidence, note) VALUES (${q(id)}, ${q(t.region)}, ${q(t.emphasis)}, ${q(t.evidence)}, ${q(t.note)})` +
          ` ON CONFLICT (exercise_id, region_key) DO UPDATE SET emphasis = excluded.emphasis, evidence = excluded.evidence, note = excluded.note` +
          ` WHERE exercise_regions.emphasis IS NOT excluded.emphasis OR exercise_regions.evidence IS NOT excluded.evidence OR exercise_regions.note IS NOT excluded.note;`
      );
    }
    out.push(`DELETE FROM exercise_regions WHERE exercise_id = ${q(id)}${list.length ? ` AND region_key NOT IN (${list.map((t) => q(t.region)).join(", ")})` : ""};`);
  }
  return out;
}

/** The family a muscle's regions belong to, for "no two primary regions of one muscle". */
const familyOf = (r: Region) => REGION_INFO[r].muscle;

/** Problems with a set of tags (tests and report): untagged counted exercises, double primaries, thin regions. */
export function regionChecks(rows: { id: string; name_en: string; muscle_primary: string; category: string | null }[], tags: ReadonlyMap<string, RegionTag[]>) {
  const untagged: { id: string; name_en: string; muscle: string }[] = [];
  const doublePrimary: string[] = [];
  const primary = new Map<Region, number>(REGIONS.map((r) => [r, 0]));
  const anyTag = new Map<Region, number>(REGIONS.map((r) => [r, 0]));
  for (const r of rows) {
    const t = tags.get(r.id) ?? [];
    if (!countsVolume(r.category)) {
      if (t.length) doublePrimary.push(`${r.id}: ${r.category} carries region tags`);
      continue;
    }
    if (!t.length) untagged.push({ id: r.id, name_en: r.name_en, muscle: r.muscle_primary });
    const fam = new Map<string, RegionTag[]>();
    for (const x of t) {
      anyTag.set(x.region, anyTag.get(x.region)! + 1);
      if (x.emphasis !== "primary") continue;
      primary.set(x.region, primary.get(x.region)! + 1);
      fam.set(familyOf(x.region), [...(fam.get(familyOf(x.region)) ?? []), x]);
    }
    for (const [f, xs] of fam) if (xs.length > 1 && !xs.every((x) => TWO_PRIMARY_RULES.has(x.note) || x.note === "reviewed")) doublePrimary.push(`${r.id} (${r.name_en}): ${xs.length} primary ${f} regions`);
  }
  return { untagged, doublePrimary, primary, anyTag };
}

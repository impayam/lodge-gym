import { describe, expect, it } from "vitest";
import library from "../fixtures/generator/library.json";
import overridesFile from "../../seed/library/region-overrides.json";
import dedupeFile from "../../seed/library/m14/dedupe-review.json";
import everkinetic from "../../seed/library/m14/everkinetic.json";
import exercemus from "../../seed/library/m14/exercemus.json";
import exercisedb from "../../seed/library/m14/exercisedb.json";
import liftosaur from "../../seed/library/m14/liftosaur.json";
import screeningFile from "../../seed/library/m14/screening.json";
import wger from "../../seed/library/m14/wger.json";
import wgerImagesFile from "../../seed/library/m14/wger-images.json";
import duplicatesFile from "../../seed/library/duplicate-images.json";
import { duplicateImageErrors, type DuplicateImage } from "../../worker/lib/library";
import { exactRepeats, regionChecks, sourceRows, validateDecisions, type DecisionFile, type DedupeEntry, type ScreeningFile } from "../../worker/lib/libraryDecisions";
import { LICENCES, SOURCES, SOURCE_ORDER, sourceExerciseId, type WgerImage } from "../../worker/lib/librarySources";
import { REGIONS, regionTags, type RegionOverrides, type RegionTag } from "../../worker/lib/regions";
import type { Equipment } from "../../worker/lib/types";

// SPEC-v11 M14 Phase A: the committed review (seed/library/m14) is complete and consistent, and the region rule table
// holds on the whole library the import writes (tests/fixtures/generator/library.json, regenerated from the same
// inputs by scripts/generator-pool.mts).

const files = [wger, everkinetic, exercisedb, liftosaur, exercemus] as unknown as DecisionFile[];
const dedupe = dedupeFile as unknown as DedupeEntry[];
const screening = screeningFile as unknown as ScreeningFile;
const overrides = overridesFile as unknown as RegionOverrides;
const wgerImages = (wgerImagesFile as unknown as { images: WgerImage[] }).images;
const pool = library as unknown as { id: string; name_en: string; muscle_primary: string; muscles_secondary: string[]; equipment: Equipment; pattern: string | null; category: string; source: string }[];
const before = pool.filter((r) => r.source === "seed" || r.source === "fedb" || r.source === "manual");
const added = sourceRows(files, dedupe);

describe("the committed review", () => {
  it("covers every source in order", () => {
    expect(files.map((f) => f.source)).toEqual([...SOURCE_ORDER]);
  });

  it("pins each source's reviewed commit, the same one the screening read", () => {
    for (const f of files) {
      expect(f.sha).toBe(SOURCES[f.source].sha);
      expect(screening.sources[f.source]).toBe(f.sha);
    }
  });

  it("decides every screened candidate exactly once, and nothing else", () => {
    for (const f of files) {
      const candidates = screening.records[f.source].filter((x) => x.kind === "candidate").map((x) => x.sid);
      expect(f.decisions.map((d) => d.sid)).toEqual(candidates);
    }
  });

  it("validates against the library: targets exist, duplicates are listed as same, rows are complete", () => {
    expect(validateDecisions(files, dedupe, new Set(before.map((r) => r.id)))).toEqual([]);
  });

  it("lists every candidate with a closest match, and every reviewed duplicate, in the dedupe review", () => {
    const listed = new Set<string>(dedupe.map((d) => d.candidate));
    const byKey = new Map<string, ScreeningFile["records"]["wger"][number]>(SOURCE_ORDER.flatMap((s) => screening.records[s].map((x) => [`${s}:${x.sid}`, x] as const)));
    for (const f of files)
      for (const d of f.decisions) {
        const key = `${f.source}:${d.sid}`;
        if (d.decision === "duplicate" || byKey.get(key)?.match) expect(listed.has(key), key).toBe(true);
      }
    expect(dedupe.every((d) => byKey.get(d.candidate)?.kind === "candidate")).toBe(true);
  });

  it("adds no row that repeats the library or another added row, and keeps existing ids", () => {
    expect(exactRepeats(added, before)).toEqual([]);
    expect(new Set(added.map((r) => r.id)).size).toBe(added.length);
    const ids = new Set(before.map((r) => r.id));
    expect(added.filter((r) => ids.has(r.id))).toEqual([]);
  });

  it("the generator pool fixture holds exactly the rows the import adds", () => {
    expect(pool.filter((r) => !before.includes(r)).map((r) => r.id)).toEqual(added.map((r) => r.id));
  });

  it("stores licensed content only from open sources, each with a known licence; no AI-generated wger image", () => {
    const ai = new Set(wgerImages.filter((i) => i.is_ai_generated).map((i) => i.image));
    for (const r of added) {
      if (SOURCES[r.source as keyof typeof SOURCES].factsOnly) {
        expect(r.license, r.id).toBeNull();
        expect(r.media, r.id).toEqual([]);
      } else expect(LICENCES, r.id).toContain(r.license);
      for (const m of r.media) expect(LICENCES, r.id).toContain(m.license);
    }
    for (const f of files) for (const d of f.decisions) for (const i of d.images ?? []) expect(ai.has(i.url), i.url).toBe(false);
  });

  it("writes our own short instructions on every added row", () => {
    for (const r of added) {
      expect(r.instructions_en.length, r.id).toBeGreaterThanOrEqual(2);
      expect(r.instructions_en.length, r.id).toBeLessThanOrEqual(3);
    }
  });
});

describe("the same picture twice (seed/library/duplicate-images.json)", () => {
  const duplicates = (duplicatesFile as unknown as { exercises: DuplicateImage[] }).exercises;

  it("lists exercises of the library, each once with a reason; a source row's entry names two of its images", () => {
    const ids = new Set(pool.map((r) => r.id));
    for (const d of duplicates) expect(ids.has(d.id), d.id).toBe(true);
    const fromSources = duplicates.filter((d) => added.some((r) => r.id === d.id));
    expect(fromSources.map((d) => d.id)).toEqual(["wger-203", "wger-456"]);
    expect(duplicateImageErrors(fromSources, added)).toEqual([]);
  });

  it("free-exercise-db entries name the two images of that entry", () => {
    for (const d of duplicates.filter((x) => x.id.startsWith("fedb-"))) {
      const folder = `library/free-exercise-db/images/${d.id.slice("fedb-".length)}/`;
      expect([d.keep, d.drop], d.id).toEqual([`${folder}0.jpg`, `${folder}1.jpg`]);
    }
  });
});

describe("region tags on the whole library", () => {
  const tags = new Map<string, RegionTag[]>(pool.map((r) => [r.id, regionTags({ ...r, id: r.id }, overrides)]));
  const checks = regionChecks(pool, tags);

  it("every exercise that counts toward volume has a region, forearm and neck work included (Phase B)", () => {
    expect(checks.untagged).toEqual([]);
  });

  it("no exercise has two primary regions of one muscle outside the reviewed rules; stretching and cardio carry none", () => {
    expect(checks.doublePrimary).toEqual([]);
  });

  it("every region is the main focus of at least three exercises", () => {
    for (const r of REGIONS) expect(checks.primary.get(r), r).toBeGreaterThanOrEqual(3);
  });

  it("reviewed overrides name exercises the library has", () => {
    for (const id of Object.keys(overrides)) expect(tags.has(id), id).toBe(true);
  });

  it("the M14 rows are tagged by the same rules: added stretching and cardio have no regions", () => {
    const sourceIds = new Set(added.map((r) => r.id));
    const quiet = pool.filter((r) => sourceIds.has(r.id) && (r.category === "stretching" || r.category === "cardio"));
    expect(quiet.length).toBeGreaterThan(0);
    for (const r of quiet) expect(tags.get(r.id), r.id).toEqual([]);
  });

  it("source ids follow the exercise id rule", () => {
    for (const f of files)
      for (const d of f.decisions) if (d.decision === "include") expect(sourceExerciseId(f.source, d.sid)).toMatch(/^[0-9A-Za-z_-]{1,64}$/);
  });
});

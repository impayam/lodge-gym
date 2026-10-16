-- 0013_exercise_regions.sql (SPEC-v11 M14 Phase A, approved 2026-10-16)
-- Library rows from open-licence sources keep their licence and the author to credit (wger: per record).
ALTER TABLE exercises ADD COLUMN license TEXT;         -- 'Unlicense' | 'CC-BY-SA-3.0' | 'CC-BY-SA-4.0' | 'CC0-1.0'; NULL when nothing licensed is stored
ALTER TABLE exercises ADD COLUMN license_author TEXT;  -- as the source gives it (wger: license_author; everkinetic: 'everkinetic')

-- Region tags (A3): which part of a muscle an exercise emphasises, and how well research supports it.
CREATE TABLE exercise_regions (
  exercise_id TEXT NOT NULL REFERENCES exercises (id),
  region_key TEXT NOT NULL,   -- one of the 26 keys in worker/lib/regions.ts (checked by the import and the tests)
  emphasis TEXT NOT NULL CHECK (emphasis IN ('primary', 'secondary')),
  evidence TEXT NOT NULL CHECK (evidence IN ('strong', 'moderate', 'weak')),
  note TEXT,                  -- the rule that set it, e.g. 'chest-incline-press'
  PRIMARY KEY (exercise_id, region_key)
);
CREATE INDEX exercise_regions_region ON exercise_regions (region_key, emphasis);

UPDATE exercises SET license = 'Unlicense' WHERE source = 'fedb';

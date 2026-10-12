-- 0004_exercise_library.sql (SPEC-v2 §7.2, approved 2026-10-13)
ALTER TABLE exercises ADD COLUMN source TEXT;            -- 'seed'|'fedb'|'manual'|'custom'
ALTER TABLE exercises ADD COLUMN source_id TEXT;
ALTER TABLE exercises ADD COLUMN cue_en TEXT;
ALTER TABLE exercises ADD COLUMN muscles_secondary TEXT; -- JSON array of canonical keys
ALTER TABLE exercises ADD COLUMN pattern TEXT;
ALTER TABLE exercises ADD COLUMN mechanic TEXT;
ALTER TABLE exercises ADD COLUMN level TEXT;
ALTER TABLE exercises ADD COLUMN media TEXT;
ALTER TABLE exercises ADD COLUMN instructions_en TEXT;
ALTER TABLE exercises ADD COLUMN archived_at TEXT;
CREATE UNIQUE INDEX ux_exercises_source ON exercises (source, source_id);
ALTER TABLE set_entries ADD COLUMN is_extra INTEGER NOT NULL DEFAULT 0;
ALTER TABLE set_entries ADD COLUMN position INTEGER;
UPDATE exercises SET source = 'seed', source_id = id WHERE source IS NULL;  -- the 27 seeded rows keep their ids

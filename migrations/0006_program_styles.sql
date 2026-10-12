-- 0006_program_styles.sql (SPEC-v2 §8.7; approved as 0005, renumbered 2026-10-12, SQL unchanged)
ALTER TABLE programs ADD COLUMN style TEXT;
ALTER TABLE programs ADD COLUMN days_per_week INTEGER;
ALTER TABLE programs ADD COLUMN params TEXT;
ALTER TABLE programs ADD COLUMN generated_by TEXT;
ALTER TABLE programs ADD COLUMN approved_at TEXT;
ALTER TABLE programs ADD COLUMN archived_at TEXT;
CREATE TABLE program_activations (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs (id),
                                  started_at TEXT NOT NULL, ended_at TEXT);
CREATE INDEX program_activations_program ON program_activations (program_id, started_at);
ALTER TABLE day_exercises ADD COLUMN target_rir_min INTEGER;
ALTER TABLE day_exercises ADD COLUMN target_rir_max INTEGER;
ALTER TABLE day_exercises ADD COLUMN slot TEXT;
UPDATE programs SET style = 'seed_full_body', days_per_week = 4, generated_by = 'seed', approved_at = created_at WHERE id = 'fullbody4';
INSERT INTO program_activations (id, program_id, started_at)
  SELECT 'act-fullbody4-seed', id, created_at FROM programs WHERE id = 'fullbody4';
UPDATE programs SET style = 'seed_upper_lower', days_per_week = 4, generated_by = 'seed', archived_at = created_at WHERE id = 'upperlower';

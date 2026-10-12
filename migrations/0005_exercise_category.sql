-- 0005_exercise_category.sql
-- SPEC-v2 §7.4: only strength work counts toward weekly muscle volume.
ALTER TABLE exercises ADD COLUMN category TEXT;
  -- 'strength' | 'powerlifting' | 'olympic_weightlifting'
  -- | 'strongman' | 'stretching' | 'plyometrics' | 'cardio'
UPDATE exercises SET category = 'strength'
  WHERE source IN ('seed', 'custom');

-- fedb rows: category from the dataset (import, right after
-- migrations in deploy:ci); manual rows: 'strength';
-- seed/seed.sql also writes 'strength' for new installs.
-- Counted: strength, powerlifting, olympic_weightlifting.

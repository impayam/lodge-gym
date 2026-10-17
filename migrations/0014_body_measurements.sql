-- 0014_body_measurements.sql (SPEC-v12 M15 §4, approved by Payam 2026-10-17): body sizes logged any time, one row per
-- entry with any subset of the fields (cm). No schedule, no reminders. Goals live in settings keys (no table).
CREATE TABLE body_measurements (
  id TEXT PRIMARY KEY,                 -- client ULID (idempotent upsert, outbox)
  local_date TEXT NOT NULL,            -- YYYY-MM-DD, the day measured (user's time zone)
  arm_cm REAL CHECK (arm_cm IS NULL OR arm_cm > 0),
  chest_cm REAL CHECK (chest_cm IS NULL OR chest_cm > 0),
  waist_cm REAL CHECK (waist_cm IS NULL OR waist_cm > 0),
  hips_cm REAL CHECK (hips_cm IS NULL OR hips_cm > 0),
  thigh_cm REAL CHECK (thigh_cm IS NULL OR thigh_cm > 0),
  calf_cm REAL CHECK (calf_cm IS NULL OR calf_cm > 0),
  neck_cm REAL CHECK (neck_cm IS NULL OR neck_cm > 0),
  shoulders_cm REAL CHECK (shoulders_cm IS NULL OR shoulders_cm > 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,            -- UTC ISO-8601
  updated_at TEXT NOT NULL,
  deleted_at TEXT                      -- soft delete, so an offline edit never resurrects a deleted entry
);
CREATE INDEX body_measurements_date ON body_measurements (local_date, created_at);

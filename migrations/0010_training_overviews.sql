-- 0010_training_overviews.sql: SPEC-v7 M9d auto-updating training overview (SQL approved by Payam 2026-10-13).
-- One new, empty table; nothing existing changes. Every regeneration inserts a row (ok or error); the latest ok row is
-- shown and older rows are kept. A deleted session leaves its overviews with trigger_session_id NULL.
CREATE TABLE training_overviews (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  trigger_session_id TEXT REFERENCES workout_sessions (id) ON DELETE SET NULL,  -- NULL = manual Regenerate or deleted session
  window_start TEXT NOT NULL,                        -- local date YYYY-MM-DD
  window_end TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  overview_json TEXT CHECK (overview_json IS NULL OR json_valid(overview_json)),
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX training_overviews_created ON training_overviews (created_at);

-- 0009_ai_reports.sql: SPEC-v3 M9a AI session report and M9c AI plan advice (SQL approved by Payam 2026-10-13).
-- Two new, empty tables; nothing existing changes. Each model call writes one row (ok or error); rows are never
-- updated, so a regenerated report or a new advice keeps the older rows. Plan advice belongs to a plan
-- (planned_sessions, data option A), not to a workout session.
CREATE TABLE session_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES workout_sessions (id),
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,                               -- the model that answered (REPORT_MODEL, or the API's fallback)
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json)),   -- the validated report
  error TEXT,                                        -- '<code>: <message>'; code 'auth' = API key expired or invalid
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX session_reports_session ON session_reports (session_id, created_at);

CREATE TABLE plan_advice (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES planned_sessions (id),
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  advice_json TEXT CHECK (advice_json IS NULL OR json_valid(advice_json)),   -- the validated advice
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX plan_advice_session ON plan_advice (session_id, created_at);

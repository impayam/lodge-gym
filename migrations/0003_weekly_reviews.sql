-- Weekly AI review written directly into D1 by Claude (not by the app). The app only reads the latest one.
CREATE TABLE weekly_reviews (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,          -- YYYY-MM-DD, first day of the reviewed week (settings week_start)
  created_at TEXT NOT NULL,          -- UTC ISO-8601
  summary_fa TEXT NOT NULL,          -- Persian summary paragraph(s)
  highlights TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(highlights)),   -- JSON array of Persian strings
  suggestions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(suggestions)) -- JSON array of Persian strings
);
CREATE INDEX weekly_reviews_week ON weekly_reviews (week_start, created_at);

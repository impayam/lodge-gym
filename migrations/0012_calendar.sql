-- 0012_calendar.sql: SPEC-v10 M13 training calendar (work shifts and planned gym sessions).
-- Two new, empty tables; nothing existing changes. Times are local: a local date (YYYY-MM-DD, the settings time zone)
-- and minutes from midnight, same-day only. Shifts and plans are plans, not history: deleting one is a real delete.
-- The calendar settings (gym_hours, travel_buffer_min, after_shift_gap_min, preferred_windows, reminder_minutes) are
-- rows of the existing settings table, written only when Payam changes them; until then the code uses the approved
-- defaults (Mon–Fri 04:00–24:00, Sat 05:00–22:00, Sun 07:00–16:00; 20 min travel each way; 30 min after a shift;
-- reminder 60 min before), so this migration inserts nothing.

CREATE TABLE work_shifts (
  id TEXT PRIMARY KEY,                                -- client ULID (created offline through the outbox)
  date TEXT NOT NULL,                                 -- local date
  start_min INTEGER NOT NULL CHECK (start_min >= 0),
  end_min INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,                           -- newest write wins when the outbox replays
  CHECK (end_min > start_min AND end_min <= 1440)     -- same day only, never after midnight
);
CREATE INDEX work_shifts_date ON work_shifts (date, start_min);

CREATE TABLE gym_plans (
  id TEXT PRIMARY KEY,                                -- client ULID
  date TEXT NOT NULL,                                 -- local date
  start_min INTEGER NOT NULL CHECK (start_min >= 0),
  end_min INTEGER NOT NULL,                           -- start + the program day's estimated minutes (travel not included)
  program_day_id TEXT NOT NULL REFERENCES program_days (id),
  source TEXT NOT NULL CHECK (source IN ('manual', 'finder', 'coach')),
  session_id TEXT REFERENCES workout_sessions (id),  -- the real session of that date (closest plan); deleting the
                                                      -- session sets it back to NULL and the plan back to 'planned'
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'missed', 'cancelled')),
  reminder_at TEXT,                                   -- UTC ISO time of the reminder push; NULL = no reminder
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_min > start_min AND end_min <= 1440)
);
CREATE INDEX gym_plans_date ON gym_plans (date, start_min);
CREATE UNIQUE INDEX gym_plans_session ON gym_plans (session_id) WHERE session_id IS NOT NULL;  -- one plan per session

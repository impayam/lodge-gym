-- 0008_planned_sessions.sql: SPEC-v3 M9c session planner, data option A (SQL and defaults approved by Payam 2026-10-13).
-- Planned sessions live in their own table; workout_sessions is unchanged (its CHECK (status IN ('active','done'))
-- and NOT NULL started_at stay). Start session creates the workout session with the plan's id, so the plan's items
-- keep describing that session's order, sets and groups. Nothing existing changes: two new, empty tables.
CREATE TABLE planned_sessions (
  id TEXT PRIMARY KEY,                               -- client ULID; becomes the workout session's id on Start
  program_day_id TEXT NOT NULL REFERENCES program_days (id),
  status TEXT NOT NULL CHECK (status IN ('planned', 'started', 'discarded')),
  started_at TEXT,                                   -- set by Start session; NULL while planned
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- At most one open plan per program day.
CREATE UNIQUE INDEX planned_sessions_open_day ON planned_sessions (program_day_id) WHERE status = 'planned';

CREATE TABLE session_plan_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES planned_sessions (id),
  exercise_id TEXT NOT NULL REFERENCES exercises (id),
  position INTEGER NOT NULL,
  sets INTEGER NOT NULL,
  reps_min INTEGER,
  reps_max INTEGER,
  per_leg INTEGER NOT NULL DEFAULT 0,                -- not in SPEC-v3's draft: copied from the program day
  is_time INTEGER NOT NULL DEFAULT 0,
  rest_sec INTEGER,
  target_rir_min INTEGER,                            -- not in SPEC-v3's draft: the M8 RIR target the session shows
  target_rir_max INTEGER,
  origin TEXT NOT NULL CHECK (origin IN ('program', 'added', 'replaced', 'ai')),
  replaced_exercise_id TEXT REFERENCES exercises (id),
  group_tag TEXT,                                    -- NULL | 'A' | 'B' …; members adjacent, ordered by position
  group_rest_sec INTEGER,                            -- rest after a full round of the group
  removed_at TEXT,                                   -- soft delete; never hard-deleted
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX session_plan_items_session ON session_plan_items (session_id, position);

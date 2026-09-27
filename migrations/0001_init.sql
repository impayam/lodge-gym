-- Lodge Gym schema (SPEC §5). All timestamps are UTC ISO-8601; local_date is YYYY-MM-DD in the settings timezone.

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  label TEXT
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('full', 'recovery'))
);
CREATE INDEX auth_sessions_expires ON auth_sessions (expires_at);

CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY,
  used_at TEXT
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  label TEXT,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE program_days (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs (id),
  position INTEGER NOT NULL,
  name_fa TEXT NOT NULL,
  name_en TEXT NOT NULL,
  focus_fa TEXT,
  est_minutes INTEGER
);

CREATE TABLE exercises (
  id TEXT PRIMARY KEY,
  name_fa TEXT NOT NULL,
  name_en TEXT NOT NULL,
  muscle_primary TEXT NOT NULL,
  is_lower INTEGER NOT NULL DEFAULT 0,
  equipment TEXT NOT NULL CHECK (equipment IN ('barbell', 'dumbbell', 'cable', 'machine', 'bodyweight')),
  cue_fa TEXT
);

CREATE TABLE day_exercises (
  id TEXT PRIMARY KEY,
  day_id TEXT NOT NULL REFERENCES program_days (id),
  exercise_id TEXT NOT NULL REFERENCES exercises (id),
  position INTEGER NOT NULL,
  sets INTEGER NOT NULL,
  reps_min INTEGER NOT NULL,
  reps_max INTEGER NOT NULL,
  per_leg INTEGER NOT NULL DEFAULT 0,
  is_time INTEGER NOT NULL DEFAULT 0,
  rest_sec INTEGER NOT NULL,
  superset_tag TEXT,
  is_main INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX day_exercises_day ON day_exercises (day_id, position);

CREATE TABLE workout_sessions (
  id TEXT PRIMARY KEY,
  program_day_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'done')),
  unit TEXT NOT NULL CHECK (unit IN ('lb', 'kg')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('app', 'import'))
);
CREATE INDEX workout_sessions_date ON workout_sessions (local_date);

CREATE TABLE set_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  set_index INTEGER NOT NULL,
  weight REAL,
  reps INTEGER,
  seconds INTEGER,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX set_entries_session ON set_entries (session_id);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  local_date TEXT NOT NULL,
  pose TEXT NOT NULL CHECK (pose IN ('front', 'side', 'back', 'other')),
  r2_key TEXT NOT NULL,
  thumb_r2_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX photos_date ON photos (local_date);

CREATE TABLE health_workouts (
  id TEXT PRIMARY KEY,
  external_key TEXT UNIQUE NOT NULL,
  activity_type TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_sec INTEGER,
  active_kcal REAL,
  total_kcal REAL,
  hr_avg REAL,
  hr_max REAL,
  matched_session_id TEXT,
  raw TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE body_metrics (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('body_mass', 'resting_hr', 'hrv', 'sleep_hours')),
  value REAL NOT NULL,
  unit TEXT,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (local_date, kind, source)
);

-- Auth plumbing outside SPEC §5 (flagged for approval):
-- one-time WebAuthn challenges, and the D1 counter table for rate limiting /api/auth/* (SPEC §4).
CREATE TABLE auth_challenges (
  challenge TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  expires_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

// Domain types shared by the Worker and the PWA.

export type Unit = "lb" | "kg";
export type WeekStart = "sat" | "sun" | "mon";
export type Equipment = "barbell" | "dumbbell" | "cable" | "machine" | "bodyweight";
export type SessionStatus = "active" | "done";

export type MonthCalendar = "gregorian" | "jalali";

export interface Settings {
  unit: Unit;
  week_start: WeekStart;
  /** Month boundaries for the monthly report (SPEC §10): Gregorian by default. */
  month_calendar: MonthCalendar;
  relock_minutes: number;
  timezone: string;
}

export interface Exercise {
  id: string;
  name_fa: string;
  name_en: string;
  muscle_primary: string;
  is_lower: boolean;
  equipment: Equipment;
  cue_fa: string;
}

export interface DayExercise {
  id: string;
  exercise_id: string;
  position: number;
  sets: number;
  reps_min: number;
  reps_max: number;
  per_leg: boolean;
  is_time: boolean;
  rest_sec: number;
  superset_tag: string | null;
  is_main: boolean;
}

export interface ProgramDay {
  id: string;
  program_id: string;
  position: number;
  name_fa: string;
  name_en: string;
  focus_fa: string;
  est_minutes: number;
  exercises: DayExercise[];
}

export interface Program {
  id: string;
  name: string;
  days: ProgramDay[];
}

export interface SetEntry {
  id: string;
  exercise_id: string;
  set_index: number;
  weight: number | null;
  reps: number | null;
  seconds: number | null;
  done: boolean;
  /** Reps in reserve: 0, 1, 2, or 3 meaning "3+". Optional. */
  rir?: number | null;
  updated_at: string;
}

export interface WorkoutSession {
  id: string;
  program_day_id: string;
  local_date: string;
  started_at: string;
  ended_at: string | null;
  status: SessionStatus;
  unit: Unit;
  note: string;
  created_at: string;
  updated_at: string;
  source: "app" | "import";
  sets: SetEntry[];
}

/** An Apple Watch workout received through the Shortcuts bridge. */
export interface HealthWorkout {
  id: string;
  activity_type: string | null;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
  active_kcal: number | null;
  total_kcal: number | null;
  hr_avg: number | null;
  hr_max: number | null;
  matched_session_id: string | null;
  received_at?: string;
  /** "session": computed from Heart Rate / Active Energy samples for that session; "workout": a watch workout (legacy fields). */
  kind: "session" | "workout";
}

export type Pose = "front" | "side" | "back" | "other";

/** Progress photo metadata (SPEC §8); the images live in R2. */
export interface Photo {
  id: string;
  session_id: string | null;
  local_date: string;
  pose: Pose;
  width: number;
  height: number;
  bytes: number;
  created_at: string;
}

/** A body metric (SPEC §5 body_metrics); the app writes body_mass with source "manual". */
export interface BodyMetric {
  local_date: string;
  kind: "body_mass" | "resting_hr" | "hrv" | "sleep_hours";
  value: number;
  unit: string | null;
  source: string;
}

export interface Bootstrap {
  settings: Settings;
  program: Program;
  other_days: Omit<ProgramDay, "exercises">[];
  exercises: Exercise[];
  sessions: WorkoutSession[];
  /** Watch workouts matched to the sessions above. */
  watch: HealthWorkout[];
  /** Body metrics for the same 60-day window. */
  body: BodyMetric[];
  server_time: string;
}

export const DEFAULT_SETTINGS: Settings = {
  unit: "lb",
  week_start: "mon",
  month_calendar: "gregorian",
  relock_minutes: 0,
  timezone: "America/Denver",
};

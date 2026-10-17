// Domain types shared by the Worker and the PWA.

import type { CalendarSettings, GymPlan, WorkShift } from "./calendar";
import type { Category } from "./category";
import type { GeneratorInput } from "./generator/model";
import type { Region } from "./regions";
import type { RotationStatus } from "./rotation";
import type { SessionPlan } from "./plan";

export type Unit = "lb" | "kg";
export type WeekStart = "sat" | "sun" | "mon";
export type Equipment = "barbell" | "dumbbell" | "cable" | "machine" | "bodyweight";
export type SessionStatus = "active" | "done";

export interface Settings {
  unit: Unit;
  week_start: WeekStart;
  relock_minutes: number;
  timezone: string;
  /** The session's rest timer (Settings → Training, Payam 2026-10-16): between sets of one exercise, seconds. */
  rest_between_sets_sec: number;
  /** After an exercise's (or a group's) last set, before the next card, seconds. */
  rest_next_exercise_sec: number;
}

/** SPEC-v2 §7.2; the M14 sources (SPEC-v11 A1): wger, everkinetic, exercisedb, liftosaur, exercemus. */
export type ExerciseSource = "seed" | "fedb" | "manual" | "custom" | "wger" | "everkinetic" | "exercisedb" | "liftosaur" | "exercemus";
export type Pattern = "squat" | "hinge" | "lunge" | "h_push" | "v_push" | "h_pull" | "v_pull" | "isolation" | "core" | "carry";

/** Image or animation of an exercise; library media lives in the private R2 bucket (served by /api/library/media). */
export interface ExerciseMedia {
  kind: "image" | "gif";
  r2_key?: string;
  url?: string;
  /** An image from an open-licence source: its own licence and author (SPEC-v11 A1). */
  license?: string;
  author?: string;
}

/** A region tag (SPEC-v11 A3, exercise_regions): the part of a muscle an exercise emphasises, and the evidence for it. */
export interface ExerciseRegion {
  region: Region;
  emphasis: "primary" | "secondary";
  evidence: "strong" | "moderate" | "weak";
}

export interface Exercise {
  id: string;
  name_fa: string;
  name_en: string;
  /** Canonical muscle key (worker/lib/muscles.ts); rows written before SPEC-v2 may hold a report group key. */
  muscle_primary: string;
  is_lower: boolean;
  equipment: Equipment;
  cue_fa: string;
  /** English form cue (SPEC-v2 M6). */
  cue_en: string | null;
  /** SPEC-v2 §7.2 library columns. */
  source: ExerciseSource;
  muscles_secondary: string[];
  pattern: Pattern | null;
  mechanic: "compound" | "isolation" | null;
  level: "beginner" | "intermediate" | "expert" | null;
  media: ExerciseMedia[];
  instructions_en: string[];
  archived_at: string | null;
  /** SPEC-v2 §7.4: only strength, powerlifting and olympic weightlifting count toward muscle volume. */
  category: Category | null;
  /** Licence of the stored content and who to credit (migration 0013); null when nothing licensed is stored. */
  license: string | null;
  license_author: string | null;
  /** Region tags, primary first (SPEC-v11 A3). */
  regions: ExerciseRegion[];
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
  /** Target reps in reserve for the slot (SPEC-v2 §8.4); null on the seed programs. */
  target_rir_min: number | null;
  target_rir_max: number | null;
  /** Generator slot (SPEC-v2 §8.7); null on the seed programs. */
  slot: "main" | "secondary" | "accessory" | "isolation" | "core" | null;
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

/** One period a program was the active program (SPEC-v2 §8.7). */
export interface ProgramActivation {
  id: string;
  program_id: string;
  started_at: string;
  ended_at: string | null;
}

export type ProgramStatus = "active" | "draft" | "archived";

/** Program metadata (SPEC-v2 §8.7): the history timeline, drafts and the program each past week is scored against. */
export interface ProgramInfo {
  id: string;
  name: string;
  /** 'seed_full_body' | 'seed_upper_lower' for the seed programs, otherwise a generator style. */
  style: string | null;
  days_per_week: number | null;
  /** Generator inputs and seed (generated programs). */
  params: GeneratorInput | null;
  /** "session": a new version made by "Apply to program" from a session plan (SPEC-v3 M9c); "coach": a coach draft
   *  added with Add to Planner (SPEC-v9 M12). */
  generated_by: "seed" | "generator" | "session" | "coach" | null;
  created_at: string;
  approved_at: string | null;
  archived_at: string | null;
  status: ProgramStatus;
  activations: ProgramActivation[];
}

/** A program with its days and exercises. */
export type ProgramVersion = ProgramInfo & { days: ProgramDay[] };

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
  /** Exercise added during the session, not in the day's plan (SPEC-v2 §7.3). */
  is_extra?: boolean;
  /** Display order of an extra exercise inside the session. */
  position?: number | null;
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

/** Weekly review written by Claude into D1 (table weekly_reviews). */
export interface WeeklyReview {
  id: string;
  week_start: string;
  created_at: string;
  summary_fa: string;
  highlights: string[];
  suggestions: string[];
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
  /** Every program with its activations (SPEC-v2 §8.6 history timeline). */
  programs: ProgramInfo[];
  exercises: Exercise[];
  sessions: WorkoutSession[];
  /** Watch workouts matched to the sessions above. */
  watch: HealthWorkout[];
  /** Body metrics for the same 60-day window. */
  body: BodyMetric[];
  /** Latest weekly review, if any. */
  review: WeeklyReview | null;
  /** Session plans (SPEC-v3 M9c): every open plan, and the plans of the sessions above. */
  plans: SessionPlan[];
  /** Training calendar (SPEC-v10 M13): shifts and gym plans from the same 60 days on, and the calendar settings. A
   *  bootstrap cached before M13 has none. */
  calendar?: { shifts: WorkShift[]; plans: GymPlan[]; settings: CalendarSettings };
  /** Rotation status of every exercise in the active program (SPEC-v11 Phase B). A bootstrap cached before has none. */
  rotation?: RotationStatus[];
  server_time: string;
}

export const DEFAULT_SETTINGS: Settings = {
  unit: "lb",
  week_start: "mon",
  relock_minutes: 0,
  timezone: "America/Denver",
  rest_between_sets_sec: 30,
  rest_next_exercise_sec: 120,
};

/** The choices Settings → Training offers for the rest timer (the API takes these values only). */
export const REST_BETWEEN_SETS_CHOICES = [15, 30, 45, 60, 75, 90, 120, 150, 180] as const;
export const REST_NEXT_EXERCISE_CHOICES = [30, 60, 90, 120, 150, 180, 240, 300] as const;

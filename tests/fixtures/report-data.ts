// Seeded fixture for report tests: the real program seed plus a small, hand-computed training history.

import seed from "../../seed/program.json";
import type { BodyMetric, Exercise, HealthWorkout, Photo, Program, Settings, SetEntry, Unit, WorkoutSession } from "../../worker/lib/types";
import type { ReportData } from "../../worker/lib/reports";

export function program(): Program {
  const p = seed.programs.find((x) => x.active === 1)!;
  return {
    id: p.id,
    name: p.name,
    days: p.days.map((d, di) => ({
      id: d.id,
      program_id: p.id,
      position: di + 1,
      name_fa: d.name_fa,
      name_en: d.name_en,
      focus_fa: d.focus_fa,
      est_minutes: d.est_minutes,
      exercises: d.ex.map((x, xi) => ({
        id: `${d.id}_${xi + 1}`,
        exercise_id: x.x,
        position: xi + 1,
        sets: x.sets,
        reps_min: x.reps[0],
        reps_max: x.reps[1],
        per_leg: Boolean((x as { per_leg?: number }).per_leg),
        is_time: Boolean((x as { time?: number }).time),
        rest_sec: x.rest,
        superset_tag: (x as { tag?: string }).tag ?? null,
        is_main: Boolean((x as { main?: number }).main),
      })),
    })),
  };
}

export const exercises = (): Exercise[] => seed.exercises.map((e) => ({ ...e, is_lower: e.is_lower === 1, equipment: e.equipment as Exercise["equipment"] }));

let n = 0;
/** sets: [exercise, count, weight, reps, seconds?] */
function session(id: string, day: string, date: string, unit: Unit, sets: [string, number, number | null, number | null, number?][], note = ""): WorkoutSession {
  const list: SetEntry[] = [];
  for (const [ex, count, w, r, sec] of sets)
    for (let i = 0; i < count; i++)
      list.push({ id: `${id}-${n++}`, exercise_id: ex, set_index: i, weight: w, reps: r, seconds: sec ?? null, done: true, rir: i === 0 ? 2 : null, updated_at: `${date}T23:30:00.000Z` });
  return {
    id,
    program_day_id: day,
    local_date: date,
    started_at: `${date}T23:00:00.000Z`,
    ended_at: `${addOne(date)}T00:00:00.000Z`,
    status: "done",
    unit,
    note,
    created_at: `${date}T23:00:00.000Z`,
    updated_at: `${date}T23:59:00.000Z`,
    source: "app",
    sets: list,
  };
}
const addOne = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);

export function reportData(settings: Partial<Settings> = {}): ReportData {
  const sessions = [
    session("E0", "D2", "2026-08-20", "lb", [["squat", 4, 180, 5]]),
    session("P1", "D1", "2026-09-15", "lb", [["bench", 4, 130, 5]]),
    session("P2", "D4", "2026-09-18", "lb", [["deadlift", 3, 225, 5], ["ohp", 3, 95, 6]]),
    session("S1", "D1", "2026-09-21", "lb", [["bench", 4, 135, 5], ["incline_db", 3, 40, 10], ["rdl", 3, 155, 8], ["cable_row", 3, 100, 10], ["lateral", 3, 15, 12], ["facepull", 3, 40, 15]], "خوب بود"),
    session("S2", "D2", "2026-09-23", "lb", [["squat", 4, 185, 5], ["leg_press", 3, 270, 10], ["incline_bb", 3, 115, 8], ["pulldown", 3, 120, 10], ["calf_stand", 3, 100, 12], ["plank", 3, null, null, 45]]),
    session("S3", "D3", "2026-09-26", "kg", [["cs_row", 4, 25, 8], ["pullup", 3, -10, 8], ["bulgarian", 3, 15, 8], ["fly", 3, 15, 12], ["curl", 3, 12, 10], ["oh_tri", 3, 20, 10]]),
    // An unfinished session never counts.
    { ...session("A1", "D4", "2026-09-27", "lb", [["deadlift", 3, 500, 5]]), status: "active" as const, ended_at: null },
  ];
  const w = (id: string, sid: string, kind: "session" | "workout", kcal: number, hr: number): HealthWorkout => ({
    id, activity_type: null, started_at: "", ended_at: null, duration_sec: null, active_kcal: kcal, total_kcal: null, hr_avg: hr, hr_max: null, matched_session_id: sid, kind,
  });
  const body: BodyMetric[] = [
    { local_date: "2026-09-15", kind: "body_mass", value: 180, unit: "lb", source: "manual" },
    { local_date: "2026-09-17", kind: "body_mass", value: 181, unit: "lb", source: "manual" },
    { local_date: "2026-09-22", kind: "body_mass", value: 179, unit: "lb", source: "manual" },
    { local_date: "2026-09-24", kind: "body_mass", value: 81, unit: "kg", source: "shortcut" },
    { local_date: "2026-09-24", kind: "resting_hr", value: 58, unit: null, source: "shortcut" },
  ];
  const photo = (id: string, date: string, pose: Photo["pose"]): Photo => ({ id, session_id: null, local_date: date, pose, width: 1200, height: 1600, bytes: 1, created_at: `${date}T12:00:00.000Z` });
  return {
    settings: { unit: "lb", week_start: "mon", month_calendar: "gregorian", relock_minutes: 0, timezone: "America/Denver", ...settings },
    program: program(),
    exercises: exercises(),
    sessions,
    watch: [w("W1", "S1", "session", 300, 120), w("W2", "S2", "workout", 250, 110), w("W3", "S2", "session", 260, 112)],
    body,
    photos: [photo("F1", "2026-09-05", "front"), photo("F2", "2026-09-26", "front"), photo("F3", "2026-09-10", "side"), photo("F0", "2026-08-30", "front")],
  };
}

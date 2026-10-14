// The weekly motivational line of the training overview (Payam, 2026-10-14), the pure part. The app decides what the
// line is about, which numbers it must state and whether a week went badly; the model only phrases it. Weeks run Monday
// to Sunday, and the tone follows the local day the overview is written:
//   Monday–Tuesday    start  an encouraging start, from last week's numbers and today's session
//   Wednesday–Friday  mid    progress so far this week: sessions done against planned up to today, records, e1RM gains
//   Saturday–Sunday   end    the week's result: sessions done against planned for the week, records, main-lift changes
// The first overview of a week also gives last week's result when no overview was written last Saturday or Sunday.
// A week is bad only when fewer than half its planned sessions were done; lift drops stay warnings in the overview.

import { nextDay, versionAliases, weekRange } from "../cycle";
import { bestIn, firstActivation, mainLifts, plannedSessions, programOn, type ReportData } from "../reports";
import { addDays, localDate } from "../time";
import type { WorkoutSession } from "../types";
import { sessionDay } from "./report";

export type WeekPhase = "start" | "mid" | "end";
export type WeekKey = "last_week" | "this_week";

/** At most this many records listed per week. */
const RECORDS_MAX = 5;

export interface WeekFacts {
  start: string;
  end: string;
  /** Sessions planned count up to this day: the week's end, or today for this week's progress. */
  through: string;
  sessions_done: number;
  /** Whole planned sessions from the week's start to `through` (the overview's rule: first activation, program of each day). */
  sessions_planned: number;
  /** Fewer than half the planned sessions done. Never with nothing planned. */
  bad: boolean;
  /** New records: the best e1RM in the week beat the best before it (the weekly report's rule). */
  records: { name: string; weight: number; reps: number; e1rm: number; previous_e1rm: number }[];
  /** Main lifts trained in the week: best e1RM against the week before. */
  main_lifts: { name: string; e1rm: number; previous_week_e1rm: number | null; change_pct: number | null }[];
}

export interface MotivationInput {
  phase: WeekPhase;
  weekday: string;
  /** The first overview of the week, and none was written last Saturday or Sunday: give last week's result too. */
  announce_last_week: boolean;
  /** The weeks the line reports; it must state each one's sessions_done and sessions_planned. */
  cover: WeekKey[];
  last_week: WeekFacts;
  this_week: WeekFacts;
  /** A session finished today, if any. */
  today_session: { day: string; sets_done: number; records: WeekFacts["records"] } | null;
  /** The next program day by the app's rotation: the concrete next step. */
  next_session: string | null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The phase of a local date: Monday–Tuesday start, Wednesday–Friday mid, Saturday–Sunday end. */
export function phaseOf(date: string): { phase: WeekPhase; weekday: string } {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { phase: dow === 1 || dow === 2 ? "start" : dow === 0 || dow === 6 ? "end" : "mid", weekday: WEEKDAYS[dow] };
}

/** Records among `sessions` (best e1RM beats the best of every done session before `from`). */
function recordsIn(d: ReportData, done: WorkoutSession[], from: string, to: string): WeekFacts["records"] {
  const unit = d.settings.unit;
  const inRange = done.filter((s) => s.local_date >= from && s.local_date <= to);
  const before = done.filter((s) => s.local_date < from);
  const ids = [...new Set(inRange.flatMap((s) => s.sets.filter((x) => x.done).map((x) => x.exercise_id)))];
  const name = (id: string) => d.exercises.find((e) => e.id === id)?.name_en ?? id;
  return ids
    .map((id) => ({ id, best: bestIn(inRange, id, unit), previous: bestIn(before, id, unit) }))
    .filter((x) => x.best && x.previous && x.best.e1rm > x.previous.e1rm)
    .map((x) => ({ name: name(x.id), weight: x.best!.weight, reps: x.best!.reps, e1rm: x.best!.e1rm, previous_e1rm: x.previous!.e1rm }))
    .sort((a, b) => (b.e1rm - b.previous_e1rm) / b.previous_e1rm - (a.e1rm - a.previous_e1rm) / a.previous_e1rm)
    .slice(0, RECORDS_MAX);
}

function weekFacts(d: ReportData, done: WorkoutSession[], start: string, through: string, since: string | null): WeekFacts {
  const end = addDays(start, 6);
  const unit = d.settings.unit;
  const week = done.filter((s) => s.local_date >= start && s.local_date <= end);
  const prev = done.filter((s) => s.local_date >= addDays(start, -7) && s.local_date < start);
  const from = since && since > start ? since : start;
  const planned = from > through ? 0 : Math.round(plannedSessions(d, from, through));
  const name = (id: string) => d.exercises.find((e) => e.id === id)?.name_en ?? id;
  const main_lifts = mainLifts(programOn(d, end)).flatMap((id) => {
    const best = bestIn(week, id, unit);
    if (!best) return [];
    const before = bestIn(prev, id, unit);
    return [{ name: name(id), e1rm: best.e1rm, previous_week_e1rm: before?.e1rm ?? null, change_pct: before ? round1(((best.e1rm - before.e1rm) / before.e1rm) * 100) : null }];
  });
  return {
    start,
    end,
    through,
    sessions_done: week.length,
    sessions_planned: planned,
    bad: planned > 0 && week.length * 2 < planned,
    records: recordsIn(d, done, start, end),
    main_lifts,
  };
}

/**
 * The motivation block on local `today`. `previousOverviews` are the creation times (ISO) of earlier ok overviews, to
 * know whether last week's result was already given. Null when no covered week has anything planned or done.
 */
export function buildMotivation(d: ReportData, today: string, previousOverviews: string[]): MotivationInput | null {
  const tz = d.settings.timezone;
  const done = d.sessions.filter((s) => s.status === "done" && s.local_date <= today);
  const { phase, weekday } = phaseOf(today);
  const thisStart = weekRange(today, "mon").start;
  const lastStart = addDays(thisStart, -7);
  const since = firstActivation(d);
  const last_week = weekFacts(d, done, lastStart, addDays(lastStart, 6), since);
  // Progress counts plans up to today; the week's result (Saturday–Sunday) counts the whole week's plan.
  const this_week = weekFacts(d, done, thisStart, phase === "end" ? addDays(thisStart, 6) : today, since);

  const earlier = previousOverviews.map((iso) => localDate(tz, iso));
  const firstThisWeek = !earlier.some((x) => x >= thisStart && x < today);
  const weekendCovered = earlier.some((x) => x === addDays(thisStart, -2) || x === addDays(thisStart, -1));
  const announce_last_week = firstThisWeek && !weekendCovered;

  const reported = (w: WeekFacts) => w.sessions_planned > 0 || w.sessions_done > 0;
  const cover: WeekKey[] = phase === "start" ? ["last_week"] : announce_last_week ? ["last_week", "this_week"] : ["this_week"];
  const kept = cover.filter((k) => reported(k === "last_week" ? last_week : this_week));
  if (!kept.length) return null;

  const todays = done.filter((s) => s.local_date === today);
  const today_session = todays.length
    ? {
        day: todays.map((s) => sessionDay(d, s.program_day_id)?.name_en ?? s.program_day_id).join(" + "),
        sets_done: todays.reduce((n, s) => n + s.sets.filter((x) => x.done).length, 0),
        records: recordsIn(d, done, today, today),
      }
    : null;

  const programs = d.programs ?? [];
  const alias = versionAliases(programs, programs.flatMap((p) => p.days), d.program.days);
  const next = nextDay(
    d.program.days.map((x) => x.id),
    d.sessions,
    alias
  );
  const next_session = next.dayId ? (sessionDay(d, next.dayId)?.name_en ?? null) : null;

  return { phase, weekday, announce_last_week, cover: kept, last_week, this_week, today_session, next_session };
}

/** Generic praise the line may not use when a week it reports went badly. */
export const PRAISE_FA = ["آفرین", "عالی", "فوق‌العاده", "بی‌نظیر", "معرکه", "درخشان", "قهرمان", "دمت گرم", "ایول", "حرف نداشت"];

/** The longest line kept. */
export const MOTIVATION_MAX = 400;

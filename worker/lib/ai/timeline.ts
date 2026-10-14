// History → Reports timeline (SPEC-v7 M9d, design approved 2026-10-13): every saved report on the date it belongs to.
// Pure, so the date rules are unit-tested:
//   session report    the session's date (its latest report, when that one is ok)
//   training overview the date of the session it was written after, or the local date it was written (Regenerate)
//   weekly review     the last day of the week it covers (week_start + 6, whatever weekday the week starts on)

import { addDays, localDate } from "../time";

export type TimelineKind = "session" | "overview" | "review";

export interface TimelineItem {
  kind: TimelineKind;
  /** The local date it sits on (rules above). */
  date: string;
  /** session: the session id (its report opens by session); overview: the overview row; review: the review row. */
  id: string;
  created_at: string;
  /** session: the session's program day; overview: the day of the session it was written after (null for Regenerate). */
  program_day_id: string | null;
  /** review: the first day of the week it covers. */
  week_start: string | null;
}

export interface TimelineRows {
  reports: { session_id: string; local_date: string; program_day_id: string; created_at: string }[];
  overviews: { id: string; created_at: string; trigger_date: string | null; trigger_day: string | null }[];
  reviews: { id: string; week_start: string; created_at: string }[];
}

const ORDER: Record<TimelineKind, number> = { session: 0, overview: 1, review: 2 };

/** Every report as a timeline item: newest date first; on one date the session report, then overviews, then reviews. */
export function buildTimeline(rows: TimelineRows, timezone: string): TimelineItem[] {
  const items: TimelineItem[] = [
    ...rows.reports.map((r) => ({ kind: "session" as const, date: r.local_date, id: r.session_id, created_at: r.created_at, program_day_id: r.program_day_id, week_start: null })),
    ...rows.overviews.map((o) => ({
      kind: "overview" as const,
      date: o.trigger_date ?? localDate(timezone, o.created_at),
      id: o.id,
      created_at: o.created_at,
      program_day_id: o.trigger_date ? o.trigger_day : null,
      week_start: null,
    })),
    ...rows.reviews.map((r) => ({ kind: "review" as const, date: addDays(r.week_start, 6), id: r.id, created_at: r.created_at, program_day_id: null, week_start: r.week_start })),
  ];
  return items.sort((a, b) => b.date.localeCompare(a.date) || ORDER[a.kind] - ORDER[b.kind] || b.created_at.localeCompare(a.created_at));
}

/** The timeline's dates, newest first, each with its items in display order. */
export function timelineDates(items: TimelineItem[]): { date: string; items: TimelineItem[] }[] {
  const out: { date: string; items: TimelineItem[] }[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.date === it.date) last.items.push(it);
    else out.push({ date: it.date, items: [it] });
  }
  return out;
}

import { describe, expect, it } from "vitest";
import { buildTimeline, timelineDates, type TimelineRows } from "../../worker/lib/ai/timeline";

// SPEC-v7 M9d, History → Reports timeline (approved 2026-10-13): the date each saved report sits on.
const TZ = "America/Denver";

describe("report timeline dates", () => {
  it("a weekly review sits on the last day of the week it covers, whatever weekday the week starts on", () => {
    const rows: TimelineRows = {
      reports: [],
      overviews: [],
      reviews: [
        // The production rows (2026-10-13): Monday–Sunday weeks, written the Monday after.
        { id: "wr-2026-09-21", week_start: "2026-09-21", created_at: "2026-09-28T13:55:00Z" },
        { id: "wr-2026-09-28", week_start: "2026-09-28", created_at: "2026-10-05T13:58:00Z" },
        { id: "wr-2026-10-05", week_start: "2026-10-05", created_at: "2026-10-12T13:54:00Z" },
        // A Wednesday–Tuesday week: Sep 30 – Oct 6.
        { id: "wed", week_start: "2026-09-30", created_at: "2026-10-07T09:00:00Z" },
      ],
    };
    expect(buildTimeline(rows, TZ).map((i) => [i.id, i.date])).toEqual([
      ["wr-2026-10-05", "2026-10-11"],
      ["wed", "2026-10-06"],
      ["wr-2026-09-28", "2026-10-04"],
      ["wr-2026-09-21", "2026-09-27"],
    ]);
  });

  it("an overview sits on the date of the session it was written after; a Regenerate on the local day it was written", () => {
    const items = buildTimeline(
      {
        reports: [{ session_id: "S1", local_date: "2026-10-12", program_day_id: "D2", created_at: "2026-10-13T03:10:00Z" }],
        overviews: [
          // Written after the Oct 12 session, past midnight UTC: still Oct 12.
          { id: "O1", created_at: "2026-10-13T03:12:00Z", trigger_date: "2026-10-12", trigger_day: "D2" },
          // Regenerate at 21:00 Denver on Oct 13 (03:00 UTC on Oct 14): Oct 13, no session that day.
          { id: "O2", created_at: "2026-10-14T03:00:00Z", trigger_date: null, trigger_day: null },
          // Regenerate on the session's own day: listed with it.
          { id: "O3", created_at: "2026-10-12T20:00:00Z", trigger_date: null, trigger_day: null },
        ],
        reviews: [],
      },
      TZ
    );
    expect(items.map((i) => [i.kind, i.id, i.date, i.program_day_id])).toEqual([
      ["overview", "O2", "2026-10-13", null],
      ["session", "S1", "2026-10-12", "D2"],
      ["overview", "O1", "2026-10-12", "D2"],
      ["overview", "O3", "2026-10-12", null],
    ]);
    // Grouped by date for the timeline's columns and the chooser.
    expect(timelineDates(items).map((d) => [d.date, d.items.map((i) => i.id)])).toEqual([
      ["2026-10-13", ["O2"]],
      ["2026-10-12", ["S1", "O1", "O3"]],
    ]);
  });
});

// A session as a card (SPEC-v8 §6.04): the day's number in a well, its name and date, a PR badge when it set a
// record, then minutes, sets and its top lift. Used by History and Home → Recent sessions; tapping opens the session.

import type { WorkoutSession } from "../../../worker/lib/types";
import { dateShort, fmtNum, hm, minutesBetween } from "../format";
import { dayTitle, liftLabel } from "../lib/lifts";
import { hasRecord, topLift } from "../lib/records";
import type { BootData } from "../localdb";
import { dayInfo } from "../model";
import { navigate } from "../store";

export function SessionCard({ s, boot, all }: { s: WorkoutSession; boot: BootData; all: WorkoutSession[] }) {
  const d = dayInfo(boot, s.program_day_id);
  const tz = boot.settings.timezone;
  const unit = boot.settings.unit;
  const mins = minutesBetween(s.started_at, s.ended_at);
  const sets = s.sets.filter((x) => x.done).length;
  // Archived upper/lower days keep their letter; every other day shows its position in its program.
  const badge = d.legacy && /^(Upper|Lower) [AB]$/.test(d.name_en) ? d.name_en.slice(-1) : d.position ? fmtNum(d.position) : "–";
  const day = boot.program.days.find((x) => x.id === s.program_day_id);
  const top = topLift(s, day?.exercises ?? [], unit);
  const topName = top ? liftLabel(top.exercise_id, boot.exercises.find((e) => e.id === top.exercise_id)?.name_en ?? top.exercise_id) : null;
  const record = s.status === "done" && hasRecord(all, s, unit);
  const times = `${hm(s.started_at, tz)}${s.ended_at ? "–" + hm(s.ended_at, tz) : ""}`;

  return (
    <button type="button" class="card press l-col l-gap-12 l-full session-card" data-testid="session-card" onClick={() => navigate("session", s.id)}>
      <span class="l-row l-gap-12 l-full">
        <span class="well icon-well icon-well--44 big-num big-num--22 t-orange num" aria-hidden="true">
          {badge}
        </span>
        <span class="l-col l-gap-2 l-grow">
          <span class="t-title">{dayTitle(d.name_en)}</span>
          <span class="caption num">
            {dateShort(s.local_date)} · {times}
          </span>
        </span>
        {s.status === "active" ? <span class="badge">Open</span> : record ? (
          <span class="badge">
            <span aria-hidden="true">PR</span>
            <span class="l-sr">Personal record</span>
          </span>
        ) : null}
      </span>
      <span class="l-grid-3 l-gap-8 l-full">
        <span class="l-col">
          <span class="big-num big-num--22 num">{mins != null ? fmtNum(mins) : "–"}</span>
          <span class="caption">minutes</span>
        </span>
        <span class="l-col">
          <span class="big-num big-num--22 num">{fmtNum(sets)}</span>
          <span class="caption">sets</span>
        </span>
        <span class="l-col">
          <span class="big-num big-num--22 num">
            {top ? fmtNum(top.set.weight) : "–"}
            {top ? <span class="big-num__unit"> {unit}</span> : null}
          </span>
          <span class="caption">{top && topName ? `${topName} × ${fmtNum(top.set.reps)}` : "top set"}</span>
        </span>
      </span>
    </button>
  );
}

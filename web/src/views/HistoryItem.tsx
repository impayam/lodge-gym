import type { WorkoutSession } from "../../../worker/lib/types";
import { dateLong, fmtNum, hm, minutesBetween, plural } from "../format";
import type { BootData } from "../localdb";
import { dayInfo } from "../model";
import { navigate } from "../store";

export function HistoryItem({ s, boot }: { s: WorkoutSession; boot: BootData }) {
  const d = dayInfo(boot, s.program_day_id);
  const tz = boot.settings.timezone;
  const mins = minutesBetween(s.started_at, s.ended_at);
  const setsDone = s.sets.filter((x) => x.done).length;
  // Archived upper/lower days keep their letter; every other day shows its position in its program.
  const badge = d.legacy && /^(Upper|Lower) [AB]$/.test(d.name_en) ? d.name_en.slice(-1) : d.position ? fmtNum(d.position) : "–";
  return (
    <button type="button" class="hist" onClick={() => navigate("session", s.id)}>
      <span class={`dot${d.legacy ? " legacy" : ""}`}>{badge}</span>
      <span class="meta">
        <b>
          {d.name_en} {s.status === "active" ? <span class="pill">open</span> : null}
        </b>
        <small>{dateLong(s.local_date)}</small>
      </span>
      <span class="side num">
        {hm(s.started_at, tz)}
        {s.ended_at ? "–" + hm(s.ended_at, tz) : ""}
        <br />
        {mins != null ? `${fmtNum(mins)} min` : ""}
        {setsDone ? `${mins != null ? " · " : ""}${plural(setsDone, "set")}` : ""}
      </span>
    </button>
  );
}

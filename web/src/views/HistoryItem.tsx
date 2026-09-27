import { faNum } from "../../../worker/lib/digits";
import type { WorkoutSession } from "../../../worker/lib/types";
import { faHM, greg, jalali, minutesBetween } from "../format";
import type { BootData } from "../localdb";
import { dayInfo } from "../model";
import { navigate } from "../store";

export function HistoryItem({ s, boot }: { s: WorkoutSession; boot: BootData }) {
  const d = dayInfo(boot, s.program_day_id);
  const tz = boot.settings.timezone;
  const mins = minutesBetween(s.started_at, s.ended_at);
  const setsDone = s.sets.filter((x) => x.done).length;
  const badge = d.legacy ? d.name_en.replace(/^(Upper|Lower) /, "") : faNum(d.position);
  return (
    <button type="button" class="hist" onClick={() => navigate("session", s.id)}>
      <span class={`dot${d.legacy ? " legacy" : ""}`}>{badge}</span>
      <span class="meta">
        <b>
          {d.name_fa} {s.status === "active" ? <span class="pill">باز</span> : null}
        </b>
        <small>
          {jalali(s.local_date)} · <span class="ltr">{greg(s.local_date)}</span>
        </small>
      </span>
      <span class="side num">
        {faHM(s.started_at, tz)}
        {s.ended_at ? "–" + faHM(s.ended_at, tz) : ""}
        <br />
        {mins != null ? `${faNum(mins)} دقیقه` : ""}
        {setsDone ? `${mins != null ? " · " : ""}${faNum(setsDone)} ست` : ""}
      </span>
    </button>
  );
}

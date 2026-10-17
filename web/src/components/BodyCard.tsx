// Profile → Body weight (SPEC-v8 §6.06; on Profile under My body since SPEC-v12 M15): the last logged value, and the
// trend of the daily values in the app's 60-day window; tapping the chart shows that day's value. Sizes are on My body.

import { useState } from "preact/hooks";
import { bodyDaily } from "../../../worker/lib/reports";
import { dayMonth, fmtNum, plural } from "../format";
import { useStore } from "../store";
import { TimeChart, type Pick } from "./TimeChart";

export function BodyCard() {
  const boot = useStore((s) => s.boot)!;
  const unit = boot.settings.unit;
  const days = [...bodyDaily({ body: boot.body ?? [] }, unit)].map(([date, value]) => ({ date, value }));
  const [picked, setPicked] = useState<Pick | null>(null);
  const last = days[days.length - 1];
  const shown = picked && picked.values[0] != null ? { date: picked.date, value: picked.values[0] } : last;

  return (
    <section class="card l-col l-gap-12" data-testid="body-weight-card">
      <div class="card__head">
        <h2 class="card__title l-m0">Body weight</h2>
        {days.length ? <span class="caption num">{plural(days.length, "day")} logged</span> : null}
      </div>
      {shown ? (
        <>
          <div class="l-row l-baseline l-gap-8" aria-live="polite">
            <span class="big-num big-num--40 num" data-testid="body-weight">
              {fmtNum(shown.value)}
              <span class="big-num__unit"> {unit}</span>
            </span>
            <span class="caption">{shown === last ? `body weight, last logged ${dayMonth(shown.date)}` : `body weight, ${dayMonth(shown.date)}`}</span>
          </div>
          {days.length > 1 ? (
            <TimeChart
              series={[{ label: "Body weight", color: "--violet", points: days }]}
              height={56}
              grid={false}
              unit={unit}
              xLabels={false}
              label={`Body weight from ${fmtNum(days[0].value)} ${unit} on ${dayMonth(days[0].date)} to ${fmtNum(last.value)} ${unit} on ${dayMonth(last.date)}, ${plural(days.length, "day")} logged`}
              onPick={setPicked}
              testid="body-chart"
            />
          ) : null}
        </>
      ) : (
        <p class="state l-m0">No body weight logged yet. You can log it when you finish a session.</p>
      )}
    </section>
  );
}

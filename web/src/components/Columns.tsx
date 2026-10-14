// Columns per week (SPEC-v8 §8: bars are HTML/CSS, not uPlot): one series in --series-2, an optional dashed target
// line, a tap picks a column and the line above reads it out (the last one at first). Every chart has a Table view.

import { useState } from "preact/hooks";
import { dayMonth } from "../format";

export interface Col {
  /** The week's first day. */
  date: string;
  value: number;
}

interface Props {
  cols: Col[];
  /** Unit after the value, e.g. "sessions" or "lb × reps". */
  unit: string;
  fmt: (n: number) => string;
  /** A dashed line at the target, explained under the chart. */
  target?: number;
  /** Summary read by VoiceOver. */
  label: string;
  testid?: string;
}

export function Columns({ cols, unit, fmt, target, label, testid }: Props) {
  const [pick, setPick] = useState<number | null>(cols.length ? cols.length - 1 : null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, target ?? 0, ...cols.map((c) => c.value)) * 1.1;
  const picked = pick != null ? cols[pick] : null;
  const pct = (n: number) => `${Math.round((n / max) * 1000) / 10}%`;
  return (
    <div class="l-col l-gap-8" data-testid={testid}>
      {table ? (
        <table class="data-table num" data-testid="chart-table">
          <caption class="l-sr">{label}</caption>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col">{unit[0].toUpperCase() + unit.slice(1)}</th>
            </tr>
          </thead>
          <tbody>
            {cols.map((c) => (
              <tr>
                <td>{dayMonth(c.date)}</td>
                <td>{fmt(c.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <div class="chart-readout num" aria-live="polite">
            {picked ? `Week of ${dayMonth(picked.date)}: ${fmt(picked.value)} ${unit}` : ""}
          </div>
          <div class="columns" role="group" aria-label={label} data-picked={pick != null ? "true" : "false"}>
            {target ? <span class="columns__target" style={{ bottom: pct(target) }} aria-hidden="true" /> : null}
            {cols.map((c, i) => (
              <button type="button" class="press" aria-pressed={pick === i} aria-label={`Week of ${dayMonth(c.date)}: ${fmt(c.value)} ${unit}`} onClick={() => setPick(i)}>
                <span class="columns__bar" style={{ height: c.value > 0 ? pct(c.value) : "0" }} />
              </button>
            ))}
          </div>
          {cols.length ? (
            <div class="l-row l-between chart-axis" aria-hidden="true">
              <span>{dayMonth(cols[0].date)}</span>
              <span>{dayMonth(cols[cols.length - 1].date)}</span>
            </div>
          ) : null}
          {target ? <span class="caption">Dashed line: the target, {fmt(target)} per week.</span> : null}
        </>
      )}
      <div class="l-row" style={{ justifyContent: "flex-end" }}>
        <button type="button" class="clay press btn-sm t-muted" data-testid="chart-table-toggle" onClick={() => setTable(!table)}>
          {table ? "Chart view" : "Table view"}
        </button>
      </div>
    </div>
  );
}

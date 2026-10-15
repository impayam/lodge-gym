// Horizontal bars with a white tick (SPEC-v8 §6.03), with a Table view: sets vs target in Reports and in the coach's
// volume card (SPEC-v9 M12), volume vs last month.

import { useState } from "preact/hooks";
import { fmtNum } from "../format";
import { barScale } from "../lib/reportsView";

export interface BarRow {
  key: string;
  label: string;
  value: number;
  /** The tick: the program target, or last month. */
  mark: number | null;
  /** Sets on the primary muscle only (the table view's Direct column). */
  direct?: number;
  status?: "under" | "on" | "over" | "none" | "untracked";
}

const STATUS_FILL: Record<string, string> = {
  under: "var(--status-under)",
  on: "var(--status-on)",
  over: "var(--status-over)",
};
const STATUS_WORD: Record<string, string> = {
  under: "under target",
  on: "on target",
  over: "over target",
};

/** Horizontal bars with a white tick (SPEC-v8 §6.03): sets vs target, or volume vs last month. */
export function Bars({ rows, fmt, markWord, fill, testid }: { rows: BarRow[]; fmt: (n: number) => string; markWord: string; fill?: string; testid: string }) {
  const [table, setTable] = useState(false);
  const direct = rows.some((r) => r.direct !== undefined);
  const scale = barScale(rows.flatMap((r) => [r.value, r.mark ?? 0]));
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;
  return (
    <div class="l-col l-gap-12" data-testid={testid}>
      {table ? (
        <table class="data-table num" data-testid="chart-table">
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col">Done</th>
              {direct ? <th scope="col">Direct</th> : null}
              <th scope="col">{markWord}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr data-row={r.key}>
                <td>{r.label}</td>
                <td>{fmt(r.value)}</td>
                {direct ? <td>{fmtNum(r.direct ?? 0)}</td> : null}
                <td>{r.mark == null ? "–" : fmt(r.mark)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        rows.map((r) => (
          <div class="bar-row" data-row={r.key}>
            <span class="bar-row__label">{r.label}</span>
            <span class="target-bar" aria-hidden="true">
              <span
                class="target-bar__fill"
                style={{
                  width: pct(r.value),
                  background: (r.status && STATUS_FILL[r.status]) ?? fill,
                }}
              />
              {r.mark != null ? <span class="target-bar__tick" style={{ left: `calc(${pct(r.mark)} - 1px)` }} /> : null}
            </span>
            <span class="bar-row__value">
              {r.status === "over" ? <span aria-hidden="true">▲ </span> : null}
              <b>{fmt(r.value)}</b>
              {r.mark != null ? <span class="bar-row__of"> / {fmt(r.mark)}</span> : null}
              {r.status && STATUS_WORD[r.status] ? <span class="l-sr">, {STATUS_WORD[r.status]}</span> : null}
            </span>
          </div>
        ))
      )}
      <div class="l-row l-between l-gap-8 l-wrap">
        {table ? <span /> : <BarsLegend rows={rows} markWord={markWord} fill={fill} />}
        <button type="button" class="clay press btn-sm t-muted" data-testid="chart-table-toggle" onClick={() => setTable(!table)}>
          {table ? "Chart view" : "Table view"}
        </button>
      </div>
    </div>
  );
}

function BarsLegend({ rows, markWord, fill }: { rows: BarRow[]; markWord: string; fill?: string }) {
  const statuses = rows.some((r) => r.status);
  return (
    <div class="chart-legend" aria-hidden="true">
      {statuses ? (
        <>
          <span>
            <span class="chart-legend__swatch" style={{ background: STATUS_FILL.on }} />
            On target
          </span>
          <span>
            <span class="chart-legend__swatch" style={{ background: STATUS_FILL.under }} />
            Under
          </span>
          {rows.some((r) => r.status === "over") ? (
            <span>
              <span class="chart-legend__swatch" style={{ background: STATUS_FILL.over }} />▲ Over
            </span>
          ) : null}
        </>
      ) : (
        <span>
          <span class="chart-legend__swatch" style={{ background: fill }} />
          Done
        </span>
      )}
      <span>
        <span class="chart-legend__tick" />
        {markWord}
      </span>
    </div>
  );
}

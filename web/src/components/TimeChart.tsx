// Time-series line chart (SPEC-v8 §8) on uPlot: 2 px lines, the last point 9 px with a page-colour ring, a recessive
// grid, one y-axis, tap (or hover, or the arrow keys) = crosshair. A single series reports the picked point to its
// card (the card shows value and date); several series show a tooltip with every series and a legend with the last
// values. Every chart has an aria-label summary and a Table view. Colours come from tokens, read at runtime.

import { useEffect, useRef, useState } from "preact/hooks";
import uPlot from "uplot";
import { dayMonth, fmtNum } from "../format";
import { token } from "../lib/tokens";

export interface ChartSeries {
  label: string;
  /** The series colour token, e.g. "--series-1". */
  color: `--${string}`;
  points: { date: string; value: number }[];
}

export interface Pick {
  date: string;
  values: (number | null)[];
}

interface Props {
  series: ChartSeries[];
  height: number;
  /** Summary read by VoiceOver. */
  label: string;
  /** Unit after values in the tooltip and table, e.g. "lb". */
  unit: string;
  /** Fill under a single series (the Home 1RM card). */
  area?: boolean;
  /** Value labels on the y-axis. */
  yAxis?: boolean;
  /** Date labels under the plot: first and last, with an optional text for the last. */
  xLabels?: { last?: string } | false;
  /** Start with the last point picked (single-series cards). */
  pickLast?: boolean;
  onPick?: (p: Pick | null) => void;
  testid?: string;
}

const DAY = 86_400_000;
const toX = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Aligned uPlot data: one x per date that has a value in any series. */
function align(series: ChartSeries[]): { dates: string[]; data: uPlot.AlignedData } {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const cols = series.map((s) => {
    const by = new Map(s.points.map((p) => [p.date, p.value]));
    return dates.map((d) => by.get(d) ?? null);
  });
  return { dates, data: [dates.map(toX), ...cols] as uPlot.AlignedData };
}

const lastIndex = (col: (number | null)[]) => {
  for (let i = col.length - 1; i >= 0; i--) if (col[i] != null) return i;
  return -1;
};

export function TimeChart({ series, height, label, unit, area, yAxis, xLabels = {}, pickLast, onPick, testid }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const { dates, data } = align(series);
  const key = JSON.stringify(data);
  const report = useRef(onPick);
  report.current = onPick;

  const pickAt = (i: number | null) => {
    setPick(i);
    report.current?.(i == null ? null : { date: dates[i], values: series.map((_, k) => (data[k + 1] as (number | null)[])[i]) });
  };

  useEffect(() => {
    const el = host.current;
    if (!el || table || !dates.length) return;
    const ink3 = token("--ink-3");
    const font = `10px ${token("--font-ui")}`;
    const ring = token("--bg-solid");
    const colors = series.map((s) => token(s.color));
    // The x-axis keeps only its baseline; the first and last dates are HTML under the plot, aligned to its ends.
    const xAxis: uPlot.Axis = {
      size: 0,
      gap: 0,
      ticks: { show: false },
      grid: { show: false },
      border: { show: true, stroke: token("--baseline"), width: 1 },
      splits: () => [],
    };
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height,
      legend: { show: false },
      padding: [10, 8, 0, yAxis ? 0 : 8],
      scales: {
        x: { time: false },
        y: {
          range: (_u, min, max) => {
            const pad = Math.max((max - min) * 0.12, 1);
            return [min - pad, max + pad];
          },
        },
      },
      axes: [
        xAxis,
        {
          // Without labels the axis still draws the recessive grid.
          stroke: ink3,
          font,
          size: yAxis ? 34 : 0,
          gap: yAxis ? 4 : 0,
          space: 36,
          ticks: { show: false },
          grid: { stroke: token("--gridline"), width: 1 },
          values: (_u, splits) => splits.map((v) => (yAxis ? fmtNum(Math.round(v)) : "")),
        },
      ],
      cursor: {
        x: true,
        y: false,
        drag: { x: false, y: false },
        // The crosshair snaps to the nearest day that has a value.
        move: (u, left, top) => {
          if (left < 0) return [left, top];
          const i = u.posToIdx(left);
          return i == null || i < 0 ? [left, top] : [Math.round(u.valToPos(u.data[0][i], "x")), top];
        },
        points: { size: 9, width: 2, stroke: () => ring, fill: (_u, si) => colors[si - 1] },
        bind: { mouseleave: () => null, dblclick: () => null },
      },
      series: [
        {},
        ...series.map((s, k): uPlot.Series => ({
          label: s.label,
          stroke: colors[k],
          width: 2,
          spanGaps: true,
          fill: area && series.length === 1 ? colors[k] + "1f" : undefined,
          points: { show: true, size: 9, width: 2, stroke: ring, fill: colors[k], filter: (u, si) => [lastIndex(u.data[si] as (number | null)[])] },
        })),
      ],
      hooks: {
        setCursor: [
          (u) => {
            if (u.cursor.idx != null && u.cursor.left != null && u.cursor.left >= 0) pickAt(u.cursor.idx);
          },
        ],
        ready: [
          (u) => {
            if (pickLast) {
              const i = lastIndex(u.data[1] as (number | null)[]);
              if (i >= 0) u.setCursor({ left: u.valToPos(u.data[0][i], "x"), top: u.valToPos((u.data[1] as number[])[i], "y") });
            }
          },
        ],
      },
    };
    const u = new uPlot(opts, data, el);
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [key, height, table]);

  const step = (d: number) => {
    const u = plot.current;
    if (!u || !dates.length) return;
    const ref = series.findIndex((_, k) => lastIndex(data[k + 1] as (number | null)[]) >= 0) + 1;
    let i = pick == null ? dates.length - 1 : Math.min(dates.length - 1, Math.max(0, pick + d));
    while (i >= 0 && i < dates.length && (data[ref] as (number | null)[])[i] == null) i += d || -1;
    if (i < 0 || i >= dates.length) return;
    u.setCursor({ left: u.valToPos(u.data[0][i], "x"), top: u.valToPos((data[ref] as number[])[i], "y") });
  };

  const tip =
    pick != null && series.length > 1 && plot.current ? (
      <div class="chart-tip" style={tipStyle(plot.current, pick)} data-testid="chart-tip">
        <span>{dayMonth(dates[pick])}</span>
        {series.map((s, k) => {
          const v = (data[k + 1] as (number | null)[])[pick];
          return v == null ? null : (
            <span>
              {s.label} <b class="num">{fmtNum(round1(v))}</b> {unit}
            </span>
          );
        })}
      </div>
    ) : null;

  return (
    <div class="l-col l-gap-8" data-testid={testid}>
      {table ? (
        <table class="data-table num" data-testid="chart-table">
          <caption class="l-sr">{label}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              {series.map((s) => (
                <th scope="col">
                  {s.label} ({unit})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dates.map((d, i) => (
              <tr>
                <td>{dayMonth(d)}</td>
                {series.map((_, k) => {
                  const v = (data[k + 1] as (number | null)[])[i];
                  return <td>{v == null ? "–" : fmtNum(round1(v))}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div
          class="chart"
          ref={host}
          role="img"
          aria-label={label}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              step(e.key === "ArrowLeft" ? -1 : 1);
            }
          }}
        >
          {tip}
        </div>
      )}
      {xLabels !== false && !table && dates.length ? (
        <div class="l-row l-between chart-axis" style={yAxis ? { paddingLeft: "34px" } : undefined} aria-hidden="true">
          <span>{dayMonth(dates[0])}</span>
          <span>{xLabels.last ?? dayMonth(dates[dates.length - 1])}</span>
        </div>
      ) : null}
      {series.length > 1 && !table ? (
        <div class="chart-legend" data-testid="chart-legend">
          {series.map((s, k) => {
            const col = data[k + 1] as (number | null)[];
            const i = lastIndex(col);
            return (
              <span>
                <span class="chart-legend__key" style={{ background: `var(${s.color})` }} />
                {s.label} <b class="num">{i >= 0 ? fmtNum(round1(col[i]!)) : "–"}</b>
              </span>
            );
          })}
        </div>
      ) : null}
      <div class="l-row" style={{ justifyContent: "flex-end" }}>
        <button type="button" class="clay press btn-sm t-muted" data-testid="chart-table-toggle" onClick={() => setTable(!table)}>
          {table ? "Chart view" : "Table view"}
        </button>
      </div>
    </div>
  );
}

/** The tooltip beside the crosshair, flipped to the left in the right half. */
function tipStyle(u: uPlot, i: number): Record<string, string> {
  const x = u.valToPos(u.data[0][i], "x") + u.over.offsetLeft;
  return x > u.width / 2 ? { right: `${u.width - x + 8}px` } : { left: `${x + 8}px` };
}

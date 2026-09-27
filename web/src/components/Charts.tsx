// Hand-rolled SVG charts (SPEC §2: no chart library). Thin marks, one axis, text in ink tokens,
// a tap/hover readout on every chart and a table view (<details>) for every chart.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { faNum } from "../../../worker/lib/digits";

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <details class="tableview">
      <summary>جدول</summary>
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              {r.map((c) => (
                <td class="num">{typeof c === "number" ? faNum(c) : c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Readout({ text, hint }: { text: string | null; hint: string }) {
  return (
    <div class="readout num" aria-live="polite">
      {text ?? hint}
    </div>
  );
}

/**
 * Horizontal bars (RTL: growing leftwards from the label column). Optional target mark per row, or an
 * optional muted comparison bar (e.g. previous month) with a legend.
 */
export function TargetBars({
  rows,
  unitLabel,
  legend,
  fmt = (n: number) => faNum(n),
}: {
  rows: { label: string; value: number; target?: number; compare?: number }[];
  unitLabel: string;
  legend?: [string, string];
  fmt?: (n: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const pair = rows.some((r) => r.compare !== undefined);
  const hasTarget = rows.some((r) => r.target !== undefined);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.value, r.target ?? 0, r.compare ?? 0))) * 1.1;
  const W = 320;
  const LABEL = 104;
  const ROW = pair ? 30 : 26;
  const plot = W - LABEL - 52;
  const a = active != null ? rows[active] : null;
  const detail = (r: (typeof rows)[number]) =>
    `${r.label}: ${fmt(r.value)} ${unitLabel}` + (r.target !== undefined ? ` از هدف ${faNum(r.target)}` : "") + (r.compare !== undefined && legend ? ` · ${legend[1]}: ${fmt(r.compare)}` : "");
  return (
    <figure class="chart">
      {legend ? (
        <div class="legend">
          <span>
            <i class="sw cur" /> {legend[0]}
          </span>
          <span>
            <i class="sw prev" /> {legend[1]}
          </span>
        </div>
      ) : null}
      <Readout text={a ? detail(a) : null} hint={hasTarget ? "برای جزئیات روی یک ردیف بزن. خط تیره هدف برنامه است." : "برای جزئیات روی یک ردیف بزن."} />
      <svg viewBox={`0 0 ${W} ${rows.length * ROW + 4}`} role="img" aria-label={unitLabel}>
        {rows.map((r, i) => {
          const y = i * ROW + 4;
          const x0 = W - LABEL;
          const bw = (r.value / max) * plot;
          const cw = r.compare !== undefined ? (r.compare / max) * plot : 0;
          const tx = r.target !== undefined ? (r.target / max) * plot : 0;
          const h = pair ? 9 : 12;
          return (
            <g class={`row${active === i ? " on" : ""}`} onPointerEnter={() => setActive(i)} onClick={() => setActive(i)}>
              <rect x={0} y={y - 2} width={W} height={ROW} class="hit" />
              <text x={W} y={y + 13} class="lbl" text-anchor="end">
                {r.label}
              </text>
              {pair ? null : <line x1={x0} x2={x0 - plot} y1={y + 9} y2={y + 9} class="track" />}
              {bw > 0 ? <path d={barLeft(x0, y + 3, bw, h)} class="bar" /> : null}
              {cw > 0 ? <path d={barLeft(x0, y + 3 + h + 2, cw, h)} class="bar prev" /> : null}
              {r.target !== undefined ? <line x1={x0 - tx} x2={x0 - tx} y1={y} y2={y + 18} class="target" /> : null}
              <text x={x0 - Math.max(bw, tx, cw) - 6} y={y + 13} class="val" text-anchor="end">
                {r.target !== undefined ? `${faNum(r.value)}/${faNum(r.target)}` : fmt(r.value)}
              </text>
            </g>
          );
        })}
      </svg>
      <Table
        head={legend ? ["", legend[0], legend[1]] : hasTarget ? ["گروه", unitLabel, "هدف"] : ["", unitLabel]}
        rows={rows.map((r) => (legend ? [r.label, r.value, r.compare ?? 0] : hasTarget ? [r.label, r.value, r.target ?? 0] : [r.label, r.value]))}
      />
    </figure>
  );
}

/** Bar path growing leftwards from x0 with a 4px rounded data-end and a square base. */
function barLeft(x0: number, y: number, w: number, h: number) {
  const r = Math.min(4, w, h / 2);
  const x1 = x0 - w;
  return `M${x0},${y} H${x1 + r} Q${x1},${y} ${x1},${y + r} V${y + h - r} Q${x1},${y + h} ${x1 + r},${y + h} H${x0} Z`;
}

/** Column path growing up from the baseline with a 4px rounded cap. */
function colUp(x: number, base: number, w: number, h: number) {
  const r = Math.min(4, h, w / 2);
  const top = base - h;
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}

export interface Column {
  label: string;
  value: number;
  /** Optional comparison value drawn as a second, muted column. */
  compare?: number;
}

/** Columns (single series, or current vs previous with a legend), optional target line. */
export function Columns({ cols, target, valueLabel, legend, fmt = (n: number) => faNum(n) }: { cols: Column[]; target?: number; valueLabel: string; legend?: [string, string]; fmt?: (n: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  const W = 320;
  const H = 150;
  const B = H - 22;
  const max = Math.max(1, target ?? 0, ...cols.map((c) => Math.max(c.value, c.compare ?? 0))) * 1.15;
  const slot = W / Math.max(1, cols.length);
  const pair = cols.some((c) => c.compare !== undefined);
  const bw = Math.min(24, (slot - 8) / (pair ? 2 : 1) - (pair ? 1 : 0));
  const a = active != null ? cols[active] : null;
  // RTL reading order: first column on the right.
  const xOf = (i: number) => W - (i + 1) * slot + (slot - bw * (pair ? 2 : 1) - (pair ? 2 : 0)) / 2;
  return (
    <figure class="chart">
      {legend ? (
        <div class="legend">
          <span>
            <i class="sw cur" /> {legend[0]}
          </span>
          <span>
            <i class="sw prev" /> {legend[1]}
          </span>
        </div>
      ) : null}
      <Readout
        text={a ? `${a.label}: ${fmt(a.value)} ${valueLabel}${a.compare !== undefined && legend ? ` · ${legend[1]}: ${fmt(a.compare)}` : ""}` : null}
        hint="برای مقدار دقیق روی یک ستون بزن."
      />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={valueLabel}>
        <line x1={0} x2={W} y1={B} y2={B} class="axis" />
        {target ? (
          <>
            <line x1={0} x2={W} y1={B - (target / max) * (B - 8)} y2={B - (target / max) * (B - 8)} class="target" />
            <text x={2} y={B - (target / max) * (B - 8) - 4} class="val">
              هدف {faNum(target)}
            </text>
          </>
        ) : null}
        {cols.map((c, i) => {
          const x = xOf(i);
          const h = (c.value / max) * (B - 8);
          const hc = c.compare !== undefined ? (c.compare / max) * (B - 8) : 0;
          return (
            <g class={`row${active === i ? " on" : ""}`} onPointerEnter={() => setActive(i)} onClick={() => setActive(i)}>
              <rect x={W - (i + 1) * slot} y={0} width={slot} height={H} class="hit" />
              {c.compare !== undefined && hc > 0 ? <path d={colUp(x, B, bw, hc)} class="bar prev" /> : null}
              {h > 0 ? <path d={colUp(pair ? x + bw + 2 : x, B, bw, h)} class="bar" /> : null}
              <text x={W - (i + 0.5) * slot} y={H - 6} class="tick" text-anchor="middle">
                {c.label}
              </text>
            </g>
          );
        })}
      </svg>
      <Table head={legend ? ["", legend[0], legend[1]] : ["", valueLabel]} rows={cols.map((c) => (legend ? [c.label, c.value, c.compare ?? 0] : [c.label, c.value]))} />
    </figure>
  );
}

export interface LinePoint {
  x: string;
  y: number;
  label: string;
}

/** Single-series line (optionally with raw dots under a smoothed line), crosshair readout. */
export function LineChart({ points, dots, valueLabel, legend, height = 130 }: { points: LinePoint[]; dots?: LinePoint[]; valueLabel: string; legend?: [string, string]; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const W = 320;
  const H = height;
  const pad = 10;
  const all = [...points, ...(dots ?? [])];
  if (!points.length) return <div class="empty">داده‌ای برای این دوره نیست.</div>;
  const xs = [...new Set(all.map((p) => p.x))].sort();
  const ys = all.map((p) => p.y);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi - lo < 1) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  lo -= span * 0.1;
  hi += span * 0.1;
  // RTL: time runs right to left.
  const X = (x: string) => (xs.length === 1 ? W / 2 : W - pad - (xs.indexOf(x) / (xs.length - 1)) * (W - 2 * pad));
  const Y = (y: number) => H - 18 - ((y - lo) / (hi - lo)) * (H - 30);
  const path = points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const a = active != null ? points[active] : null;
  const pick = (e: PointerEvent) => {
    const svg = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = ((e.clientX - svg.left) / svg.width) * W;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(X(p.x) - x) < Math.abs(X(points[best].x) - x)) best = i;
    });
    setActive(best);
  };
  return (
    <figure class="chart">
      {legend ? (
        <div class="legend">
          <span>
            <i class="sw line" /> {legend[0]}
          </span>
          <span>
            <i class="sw dot" /> {legend[1]}
          </span>
        </div>
      ) : null}
      <Readout text={a ? `${a.label}: ${faNum(a.y, 1)} ${valueLabel}` : null} hint="برای مقدار دقیق روی نمودار بزن." />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={valueLabel} onPointerMove={pick} onPointerDown={pick}>
        <line x1={0} x2={W} y1={H - 18} y2={H - 18} class="axis" />
        <text x={W} y={H - 4} class="tick" text-anchor="end">
          {points[0].label}
        </text>
        {points.length > 1 ? (
          <text x={0} y={H - 4} class="tick" text-anchor="start">
            {points[points.length - 1].label}
          </text>
        ) : null}
        {a ? <line x1={X(a.x)} x2={X(a.x)} y1={6} y2={H - 18} class="cross" /> : null}
        {(dots ?? []).map((p) => (
          <circle cx={X(p.x)} cy={Y(p.y)} r={3} class="dot muted" />
        ))}
        <path d={path} class="line" />
        {points.map((p, i) => (i === points.length - 1 || i === active ? <circle cx={X(p.x)} cy={Y(p.y)} r={4.5} class="dot" /> : null))}
        <text x={X(points[points.length - 1].x) + 6} y={Y(points[points.length - 1].y) - 8} class="val" text-anchor="start">
          {faNum(points[points.length - 1].y, 1)}
        </text>
      </svg>
      <Table head={["تاریخ", valueLabel]} rows={points.map((p) => [p.label, p.y])} />
    </figure>
  );
}

export function Stat({ value, label, sub }: { value: ComponentChildren; label: string; sub?: ComponentChildren }) {
  return (
    <div class="stat">
      <b class="num">{value}</b>
      <small>{label}</small>
      {sub ? <small class="sub">{sub}</small> : null}
    </div>
  );
}

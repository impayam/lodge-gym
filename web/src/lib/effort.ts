// Session effort (SPEC-v8 §6, Payam 2026-10-14): effort e = sets done / sets planned in this session, 0..1. Its colour
// mixes the three --effort-* tokens linearly in RGB (0 → --effort-1, 0.5 → --effort-2, 1 → --effort-3); the session
// screen reads the tokens at runtime (web/src/lib/tokens.ts) and passes them in, so no colour is written here.

/** The three effort token values, in order: --effort-1, --effort-2, --effort-3 (each "#rrggbb"). */
export type EffortStops = readonly [string, string, string];

export type EffortLabel = "Warming up" | "Working" | "All in";

/** The share of the session's planned sets that are done, 0..1 (0 when nothing is planned). */
export function effortOf(done: number, planned: number): number {
  return planned > 0 ? Math.min(1, Math.max(0, done / planned)) : 0;
}

const channels = (color: string): [number, number, number] => {
  const h = color.trim().replace(/^#/, "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};

const mix = (a: string, b: string, t: number): string => {
  const ca = channels(a);
  const cb = channels(b);
  return "#" + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, "0")).join("");
};

/** The effort colour for e (clamped to 0..1) as "#rrggbb". */
export function effortColor(e: number, stops: EffortStops): string {
  const x = Math.min(1, Math.max(0, e));
  return x <= 0.5 ? mix(stops[0], stops[1], x / 0.5) : mix(stops[1], stops[2], (x - 0.5) / 0.5);
}

/** The effort chip's label: Warming up below 0.34, Working below 0.67, then All in. */
export function effortLabel(e: number): EffortLabel {
  return e < 0.34 ? "Warming up" : e < 0.67 ? "Working" : "All in";
}

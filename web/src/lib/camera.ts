// The photo guide camera's pure parts (SPEC-v10.1): the remembered settings per pose, the phone's tilt from the motion
// sensor, and the body outline with its two guide lines: head and feet for a full-body photo, head and waist for an
// upper-body one (PR #26 review: the pose check picks the framing, ./pose.ts). Unit-tested.

import type { Framing, Pose } from "../../../worker/lib/types";

export type Facing = "environment" | "user";
export const TIMERS = [0, 3, 5, 10] as const;
export type TimerSec = (typeof TIMERS)[number];

/** Where the guide lines sit for one framing. */
export interface Fit {
  /** The outline's height as a share of the frame (head line to feet line, or to waist line). */
  scale: number;
  /** The outline's vertical shift as a share of the frame (+ is lower). */
  offset: number;
}

/** Remembered per pose, so the next photo starts identical. */
export interface CameraSettings {
  facing: Facing;
  timer: TimerSec;
  ghost: boolean;
  /** The framing the pose check found last time for this pose (the guide starts with it). */
  framing: Framing;
  /** The guide lines of each framing. */
  fit: Record<Framing, Fit>;
}

export const SCALE_RANGE = [0.7, 0.95] as const;
export const OFFSET_RANGE = [-0.08, 0.08] as const;
export const DEFAULT_FIT: Record<Framing, Fit> = { full: { scale: 0.86, offset: 0 }, upper: { scale: 0.8, offset: 0 } };
export const DEFAULT_CAMERA: CameraSettings = { facing: "environment", timer: 5, ghost: true, framing: "full", fit: DEFAULT_FIT };
/** The shutter warns when the phone leans forward or back more than this. */
export const MAX_TILT = 3;
export const BURST = 3;
export const BURST_GAP_MS = 400;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

const obj = (v: unknown) => (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
const num = (v: unknown, range: readonly [number, number], fallback: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, range) : fallback);
const fitOf = (raw: unknown, d: Fit): Fit => {
  const r = obj(raw);
  return { scale: num(r.scale, SCALE_RANGE, d.scale), offset: num(r.offset, OFFSET_RANGE, d.offset) };
};

/**
 * Settings read back from storage: anything missing or out of range falls back to the defaults. Settings saved before
 * the pose check (one scale and offset) become the full-body fit.
 */
export function cameraSettings(raw: unknown): CameraSettings {
  const r = obj(raw);
  const fit = obj(r.fit);
  return {
    facing: r.facing === "user" || r.facing === "environment" ? r.facing : DEFAULT_CAMERA.facing,
    timer: (TIMERS as readonly unknown[]).includes(r.timer) ? (r.timer as TimerSec) : DEFAULT_CAMERA.timer,
    ghost: typeof r.ghost === "boolean" ? r.ghost : DEFAULT_CAMERA.ghost,
    framing: r.framing === "upper" || r.framing === "full" ? r.framing : DEFAULT_CAMERA.framing,
    fit: { full: fitOf("fit" in r ? fit.full : r, DEFAULT_FIT.full), upper: fitOf(fit.upper, DEFAULT_FIT.upper) },
  };
}

const key = (pose: Pose) => `camera:${pose}`;

/** The browser's localStorage (this module is also unit-tested outside a browser, where there is none). */
interface KeyValue {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
const store = (): KeyValue => {
  const s = (globalThis as { localStorage?: KeyValue }).localStorage;
  if (!s) throw new Error("no storage");
  return s;
};

export function loadCameraSettings(pose: Pose): CameraSettings {
  try {
    return cameraSettings(JSON.parse(store().getItem(key(pose)) ?? "null"));
  } catch {
    return DEFAULT_CAMERA;
  }
}

export function saveCameraSettings(pose: Pose, s: CameraSettings) {
  try {
    store().setItem(key(pose), JSON.stringify(s));
    store().setItem("camera:pose", pose);
  } catch {
    // Private mode or full storage: the defaults come back next time.
  }
}

export function lastPose(): Pose {
  try {
    const p = store().getItem("camera:pose");
    return p === "side" || p === "back" || p === "other" ? p : "front";
  } catch {
    return "front";
  }
}

export function tipsSeen(): boolean {
  try {
    return store().getItem("camera:tips") === "1";
  } catch {
    return false;
  }
}

export function markTipsSeen() {
  try {
    store().setItem("camera:tips", "1");
  } catch {
    // Shown again next time.
  }
}

/**
 * How far the phone leans forward or back, in degrees, from a deviceorientation event: upright in portrait is
 * beta = 90 (beta is the front-back tilt). Null without a reading.
 */
export function tilt(beta: number | null | undefined): number | null {
  if (beta == null || !Number.isFinite(beta)) return null;
  return Math.round(Math.abs(Math.abs(beta) - 90) * 10) / 10;
}

export const isLevel = (deg: number | null) => deg !== null && deg <= MAX_TILT;

/** The outline's frame: 3:4, the preview's shape. */
export const FRAME_W = 300;
export const FRAME_H = 400;

/** Half of the front / back body outline (right side), x from the centre line and y from the head top, in body heights. */
const FRONT_HALF: readonly [number, number][] = [
  [0.035, 0.13],
  [0.12, 0.17],
  [0.14, 0.25],
  [0.15, 0.42],
  [0.155, 0.52],
  [0.125, 0.53],
  [0.11, 0.42],
  [0.1, 0.28],
  [0.09, 0.4],
  [0.1, 0.5],
  [0.085, 0.75],
  [0.07, 0.97],
  [0.09, 1],
  [0.02, 1],
  [0.025, 0.75],
  [0, 0.53],
];
/** The side outline, facing right: the front edge, then the back edge back up. */
const SIDE: readonly [number, number][] = [
  [0.02, 0.13],
  [0.06, 0.18],
  [0.07, 0.3],
  [0.05, 0.42],
  [0.06, 0.5],
  [0.05, 0.75],
  [0.04, 0.97],
  [0.1, 1],
  [-0.06, 1],
  [-0.03, 0.97],
  [-0.05, 0.75],
  [-0.08, 0.52],
  [-0.05, 0.4],
  [-0.07, 0.25],
  [-0.05, 0.15],
  [-0.02, 0.13],
];
const HEAD_R = 0.06;
const HEAD_Y = 0.065;
/** The waist line of an upper-body photo, in body heights from the head top (where the outline's waist is narrowest). */
export const WAIST_Y = 0.42;

export interface Outline {
  /** The body outline as an SVG path (in FRAME_W × FRAME_H); cut at the waist for an upper-body photo. */
  d: string;
  head: { cx: number; cy: number; r: number };
  /** The head line (top of the head) and the bottom line: the soles (full body) or the waist (upper body). */
  headY: number;
  baseY: number;
  base: "feet" | "waist";
}

type Pt = readonly [number, number];

/** The part of a closed polygon at or above y = cut (one Sutherland–Hodgman pass). */
export function clipBelow(pts: readonly Pt[], cut: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const aIn = a[1] <= cut;
    const bIn = b[1] <= cut;
    if (aIn) out.push(a);
    if (aIn !== bIn) out.push([a[0] + ((cut - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), cut]);
  }
  return out;
}

export function outline(pose: Pose, s: Fit, framing: Framing = "full"): Outline {
  // The guide's length (head to feet, or head to waist) is `scale` of the frame; the body is drawn to that size.
  const span = FRAME_H * s.scale;
  const h = framing === "full" ? span : span / WAIST_Y;
  const top = FRAME_H * (0.5 - s.scale / 2 + s.offset);
  const cx = FRAME_W / 2;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const p = ([x, y]: Pt) => `${r1(cx + x * h)} ${r1(top + y * h)}`;
  const whole: Pt[] = pose === "side" ? [...SIDE] : [...FRONT_HALF, ...[...FRONT_HALF].reverse().map(([x, y]) => [-x, y] as Pt)];
  const pts = framing === "full" ? whole : clipBelow(whole, WAIST_Y);
  return {
    d: `M ${pts.map(p).join(" L ")} Z`,
    head: { cx: r1(cx + (pose === "side" ? 0.01 * h : 0)), cy: r1(top + HEAD_Y * h), r: r1(HEAD_R * h) },
    headY: r1(top),
    baseY: r1(top + span),
    base: framing === "full" ? "feet" : "waist",
  };
}

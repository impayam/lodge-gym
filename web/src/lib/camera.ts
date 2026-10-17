// The photo guide camera's pure parts (SPEC-v10.1): the remembered settings per pose, the phone's tilt from the motion
// sensor, and the body outline with its head and feet lines. Unit-tested.

import type { Pose } from "../../../worker/lib/types";

export type Facing = "environment" | "user";
export const TIMERS = [0, 3, 5, 10] as const;
export type TimerSec = (typeof TIMERS)[number];

/** Remembered per pose, so the next photo starts identical. */
export interface CameraSettings {
  facing: Facing;
  timer: TimerSec;
  /** The outline's height as a share of the frame (head line to feet line). */
  scale: number;
  /** The outline's vertical shift as a share of the frame (+ is lower). */
  offset: number;
  ghost: boolean;
}

export const SCALE_RANGE = [0.7, 0.95] as const;
export const OFFSET_RANGE = [-0.08, 0.08] as const;
export const DEFAULT_CAMERA: CameraSettings = { facing: "environment", timer: 5, scale: 0.86, offset: 0, ghost: true };
/** The shutter warns when the phone leans forward or back more than this. */
export const MAX_TILT = 3;
export const BURST = 3;
export const BURST_GAP_MS = 400;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** Settings read back from storage: anything missing or out of range falls back to the defaults. */
export function cameraSettings(raw: unknown): CameraSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof CameraSettings, unknown>>;
  return {
    facing: r.facing === "user" || r.facing === "environment" ? r.facing : DEFAULT_CAMERA.facing,
    timer: (TIMERS as readonly unknown[]).includes(r.timer) ? (r.timer as TimerSec) : DEFAULT_CAMERA.timer,
    scale: typeof r.scale === "number" && Number.isFinite(r.scale) ? clamp(r.scale, SCALE_RANGE) : DEFAULT_CAMERA.scale,
    offset: typeof r.offset === "number" && Number.isFinite(r.offset) ? clamp(r.offset, OFFSET_RANGE) : DEFAULT_CAMERA.offset,
    ghost: typeof r.ghost === "boolean" ? r.ghost : DEFAULT_CAMERA.ghost,
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

export interface Outline {
  /** The body outline as an SVG path (in FRAME_W × FRAME_H). */
  d: string;
  head: { cx: number; cy: number; r: number };
  /** The head line (top of the head) and the feet line (soles). */
  headY: number;
  feetY: number;
}

export function outline(pose: Pose, s: Pick<CameraSettings, "scale" | "offset">): Outline {
  const h = FRAME_H * s.scale;
  const top = FRAME_H * (0.5 - s.scale / 2 + s.offset);
  const cx = FRAME_W / 2;
  const p = ([x, y]: readonly [number, number]) => `${Math.round((cx + x * h) * 10) / 10} ${Math.round((top + y * h) * 10) / 10}`;
  const pts = pose === "side" ? SIDE : [...FRONT_HALF, ...[...FRONT_HALF].reverse().map(([x, y]) => [-x, y] as [number, number])];
  return {
    d: `M ${pts.map(p).join(" L ")} Z`,
    head: { cx: Math.round((cx + (pose === "side" ? 0.01 * h : 0)) * 10) / 10, cy: Math.round((top + HEAD_Y * h) * 10) / 10, r: Math.round(HEAD_R * h * 10) / 10 },
    headY: Math.round(top * 10) / 10,
    feetY: Math.round((top + h) * 10) / 10,
  };
}

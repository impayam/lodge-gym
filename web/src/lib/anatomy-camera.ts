// Camera of the 3D anatomy picker (SPEC-v6 §4), pure so it is unit-tested without WebGL. The camera orbits a target
// at the target's height (rotation around the vertical axis only, no panning); a yaw of 0 looks at the body's front
// (the model faces +Z), π at its back. Each body area has a preset close-up framed on its muscles' bounding box.

import { BODY_AREAS, type BodyArea, type FigureView } from "../../../worker/lib/bodyAreas";

export type Vec3 = [number, number, number];
export interface Box {
  min: Vec3;
  max: Vec3;
}
export interface CameraPose {
  target: Vec3;
  distance: number;
  yaw: number;
}

export const FOV_DEG = 30;
/** Turn time of Front / Back and of a region change (SPEC-v6 §4: at most 400 ms). */
export const TURN_MS = 380;

export const yawOf = (view: FigureView): number => (view === "front" ? 0 : Math.PI);

export interface AreaPreset {
  /** The side the close-up opens on. */
  view: FigureView;
  /** Margin around the muscles: 1 fits them exactly. */
  pad: number;
}

/** Close-up of each body area, opening on the side the area's first view shows (bodyAreas.ts). */
export const AREA_PRESETS: Readonly<Record<BodyArea, AreaPreset>> = Object.fromEntries(
  BODY_AREAS.map((a) => [a.key, { view: a.views[0], pad: a.key === "chest" || a.key === "core" ? 1.35 : 1.2 }])
) as Record<BodyArea, AreaPreset>;

/** Camera pose that fits a box on screen, seen from `yaw`, with the camera level with the box's centre. */
export function frameBox(box: Box, yaw: number, aspect: number, pad: number, fovDeg = FOV_DEG): CameraPose {
  const size = box.max.map((v, i) => v - box.min[i]) as Vec3;
  const target = box.max.map((v, i) => (v + box.min[i]) / 2) as Vec3;
  const tan = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  // Width across the view and depth along it, for a box turned by yaw around the vertical axis.
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const width = c * size[0] + s * size[2];
  const depth = s * size[0] + c * size[2];
  const fit = Math.max(size[1] / 2 / tan, width / 2 / (tan * aspect));
  return { target, distance: fit * pad + depth / 2, yaw };
}

/**
 * Closest the camera may come to a target: outside the body at any height, so pinch zoom never flies inside it.
 * The body's footprint is its bounding box seen from above; the camera stays beyond its farthest corner.
 */
export function minDistance(body: Box, target: Vec3, margin = 0.05): number {
  let far = 0;
  for (const x of [body.min[0], body.max[0]]) for (const z of [body.min[2], body.max[2]]) far = Math.max(far, Math.hypot(x - target[0], z - target[2]));
  return far + margin;
}

/** Camera position for a pose: on the horizontal circle around the target. */
export function cameraPosition(p: CameraPose): Vec3 {
  return [p.target[0] + Math.sin(p.yaw) * p.distance, p.target[1], p.target[2] + Math.cos(p.yaw) * p.distance];
}

/** The yaw closest to `from` that faces the same way as `to` (Front / Back turn the short way round). */
export function nearestYaw(from: number, to: number): number {
  const turn = ((((to - from) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return from + turn;
}

/** Ease in-out for camera moves, t in [0, 1]. */
export const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  const k = ease(Math.min(1, Math.max(0, t)));
  return {
    target: a.target.map((v, i) => v + (b.target[i] - v) * k) as Vec3,
    distance: a.distance + (b.distance - a.distance) * k,
    yaw: a.yaw + (b.yaw - a.yaw) * k,
  };
}

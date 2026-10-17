// The guide camera's pose model, loaded on first use (SPEC-v10.1; PR #26 review): MediaPipe Pose Landmarker lite
// (Apache-2.0, web/public/pose/POSE-SOURCE.md) on the phone's CPU, one body, a still image at a time. Nothing leaves
// the phone. What the landmarks mean is ./pose.ts. Loaded by a dynamic import, so the camera opens without it and the
// app's first load stays as it was; the service worker keeps it for offline use (./pose-asset.ts).

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import loaderSimd from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmSimd from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import loaderNoSimd from "@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url";
import wasmNoSimd from "@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url";
import type { Landmark } from "./pose";
import { POSE_MODEL_URL } from "./pose-asset";

export interface PoseDetector {
  /** The landmarks of the one body in the image (shares of its width and height), or null without one. */
  detect(image: HTMLCanvasElement): Landmark[] | null;
}

/** Test and measurement hook: how often the pose check ran, and whether the real model is loaded. */
export const poseHook = { runs: 0, model: false };
(globalThis as unknown as { __pose: typeof poseHook }).__pose = poseHook;

/** e2e: a stand-in for the model, set before the page loads (the fake camera shows no real body). */
type Fake = (image: HTMLCanvasElement) => Landmark[] | null;
const fake = () => (globalThis as unknown as { __poseFake?: Fake }).__poseFake;

let loading: Promise<PoseDetector> | null = null;

/** The detector, created once per app run (the model takes a second to start); a failed load can be tried again. */
export function loadPoseDetector(): Promise<PoseDetector> {
  const f = fake();
  if (f) return Promise.resolve(wrap(f));
  loading ??= create().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function create(): Promise<PoseDetector> {
  // iOS Safari 16.4+ has WebAssembly SIMD; older engines take the slower build.
  const simd = await FilesetResolver.isSimdSupported();
  const landmarker = await PoseLandmarker.createFromOptions(
    { wasmLoaderPath: simd ? loaderSimd : loaderNoSimd, wasmBinaryPath: simd ? wasmSimd : wasmNoSimd },
    { baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "CPU" }, runningMode: "IMAGE", numPoses: 1 }
  );
  poseHook.model = true;
  return wrap((image) => landmarker.detect(image).landmarks[0] ?? null);
}

const wrap = (run: (image: HTMLCanvasElement) => Landmark[] | null): PoseDetector => ({
  detect(image) {
    poseHook.runs++;
    return run(image);
  },
});

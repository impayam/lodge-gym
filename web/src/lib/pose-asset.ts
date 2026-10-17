// The guide camera's pose model (SPEC-v10.1; PR #26 review, Payam 2026-10-17): where the app serves it and the cache
// that keeps it, the MediaPipe runtime (WebAssembly and its loader) and the pose code chunk after first use.
// scripts/anatomy-assets.mjs checks the model's SHA-256 at build time. The runtime comes from the pinned npm package
// @mediapipe/tasks-vision, which Vite copies into /assets/ with a content hash (./poseModel.ts), so everything is
// self-hosted and every version has its own URL.

/** SHA-256 of web/public/pose/pose_landmarker_lite.task (MediaPipe Pose Landmarker lite, float16, version 1, unmodified). */
export const POSE_MODEL_SHA256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a";

/** The model, versioned by its hash so a changed file never comes from an old cache. */
export const POSE_MODEL_URL = `/pose/pose_landmarker_lite.task?v=${POSE_MODEL_SHA256.slice(0, 12)}`;
/** Service-worker cache for the model, the runtime and the pose code chunk. */
export const POSE_CACHE = `pose-${POSE_MODEL_SHA256.slice(0, 12)}`;
/** True for the requests the pose cache serves. */
export const isPoseAsset = (pathname: string): boolean =>
  pathname === "/pose/pose_landmarker_lite.task" || /^\/assets\/(poseModel|vision_wasm_internal|vision_wasm_nosimd_internal)-[\w-]+\.(js|wasm)$/.test(pathname);

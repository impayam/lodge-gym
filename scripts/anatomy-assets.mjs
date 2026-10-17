// Build step for the pinned model files, run by `npm run build` and `npm run dev`: checks that the 3D anatomy model
// (SPEC-v6 §1, web/public/models/body.glb) and the guide camera's pose model (SPEC-v10.1, PR #26 review,
// web/public/pose/pose_landmarker_lite.task) have their pinned SHA-256 and fails the build otherwise.
// (The Draco decoder and the MediaPipe runtime need no step: Vite copies them from npm into dist/assets/.)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  { file: "web/public/models/body.glb", pin: "web/src/lib/anatomy-asset.ts", name: "GLB_SHA256", source: "web/public/models/ANATOMY-SOURCE.md" },
  { file: "web/public/pose/pose_landmarker_lite.task", pin: "web/src/lib/pose-asset.ts", name: "POSE_MODEL_SHA256", source: "web/public/pose/POSE-SOURCE.md" },
];

for (const f of FILES) {
  const pinned = readFileSync(join(root, f.pin), "utf8").match(new RegExp(`export const ${f.name} = "([0-9a-f]{64})"`))?.[1];
  if (!pinned) throw new Error(`anatomy-assets: ${f.name} not found in ${f.pin}`);
  const actual = createHash("sha256").update(readFileSync(join(root, f.file))).digest("hex");
  if (actual !== pinned) {
    console.error(`anatomy-assets: ${f.file} has SHA-256 ${actual}, expected ${pinned}.`);
    console.error(`The model must be the pinned, unmodified file (see ${f.source}).`);
    process.exit(1);
  }
  console.log(`anatomy-assets: ${f.file.split("/").pop()} SHA-256 ok`);
}

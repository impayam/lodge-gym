// Build step for the 3D anatomy picker (SPEC-v6 §1), run by `npm run build` and `npm run dev`: checks that
// web/public/models/body.glb has the pinned SHA-256 (web/src/lib/anatomy-asset.ts) and fails the build otherwise.
// (The Draco decoder needs no step: Vite copies three's glTF decoder into dist/assets/, see anatomy-asset.ts.)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinned = readFileSync(join(root, "web/src/lib/anatomy-asset.ts"), "utf8").match(/export const GLB_SHA256 = "([0-9a-f]{64})"/)?.[1];
if (!pinned) throw new Error("anatomy-assets: GLB_SHA256 not found in web/src/lib/anatomy-asset.ts");

const actual = createHash("sha256").update(readFileSync(join(root, "web/public/models/body.glb"))).digest("hex");
if (actual !== pinned) {
  console.error(`anatomy-assets: web/public/models/body.glb has SHA-256 ${actual}, expected ${pinned}.`);
  console.error("The model must be the pinned, unmodified file (see web/public/models/ANATOMY-SOURCE.md).");
  process.exit(1);
}
console.log("anatomy-assets: body.glb SHA-256 ok");

import { describe, expect, it } from "vitest";
import { AREA_PRESETS, TURN_MS, cameraPosition, frameBox, lerpPose, minDistance, nearestYaw, yawOf, type Box } from "../../web/src/lib/anatomy-camera";
import { ANATOMY_CACHE, GLB_SHA256, GLB_URL, isAnatomyAsset } from "../../web/src/lib/anatomy-asset";
import { BODY_AREAS } from "../../worker/lib/bodyAreas";

// SPEC-v6 §4: camera presets and moves of the 3D picker; §1/§5: asset URLs and cache.
describe("3D picker camera", () => {
  it("has a close-up preset for each of the 8 areas, opening on the area's first side", () => {
    expect(Object.keys(AREA_PRESETS).sort()).toEqual(BODY_AREAS.map((a) => a.key).sort());
    for (const a of BODY_AREAS) {
      expect(AREA_PRESETS[a.key].view, a.key).toBe(a.views[0]);
      expect(AREA_PRESETS[a.key].pad, a.key).toBeGreaterThanOrEqual(1);
    }
  });

  it("frames a box: the taller dimension fits the field of view, the camera level with the centre", () => {
    const body: Box = { min: [-0.33, 0, -0.13], max: [0.33, 1.7, 0.14] };
    const p = frameBox(body, 0, 0.75, 1);
    expect(p.target).toEqual([0, 0.85, expect.closeTo(0.005, 6)]);
    // Height 1.7 at 30° fov: 0.85 / tan(15°) + half the depth.
    expect(p.distance).toBeCloseTo(0.85 / Math.tan((15 * Math.PI) / 180) + 0.135, 6);
    // A wide box on a narrow screen is fitted by its width.
    const wide = frameBox({ min: [-1, 0, 0], max: [1, 0.2, 0] }, 0, 0.5, 1);
    expect(wide.distance).toBeCloseTo(1 / (Math.tan((15 * Math.PI) / 180) * 0.5), 6);
    // Seen from the side, depth becomes width.
    expect(frameBox({ min: [-1, 0, -0.1], max: [1, 0.2, 0.1] }, Math.PI / 2, 1, 1).distance).toBeCloseTo(0.1 / Math.tan((15 * Math.PI) / 180) + 1, 6);
  });

  it("keeps the camera outside the body when zooming", () => {
    const body: Box = { min: [-0.33, 0, -0.13], max: [0.33, 1.7, 0.14] };
    expect(minDistance(body, [0, 1, 0], 0)).toBeCloseTo(Math.hypot(0.33, 0.14), 9);
    expect(minDistance(body, [0.2, 1, 0])).toBeGreaterThan(0.53);
  });

  it("turns Front / Back the short way, in at most 400 ms", () => {
    expect(TURN_MS).toBeLessThanOrEqual(400);
    expect(yawOf("front")).toBe(0);
    expect(yawOf("back")).toBe(Math.PI);
    expect(nearestYaw(2 * Math.PI + 0.1, 0)).toBeCloseTo(2 * Math.PI, 9);
    expect(Math.abs(nearestYaw(0.2, Math.PI) - 0.2)).toBeCloseTo(Math.PI - 0.2, 9);
    const a = { target: [0, 1, 0] as [number, number, number], distance: 4, yaw: 0 };
    const b = { target: [0, 1.2, 0] as [number, number, number], distance: 2, yaw: Math.PI };
    expect(lerpPose(a, b, 0)).toEqual(a);
    expect(lerpPose(a, b, 1)).toEqual(b);
    expect(lerpPose(a, b, 0.5).yaw).toBeCloseTo(Math.PI / 2, 9);
    const [x, y, z] = cameraPosition({ target: [0, 1, 0], distance: 2, yaw: Math.PI });
    expect([x, y, z].map((v) => +v.toFixed(9))).toEqual([0, 1, -2]);
  });
});

describe("3D picker assets", () => {
  it("versions the model URL and the cache by the model's SHA-256", () => {
    expect(GLB_SHA256).toBe("0886b6a068e655b284903664e2178d7964f80b1c0ce798461909ac806bcef2e3");
    expect(GLB_URL).toBe("/models/body.glb?v=0886b6a068e6");
    expect(ANATOMY_CACHE).toBe("anatomy-0886b6a068e6");
    for (const p of ["/models/body.glb", "/assets/draco_decoder-Z1_iN-Ht.wasm", "/assets/draco_wasm_wrapper-fZCQGLGb.js", "/assets/anatomy3d-Ab12_x.js"])
      expect(isAnatomyAsset(p), p).toBe(true);
    for (const p of ["/assets/index-Ab12.js", "/models/other.glb", "/assets/draco_decoder.wasm", "/api/library/media/x"]) expect(isAnatomyAsset(p), p).toBe(false);
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ANATOMY_ROWS, MAPPED_MUSCLES, anatomyOf, baseName } from "../../web/src/lib/anatomy-map";
import { BODY_AREAS, areaOfMuscle } from "../../worker/lib/bodyAreas";
import { CANONICAL_MUSCLES } from "../../worker/lib/muscles";

// SPEC-v6 §3: the model → app muscle mapping, checked against the GLB's own node list (vitest.config.ts reads its JSON chunk).
describe("3D anatomy mapping (SPEC-v6 M9b-3D)", () => {
  const nodes = env.TEST_GLB_NODES;
  const muscleNodes = nodes.filter((n) => n.type === "muscle");

  it("reads the model: 440 muscle nodes, 222 muscle names", () => {
    expect(muscleNodes).toHaveLength(440);
    expect(new Set(muscleNodes.map((n) => baseName(n.name))).size).toBe(222);
  });

  it("gives every picker muscle at least one mapped mesh, and neck none", () => {
    const pickerMuscles = [...new Set(BODY_AREAS.flatMap((a) => a.muscles))];
    expect(pickerMuscles).toHaveLength(18);
    for (const m of pickerMuscles) {
      const meshes = muscleNodes.filter((n) => n.mesh && anatomyOf(n.name)?.muscle === m);
      expect(meshes.length, m).toBeGreaterThanOrEqual(1);
    }
    expect(MAPPED_MUSCLES).not.toContain("neck");
    expect([...MAPPED_MUSCLES].sort()).toEqual(CANONICAL_MUSCLES.filter((m) => m !== "neck").sort());
    for (const m of MAPPED_MUSCLES) expect(areaOfMuscle(m), m).not.toBeNull();
  });

  it("maps parts of one muscle by where they are, not only by their names (the model swaps two trapezius names)", () => {
    // Mesh centres in model space (metres, y up, +z front), both sides.
    const centre = (name: string) => {
      const ns = muscleNodes.filter((n) => n.mesh && n.min && baseName(n.name) === name);
      expect(ns.length, name).toBeGreaterThanOrEqual(2);
      return [0, 1, 2].map((i) => ns.reduce((a, n) => a + (n.min![i] + n.max![i]) / 2, 0) / ns.length);
    };
    const y = (name: string) => centre(name)[1];
    const z = (name: string) => centre(name)[2];
    // Trapezius: the part mapped to traps (upper fibres) is above both parts mapped to upper back.
    const trap = ANATOMY_ROWS.filter((r) => /part of trapezius/.test(r.name));
    const upper = trap.filter((r) => r.muscle === "traps").map((r) => y(r.name));
    const midLower = trap.filter((r) => r.muscle === "back_upper").map((r) => y(r.name));
    expect(upper).toHaveLength(1);
    expect(midLower).toHaveLength(2);
    expect(Math.min(...upper)).toBeGreaterThan(Math.max(...midLower));
    expect(anatomyOf("Ascending part of trapezius muscle")?.muscle).toBe("traps");
    expect(anatomyOf("Descending part of trapezius muscle")?.muscle).toBe("back_upper");
    // Chest regions top to bottom; front delts in front of rear delts.
    const pec = (region: string) => y(ANATOMY_ROWS.find((r) => r.region === region && r.muscle === "chest")!.name);
    expect(pec("chest_upper")).toBeGreaterThan(pec("chest_mid"));
    expect(pec("chest_mid")).toBeGreaterThan(pec("chest_lower"));
    expect(z("Clavicular part of deltoid muscle")).toBeGreaterThan(z("Scapular spinal part of deltoid muscle"));
  });

  it("maps only names that exist in the model as muscles with a mesh, on both sides", () => {
    for (const r of ANATOMY_ROWS) {
      const copies = muscleNodes.filter((n) => baseName(n.name) === r.name);
      expect(copies.length, r.name).toBeGreaterThanOrEqual(r.name === "Linea alba" ? 1 : 2);
      expect(copies.every((n) => n.mesh), r.name).toBe(true);
    }
  });

  it("maps no name twice", () => {
    const names = ANATOMY_ROWS.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("strips only the left/right suffix", () => {
    expect(anatomyOf("Long head of triceps brachii.001")).toMatchObject({ muscle: "triceps", region: "triceps_long" });
    expect(anatomyOf("Long head of triceps brachii")).toMatchObject({ muscle: "triceps" });
    expect(anatomyOf("Sternocleidomastoid muscle.001")).toBeNull();
    expect(anatomyOf("Humerus")).toBeNull();
  });
});

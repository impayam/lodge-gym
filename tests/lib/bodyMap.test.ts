import { describe, expect, it } from "vitest";
import { BACK, FRONT, SILHOUETTE, VIEW_W, bothSides, mirrorPath, type RegionKey } from "../../web/src/components/bodyMap";
import { groupOf } from "../../worker/lib/muscles";

const KEYS: RegionKey[] = ["chest", "back_lats", "back_upper", "traps", "lower_back", "shoulders_front", "shoulders_side", "rear_delts", "biceps", "triceps", "forearms", "core", "quads", "hamstrings", "glutes", "adductors", "calves"];
const numbers = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number);
const xs = (d: string) => numbers(d).filter((_, i) => i % 2 === 0);

describe("muscle map figures", () => {
  it("mirror the figure's left half across the centre line", () => {
    expect(mirrorPath("M10,20 L30.5,40 C1,2 3,4 5,6 Q7,8 9,10 Z")).toBe("M190,20 L169.5,40 C199,2,197,4,195,6 Q193,8,191,10 Z");
    for (const r of [...FRONT, ...BACK]) expect(numbers(mirrorPath(mirrorPath(r.d)))).toEqual(numbers(r.d));
    expect(() => mirrorPath("m10,20 l5,5 z")).toThrow(/relative/);
  });

  it("draw every region key once per side, in absolute commands on the left half only", () => {
    expect(new Set([...FRONT, ...BACK].map((r) => r.key))).toEqual(new Set(KEYS));
    for (const r of [...FRONT, ...BACK]) {
      expect(r.d, r.key).toMatch(/^M[\d.,\s LCQZ-]+$/);
      expect(Math.max(...xs(r.d)), r.key).toBeLessThanOrEqual(VIEW_W / 2);
      expect(groupOf(r.key), r.key).not.toBeNull();
    }
    const both = bothSides(FRONT);
    expect(both).toHaveLength(FRONT.length * 2);
    expect(Math.min(...xs(both[1].d))).toBeGreaterThanOrEqual(VIEW_W / 2);
  });

  it("build the silhouette as one closed outline, symmetric about x = 100", () => {
    expect(SILHOUETTE.match(/M/g)).toHaveLength(1);
    expect(SILHOUETTE.trim().endsWith("Z")).toBe(true);
    const pts = numbers(SILHOUETTE);
    const pairs: string[] = [];
    for (let i = 0; i < pts.length; i += 2) pairs.push(`${Math.round(pts[i] * 100)},${Math.round(pts[i + 1] * 100)}`);
    const set = new Set(pairs);
    for (const p of pairs) {
      const [x, y] = p.split(",").map(Number);
      expect(set.has(`${VIEW_W * 100 - x},${y}`), `mirror of ${p}`).toBe(true);
    }
  });
});

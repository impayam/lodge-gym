import { describe, expect, it } from "vitest";
import { BACK, FRONT, FRONT_DETAIL, LANDMARKS, SILHOUETTE, VIEW_W, bothSides, mirrorPath, type HalfRegion, type RegionKey } from "../../web/src/components/bodyMap";
import { groupOf } from "../../worker/lib/muscles";

const KEYS: RegionKey[] = ["chest", "back_lats", "back_upper", "traps", "lower_back", "shoulders_front", "shoulders_side", "rear_delts", "biceps", "triceps", "forearms", "core", "quads", "hamstrings", "glutes", "adductors", "calves"];
const numbers = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number);
const xs = (d: string) => numbers(d).filter((_, i) => i % 2 === 0);

/** Points along an absolute M/L/C/Q/Z path (the curves themselves, not their control points). */
function sample(d: string, steps = 24): [number, number][] {
  const out: [number, number][] = [];
  let cur: [number, number] = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([MLCQZ])([^MLCQZ]*)/g)) {
    const n = args.trim() ? args.trim().split(/[\s,]+/).map(Number) : [];
    if (cmd === "M" || cmd === "L") {
      cur = [n[0], n[1]];
      out.push(cur);
    } else if (cmd === "C" || cmd === "Q") {
      const p = [cur, ...Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i], n[2 * i + 1]] as [number, number])];
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const c = p.length === 4 ? [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3] : [(1 - t) ** 2, 2 * (1 - t) * t, t ** 2];
        out.push([c.reduce((a, w, i) => a + w * p[i][0], 0), c.reduce((a, w, i) => a + w * p[i][1], 0)]);
      }
      cur = p[p.length - 1];
    }
  }
  return out;
}
const ys = (pts: [number, number][]) => pts.map((p) => p[1]);
const region = (list: HalfRegion[], key: RegionKey) => sample(list.filter((r) => r.key === key).map((r) => r.d).join(" "));

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

  describe("8-head canon (head top 0, sole 8; within 2% of the height)", () => {
    const body = sample(SILHOUETTE);
    const top = Math.min(...ys(body));
    const sole = Math.max(...ys(body));
    const heads = (y: number) => (8 * (y - top)) / (sole - top);
    const width = (x: number) => (8 * 2 * (100 - x)) / (sole - top);
    const TOL = 0.16; // 2% of 8 heads
    const near = (label: string, got: number, want: number) => expect(Math.abs(got - want), `${label}: ${got.toFixed(2)} heads, want ${want}`).toBeLessThanOrEqual(TOL);

    it("silhouette landmarks", () => {
      near("chin", heads(LANDMARKS.chin[1]), 1);
      near("elbow (navel level)", heads(LANDMARKS.elbow[1]), 3);
      near("wrist (crotch level)", heads(LANDMARKS.wrist[1]), 4);
      near("crotch", heads(LANDMARKS.crotch[1]), 4);
      expect(Math.abs((LANDMARKS.crotch[1] - top) / (sole - top) - 0.5)).toBeLessThanOrEqual(0.02);
      const hand = body.filter(([x, y]) => x < 58 && y > LANDMARKS.wrist[1] - 5);
      near("fingertips (mid-thigh)", heads(Math.max(...ys(hand))), 4.6);
      near("knee centre", heads(LANDMARKS.knee[1]), 6);
      near("ankle", heads(LANDMARKS.ankle[1]), 7.6);
      near("sole", heads(sole), 8);
      const shoulder = body.filter(([, y]) => y > 80 && y < 130);
      near("shoulder width", width(Math.min(...shoulder.map((p) => p[0]))), 2);
      near("hip width", width(LANDMARKS.hip[0]), 1.5);
    });

    it("front regions scale with the body", () => {
      near("pec bottom", heads(Math.max(...ys(region(FRONT, "chest")))), 2);
      const navel = sample(FRONT_DETAIL[FRONT_DETAIL.length - 1]);
      near("navel", heads((Math.min(...ys(navel)) + Math.max(...ys(navel))) / 2), 3);
      near("abs end at the iliac crest", heads(Math.max(...ys(region(FRONT.filter((r) => r.key === "core").slice(0, 1), "core")))), 3.6);
      const quads = ys(region(FRONT, "quads"));
      near("quads top", heads(Math.min(...quads)), 4.2);
      near("quads bottom", heads(Math.max(...quads)), 5.8);
      const calves = ys(region(FRONT, "calves"));
      near("front calves top", heads(Math.min(...calves)), 6.2);
      near("front calves bottom", heads(Math.max(...calves)), 7.3);
      expect(heads(LANDMARKS.ankle[1]) - heads(Math.max(...calves)), "bare lower shin above the ankle").toBeGreaterThanOrEqual(0.2);
    });

    it("back regions scale with the body", () => {
      const glutes = ys(region(BACK, "glutes"));
      near("glutes top (iliac crest)", heads(Math.min(...glutes)), 3.6);
      near("glutes bottom (gluteal fold)", heads(Math.max(...glutes)), 4.45);
      const hams = ys(region(BACK, "hamstrings"));
      near("hamstrings top", heads(Math.min(...hams)), 4.45);
      near("hamstrings bottom", heads(Math.max(...hams)), 5.85);
      const calves = ys(region(BACK, "calves"));
      near("back calves top", heads(Math.min(...calves)), 6.2);
      near("back calves bottom", heads(Math.max(...calves)), 7.3);
      expect(heads(LANDMARKS.ankle[1]) - heads(Math.max(...calves)), "bare lower shin above the ankle").toBeGreaterThanOrEqual(0.2);
    });
  });
});

// Anatomical front and back figures for the muscle map. Original drawing for Lodge Gym (no third-party artwork).
//
// Only the figure's left half (x ≤ 100 in a 200 × 460 viewBox) is drawn; the right half is its mirror image, so both
// figures are symmetric by construction. The silhouette is one closed outline built from the half outline and its
// reversed mirror, so the body has no seams and no second layer. Every region carries one canonical muscle key
// (worker/lib/muscles.ts); the map colours it by the key's report group.

export const VIEW_W = 200;
export const VIEW_H = 460;

export type RegionKey =
  | "chest"
  | "back_lats"
  | "back_upper"
  | "traps"
  | "lower_back"
  | "shoulders_front"
  | "shoulders_side"
  | "rear_delts"
  | "biceps"
  | "triceps"
  | "forearms"
  | "core"
  | "quads"
  | "hamstrings"
  | "glutes"
  | "adductors"
  | "calves";

/** One muscle region of the left half: a closed path in absolute M/L/C/Q/Z commands. */
export interface HalfRegion {
  key: RegionKey;
  d: string;
}

/** A cubic segment of the half outline: control points and end point. */
type Seg = [number, number, number, number, number, number];

/** Mirrors an absolute M/L/C/Q/Z path across the figure's vertical centre line. */
export function mirrorPath(d: string): string {
  const out: string[] = [];
  const re = /([MLCQZ])([^MLCQZ]*)/gi;
  for (const [, cmd, args] of d.matchAll(re)) {
    if (cmd !== cmd.toUpperCase()) throw new Error(`relative path command ${cmd} cannot be mirrored`);
    const n = args.trim() ? args.trim().split(/[\s,]+/).map(Number) : [];
    out.push(cmd + n.map((v, i) => (i % 2 === 0 ? round(VIEW_W - v) : round(v))).join(","));
  }
  return out.join(" ");
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Closed outline from the left half (top centre → … → bottom centre) and its reversed mirror. */
function outline(start: [number, number], segs: Seg[]): string {
  const pts: [number, number][] = [start, ...segs.map((s) => [s[4], s[5]] as [number, number])];
  const fwd = segs.map((s) => `C${s.map(round).join(",")}`).join(" ");
  const back: string[] = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const [c1x, c1y, c2x, c2y] = segs[i];
    const [px, py] = pts[i];
    back.push(`C${[VIEW_W - c2x, c2y, VIEW_W - c1x, c1y, VIEW_W - px, py].map(round).join(",")}`);
  }
  return `M${start.join(",")} ${fwd} ${back.join(" ")} Z`;
}

/* ---------------- proportions: the 8-head adult male canon ---------------- */

/** Top of the head and the sole; one head is an eighth of the figure's height (56.5 units). */
export const TOP_Y = 4;
export const SOLE_Y = 456;
export const HEAD = (SOLE_Y - TOP_Y) / 8;
/** y of a canon landmark given in heads from the top of the head (chin 1, pecs 2, navel 3, crotch 4, knee 6, sole 8). */
const at = (heads: number) => round(TOP_Y + heads * HEAD);

/* ---------------- silhouette (left half, from the top of the head down and back up to the crotch) ---------------- */

/** One cubic segment of the half outline; named ones end on a landmark the unit tests measure. */
interface Anchor {
  seg: Seg;
  name?: string;
}

const HALF: Anchor[] = [
  { seg: [88.5, TOP_Y, 81.5, 14, 81.5, 29], name: "temple" }, // crown to the widest point of the head
  { seg: [81.5, 42, 85, 53, 90.5, at(1)], name: "chin" }, // jaw, ending where the neck starts at chin level
  { seg: [91, 64, 90.5, 68, 89.5, 72], name: "neck" },
  { seg: [82, 77, 66, 81, 55, 84.5], name: "acromion" }, // trapezius slope
  { seg: [47, 87, 43.5, 93, 43.5, 103], name: "deltoid" }, // shoulder width: 2 heads
  { seg: [43.5, 120, 42, 140, 41.5, 158] }, // upper arm, outer
  { seg: [41.2, 165, 41, 170, 41, at(3)], name: "elbow" }, // elbow at navel level
  { seg: [39, 190, 38.5, 210, 40.5, at(4)], name: "wrist" }, // forearm, outer; wrist at crotch level
  { seg: [38.5, 240, 38, 252, 40.5, 261] }, // hand, outer
  { seg: [42.5, 266, 48, 267.5, 51, at(4.6)], name: "fingertips" }, // fingertips at mid-thigh
  { seg: [54, 256, 55.5, 244, 55, 232] }, // hand, inner
  { seg: [56, 212, 58.5, 192, 60, 177] }, // forearm, inner
  { seg: [61.5, 160, 62, 130, 64, 107], name: "armpit" }, // upper arm, inner
  { seg: [65, 125, 66, 150, 67.5, 172], name: "waist" }, // flank
  { seg: [68.5, 190, 62, 208, 58.5, 228], name: "hip" }, // hip width: 1.5 heads
  { seg: [57, 250, 59, 288, 64.5, 322] }, // thigh, outer
  { seg: [66.5, 331, 67.5, 337, 67.5, at(6)], name: "knee" }, // knee centre at 6 heads
  { seg: [64, 362, 64.5, 392, 71.5, 418] }, // calf, outer
  { seg: [73.5, 424, 74, 429, 73.5, at(7.6)], name: "ankle" }, // ankle at 7.6 heads
  { seg: [70.5, 442, 70.5, SOLE_Y, 80, SOLE_Y], name: "sole" }, // heel to sole
  { seg: [87, SOLE_Y, 92, 455, 91.5, 447] }, // foot, inner
  { seg: [90.5, 441, 90.5, 437, 90.5, at(7.6)] }, // ankle, inner
  { seg: [93.5, 412, 95.5, 384, 94, 364] }, // calf, inner
  { seg: [93, 357, 93, 350, 94, at(6)] }, // knee, inner
  { seg: [97, 300, 99.3, 262, 100, at(4)], name: "crotch" }, // thigh, inner: the crotch at exactly half the height
];

export const SILHOUETTE = outline([100, TOP_Y], HALF.map((a) => a.seg));
/** End points of the named outline segments (left half), for the proportion tests. */
export const LANDMARKS: Readonly<Record<string, readonly [number, number]>> = Object.fromEntries(HALF.filter((a) => a.name).map((a) => [a.name!, [a.seg[4], a.seg[5]] as const]));

/* ---------------- front ---------------- */

export const FRONT: HalfRegion[] = [
  // Upper trapezius, between the neck and the clavicle.
  { key: "traps", d: "M90.5,72.5 C88.5,78 78,81.8 60,85.2 C69,86.8 79.5,86.8 91,85.8 C92,81.5 91.5,76.5 90.5,72.5 Z" },
  // Pectoralis major: sternum, clavicle, the anterior deltoid border, the armpit fold and the lower edge at 2 heads.
  { key: "chest", d: "M98.5,90 L78,88 C72,93 67.5,100 65.8,107 C65,111 65.2,114.5 66.6,117 C72,121.5 81,123 90,121.5 C95,120.5 98,118.5 98.5,116 Z" },
  // Anterior deltoid.
  { key: "shoulders_front", d: "M77,87 C68,85.5 59,87.5 53,94 C49,102 48.5,116 51,136 C56,126 60,116 64.5,107.5 C67,99 71,92 77,87 Z" },
  // Lateral deltoid (the cap, seen from the front).
  { key: "shoulders_side", d: "M57,86.6 C49.5,88 45.5,95 45,105 C44.5,118 46.5,130 49.5,141 L51.5,136 C49,116 49.5,102 53,94 C54.5,90 55.5,88 57,86.6 Z" },
  // Biceps brachii, from the deltoid insertion to the elbow.
  { key: "biceps", d: "M51,141 C46.5,148.5 44.5,158 45.2,167 C45.6,172 47.6,175.5 50.5,177 C55,173 58.3,166 58.8,157.5 C59.2,149.5 56,144 51,141 Z" },
  // Forearm flexors, elbow to wrist.
  { key: "forearms", d: "M44.5,182 C41.8,194 41.2,210 42.6,226 L54.3,228 C55.2,212 57.2,197 58.8,184 C53.5,179.5 48.5,179.5 44.5,182 Z" },
  // Rectus abdominis, from below the pecs to the iliac crest (3.6 heads), and the obliques.
  { key: "core", d: "M98.5,124.5 C93,124.5 87,125.5 84,128 C83,150 84,175 86.5,197 C89.5,203 94,206.5 98.5,208 Z" },
  { key: "core", d: "M81.5,126 C76,130 72,138 71,150 C70.5,168 71.5,182 73,193 C75.5,200 79.5,205 84,208 C82.5,190 81.5,160 81.5,126 Z" },
  // Quadriceps, 4.2 to 5.8 heads.
  { key: "quads", d: "M60.8,240 C59,260 60,286 63.8,308 C66.2,320 70,329 75,333 C81,335.5 87,334 90.5,329 C93.5,312 94,290 92.5,272 C90.5,257 85,246 78.5,241 C72,237.5 65,237 60.8,240 Z" },
  // Adductors, inner thigh.
  { key: "adductors", d: "M98.5,235 C94.5,235.5 91.5,240 90,247 C89.5,265 91.5,283 94.5,299 C96.8,285 98.3,265 98.5,249 Z" },
  // Gastrocnemius and soleus, 6.2 to 7.3 heads, seen on both sides of the shin; the lower shin and the ankle stay bare.
  { key: "calves", d: "M69.8,356 C66.8,370 67.2,390 71,411 C72.8,411.5 74.6,410.5 76,408.5 C74.6,391 74.6,372 76,356 Z" },
  { key: "calves", d: "M86,354 C92.5,360 94.6,374 93.6,390 C92.6,402 90.3,411 87,416 C85.5,402 85,388 85.5,374 Z" },
];

/* ---------------- back ---------------- */

export const BACK: HalfRegion[] = [
  // Trapezius: occiput to the acromion and down to the mid back.
  { key: "traps", d: "M98.5,50 C95.5,60 92,68 87.2,74.6 C79,79.6 67,83 56.5,85.8 C66,90 76,97 84.5,108 C91,121 95.5,135 98.5,152 Z" },
  // Infraspinatus, teres and rhomboids over the scapula.
  { key: "back_upper", d: "M85,110 C78,104 71,104 67.5,110 C65.6,117 66,127 68.5,135 C74.5,141 82.5,145 90,147 C91,133 89.5,120 85,110 Z" },
  // Posterior deltoid.
  { key: "rear_delts", d: "M62,87.8 C55.5,89.8 51,97 50.6,107 C50.2,118 51.6,127 54,136 C58.5,126 62.5,116 66,107.5 C66,99 64.5,92 62,87.8 Z" },
  // Lateral deltoid (the cap, seen from behind).
  { key: "shoulders_side", d: "M57,86.6 C49.5,88 45.5,95 45,105 C44.5,118 46.5,130 49.5,141 L52,136 C50,121 50.5,107 52.5,98 C53.5,92 55,88.5 57,86.6 Z" },
  // Latissimus dorsi, from under the scapula (its top edge follows the upper back's lower edge) to the lower back.
  { key: "back_lats", d: "M67.2,131 C73,139.8 81.5,145.8 90.5,149 C92.5,150.5 94,151.5 95.5,152.5 C91.5,158 88,167 87,178 C85.5,187 83,195 80,201 C74.5,192 71,180 69.6,168 C67.4,152 66.5,139 67.2,131 Z" },
  // Erector spinae, lumbar, down to the sacrum.
  { key: "lower_back", d: "M98.5,166 C93.5,170 89.5,179 89,191 C88.5,201 90.5,210 94,216 C95.5,217.5 97,218 98.5,218 Z" },
  // Triceps brachii.
  { key: "triceps", d: "M46,141 C43.2,152 42.8,163 44.2,172 C45.6,176 47.8,178 50.5,178.5 C55,174 58.3,166 58.8,157.5 C59.2,149.5 57,144 52.5,140 Z" },
  // Forearm extensors.
  { key: "forearms", d: "M44.5,182 C41.8,194 41.2,210 42.6,226 L54.3,228 C55.2,212 57.2,197 58.8,184 C53.5,179.5 48.5,179.5 44.5,182 Z" },
  // Gluteus maximus, from the iliac crest to the gluteal fold.
  { key: "glutes", d: "M98.5,212 C90,207 79,206 70.5,209.5 C63.8,214.5 61.4,226 62.2,238 C63.6,249 72,255.5 84,256 C90,256 95,254.5 98.5,252 Z" },
  // Hamstrings, from the gluteal fold to behind the knee.
  { key: "hamstrings", d: "M63,256 C61.6,274 63,295 67.5,314 C70,325 73.5,332 78,335 C83,336.5 87.5,334 89.5,329 C92,312 93,292 93,274 C92.6,265 91.6,260 90,258 C82,261 70,261 63,256 Z" },
  // Adductor magnus, inner thigh.
  { key: "adductors", d: "M97.5,260 C94.5,262.5 93,267 93,272 C93.5,284 94.5,294 96,302 C97,290 97.8,274 97.5,260 Z" },
  // Gastrocnemius and soleus, 6.2 to 7.3 heads.
  { key: "calves", d: "M70.5,356 C66.8,368 66.8,388 70.4,406 C73,415 79,418.5 83.5,414 C88,402 91.5,384 91.5,368 C88,358.5 79,354 70.5,356 Z" },
];

/** Decorative anatomy lines (not tap targets), left half: the abdominal intersections, the navel at 3 heads, the
 * split between the calf heads. */
export const FRONT_DETAIL = ["M84.3,141 C90,140 95,140 98.5,141", "M84.7,157 C90,156 95,156 98.5,157", `M98.5,${at(3) - 2.5} C97,${at(3) - 1.5} 97,${at(3) + 1.5} 98.5,${at(3) + 2.5}`];
export const BACK_DETAIL = ["M80,362 C79,378 78,394 77,410"];

/** Both halves of a figure: each left-half region and its mirror (separate shapes, so each side is a tap target). */
export function bothSides(regions: HalfRegion[]): HalfRegion[] {
  return regions.flatMap((r) => [r, { key: r.key, d: mirrorPath(r.d) }]);
}

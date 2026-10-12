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

/* ---------------- silhouettes (left half, from the top of the head down and back up to the crotch) ---------------- */

const SIL_SEGS: Seg[] = [
  [88, 6, 81, 16, 81, 30], // head, crown to temple
  [81, 42, 84, 52, 89, 57], // jaw
  [90, 62, 89, 68, 87, 72], // neck
  [80, 77, 66, 80, 56, 83], // trapezius slope
  [45, 85, 37, 93, 36, 108], // deltoid cap
  [35, 122, 35, 142, 36, 165], // upper arm, outer
  [36.5, 178, 35.5, 188, 35, 196], // elbow, outer
  [32, 212, 31, 232, 35, 256], // forearm, outer
  [33, 266, 31, 278, 33, 290], // hand, outer
  [35, 300, 41, 305, 46, 300], // fingertips
  [49, 292, 50, 278, 50, 262], // hand, inner
  [51, 240, 55, 216, 56, 198], // forearm, inner
  [57, 188, 58, 178, 58.5, 168], // elbow, inner
  [59, 152, 60, 138, 63, 128], // upper arm, inner, to the armpit
  [66, 148, 67, 170, 71, 196], // flank
  [72, 214, 68, 232, 65, 248], // waist to hip
  [61, 268, 61, 300, 65, 330], // thigh, outer
  [67, 344, 69, 352, 69, 360], // knee, outer
  [64, 378, 66, 402, 72, 428], // calf, outer
  [72, 438, 66, 446, 70, 452], // ankle, outer, to the heel
  [76, 456, 86, 456, 90, 452], // foot
  [91, 446, 90, 438, 90, 430], // ankle, inner
  [93, 408, 94, 384, 93, 366], // calf, inner
  [92, 358, 93, 352, 94, 346], // knee, inner
  [97, 320, 99, 296, 100, 272], // thigh, inner, to the crotch
];

export const SILHOUETTE = outline([100, 6], SIL_SEGS);

/* ---------------- front ---------------- */

export const FRONT: HalfRegion[] = [
  // Upper trapezius, between the neck and the clavicle.
  { key: "traps", d: "M89.5,70 C88,76 78,80 61,84 C70,85.5 79,85.5 90,84 C91,79 90.5,74 89.5,70 Z" },
  // Pectoralis major: sternum, clavicle, the anterior deltoid border, the armpit fold and the lower edge.
  { key: "chest", d: "M98.5,88 L77,86 C71,91 66,99 64,108 C62.5,116 62.5,123 64.5,129 C70,137 80,142 90,141 C95,140 98,138 98.5,135 Z" },
  // Anterior deltoid.
  { key: "shoulders_front", d: "M76,85 C67,83 58,85 52,91 C48,99 47,112 50,130 C55,121 59,112 63,104 C66,97 70,90 76,85 Z" },
  // Lateral deltoid (the cap, seen from the front).
  { key: "shoulders_side", d: "M57,84 C46,86 38,95 37.5,108 C37,120 40,130 46,138 L50,131 C47,116 47,103 51,94 C52.5,89 54.5,86 57,84 Z" },
  // Biceps brachii.
  { key: "biceps", d: "M49,136 C43,146 40,160 41,175 C42,184 45,190 50,193 C55,188 58,178 58,166 C58,152 55,142 49,136 Z" },
  // Forearm flexors.
  { key: "forearms", d: "M38,199 C34,214 33,233 36.5,254 L49.5,256 C52,238 55,217 56,201 C50,196 43,196 38,199 Z" },
  // Rectus abdominis and the obliques.
  { key: "core", d: "M98.5,144 C93,144 87,145 84,148 C83,172 84,200 87,228 C90,238 95,244 98.5,249 Z" },
  { key: "core", d: "M81,147 C76,151 72,160 71,175 C71,194 72.5,209 74,221 C77,231 81,238 86,243 C83,220 81,190 81,147 Z" },
  // Quadriceps.
  { key: "quads", d: "M65.5,253 C62,272 62,298 64.5,322 C66,336 69.5,347 75,353 C81,356 87,354 90.5,348 C93.5,330 93.5,305 91.5,287 C89.5,271 84,259 78,254 C73,250 68,250 65,253 Z" },
  // Adductors, inner thigh.
  { key: "adductors", d: "M98.5,266 C94,266 90,270 88,278 C87,296 90,316 93,332 C97,316 98.5,296 98.5,278 Z" },
  // Gastrocnemius and soleus, seen on both sides of the shin.
  { key: "calves", d: "M68.5,366 C64.5,380 65,398 70,416 C72,416 74,415 75.5,413 C73.5,398 73.5,381 75,366 Z" },
  { key: "calves", d: "M85.5,364 C92,370 94.5,384 93.5,398 C92.5,408 90,415 86.5,418 C85,404 84.5,390 85,376 Z" },
];

/* ---------------- back ---------------- */

export const BACK: HalfRegion[] = [
  // Trapezius: occiput to the acromion and down to the mid back.
  { key: "traps", d: "M98.5,50 C95.5,60 91,68 85,73 C77,79 67,82 57,84 C67,88 77,95 85,106 C91,118 95.5,134 98.5,154 Z" },
  // Infraspinatus, teres and rhomboids over the scapula.
  { key: "back_upper", d: "M84,106 C77,100 69,100 65.5,106 C62.5,114 63,125 66.5,133 C73,139 82,143 90,145 C91,131 89,116 84,106 Z" },
  // Posterior deltoid.
  { key: "rear_delts", d: "M63,86 C56,88 51,96 50,106 C49,116 50,124 53,133 C58,123 62,113 66,104 C66,97 65.5,91 63,86 Z" },
  // Lateral deltoid (the cap, seen from behind).
  { key: "shoulders_side", d: "M57,84 C46,86 38,95 37.5,108 C37,120 40,130 46,138 L50,132 C48,118 48,106 50,96 C52,90 54,86.5 57,84 Z" },
  // Latissimus dorsi.
  { key: "back_lats", d: "M66.5,137 C65.5,153 67,173 71.5,192 C73,206 76,218 81,228 C84,222 86,214 87,204 C88,190 92,178 96,170 C95,162 94,155 92,149 C83,147 73,143 65,137 Z" },
  // Erector spinae, lumbar.
  { key: "lower_back", d: "M98.5,176 C93,180 88.5,190 88,204 C87.5,220 89.5,236 93,246 C95,247.5 97,248 98.5,248 Z" },
  // Triceps brachii.
  { key: "triceps", d: "M44,137 C38.5,149 37.5,164 39.5,178 C41.5,186 45.5,191 50,193 C55.5,187 58,175 58,161 C58,150 55.5,142 50,136 Z" },
  // Forearm extensors.
  { key: "forearms", d: "M38,199 C34,214 33,233 36.5,254 L49.5,256 C52,238 55,217 56,201 C50,196 43,196 38,199 Z" },
  // Gluteus maximus.
  { key: "glutes", d: "M98.5,254 C90,249 79,247 70,250 C63,255 61,268 63,281 C65,293 74,301 86,302 C91,302 95,301 98.5,299 Z" },
  // Hamstrings.
  { key: "hamstrings", d: "M64.5,299 C62.5,317 64.5,337 70.5,353 C76.5,358 82.5,358 86.5,353 C89.5,337 90.5,319 90.5,305 C82.5,307 72.5,305 64.5,299 Z" },
  // Adductor magnus, inner thigh.
  { key: "adductors", d: "M97.5,300 C94,302 91.5,306 91,312 C91.5,322 92,332 93.5,340 C95,328 96.5,314 97.5,300 Z" },
  // Gastrocnemius and soleus.
  { key: "calves", d: "M70,362 C65.5,374 65.5,394 69.5,412 C73,420 78.5,422 82.5,417 C86.5,405 89.5,387 89.5,372 C85.5,363 77.5,359 69.5,362 Z" },
];

/** Decorative anatomy lines (not tap targets), left half. */
export const FRONT_DETAIL = ["M84,170 C90,169 95,169 98.5,170", "M85,194 C90,193 95,193 98.5,194", "M86,218 C90,217 95,217 98.5,218"];
export const BACK_DETAIL = ["M79,368 C78,382 77,396 76,410"];

/** Both halves of a figure: each left-half region and its mirror (separate shapes, so each side is a tap target). */
export function bothSides(regions: HalfRegion[]): HalfRegion[] {
  return regions.flatMap((r) => [r, { key: r.key, d: mirrorPath(r.d) }]);
}

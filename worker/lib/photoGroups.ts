// Which progress photos may be compared (PR #26 review, Payam 2026-10-17): only photos of the same pose AND the same
// framing (migration 0015). A photo without a framing (from the library, or older) pairs only with another one without.
// Used by Profile's Before · After and the month report's first and last photo. Pure, unit-tested.

import type { Framing, Photo, Pose } from "./types";

export const FRAMING_LABEL: Record<Framing, string> = { full: "Full body", upper: "Upper body" };

const POSE_ORDER: readonly Pose[] = ["front", "side", "back", "other"];
const FRAMING_ORDER: readonly (Framing | null)[] = ["full", "upper", null];

export interface PhotoGroup {
  pose: Pose;
  framing: Framing | null;
  /** Oldest first. */
  photos: Photo[];
}

const older = (a: Photo, b: Photo) => (a.local_date + a.created_at).localeCompare(b.local_date + b.created_at);

/** The photos by pose (front, side, back, other), then framing (full, upper, none); empty groups left out. */
export function photoGroups(photos: readonly Photo[]): PhotoGroup[] {
  const out: PhotoGroup[] = [];
  for (const pose of POSE_ORDER)
    for (const framing of FRAMING_ORDER) {
      const list = photos.filter((p) => p.pose === pose && (p.framing ?? null) === framing).sort(older);
      if (list.length) out.push({ pose, framing, photos: list });
    }
  return out;
}

/** Before · After: the newest two photos of one pose and framing (front first, full body first), older one first. */
export function beforeAfter(photos: readonly Photo[]): [Photo, Photo] | null {
  for (const g of photoGroups(photos)) if (g.photos.length >= 2) return [g.photos[g.photos.length - 2], g.photos[g.photos.length - 1]];
  return null;
}

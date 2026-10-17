// The guide camera's on-device pose check (SPEC-v10.1; PR #26 review, Payam 2026-10-17), the pure part: from the 33
// body landmarks of MediaPipe's pose model, which framing the photo has (ankles in the frame: full body, otherwise
// upper body, e.g. in a mirror with the phone in hand), where the head top, the feet or the waist and the body's centre
// are, and the one hint that brings the body onto the guide lines. Unit-tested; the model itself is ./poseModel.ts.
//
// Coordinates are shares of the 3:4 frame as the preview shows it (x 0 = left edge, y 0 = top), so the photo's crop
// (mirrored for the front camera) and the hints agree with what is on screen.

import type { Framing } from "../../../worker/lib/types";

export type { Framing };

/** One landmark as the model gives it (normalized to the image it saw). */
export interface Landmark {
  x: number;
  y: number;
  /** 0–1: how likely the point is visible and in the image. */
  visibility?: number;
}

/** MediaPipe pose landmark indices (BlazePose, 33 points). */
export const LM = {
  nose: 0,
  shoulderL: 11,
  shoulderR: 12,
  wristL: 15,
  wristR: 16,
  hipL: 23,
  hipR: 24,
  ankleL: 27,
  ankleR: 28,
  heelL: 29,
  heelR: 30,
  toeL: 31,
  toeR: 32,
} as const;

/** A point counts as seen from this visibility. */
export const SEEN = 0.5;
/** The head top above the nose, as a share of nose-to-shoulders (head top 0, nose ≈ 0.075, shoulders ≈ 0.185 of height). */
export const HEAD_TOP_K = 0.7;
/** The waist between the shoulders and the hip joints (shoulders ≈ 0.185, waist ≈ 0.42, hips ≈ 0.5 of height). */
export const WAIST_K = 0.75;

export interface PoseReading {
  framing: Framing;
  /** Head top, and the feet (full body) or the waist (upper body), as shares of the frame height. */
  top: number;
  base: number;
  /** The body's centre line (shoulders and hips), as a share of the frame width. */
  cx: number;
}

const seen = (p: Landmark | undefined) => !!p && (p.visibility ?? 1) >= SEEN;
const inFrame = (p: Landmark) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const mid = (a: Landmark, b: Landmark) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Ankles in the frame: full body; otherwise upper body (Payam's rule). */
export function framingOf(lms: readonly Landmark[]): Framing {
  return [LM.ankleL, LM.ankleR].some((i) => seen(lms[i]) && inFrame(lms[i])) ? "full" : "upper";
}

/** What the model's landmarks say about the photo; null without a body (no landmarks, or no head and shoulders). */
export function readPose(lms: readonly Landmark[] | null | undefined): PoseReading | null {
  if (!lms || lms.length < 33) return null;
  const nose = lms[LM.nose];
  if (!seen(nose) || (!seen(lms[LM.shoulderL]) && !seen(lms[LM.shoulderR]))) return null;
  const shoulders = mid(lms[LM.shoulderL], lms[LM.shoulderR]);
  const hips = mid(lms[LM.hipL], lms[LM.hipR]);
  const framing = framingOf(lms);
  const top = nose.y - HEAD_TOP_K * (shoulders.y - nose.y);
  let base: number;
  if (framing === "full") {
    const feet = [LM.ankleL, LM.ankleR, LM.heelL, LM.heelR, LM.toeL, LM.toeR].map((i) => lms[i]).filter(seen);
    base = Math.max(...feet.map((p) => p.y));
  } else base = shoulders.y + WAIST_K * (hips.y - shoulders.y);
  return { framing, top: round3(top), base: round3(base), cx: round3((shoulders.x + hips.x) / 2) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/* ---------------- the framing, held steady ---------------- */

/** A new framing must be read this many times in a row before the guide switches to it (the model can flicker). */
export const FRAMING_STREAK = 3;

export interface FramingState {
  framing: Framing;
  /** Whether the pose check has read a body in this camera session. */
  detected: boolean;
  /** The other framing being read, and how often in a row. */
  streak: { framing: Framing; n: number } | null;
}

export const framingStart = (framing: Framing): FramingState => ({ framing, detected: false, streak: null });

/** The framing after one more reading (null: nobody in the frame, which keeps the framing and ends a streak). */
export function nextFraming(s: FramingState, r: PoseReading | null): FramingState {
  if (!r) return s.streak ? { ...s, streak: null } : s;
  if (r.framing === s.framing) return s.detected && !s.streak ? s : { framing: s.framing, detected: true, streak: null };
  const n = s.streak?.framing === r.framing ? s.streak.n + 1 : 1;
  return n >= FRAMING_STREAK ? { framing: r.framing, detected: true, streak: null } : { framing: s.framing, detected: true, streak: { framing: r.framing, n } };
}

/* ---------------- the hint ---------------- */

/** Head-to-base length within ±6 % of the guide's, centre within 6 % of the width, lines within 4 % of the height. */
export const SIZE_TOL = 0.06;
export const CENTRE_TOL = 0.06;
export const LINE_TOL = 0.04;

export type HintKey = "none" | "framing" | "back" | "closer" | "left" | "right" | "raise" | "lower" | "ok";

export interface PoseHint {
  key: HintKey;
  text: string;
}

/**
 * The one thing to change so the body sits on the guide lines (`headY`, `baseY`: shares of the frame height), most
 * important first: someone in the frame, the framing the guide shows, the distance, left / right (as seen on the
 * screen), then the phone's height.
 */
export function poseHint(r: PoseReading | null, guide: { framing: Framing; headY: number; baseY: number }): PoseHint {
  if (!r) return { key: "none", text: "No one in the frame yet." };
  if (r.framing !== guide.framing) return { key: "framing", text: r.framing === "full" ? "Full body found: switching the guide…" : "Upper body found: switching the guide…" };
  const base = guide.framing === "full" ? "feet" : "waist";
  const ratio = (r.base - r.top) / (guide.baseY - guide.headY);
  if (ratio > 1 + SIZE_TOL) return { key: "back", text: `Step back a bit: head and ${base} on the lines.` };
  if (ratio < 1 - SIZE_TOL) return { key: "closer", text: `Step closer a bit: head and ${base} on the lines.` };
  if (r.cx > 0.5 + CENTRE_TOL) return { key: "left", text: "Move left a bit, to the middle." };
  if (r.cx < 0.5 - CENTRE_TOL) return { key: "right", text: "Move right a bit, to the middle." };
  // Raising the phone moves the body down in the picture.
  if (r.top < guide.headY - LINE_TOL) return { key: "raise", text: "Raise the phone a little." };
  if (r.top > guide.headY + LINE_TOL) return { key: "lower", text: "Lower the phone a little." };
  return { key: "ok", text: "On the lines." };
}

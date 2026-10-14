// Active session screen logic (SPEC-v8 §6.02): effort, the current set, which exercise the card shows, the card swipe
// and the rest ring. Pure, unit-tested.

import { effortOf } from "./effort";

export interface SessionEffort {
  done: number;
  planned: number;
  /** done / planned, 0..1. */
  e: number;
}

/** Effort of a session: the share of its sets that are done (SPEC-v8 §6.02, Payam 2026-10-14). */
export function sessionEffort(sets: readonly { done: boolean }[]): SessionEffort {
  const done = sets.filter((x) => x.done).length;
  return { done, planned: sets.length, e: effortOf(done, sets.length) };
}

/** The set to do next: the first one not done; -1 when every set is done. */
export function currentSetIndex(sets: readonly { done: boolean }[]): number {
  return sets.findIndex((x) => !x.done);
}

/**
 * The exercise the card shows: the one last shown while it is still in the session, otherwise the first exercise with a
 * set left, otherwise the first.
 */
export function cardIndex(blocks: readonly { id: string; sets: readonly { done: boolean }[] }[], remembered: string | null): number {
  const kept = remembered === null ? -1 : blocks.findIndex((b) => b.id === remembered);
  if (kept >= 0) return kept;
  const open = blocks.findIndex((b) => b.sets.some((x) => !x.done));
  return open >= 0 ? open : 0;
}

/**
 * A horizontal drag on the exercise card (SPEC-v8 §5): left = next exercise, right = previous. It completes past 35% of
 * the card's width or with a fast flick (at least 0.5 px/ms after 24 px), in a direction that has an exercise.
 */
export function cardSwipeOutcome(dx: number, width: number, velocity: number, canPrev: boolean, canNext: boolean): "next" | "prev" | "cancel" {
  const far = Math.abs(dx) >= width * 0.35;
  const flick = Math.abs(velocity) >= 0.5 && Math.abs(dx) >= 24 && Math.sign(velocity) === Math.sign(dx);
  if (!far && !flick) return "cancel";
  if (dx < 0) return canNext ? "next" : "cancel";
  return canPrev ? "prev" : "cancel";
}

/** The rest ring's filled share, 1 at the start of the rest down to 0 when it is over. */
export function restShare(leftSec: number, totalSec: number): number {
  if (totalSec <= 0) return 0;
  return Math.min(1, Math.max(0, leftSec / totalSec));
}

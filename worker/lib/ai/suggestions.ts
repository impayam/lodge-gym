// AI plan advice suggestions (SPEC-v3 M9c): their shape and the plan edits an Apply tap makes, with what Undo needs.
// Nothing changes in a plan without that tap. Pure and free of Zod, shared by the Worker and the PWA.

import { addItem, ADD_DEFAULTS, inPlan, liveItems, moveItemTo, removeItem, replaceItem, restoreItem, updateItem, type PlanItem, type SessionPlan } from "../plan";

export const SUGGESTION_TYPES = ["add", "remove", "replace", "reorder", "sets"] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];

export interface AdviceSuggestion {
  type: SuggestionType;
  exercise_id: string;
  replace_exercise_id: string | null;
  position: number | null;
  sets: number | null;
  reason_fa: string;
}

export interface PlanAdvice {
  assessment_fa: string;
  suggestions: AdviceSuggestion[];
}

/* ---------------- Apply / Undo ---------------- */

/** What Undo needs: the item the suggestion changed, as it was (null when the suggestion added it), and its place. */
export interface AppliedChange {
  itemId: string;
  before: PlanItem | null;
  index: number;
}

/**
 * Applies one suggestion to the plan (an Apply tap). Exercises it adds or swaps in are marked origin 'ai'. Returns null
 * when the suggestion no longer fits the plan (edited since), so nothing changes.
 */
export function applySuggestion(plan: SessionPlan, s: AdviceSuggestion, now: string, newId: string): { plan: SessionPlan; change: AppliedChange } | null {
  const live = liveItems(plan);
  const find = (exId: string) => live.find((it) => it.exercise_id === exId) ?? null;
  const asAi = (p: SessionPlan, itemId: string): SessionPlan => ({ ...p, items: p.items.map((it) => (it.id === itemId ? { ...it, origin: "ai" } : it)) });
  switch (s.type) {
    case "add": {
      if (inPlan(plan, s.exercise_id)) return null;
      let next = asAi(addItem(plan, s.exercise_id, now, newId, { sets: s.sets ?? ADD_DEFAULTS.sets }), newId);
      next = moveItemTo(next, newId, (s.position ?? live.length + 1) - 1, now);
      return { plan: next, change: { itemId: newId, before: null, index: live.length } };
    }
    case "remove": {
      const it = find(s.exercise_id);
      if (!it) return null;
      return { plan: removeItem(plan, it.id, now), change: { itemId: it.id, before: it, index: live.indexOf(it) } };
    }
    case "replace": {
      const it = s.replace_exercise_id ? find(s.replace_exercise_id) : null;
      if (!it || inPlan(plan, s.exercise_id)) return null;
      const swapped = replaceItem(plan, it.id, s.exercise_id, now);
      const item = swapped.items.find((x) => x.id === it.id)!;
      // An exercise swapped back to the program's own is a program item again; anything else came from the advice.
      return { plan: item.origin === "program" ? swapped : asAi(swapped, it.id), change: { itemId: it.id, before: it, index: live.indexOf(it) } };
    }
    case "reorder": {
      const it = find(s.exercise_id);
      if (!it || s.position == null) return null;
      return { plan: moveItemTo(plan, it.id, s.position - 1, now), change: { itemId: it.id, before: it, index: live.indexOf(it) } };
    }
    case "sets": {
      const it = find(s.exercise_id);
      if (!it || s.sets == null) return null;
      return { plan: updateItem(plan, it.id, { sets: s.sets }, now), change: { itemId: it.id, before: it, index: live.indexOf(it) } };
    }
  }
}

/** Undo of one applied suggestion: an added exercise is removed again; anything else goes back to how it was. */
export function undoSuggestion(plan: SessionPlan, change: AppliedChange, now: string): SessionPlan {
  if (!change.before) return removeItem(plan, change.itemId, now);
  return restoreItem(plan, change.before, change.index, now);
}


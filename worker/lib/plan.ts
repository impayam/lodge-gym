// Session planner (SPEC-v3 M9c), pure and shared by the PWA and the Worker. A plan starts as a copy of a program day,
// is edited (replace, add, delete, reorder, sets/reps/rest, groups), saved, and started: the workout session then takes
// the plan's id and the plan keeps describing its order, targets and groups. Removal is a soft delete (removed_at).
// Groups are 2–3 adjacent items with the same group_tag (a superset or a tri-set), lettered A, B, C… in order; any
// exercises can be grouped, with no warning (Payam, 2026-10-13).

import type { DayExercise, ProgramDay } from "./types";

export type PlanStatus = "planned" | "started" | "discarded";
export type PlanOrigin = "program" | "added" | "replaced" | "ai";

export interface PlanItem {
  id: string;
  exercise_id: string;
  position: number;
  sets: number;
  reps_min: number | null;
  reps_max: number | null;
  per_leg: boolean;
  is_time: boolean;
  rest_sec: number | null;
  target_rir_min: number | null;
  target_rir_max: number | null;
  origin: PlanOrigin;
  /** The program exercise this item replaced (kept across further replacements). */
  replaced_exercise_id: string | null;
  group_tag: string | null;
  /** Rest after a full round of the group (same value on every member). */
  group_rest_sec: number | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionPlan {
  /** Becomes the workout session's id when the plan starts. */
  id: string;
  program_day_id: string;
  status: PlanStatus;
  started_at: string | null;
  created_at: string;
  updated_at: string;
  items: PlanItem[];
}

/** An exercise added in the planner (approved default 3): 3 sets × 8–12 reps, 90 s rest, no RIR target. */
export const ADD_DEFAULTS = { sets: 3, reps_min: 8, reps_max: 12, rest_sec: 90 } as const;
export const MIN_SETS = 1;
export const MAX_SETS = 10;
export const GROUP_SIZES = [2, 3] as const;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Live items (not removed) in order. */
export const liveItems = (p: Pick<SessionPlan, "items">): PlanItem[] => p.items.filter((i) => !i.removed_at).sort((a, b) => a.position - b.position);

/** A group's (or a single item's) run of adjacent items. */
export interface PlanBlock {
  tag: string | null;
  items: PlanItem[];
}

export function planBlocks(p: Pick<SessionPlan, "items">): PlanBlock[] {
  const out: PlanBlock[] = [];
  for (const it of liveItems(p)) {
    const last = out[out.length - 1];
    if (it.group_tag && last?.tag === it.group_tag) last.items.push(it);
    else out.push({ tag: it.group_tag, items: [it] });
  }
  return out;
}

/** Labels like A1, A2, B1 for grouped items (by item id). */
export function groupLabels(p: Pick<SessionPlan, "items">): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of planBlocks(p)) if (b.tag) b.items.forEach((it, i) => out.set(it.id, `${b.tag}${i + 1}`));
  return out;
}

/**
 * Puts live items in the given order (positions 0…n-1), dissolves groups of fewer than two adjacent members and
 * re-letters groups A, B, C… in order of appearance. Every edit goes through here.
 */
function settle(p: SessionPlan, order: PlanItem[], now: string, changed: Set<string> = new Set()): SessionPlan {
  const live = order.map((it) => ({ ...it }));
  // Runs of the same tag; a tag split into two runs keeps only its first run.
  const runs: { tag: string; members: PlanItem[] }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < live.length; i++) {
    const tag = live[i].group_tag;
    if (!tag) continue;
    if (i > 0 && live[i - 1].group_tag === tag) {
      runs[runs.length - 1].members.push(live[i]);
      continue;
    }
    if (seen.has(tag)) {
      live[i].group_tag = null;
      live[i].group_rest_sec = null;
      continue;
    }
    seen.add(tag);
    runs.push({ tag, members: [live[i]] });
  }
  let letter = 0;
  for (const run of runs) {
    if (run.members.length < 2) {
      for (const m of run.members) {
        m.group_tag = null;
        m.group_rest_sec = null;
      }
      continue;
    }
    const tag = LETTERS[letter++ % LETTERS.length];
    const rest = run.members.find((m) => m.group_rest_sec != null)?.group_rest_sec ?? Math.max(...run.members.map((m) => m.rest_sec ?? 0));
    for (const m of run.members) {
      m.group_tag = tag;
      m.group_rest_sec = rest;
    }
  }
  const before = new Map(p.items.map((it) => [it.id, it]));
  const next = live.map((it, i) => {
    const b = before.get(it.id);
    const moved = { ...it, position: i };
    const same =
      b &&
      !changed.has(it.id) &&
      b.position === moved.position &&
      b.group_tag === moved.group_tag &&
      b.group_rest_sec === moved.group_rest_sec &&
      b.removed_at === moved.removed_at;
    return same ? b : { ...moved, updated_at: now };
  });
  const removed = p.items.filter((it) => it.removed_at && !live.some((l) => l.id === it.id));
  return { ...p, items: [...next, ...removed], updated_at: now };
}

/** Item ids of a fresh plan: "<plan id>-1", "-2"…, the same on the phone and on the server. */
export function seqIds(planId: string): () => string {
  let n = 0;
  return () => `${planId}-${++n}`;
}

/** A plan that copies a program day: same exercises, order, sets, reps, rest, RIR targets; its supersets become groups. */
export function planFromDay(day: ProgramDay, id: string, now: string, newId: () => string): SessionPlan {
  const ordered = [...day.exercises].sort((a, b) => a.position - b.position);
  const items: PlanItem[] = ordered.map((x, i) => ({
    id: newId(),
    exercise_id: x.exercise_id,
    position: i,
    sets: x.sets,
    reps_min: x.reps_min,
    reps_max: x.reps_max,
    per_leg: x.per_leg,
    is_time: x.is_time,
    rest_sec: x.rest_sec,
    target_rir_min: x.target_rir_min,
    target_rir_max: x.target_rir_max,
    origin: "program",
    replaced_exercise_id: null,
    group_tag: x.superset_tag ? x.superset_tag[0] : null,
    group_rest_sec: null,
    removed_at: null,
    created_at: now,
    updated_at: now,
  }));
  const plan: SessionPlan = { id, program_day_id: day.id, status: "planned", started_at: null, created_at: now, updated_at: now, items };
  return settle(plan, items, now);
}

const findLive = (p: SessionPlan, itemId: string) => liveItems(p).find((it) => it.id === itemId);

/** Replaces an item's exercise; the slot's sets, reps, rest and RIR target stay. */
export function replaceItem(p: SessionPlan, itemId: string, exerciseId: string, now: string): SessionPlan {
  const it = findLive(p, itemId);
  if (!it || it.exercise_id === exerciseId) return p;
  const original = it.origin === "program" ? it.exercise_id : it.replaced_exercise_id;
  const back = original === exerciseId;
  const next: PlanItem = {
    ...it,
    exercise_id: exerciseId,
    origin: it.origin === "added" ? "added" : back ? "program" : "replaced",
    replaced_exercise_id: it.origin === "added" || back ? null : original,
  };
  return settle(p, liveItems(p).map((x) => (x.id === itemId ? next : x)), now, new Set([itemId]));
}

/** Adds an exercise at the end with the planner defaults. */
export function addItem(p: SessionPlan, exerciseId: string, now: string, id: string, init: Partial<Pick<PlanItem, "sets" | "reps_min" | "reps_max" | "rest_sec" | "is_time">> = {}): SessionPlan {
  const item: PlanItem = {
    id,
    exercise_id: exerciseId,
    position: liveItems(p).length,
    sets: init.sets ?? ADD_DEFAULTS.sets,
    reps_min: init.reps_min === undefined ? ADD_DEFAULTS.reps_min : init.reps_min,
    reps_max: init.reps_max === undefined ? ADD_DEFAULTS.reps_max : init.reps_max,
    per_leg: false,
    is_time: init.is_time ?? false,
    rest_sec: init.rest_sec === undefined ? ADD_DEFAULTS.rest_sec : init.rest_sec,
    target_rir_min: null,
    target_rir_max: null,
    origin: "added",
    replaced_exercise_id: null,
    group_tag: null,
    group_rest_sec: null,
    removed_at: null,
    created_at: now,
    updated_at: now,
  };
  return settle({ ...p, items: [...p.items, item] }, [...liveItems(p), item], now, new Set([id]));
}

/** Soft-deletes an item; a group left with one member dissolves. */
export function removeItem(p: SessionPlan, itemId: string, now: string): SessionPlan {
  const it = findLive(p, itemId);
  if (!it) return p;
  const gone: PlanItem = { ...it, removed_at: now, group_tag: null, group_rest_sec: null, updated_at: now };
  const items = p.items.map((x) => (x.id === itemId ? gone : x));
  return settle({ ...p, items }, liveItems({ items }), now);
}

export function updateItem(p: SessionPlan, itemId: string, patch: Partial<Pick<PlanItem, "sets" | "reps_min" | "reps_max" | "rest_sec">>, now: string): SessionPlan {
  const it = findLive(p, itemId);
  if (!it) return p;
  const next = { ...it, ...patch };
  if (next.sets < MIN_SETS || next.sets > MAX_SETS) return p;
  if (next.reps_min != null && next.reps_max != null && next.reps_min > next.reps_max) next.reps_max = next.reps_min;
  return settle(p, liveItems(p).map((x) => (x.id === itemId ? next : x)), now, new Set([itemId]));
}

/** Moves an item one step: inside its group it swaps with the neighbouring member; alone it jumps a whole block. */
export function moveItem(p: SessionPlan, itemId: string, dir: -1 | 1, now: string): SessionPlan {
  const blocks = planBlocks(p);
  const bi = blocks.findIndex((b) => b.items.some((it) => it.id === itemId));
  if (bi < 0) return p;
  const block = blocks[bi];
  if (block.tag) {
    const i = block.items.findIndex((it) => it.id === itemId);
    const j = i + dir;
    if (j < 0 || j >= block.items.length) return p;
    [block.items[i], block.items[j]] = [block.items[j], block.items[i]];
    return settle(p, blocks.flatMap((b) => b.items), now);
  }
  return moveBlock(p, bi, bi + dir, now);
}

/** Moves a whole group one step past the neighbouring block. */
export function moveGroup(p: SessionPlan, tag: string, dir: -1 | 1, now: string): SessionPlan {
  const bi = planBlocks(p).findIndex((b) => b.tag === tag);
  return bi < 0 ? p : moveBlock(p, bi, bi + dir, now);
}

/** Moves the block at `from` (an item alone or a whole group) to block index `to`. */
export function moveBlock(p: SessionPlan, from: number, to: number, now: string): SessionPlan {
  const blocks = planBlocks(p);
  if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length || from === to) return p;
  const [b] = blocks.splice(from, 1);
  blocks.splice(to, 0, b);
  return settle(p, blocks.flatMap((x) => x.items), now);
}

/** Moves a group member to index `to` inside its group. */
export function moveInGroup(p: SessionPlan, itemId: string, to: number, now: string): SessionPlan {
  const blocks = planBlocks(p);
  const block = blocks.find((b) => b.tag && b.items.some((it) => it.id === itemId));
  if (!block) return p;
  const from = block.items.findIndex((it) => it.id === itemId);
  if (to < 0 || to >= block.items.length || from === to) return p;
  const [it] = block.items.splice(from, 1);
  block.items.splice(to, 0, it);
  return settle(p, blocks.flatMap((b) => b.items), now);
}

/** Whether these items can form a group: 2 or 3 live items, none already in a group. */
export function canGroup(p: SessionPlan, itemIds: string[]): boolean {
  const ids = new Set(itemIds);
  const chosen = liveItems(p).filter((it) => ids.has(it.id));
  return chosen.length === ids.size && (GROUP_SIZES as readonly number[]).includes(chosen.length) && chosen.every((it) => !it.group_tag);
}

/**
 * Groups 2–3 items as a superset or tri-set: they move together to where the first of them is, in their current
 * order. Rest after a round defaults to the longest planned rest of the members. No check on what is grouped.
 */
export function groupItems(p: SessionPlan, itemIds: string[], now: string): SessionPlan {
  if (!canGroup(p, itemIds)) return p;
  const ids = new Set(itemIds);
  const live = liveItems(p);
  const members = live.filter((it) => ids.has(it.id));
  const tag = "~new";
  const rest = Math.max(...members.map((m) => m.rest_sec ?? 0));
  const grouped = members.map((m) => ({ ...m, group_tag: tag, group_rest_sec: rest }));
  const first = live.findIndex((it) => ids.has(it.id));
  const others = live.filter((it) => !ids.has(it.id));
  const at = live.slice(0, first).length;
  const order = [...others.slice(0, at), ...grouped, ...others.slice(at)];
  return settle(p, order, now, ids);
}

export function ungroup(p: SessionPlan, tag: string, now: string): SessionPlan {
  const live = liveItems(p).map((it) => (it.group_tag === tag ? { ...it, group_tag: null, group_rest_sec: null } : it));
  const changed = new Set(liveItems(p).filter((it) => it.group_tag === tag).map((it) => it.id));
  return settle(p, live, now, changed);
}

/** Rest after a full round of a group. */
export function setGroupRest(p: SessionPlan, tag: string, sec: number, now: string): SessionPlan {
  if (!Number.isFinite(sec) || sec < 0 || sec > 600) return p;
  const live = liveItems(p).map((it) => (it.group_tag === tag ? { ...it, group_rest_sec: Math.round(sec) } : it));
  const changed = new Set(live.filter((it) => it.group_tag === tag).map((it) => it.id));
  return settle(p, live, now, changed);
}

/** Whether the plan differs from its program day (for "Planned: Day 1 – Chest (edited)"). */
export function isEdited(p: SessionPlan, day: ProgramDay): boolean {
  const live = liveItems(p);
  const ordered = [...day.exercises].sort((a, b) => a.position - b.position);
  if (live.length !== ordered.length) return true;
  const fresh = planFromDay(day, p.id, p.created_at, (() => {
    let n = 0;
    return () => `x${n++}`;
  })());
  const ref = liveItems(fresh);
  return live.some((it, i) => {
    const r = ref[i];
    return (
      it.exercise_id !== r.exercise_id ||
      it.sets !== r.sets ||
      it.reps_min !== r.reps_min ||
      it.reps_max !== r.reps_max ||
      it.rest_sec !== r.rest_sec ||
      it.group_tag !== r.group_tag ||
      (it.group_tag != null && it.group_rest_sec !== r.group_rest_sec)
    );
  });
}

/** The day-exercise view of a plan item, as the session screen and progression read it. */
export function itemAsDayExercise(it: PlanItem, label: string | null, dayExercise?: DayExercise): DayExercise {
  return {
    id: it.id,
    exercise_id: it.exercise_id,
    position: it.position,
    sets: it.sets,
    reps_min: it.reps_min ?? 0,
    reps_max: it.reps_max ?? 0,
    per_leg: it.per_leg,
    is_time: it.is_time,
    rest_sec: it.rest_sec ?? ADD_DEFAULTS.rest_sec,
    superset_tag: label,
    // "Main" stays on the program's exercise in its slot, also when it is replaced.
    is_main: dayExercise?.is_main ?? false,
    target_rir_min: it.target_rir_min,
    target_rir_max: it.target_rir_max,
    slot: dayExercise?.slot ?? null,
  };
}

/**
 * Rest after checking a set, inside a group (SPEC-v3 M9c logging flow): a round is set i of every member that has a
 * set i. Inside a round no timer runs (null); after the last set of the round the group's rest starts. Sets beyond the
 * other members' counts are done alone, each followed by that member's own rest.
 * @param done per member, the done flags of its sets in order, after the check.
 */
export function restAfterGroupSet(done: boolean[][], set: number, groupRest: number, ownRest: number): number | null {
  const inRound = done.filter((sets) => sets.length > set);
  if (inRound.length < 2) return ownRest;
  return inRound.every((sets) => sets[set]) ? groupRest : null;
}

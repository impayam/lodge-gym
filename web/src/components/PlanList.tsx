// The ordered exercise list of a session plan (SPEC-v3 M9c), shared by the planner and an active session:
// drag handles plus Move up / Move down buttons, Group / Ungroup (any 2–3 exercises, no warning), rest after a round,
// and per exercise its actions (planner: sets, reps, rest, Replace, Remove; session: Remove).

import { useEffect, useRef, useState } from "preact/hooks";
import {
  canGroup,
  groupItems,
  itemAsDayExercise,
  MAX_SETS,
  moveBlock,
  moveGroup,
  moveInGroup,
  moveItem,
  planBlocks,
  setGroupRest,
  ungroup,
  updateItem,
  type PlanItem,
  type SessionPlan,
} from "../../../worker/lib/plan";
import type { Exercise } from "../../../worker/lib/types";
import { fmtNum } from "../format";
import { targetText } from "../views/Program";
import { Stepper } from "./Stepper";

export interface PlanListProps {
  plan: SessionPlan;
  exMap: Map<string, Exercise>;
  onChange: (next: SessionPlan) => void;
  mode: "plan" | "session";
  /** Session mode: the line under the name, e.g. "1 of 3 sets done". */
  progress?: (exerciseId: string) => string;
  onReplace?: (item: PlanItem) => void;
  onRemove: (item: PlanItem) => void;
}

const nowISO = () => new Date().toISOString();
export const groupKind = (size: number) => (size === 3 ? "Tri-set" : "Superset");

interface Drag {
  kind: "block" | "member";
  index: number;
  itemId: string | null;
  tag: string | null;
}

export function PlanList({ plan, exMap, onChange, mode, progress, onReplace, onRemove }: PlanListProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // The plan as last changed: pointer moves can arrive before the parent re-renders.
  const latest = useRef(plan);
  latest.current = plan;

  const change = (next: SessionPlan) => {
    if (next === latest.current) return;
    latest.current = next;
    onChange(next);
  };
  const blocks = planBlocks(plan);
  const name = (it: PlanItem) => exMap.get(it.exercise_id)?.name_en ?? it.exercise_id;
  const live = new Set(blocks.flatMap((b) => b.items.map((it) => it.id)));
  const chosen = selected.filter((id) => live.has(id));

  const toggleSelect = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const group = () => {
    change(groupItems(latest.current, chosen, nowISO()));
    setSelected([]);
  };

  /*
   * Drag: crossing a neighbour's middle moves the block (or the group member) there. The pointer is followed on the
   * window, not the handle: a move re-renders the list, and the element under the finger may change.
   */
  const stopListening = useRef<(() => void) | null>(null);
  useEffect(() => () => stopListening.current?.(), []);
  const startDrag = (e: PointerEvent, d: Drag, key: string) => {
    e.preventDefault();
    stopListening.current?.();
    const id = e.pointerId;
    const move = (ev: PointerEvent) => ev.pointerId === id && moveDrag(ev);
    const end = (ev: PointerEvent) => ev.pointerId === id && endDrag();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    stopListening.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      stopListening.current = null;
    };
    drag.current = d;
    setDragging(key);
  };
  const moveDrag = (e: PointerEvent) => {
    const d = drag.current;
    const list = listRef.current;
    if (!d || !list) return;
    if (e.clientY < 90) window.scrollBy(0, -10);
    else if (e.clientY > window.innerHeight - 130) window.scrollBy(0, 10);
    const els = d.kind === "block" ? [...list.querySelectorAll<HTMLElement>(":scope > [data-block]")] : [...list.querySelectorAll<HTMLElement>(`[data-group="${d.tag}"] [data-member]`)];
    let to = d.index;
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (i < d.index && e.clientY < mid) to = Math.min(to, i);
      if (i > d.index && e.clientY > mid) to = Math.max(to, i);
    });
    if (to === d.index) return;
    const cur = latest.current;
    change(d.kind === "block" ? moveBlock(cur, d.index, to, nowISO()) : moveInGroup(cur, d.itemId!, to, nowISO()));
    d.index = to;
  };
  const endDrag = () => {
    stopListening.current?.();
    drag.current = null;
    setDragging(null);
  };
  const handle = (d: Drag, key: string, label: string) => (
    <span class="plan-handle" role="img" aria-label={`Drag to move ${label}`} data-testid={`handle-${key}`} onPointerDown={(e) => startDrag(e, d, key)}>
      <svg viewBox="0 0 12 20" aria-hidden="true">
        {[4, 10, 16].map((y) => (
          <>
            <circle cx="3" cy={y} r="1.6" />
            <circle cx="9" cy={y} r="1.6" />
          </>
        ))}
      </svg>
    </span>
  );

  const row = (it: PlanItem, blockIndex: number, member: { tag: string; index: number; size: number } | null) => {
    const n = name(it);
    const target = itemAsDayExercise(it, null);
    const isOpen = open === it.id;
    const canUp = member ? member.index > 0 : blockIndex > 0;
    const canDown = member ? member.index < member.size - 1 : blockIndex < blocks.length - 1;
    const meta = mode === "session" ? (progress?.(it.exercise_id) ?? "") : `${targetText(target)} · rest ${fmtNum(it.rest_sec ?? 0)} s`;
    const origin =
      it.origin === "replaced" && it.replaced_exercise_id
        ? `instead of ${exMap.get(it.replaced_exercise_id)?.name_en ?? it.replaced_exercise_id}`
        : it.origin === "added" && mode === "plan"
          ? "added"
          : "";
    return (
      <div
        key={it.id}
        class="card plan-item"
        data-dragging={dragging === it.id ? "true" : undefined}
        data-member={member ? "" : undefined}
        data-block={member ? undefined : ""}
        data-testid={`pitem-${it.exercise_id}`}
      >
        <div class="plan-item__row">
          {member ? handle({ kind: "member", index: member.index, itemId: it.id, tag: member.tag }, it.id, n) : handle({ kind: "block", index: blockIndex, itemId: it.id, tag: null }, it.id, n)}
          {member ? (
            <span class="plan-tag">
              {member.tag}
              {member.index + 1}
            </span>
          ) : (
            <label class="plan-select">
              <input type="checkbox" checked={chosen.includes(it.id)} aria-label={`Select ${n}`} onChange={() => toggleSelect(it.id)} />
            </label>
          )}
          <button type="button" class="plan-name" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : it.id)}>
            <b class="t-title">{n}</b>
            <span class="caption num">
              {meta}
              {origin ? <span class="t-violet"> · {origin}</span> : null}
            </span>
          </button>
          <span class="plan-move">
            <button type="button" class="clay press t-muted" aria-label={`Move ${n} up`} disabled={!canUp} onClick={() => change(moveItem(latest.current, it.id, -1, nowISO()))}>
              ↑
            </button>
            <button type="button" class="clay press t-muted" aria-label={`Move ${n} down`} disabled={!canDown} onClick={() => change(moveItem(latest.current, it.id, 1, nowISO()))}>
              ↓
            </button>
          </span>
        </div>
        {isOpen ? (
          <div class="plan-edit" data-testid={`pedit-${it.exercise_id}`}>
            {mode === "plan" ? (
              <div class="l-grid-2 l-gap-12">
                <div class="form-field">
                  <span class="form-field__label">Sets</span>
                  <Stepper
                    value={it.sets}
                    placeholder="3"
                    base={it.sets}
                    step={1}
                    min={1}
                    decimals={false}
                    label={`Sets, ${n}`}
                    testId={`sets-${it.exercise_id}`}
                    small
                    onChange={(v) => v != null && v <= MAX_SETS && change(updateItem(latest.current, it.id, { sets: v }, nowISO()))}
                  />
                </div>
                <div class="form-field">
                  <span class="form-field__label">Rest (s)</span>
                  <Stepper
                    value={it.rest_sec}
                    placeholder="90"
                    base={it.rest_sec ?? 90}
                    step={15}
                    min={0}
                    decimals={false}
                    label={`Rest in seconds, ${n}`}
                    testId={`rest-${it.exercise_id}`}
                    small
                    onChange={(v) => v != null && v <= 600 && change(updateItem(latest.current, it.id, { rest_sec: v }, nowISO()))}
                  />
                </div>
                <div class="form-field">
                  <span class="form-field__label">{it.is_time ? "Seconds from" : "Reps from"}</span>
                  <Stepper
                    value={it.reps_min}
                    placeholder="–"
                    base={it.reps_min ?? 8}
                    step={it.is_time ? 5 : 1}
                    min={0}
                    decimals={false}
                    label={`${it.is_time ? "Seconds" : "Reps"} from, ${n}`}
                    testId={`repsmin-${it.exercise_id}`}
                    small
                    onChange={(v) => change(updateItem(latest.current, it.id, { reps_min: v }, nowISO()))}
                  />
                </div>
                <div class="form-field">
                  <span class="form-field__label">{it.is_time ? "Seconds to" : "Reps to"}</span>
                  <Stepper
                    value={it.reps_max}
                    placeholder="–"
                    base={it.reps_max ?? 12}
                    step={it.is_time ? 5 : 1}
                    min={it.reps_min ?? 0}
                    decimals={false}
                    label={`${it.is_time ? "Seconds" : "Reps"} to, ${n}`}
                    testId={`repsmax-${it.exercise_id}`}
                    small
                    onChange={(v) => change(updateItem(latest.current, it.id, { reps_max: v }, nowISO()))}
                  />
                </div>
              </div>
            ) : null}
            <div class="l-row l-gap-8">
              {mode === "plan" && onReplace ? (
                <button type="button" class="clay press btn btn--fit t-muted" onClick={() => onReplace(it)}>
                  Replace
                </button>
              ) : null}
              <button type="button" class="clay press btn btn--fit t-danger" onClick={() => onRemove(it)}>
                Remove
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div class="plan-list" ref={listRef} data-testid="plan-list">
        {blocks.map((b, bi) =>
          b.tag ? (
            <div
              key={
                "g" +
                b.items
                  .map((it) => it.id)
                  .sort()
                  .join()
              }
              class="plan-group"
              data-dragging={dragging === "g" + b.tag ? "true" : undefined}
              data-block=""
              data-group={b.tag}
              data-testid={`pgroup-${b.tag}`}
            >
              <div class="plan-group__head">
                {handle({ kind: "block", index: bi, itemId: null, tag: b.tag }, "g" + b.tag, `${groupKind(b.items.length)} ${b.tag}`)}
                <b class="t-title t-violet l-grow">
                  {groupKind(b.items.length)} {b.tag}
                </b>
                <span class="plan-move">
                  <button
                    type="button"
                    class="clay press t-muted"
                    aria-label={`Move ${groupKind(b.items.length)} ${b.tag} up`}
                    disabled={bi === 0}
                    onClick={() => change(moveGroup(latest.current, b.tag!, -1, nowISO()))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="clay press t-muted"
                    aria-label={`Move ${groupKind(b.items.length)} ${b.tag} down`}
                    disabled={bi === blocks.length - 1}
                    onClick={() => change(moveGroup(latest.current, b.tag!, 1, nowISO()))}
                  >
                    ↓
                  </button>
                </span>
              </div>
              {b.items.map((it, i) => row(it, bi, { tag: b.tag!, index: i, size: b.items.length }))}
              <div class="plan-group__foot">
                <span class="form-field__label l-full">Rest after each round, seconds</span>
                <span class="l-grow">
                  <Stepper
                    value={b.items[0].group_rest_sec}
                    placeholder="90"
                    base={b.items[0].group_rest_sec ?? 90}
                    step={15}
                    min={0}
                    decimals={false}
                    label={`Rest after each round of ${groupKind(b.items.length)} ${b.tag}, seconds`}
                    testId={`grouprest-${b.tag}`}
                    small
                    onChange={(v) => v != null && v <= 600 && change(setGroupRest(latest.current, b.tag!, v, nowISO()))}
                  />
                </span>
                <button type="button" class="clay press btn-sm btn--fit t-muted" onClick={() => change(ungroup(latest.current, b.tag!, nowISO()))}>
                  Ungroup
                </button>
              </div>
            </div>
          ) : (
            row(b.items[0], bi, null)
          )
        )}
      </div>
      {chosen.length ? (
        <div class="card plan-groupbar" role="region" aria-label="Group the selected exercises" data-testid="groupbar">
          <span class="l-grow num">
            {fmtNum(chosen.length)} selected{chosen.length === 1 || chosen.length > 3 ? ": pick 2 or 3" : ""}
          </span>
          <button type="button" class="clay press btn-sm btn--fit t-pink" disabled={!canGroup(plan, chosen)} onClick={group}>
            {chosen.length === 3 ? "Group as tri-set" : chosen.length === 2 ? "Group as superset" : "Group"}
          </button>
          <button type="button" class="clay press btn-sm btn--fit t-muted" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      ) : null}
    </>
  );
}

// The goal diamond (SPEC-v12 M15 §2.4, §5; Payam 2026-10-17): Growth top, Strength right, Endurance bottom, Power left.
// On Profile it is the Living Diamond: each corner stretches with that goal's progress (0–1, drawn from a floor so the
// shape stays visible), the dashed ghost is the same four numbers four weeks ago, the chosen goals' corners glow pink,
// every corner always shows its number (Power: 0 and "No data" until there is a way to measure it), and a tap on a
// corner opens its panel. On Set goal it is the picker: a tap selects or deselects a goal.

import type { ComponentChildren } from "preact";
import { BODY_GOAL_BADGE, TRAINING_GOAL_NAME, type BodyGoal, type TrainingGoal } from "../../../worker/lib/goals";

export const CORNERS: readonly TrainingGoal[] = ["growth", "strength", "endurance", "power"];
/** The shape never shrinks below this, so a corner at 0 still reads as a corner. */
export const FLOOR = 0.35;

const C = 165;
const R = 125;
const DIR: Readonly<Record<TrainingGoal, readonly [number, number]>> = { growth: [0, -1], strength: [1, 0], endurance: [0, 1], power: [-1, 0] };
const at = (g: TrainingGoal, v: number): [number, number] => [C + DIR[g][0] * R * v, C + DIR[g][1] * R * v];
const pts = (xs: [number, number][]) => xs.map(([x, y]) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`).join(" ");
const shown = (v: number) => Math.max(FLOOR, Math.min(1, v));

/** Where each corner's name and number sit, and how they are aligned. */
const LABEL: Readonly<Record<TrainingGoal, { x: number; y: number; anchor: "middle" | "start" | "end"; dy: number }>> = {
  growth: { x: C, y: 18, anchor: "middle", dy: 18 },
  strength: { x: 326, y: 140, anchor: "end", dy: 18 },
  endurance: { x: C, y: 308, anchor: "middle", dy: 18 },
  power: { x: 4, y: 140, anchor: "start", dy: 18 },
};

/** A chosen goal's kite: the centre, half-way to each neighbour, and the corner. */
function kite(g: TrainingGoal, v: (g: TrainingGoal) => number): [number, number][] {
  const i = CORNERS.indexOf(g);
  const prev = CORNERS[(i + 3) % 4];
  const next = CORNERS[(i + 1) % 4];
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p = at(g, v(g));
  return [[C, C], mid(at(prev, v(prev)), p), p, mid(at(next, v(next)), p)];
}

export interface CornerShow {
  value: number;
  label: string;
  has_data: boolean;
}

export function Diamond({
  corners,
  ghost,
  selected,
  body,
  open,
  onCorner,
  pick = false,
  label,
}: {
  /** Now: each corner's 0–1 and its number; null draws the empty diamond (no goal yet, or the picker). */
  corners: Record<TrainingGoal, CornerShow> | null;
  ghost?: Record<TrainingGoal, number> | null;
  selected: readonly TrainingGoal[];
  body: BodyGoal | null;
  /** The corner whose panel is open. */
  open?: TrainingGoal | null;
  onCorner?: (g: TrainingGoal) => void;
  pick?: boolean;
  label: string;
}) {
  const v = (g: TrainingGoal) => (corners ? shown(corners[g].value) : pick ? 1 : FLOOR);
  const now = CORNERS.map((g) => at(g, v(g)));
  return (
    <svg class={pick ? "diamond diamond--pick" : "diamond"} viewBox="0 0 330 330" role="group" aria-label={label} data-testid={pick ? "goal-diamond" : "living-diamond"}>
      <g class="diamond__axis" aria-hidden="true">
        {CORNERS.map((g) => {
          const [x, y] = at(g, 1);
          return <line x1={C} y1={C} x2={x} y2={y} />;
        })}
      </g>
      <polygon class="diamond__full" points={pts(CORNERS.map((g) => at(g, 1)))} aria-hidden="true" />
      {selected.map((g) => (
        <polygon class="diamond__glow" points={pts(kite(g, v))} aria-hidden="true" data-glow={g} />
      ))}
      {corners ? <polygon class="diamond__now" points={pts(now)} aria-hidden="true" data-testid="diamond-now" /> : null}
      {ghost ? <polygon class="diamond__ghost" points={pts(CORNERS.map((g) => at(g, shown(ghost[g]))))} aria-hidden="true" data-testid="diamond-ghost" /> : null}
      {CORNERS.map((g) => {
        const [x, y] = at(g, v(g));
        const on = selected.includes(g);
        const c = corners?.[g];
        const l = LABEL[g];
        const name = TRAINING_GOAL_NAME[g];
        const aria = pick ? `${name}${on ? ", selected" : ""}` : `${name}: ${c ? (c.has_data ? c.label : `${c.label}, no data`) : "no goal yet"}${on ? ", your goal" : ""}. Show details`;
        return (
          <g data-corner={g}>
            <circle class="diamond__corner" data-on={on ? "true" : "false"} data-nodata={c && !c.has_data ? "true" : "false"} cx={x} cy={y} r={on ? 7 : 6} aria-hidden="true" />
            <text class="diamond__label" data-on={on ? "true" : "false"} x={l.x} y={l.y} text-anchor={l.anchor} aria-hidden="true">
              {name}
            </text>
            {c ? (
              <text class="diamond__value" data-muted={c.has_data ? "false" : "true"} x={l.x} y={l.y + l.dy} text-anchor={l.anchor} aria-hidden="true" data-testid={`corner-value-${g}`}>
                {c.has_data ? c.label : `${c.label} · No data`}
              </text>
            ) : null}
            {onCorner ? (
              <circle
                class="diamond__hit"
                cx={x}
                cy={y}
                r={22}
                role="button"
                tabIndex={0}
                aria-label={aria}
                aria-pressed={pick ? on : undefined}
                aria-expanded={pick ? undefined : open === g}
                data-testid={`corner-${g}`}
                onClick={() => onCorner(g)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onCorner(g);
                  }
                }}
              />
            ) : null}
          </g>
        );
      })}
      {body ? (
        <g aria-hidden="true">
          <rect class="diamond__center-bg" x={C - 24} y={C - 11} width={48} height={22} rx={11} />
          <text class="diamond__center" x={C} y={C + 4} text-anchor="middle" data-testid="diamond-center">
            {BODY_GOAL_BADGE[body]}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

/** What one or two goals mean for the lifting, in one line (Set goal). */
export function goalMeaning(training: readonly TrainingGoal[]): string {
  if (!training.length) return "Pick one or two training goals.";
  const RANK: Record<TrainingGoal, number> = { strength: 0, power: 1, growth: 2, endurance: 3 };
  const MAIN: Record<TrainingGoal, string> = { growth: "5–8 reps", strength: "3–5 heavy reps", endurance: "8–12 reps", power: "3–5 reps lifted fast" };
  const REST: Record<TrainingGoal, string> = { growth: "8–15 near failure", strength: "6–12 with longer rest", endurance: "15–25 with short rest", power: "8–15 near failure" };
  const sorted = [...training].sort((a, b) => RANK[a] - RANK[b]);
  return `Main lifts ${MAIN[sorted[0]]}, accessories ${REST[sorted[sorted.length - 1]]}.`;
}

/** A corner's panel under the diamond. */
export function CornerPanel({ title, children, testid }: { title: string; children: ComponentChildren; testid: string }) {
  return (
    <section class="callout" data-testid={testid} aria-live="polite">
      <span class="t-title">{title}</span>
      {children}
    </section>
  );
}

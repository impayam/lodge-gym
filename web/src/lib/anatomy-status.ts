// Colours of the 3D muscle map in Reports (SPEC-v6 §8): each mapped app muscle takes the weekly status of its report
// group (the same fractional numbers and thresholds as the list below the map). The 3D stage is dark in both themes,
// so the colours are the dark theme's status tokens (web/src/styles.css): under --warn, on --good, over --plate,
// no target --accent; a muscle not trained this week is muted. Unmapped muscles are drawn dark by the 3D view itself.
// Status is never colour alone: the card, the legend and the list carry the icon and the label.

import { CANONICAL_MUSCLES, groupOf, type Muscle } from "../../../worker/lib/muscles";
import type { BalanceStatus, MuscleRow } from "../../../worker/lib/reports";

export const STAGE_STATUS_COLOR: Record<BalanceStatus, string> = {
  under: "#e3a93a",
  on: "#56c98a",
  over: "#f08a4b",
  untracked: "#3fbfa6",
  none: "#5a4b49",
};

export interface MuscleState {
  muscle: Muscle;
  /** The report group whose numbers the muscle shows. */
  group: string;
  row: MuscleRow | null;
  status: BalanceStatus;
}

/** A muscle's weekly numbers: its report group's row. */
export function muscleState(rows: MuscleRow[], muscle: Muscle): MuscleState {
  const group = groupOf(muscle) ?? muscle;
  const row = rows.find((r) => r.muscle === group) ?? null;
  return { muscle, group, row, status: row?.status ?? "none" };
}

/** The colour of every app muscle for the 3D view. */
export function stageTints(rows: MuscleRow[]): Map<Muscle, string> {
  return new Map(CANONICAL_MUSCLES.map((m) => [m, STAGE_STATUS_COLOR[muscleState(rows, m).status]]));
}

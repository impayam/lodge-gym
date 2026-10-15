// Colours of the 3D muscle map in Reports (SPEC-v6 §8): each mapped app muscle takes the weekly status of its report
// group (the same fractional numbers and thresholds as the list below the map). The colours are the --model-* status
// tokens (web/src/styles/tokens.css, the pre-Pulse values unchanged): under, on, over, no target (untracked); a muscle
// not trained this week is muted (none). Unmapped muscles are drawn dark by the 3D view itself.
// Status is never colour alone: the card, the legend and the list carry the icon and the label.

import { CANONICAL_MUSCLES, groupOf, type Muscle } from "../../../worker/lib/muscles";
import type { BalanceStatus, MuscleRow } from "../../../worker/lib/reports";

/** The token holding each status colour of the 3D map (read at runtime by the view: web/src/lib/tokens.ts). */
export const STAGE_STATUS_TOKEN: Record<BalanceStatus, `--model-${BalanceStatus}`> = {
  under: "--model-under",
  on: "--model-on",
  over: "--model-over",
  untracked: "--model-untracked",
  none: "--model-none",
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

/** The colour of every app muscle for the 3D view; `colorOf` gives a status its colour. */
export function stageTints(rows: MuscleRow[], colorOf: (status: BalanceStatus) => string): Map<Muscle, string> {
  return new Map(CANONICAL_MUSCLES.map((m) => [m, colorOf(muscleState(rows, m).status)]));
}

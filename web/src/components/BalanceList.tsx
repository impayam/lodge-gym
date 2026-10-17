// Muscle balance list (Profile → Details → All): each group's fractional sets this week vs the program target
// (SPEC-v2 §7.4: primary muscle 1 set, secondary 0.5), with its direct and fractional numbers and a text status.
// Groups without a program target are shown with their sets only. The body map that used to sit above it is gone:
// My body on Profile is the only body (SPEC-v12 M15 §3.2), drawn by the shared ./Body3D.tsx.

import { fmtNum } from "../../../worker/lib/digits";

export type Status = "none" | "under" | "on" | "over" | "untracked";
export interface MuscleRow {
  muscle: string;
  /** Direct sets (primary muscle). */
  sets: number;
  /** Fractional sets; the status compares this number with the target (direct sets for a "direct" row). */
  fractional: number;
  target: number | null;
  status: Status;
  /** Forearms and neck with a direct-set target (SPEC-v11 Phase B). */
  basis?: "direct";
}

export const MUSCLE_NAME: Record<string, string> = {
  chest: "Chest",
  back: "Back",
  quads: "Quads",
  hamstrings_glutes: "Hamstrings & glutes",
  shoulders: "Shoulders",
  rear_delts: "Rear delts",
  calves: "Calves",
  core: "Core",
  biceps: "Biceps",
  triceps: "Triceps",
  traps: "Traps",
  forearms: "Forearms",
  lower_back: "Lower back",
  adductors: "Adductors",
  abductors: "Abductors",
  neck: "Neck",
};

export const STATUS_NAME: Record<Status, string> = { none: "No sets", under: "Under target", on: "On target", over: "Over target", untracked: "No target" };
export const STATUS_ICON: Record<Status, string> = { none: "–", under: "▼", on: "✓", over: "▲", untracked: "·" };

/** Muscle balance this week: every group with its direct and fractional sets against its target, and the status. */
export function BalanceList({ muscles }: { muscles: MuscleRow[] }) {
  return (
    <div class="l-col l-gap-12" data-testid="muscle-map">
      <ul class="balance-list">
        <li aria-hidden="true">
          <span>Muscle</span>
          <span>direct · fractional / target</span>
          <span>Status</span>
        </li>
        {muscles.map((m) => (
          <li data-testid={`muscle-${m.muscle}`} data-status={m.status}>
            <span>{MUSCLE_NAME[m.muscle]}</span>
            {m.basis === "direct" ? (
              <span class="num" title="direct / direct target · fractional">
                {fmtNum(m.sets)} / {fmtNum(m.target ?? 0)} direct · {fmtNum(m.fractional, 1)}
              </span>
            ) : (
              <span class="num" title="direct · fractional / target">
                {fmtNum(m.sets)} · {fmtNum(m.fractional, 1)} / {m.target === null ? "–" : fmtNum(m.target)}
              </span>
            )}
            <span class="balance-list__status">
              {STATUS_ICON[m.status]} {STATUS_NAME[m.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

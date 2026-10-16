// Body weight for a day (optional, for the reports): one manual value per day, in the session's unit. The same field
// in the session's More sheet and on the end-of-session screen (Payam, 2026-10-16). Until today's value is set, the
// last entry shows as the suggestion and −/+ start from it; skipping it never blocks anything.

import type { Unit } from "../../../worker/lib/types";
import { fmtNum } from "../format";
import { saveBodyMass, useStore } from "../store";
import { Stepper } from "./Stepper";

export function BodyWeight({ date, unit, label, testId }: { date: string; unit: Unit; label: string; testId: string }) {
  const boot = useStore((st) => st.boot)!;
  const manual = (boot.body ?? []).filter((m) => m.kind === "body_mass" && m.source === "manual");
  const today = manual.find((m) => m.local_date === date) ?? null;
  const last = [...manual].reverse().find((m) => m.unit === unit)?.value ?? null;
  const otherUnit = today !== null && today.unit !== unit;
  return (
    <div class="form-field">
      <span class="form-field__label" aria-hidden="true">
        {label}
      </span>
      <Stepper
        value={otherUnit ? null : (today?.value ?? null)}
        placeholder={otherUnit ? `${fmtNum(today!.value)} ${today!.unit}` : last != null ? fmtNum(last) : "–"}
        base={last ?? 0}
        step={0.1}
        min={0}
        label={`Body weight (${unit})`}
        testId={testId}
        onChange={(v) => void saveBodyMass(date, v, unit)}
      />
    </div>
  );
}

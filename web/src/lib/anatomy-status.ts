// Colours of the shared 3D body on Profile → My body (SPEC-v12 M15 §3.1): a muscle whose report group had a done set
// today is pink, this week violet, the rest dark (the --model-none token); unmapped tissue is drawn dark by the view
// itself. The colours are token names, read at runtime by ../components/Body3D.tsx (web/src/lib/tokens.ts). Colour is
// never the only cue: the card says the group's sets today and this week, and the legend names each colour.

import { CANONICAL_MUSCLES, groupOf, type Muscle } from "../../../worker/lib/muscles";

/** A colour token of the body (a --model-* or a Pulse data colour), read at runtime by the 3D view. */
export type TintToken = `--${string}`;

export type BodyDay = "today" | "week" | "rest";

/** The token of each state (the Pulse pink and violet, and the model's muted muscle colour). */
export const BODY_TINT: Readonly<Record<BodyDay, TintToken>> = { today: "--pink", week: "--violet", rest: "--model-none" };

/** A muscle's state: its report group trained today, earlier this week, or not this week. */
export function bodyDay(muscle: Muscle, today: ReadonlySet<string>, week: ReadonlySet<string>): BodyDay {
  const g = groupOf(muscle) ?? muscle;
  return today.has(g) ? "today" : week.has(g) ? "week" : "rest";
}

/** The colour of every app muscle for Profile → My body, from the report groups with done sets today and this week. */
export function profileTints(today: ReadonlySet<string>, week: ReadonlySet<string>): Map<Muscle, TintToken> {
  return new Map(CANONICAL_MUSCLES.map((m) => [m, BODY_TINT[bodyDay(m, today, week)]]));
}

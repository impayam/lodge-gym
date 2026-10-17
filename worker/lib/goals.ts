// Goals (SPEC-v12 M15 §2, decisions by Payam 2026-10-17): a training goal of one or two of Growth, Strength,
// Endurance, Power and a body goal of Gain, Maintain or Cut. Stored as settings keys (no migration). Pure.
//
// What a goal changes is the slot schemes the generator and the Coach use (rep ranges are guides: growth is similar
// across a wide range when sets are near failure, heavier loads build more strength, light loads and short rest train
// local endurance; ACSM 2009, Schoenfeld et al. 2017 and 2021). With two goals the main and secondary lifts follow the
// heavier goal of the pair (Strength > Power > Growth > Endurance), the accessory, isolation and core work the other.
// The body goal never changes the lifting; it sets the weight pace (Gain 0.25–0.5 % of body weight a week, Cut 0.5–1 %,
// Maintain within ±0.5 kg over four weeks: Iraki et al. 2019, Helms et al. 2014, Garthe et al. 2011).

export const TRAINING_GOALS = ["growth", "strength", "endurance", "power"] as const;
export type TrainingGoal = (typeof TRAINING_GOALS)[number];
export const BODY_GOALS = ["gain", "maintain", "cut"] as const;
export type BodyGoal = (typeof BODY_GOALS)[number];

export interface Goals {
  /** One or two training goals, in the order they were picked. */
  training: TrainingGoal[];
  body: BodyGoal;
  /** UTC ISO time the goal was saved. */
  set_at: string;
}

export const TRAINING_GOAL_NAME: Readonly<Record<TrainingGoal, string>> = { growth: "Growth", strength: "Strength", endurance: "Endurance", power: "Power" };
export const BODY_GOAL_NAME: Readonly<Record<BodyGoal, string>> = { gain: "Gain", maintain: "Maintain", cut: "Cut" };
/** The badge on Profile → My body. */
export const BODY_GOAL_BADGE: Readonly<Record<BodyGoal, string>> = { gain: "GAIN", maintain: "HOLD", cut: "CUT" };

/** Heavier first: the main and secondary lifts of a pair follow the heavier goal. */
const HEAVY_RANK: Readonly<Record<TrainingGoal, number>> = { strength: 0, power: 1, growth: 2, endurance: 3 };

export const isTrainingGoal = (v: unknown): v is TrainingGoal => typeof v === "string" && (TRAINING_GOALS as readonly string[]).includes(v);
export const isBodyGoal = (v: unknown): v is BodyGoal => typeof v === "string" && (BODY_GOALS as readonly string[]).includes(v);

/** The goal a slot follows: the heavier goal for main and secondary lifts, the other for the rest; null without a goal. */
export function slotGoal(slot: "main" | "secondary" | "accessory" | "isolation" | "core", training: readonly TrainingGoal[] | null | undefined): TrainingGoal | null {
  if (!training?.length) return null;
  const sorted = [...training].sort((a, b) => HEAVY_RANK[a] - HEAVY_RANK[b]);
  return slot === "main" || slot === "secondary" ? sorted[0] : sorted[sorted.length - 1];
}

/** "Growth + Strength". */
export const trainingLabel = (training: readonly TrainingGoal[]) => training.map((g) => TRAINING_GOAL_NAME[g]).join(" + ");

/** Parses the stored settings keys; null when no goal is set or a value is not valid. */
export function goalsFromSettings(rows: Readonly<Record<string, string | undefined>>): Goals | null {
  const body = rows.goal_body;
  const at = rows.goal_set_at;
  if (!rows.goal_training || !isBodyGoal(body) || !at) return null;
  try {
    const t = JSON.parse(rows.goal_training) as unknown;
    if (!Array.isArray(t) || t.length < 1 || t.length > 2 || !t.every(isTrainingGoal) || new Set(t).size !== t.length) return null;
    return { training: t, body, set_at: at };
  } catch {
    return null;
  }
}

/* ---------------- body goal pace ---------------- */

/** Weekly change of body weight, as a share of body weight, that is on pace for the body goal. */
export const PACE: Readonly<Record<Exclude<BodyGoal, "maintain">, readonly [number, number]>> = { gain: [0.0025, 0.005], cut: [-0.01, -0.005] };
/** Maintain: within this many kg over four weeks. */
export const MAINTAIN_KG = 0.5;

export type PaceStatus = "on" | "slow" | "fast" | "holding" | "drifting" | "no_data";

/**
 * Where the body weight is against the body goal: `rate` is the weekly change as a share of body weight (a 7-day
 * average now against four weeks earlier, divided by 4), `changeKg` the four-week change in kg.
 */
export function paceStatus(body: BodyGoal, rate: number | null, changeKg: number | null): PaceStatus {
  if (rate === null || changeKg === null) return "no_data";
  if (body === "maintain") return Math.abs(changeKg) <= MAINTAIN_KG ? "holding" : "drifting";
  const [lo, hi] = PACE[body];
  if (rate < lo) return body === "gain" ? "slow" : "fast";
  if (rate > hi) return body === "gain" ? "fast" : "slow";
  return "on";
}

/** One plain sentence for the pace (Profile → My body). */
export function paceSentence(body: BodyGoal, status: PaceStatus): string {
  const range = body === "gain" ? "0.25–0.5 % of body weight a week" : body === "cut" ? "0.5–1 % of body weight a week" : "within 0.5 kg over four weeks";
  switch (status) {
    case "on":
      return `Right on pace for ${BODY_GOAL_NAME[body]}: ${range}.`;
    case "slow":
      return body === "gain" ? `Slower than the Gain pace of ${range}.` : `Slower than the Cut pace of ${range}.`;
    case "fast":
      return body === "gain" ? `Faster than the Gain pace of ${range}: more of it may be fat.` : `Faster than the Cut pace of ${range}: muscle is at risk.`;
    case "holding":
      return `Holding steady: ${range}.`;
    case "drifting":
      return `Moving more than the Maintain range: ${range}.`;
    case "no_data":
      return "Log your body weight a few times a week to see the pace.";
  }
}

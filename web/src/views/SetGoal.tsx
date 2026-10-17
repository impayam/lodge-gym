// Set goal (SPEC-v12 M15 §2.4–2.5): a training goal of one or two of Growth, Strength, Endurance and Power (the diamond's
// corners, or the chips under it: the same choice), and a body goal of Gain, Maintain or Cut. A third pick replaces the
// oldest. Save stores the goal (offline too) and changes nothing in the program; after it, "Ask Coach for a program for
// this goal" opens the Coach, whose draft applies only when Payam approves it.

import { useState } from "preact/hooks";
import { BODY_GOALS, BODY_GOAL_NAME, TRAINING_GOAL_NAME, trainingLabel, type BodyGoal, type TrainingGoal } from "../../../worker/lib/goals";
import { askCoachAbout } from "../coach";
import { CORNERS, Diamond, goalMeaning } from "../components/Diamond";
import { ScreenHead } from "../components/ScreenHead";
import { navigate, saveGoals, useStore } from "../store";

const BODY_LINE: Readonly<Record<BodyGoal, string>> = {
  gain: "Gain 0.25–0.5 % of body weight a week. Lifting stays as it is; little or no cardio.",
  maintain: "Hold within 0.5 kg over four weeks. Lifting stays as it is; cardio as you like.",
  cut: "Lose 0.5–1 % of body weight a week. Lifting stays as it is; the Coach suggests cardio.",
};

/** A tap selects or deselects a goal; a third replaces the oldest of the two. */
export function toggleGoal(list: readonly TrainingGoal[], g: TrainingGoal): TrainingGoal[] {
  if (list.includes(g)) return list.filter((x) => x !== g);
  return [...list, g].slice(-2);
}

export function SetGoal() {
  const goals = useStore((s) => s.boot!.goals ?? null);
  const [training, setTraining] = useState<TrainingGoal[]>(goals?.training ?? []);
  const [body, setBody] = useState<BodyGoal | null>(goals?.body ?? null);
  const [saved, setSaved] = useState(false);
  const pick = (g: TrainingGoal) => {
    setTraining((t) => toggleGoal(t, g));
    setSaved(false);
  };
  const canSave = training.length >= 1 && training.length <= 2 && body !== null;
  const same = !!goals && body === goals.body && training.length === goals.training.length && training.every((g, i) => goals.training[i] === g);

  return (
    <main class="page" data-testid="set-goal">
      <ScreenHead title="Set goal" sub="Profile" />
      <section class="card l-col l-gap-12" aria-labelledby="goal-training-title">
        <div class="card__head">
          <h2 class="card__title l-m0" id="goal-training-title">
            Training goal
          </h2>
          <span class="caption">one or two</span>
        </div>
        <Diamond corners={null} selected={training} body={body} pick onCorner={pick} label="Training goal: tap a corner to choose it" />
        <p class="ex-card__meta l-m0" data-testid="goal-meaning" aria-live="polite">
          {goalMeaning(training)}
        </p>
        <div class="chip-wrap" role="group" aria-label="Training goal">
          {CORNERS.map((g) => (
            <button type="button" class="clay press chip chip--lg" aria-pressed={training.includes(g)} data-testid={`goal-chip-${g}`} onClick={() => pick(g)}>
              {TRAINING_GOAL_NAME[g]}
            </button>
          ))}
        </div>
      </section>
      <section class="card l-col l-gap-12" aria-labelledby="goal-body-title">
        <h2 class="card__title l-m0" id="goal-body-title">
          Body goal
        </h2>
        <div class="chip-wrap" role="group" aria-label="Body goal">
          {BODY_GOALS.map((b) => (
            <button
              type="button"
              class="clay press chip chip--lg"
              aria-pressed={body === b}
              data-testid={`goal-body-${b}`}
              onClick={() => {
                setBody(b);
                setSaved(false);
              }}
            >
              {BODY_GOAL_NAME[b]}
            </button>
          ))}
        </div>
        {body ? <p class="caption l-m0">{BODY_LINE[body]}</p> : null}
      </section>
      {saved ? (
        <section class="callout" data-testid="goal-saved" role="status">
          <span class="t-title">
            Saved: {trainingLabel(training)} · {BODY_GOAL_NAME[body!]}
          </span>
          <span class="ex-card__meta">Your program stays as it is. New programs and the Coach follow this goal.</span>
          <button
            type="button"
            class="clay press btn t-pink"
            data-testid="goal-ask-coach"
            onClick={() => {
              askCoachAbout(`Make me a program for my goal: ${trainingLabel(training)}, ${BODY_GOAL_NAME[body!]}.`, { goal_program: true });
              navigate("coach");
            }}
          >
            Ask Coach for a program for this goal
          </button>
        </section>
      ) : (
        <button
          type="button"
          class="clay press btn t-pink"
          data-testid="goal-save"
          disabled={!canSave || same}
          onClick={() => {
            void saveGoals(training, body!);
            setSaved(true);
          }}
        >
          Save
        </button>
      )}
    </main>
  );
}

// Profile → My training (PR #26 review, Payam 2026-10-17): the training settings moved out of Settings unchanged, the
// rest timer ("Training") and the whole "Calendar" group. Same settings keys and API; Settings keeps the app's own.

import { CalendarSettingsCard } from "../components/CalendarSettings";
import { REST_BETWEEN_SETS_CHOICES, REST_NEXT_EXERCISE_CHOICES, type Settings as SettingsT } from "../../../worker/lib/types";
import { REST_DEFAULTS } from "../../../worker/lib/rest";
import { fmtNum } from "../format";
import { ScreenHead } from "../components/ScreenHead";
import { Select } from "../components/Select";
import { saveSettings, useStore } from "../store";

/** "45 s", "2 min", "1 min 30 s". */
const restText = (sec: number) => (sec < 60 ? `${fmtNum(sec)} s` : sec % 60 ? `${fmtNum(Math.floor(sec / 60))} min ${fmtNum(sec % 60)} s` : `${fmtNum(sec / 60)} min`);

export function MyTraining() {
  const st = useStore((s) => s.boot)!.settings;
  const set = (patch: Partial<SettingsT>) => void saveSettings(patch);
  return (
    <main class="page" data-testid="my-training">
      <ScreenHead title="My training" sub="Profile" />
      <h2 class="section-label">Training</h2>
      <section class="card l-col l-gap-14" aria-label="Training" data-testid="training-settings">
        <div class="form-field">
          <label class="form-field__label" for="s-rest-sets">
            Rest between sets
          </label>
          <Select id="s-rest-sets" value={String(st.rest_between_sets_sec ?? REST_DEFAULTS.rest_between_sets_sec)} onChange={(e) => set({ rest_between_sets_sec: Number((e.currentTarget as HTMLSelectElement).value) })}>
            {REST_BETWEEN_SETS_CHOICES.map((n) => (
              <option value={String(n)}>{restText(n)}</option>
            ))}
          </Select>
        </div>
        <div class="form-field">
          <label class="form-field__label" for="s-rest-next">
            Rest before the next exercise
          </label>
          <Select id="s-rest-next" value={String(st.rest_next_exercise_sec ?? REST_DEFAULTS.rest_next_exercise_sec)} onChange={(e) => set({ rest_next_exercise_sec: Number((e.currentTarget as HTMLSelectElement).value) })}>
            {REST_NEXT_EXERCISE_CHOICES.map((n) => (
              <option value={String(n)}>{restText(n)}</option>
            ))}
          </Select>
        </div>
        <p class="caption l-m0">Supersets and tri-sets rest as your program sets after each round, and as above after their last round. The timer keeps +30 s and Skip.</p>
      </section>

      <h2 class="section-label">Calendar</h2>
      <CalendarSettingsCard />
    </main>
  );
}

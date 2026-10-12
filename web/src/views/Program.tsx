import type { DayExercise } from "../../../worker/lib/types";
import { fmtNum, ytLink } from "../format";
import { exerciseMap } from "../model";
import { useStore } from "../store";

export function targetText(p: DayExercise) {
  if (p.is_time) return `${fmtNum(p.sets)} × ${fmtNum(p.reps_max)} s`;
  const reps = p.reps_min !== p.reps_max ? `${fmtNum(p.reps_min)}–${fmtNum(p.reps_max)}` : fmtNum(p.reps_max);
  return `${fmtNum(p.sets)} × ${reps}${p.per_leg ? " per leg" : ""}`;
}

export function Program() {
  const boot = useStore((s) => s.boot)!;
  const exMap = exerciseMap(boot);
  return (
    <>
      <h2>Program rules</h2>
      <div class="card">
        <ul class="rules">
          <li>Full body with a daily focus: every session trains the whole body, and the first exercise is the main, heavy lift of the day.</li>
          <li>Order: Day 1 → 2 → 3 → 4. Whenever you train, do the next day. No more than two training days in a row.</li>
          <li>Goal: 4 sessions in 7 days.</li>
          <li>Weeks 1 and 2: end each set with 3–4 reps in reserve. From week 3: 1–2 reps in reserve.</li>
          <li>All sets completed? Next session add: upper body 5 lb (2.5 kg), lower body 10 lb (5 kg), dumbbells 5 lb (2 kg) per hand.</li>
          <li>To keep muscle: don't eat below maintenance, 130–150 g of protein a day, 7–9 hours of sleep.</li>
          <li>A1/A2 and B1/B2 are supersets: alternate them and rest 60–90 s after each round.</li>
          <li>Every 6–8 weeks, a light week with half the sets.</li>
        </ul>
      </div>
      {boot.program.days.map((d) => (
        <>
          <h2>
            {d.name_en} <small>· about {fmtNum(d.est_minutes)} min</small>
          </h2>
          <div class="card prog-day">
            {d.exercises.map((p) => {
              const e = exMap.get(p.exercise_id)!;
              return (
                <div class="prog-item">
                  <div>
                    <b>
                      {p.is_main ? <span class="mainb">Main</span> : null}
                      {e.name_en}
                      {p.superset_tag ? <span class="tag">{p.superset_tag}</span> : null}
                    </b>
                    <small>
                      {targetText(p)} · rest {fmtNum(p.rest_sec)} s
                    </small>
                  </div>
                  <a href={ytLink(e.name_en)} target="_blank" rel="noopener noreferrer">
                    Form video ↗
                  </a>
                </div>
              );
            })}
          </div>
        </>
      ))}
    </>
  );
}

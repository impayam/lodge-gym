import type { DayExercise } from "../../../worker/lib/types";
import { fmtNum, instantShort, ytLink } from "../format";
import { activeProgramInfo, exerciseMap, programName, styleLabel } from "../model";
import { IconPlay } from "../components/PulseIcons";
import { ScreenHead } from "../components/ScreenHead";
import { openProgramEditor, useStore } from "../store";

export function targetText(p: Pick<DayExercise, "sets" | "reps_min" | "reps_max" | "is_time" | "per_leg">) {
  if (p.is_time) return p.reps_min !== p.reps_max ? `${fmtNum(p.sets)} × ${fmtNum(p.reps_min)}–${fmtNum(p.reps_max)} s` : `${fmtNum(p.sets)} × ${fmtNum(p.reps_max)} s`;
  const reps = p.reps_min !== p.reps_max ? `${fmtNum(p.reps_min)}–${fmtNum(p.reps_max)}` : fmtNum(p.reps_max);
  return `${fmtNum(p.sets)} × ${reps}${p.per_leg ? " per leg" : ""}`;
}

/** Target reps in reserve of a generated program's exercise (SPEC-v2 §8.4), e.g. "RIR 1–2". */
export function rirText(p: Pick<DayExercise, "target_rir_min" | "target_rir_max">): string {
  if (p.target_rir_min == null || p.target_rir_max == null) return "";
  return p.target_rir_min === p.target_rir_max ? `RIR ${fmtNum(p.target_rir_min)}` : `RIR ${fmtNum(p.target_rir_min)}–${fmtNum(p.target_rir_max)}`;
}

/** Rules for the active program: the seed program keeps its approved rules (SPEC §6); generated programs get theirs
 *  from the style (SPEC-v2 §8.3–§8.4). No light-week or intro-week rule (decided 2026-10-12). */
function rules(style: string | null, days: number, hasSupersets: boolean, strength: boolean): string[] {
  const progression = "All sets completed? Next session add: upper body 5 lb (2.5 kg), lower body 10 lb (5 kg), dumbbells 5 lb (2 kg) per hand.";
  const food = "To keep muscle: don't eat below maintenance, 130–150 g of protein a day, 7–9 hours of sleep.";
  const supersets = "A1/A2 and B1/B2 are supersets: alternate them and rest 60–90 s after each round.";
  if (style === null || style === "seed_full_body")
    return [
      "Full body with a daily focus: every session trains the whole body, and the first exercise is the main, heavy lift of the day.",
      "Order: Day 1 → 2 → 3 → 4. Whenever you train, do the next day. No more than two training days in a row.",
      "Goal: 4 sessions in 7 days.",
      "Weeks 1 and 2: end each set with 3–4 reps in reserve. From week 3: 1–2 reps in reserve.",
      progression,
      food,
      supersets,
    ];
  const order = `Order: ${Array.from({ length: days }, (_, i) => `Day ${i + 1}`).join(" → ")}. Whenever you train, do the next day.`;
  const sequencing =
    style === "full_body" || style === "strength" || style === "seed_upper_lower"
      ? "No more than two training days in a row."
      : "The days are arranged so no muscle is trained on two days in a row; keep the order.";
  return [
    `${styleLabel(style)}: ${days} sessions a week. The first exercise of each day is its main lift.`,
    `${order} ${sequencing}`,
    `Goal: ${days} sessions in 7 days.`,
    style === "seed_upper_lower"
      ? "End each set with 1–2 reps in reserve."
      : strength
        ? "Main lifts: 3–5 reps, ending each set with 1–2 reps in reserve. Accessories: 6–12 reps."
        : "Each exercise shows its target reps in reserve (RIR): main and secondary lifts 1–3, accessories 1–2, isolation 0–2.",
    progression,
    food,
    ...(hasSupersets ? [supersets] : []),
  ];
}

export function Program() {
  const boot = useStore((s) => s.boot)!;
  const exMap = exerciseMap(boot);
  const info = activeProgramInfo(boot);
  const days = boot.program.days;
  const list = rules(info?.style ?? null, info?.days_per_week ?? days.length, days.some((d) => d.exercises.some((x) => x.superset_tag)), info?.style === "strength");
  const since = info?.activations[info.activations.length - 1]?.started_at;
  return (
    <main class="page" data-testid="program">
      <ScreenHead title={<span data-testid="program-name">{programName(info, boot.program.name)}</span>} sub="Program" />
      <span class="ex-card__meta num">
        {info?.generated_by === "generator" ? "Made with New program" : "Original program"}
        {since ? ` · since ${instantShort(since, boot.settings.timezone)}` : ""}
      </span>
      <section class="card l-col l-gap-12" aria-labelledby="program-rules-title">
        <h2 class="card__title l-m0" id="program-rules-title">
          How it works
        </h2>
        <ul class="prose-list" data-testid="program-rules">
          {list.map((r) => (
            <li>{r}</li>
          ))}
        </ul>
        <button type="button" class="clay press btn t-pink" data-testid="program-new" onClick={() => openProgramEditor()}>
          New program
        </button>
      </section>
      {days.map((d) => (
        <section class="l-col l-gap-8" aria-label={d.name_en}>
          <h2 class="section-label num">
            {d.name_en} · about {fmtNum(d.est_minutes)} min
          </h2>
          <div class="card card--list">
            {d.exercises.map((p) => {
              const e = exMap.get(p.exercise_id)!;
              const rir = rirText(p);
              return (
                <div class="list-row" data-testid="program-exercise">
                  <span class="list-row__text">
                    <span class="t-title">
                      {p.superset_tag ? <span class="t-violet">{p.superset_tag} </span> : null}
                      {e.name_en}
                      {p.is_main ? (
                        <>
                          {" "}
                          <span class="badge">Main</span>
                        </>
                      ) : null}
                    </span>
                    <span class="caption num">
                      {targetText(p)}
                      {rir ? ` · ${rir}` : ""} · rest {fmtNum(p.rest_sec)} s
                    </span>
                  </span>
                  <a class="btn-icon btn-icon--soft press" href={ytLink(e.name_en)} target="_blank" rel="noopener noreferrer" aria-label={`Form video: ${e.name_en}`}>
                    <IconPlay />
                  </a>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}

import type { DayExercise } from "../../../worker/lib/types";
import { fmtNum, instantShort, ytLink } from "../format";
import { activeProgramInfo, exerciseMap, programName, styleLabel } from "../model";
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
    <>
      <h2 data-testid="program-name">
        {programName(info, boot.program.name)}{" "}
        <small>
          {info?.generated_by === "generator" ? "" : "· original program "}
          {since ? <span class="nowrap">· since {instantShort(since, boot.settings.timezone)}</span> : null}
        </small>
      </h2>
      <div class="card">
        <ul class="rules" data-testid="program-rules">
          {list.map((r) => (
            <li>{r}</li>
          ))}
        </ul>
        <button type="button" class="btn btn-ghost btn-small" style={{ marginTop: "8px" }} data-testid="program-new" onClick={() => openProgramEditor()}>
          New program
        </button>
      </div>
      {days.map((d) => (
        <>
          <h2>
            {d.name_en} <small>· about {fmtNum(d.est_minutes)} min</small>
          </h2>
          <div class="card prog-day">
            {d.exercises.map((p) => {
              const e = exMap.get(p.exercise_id)!;
              const rir = rirText(p);
              return (
                <div class="prog-item">
                  <div>
                    <b>
                      {p.is_main ? <span class="mainb">Main</span> : null}
                      {e.name_en}
                      {p.superset_tag ? <span class="tag">{p.superset_tag}</span> : null}
                    </b>
                    <small>
                      {targetText(p)}
                      {rir ? ` · ${rir}` : ""} · rest {fmtNum(p.rest_sec)} s
                    </small>
                  </div>
                  <a href={ytLink(e.name_en)} target="_blank" rel="noopener noreferrer">
                    Watch form video ↗
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

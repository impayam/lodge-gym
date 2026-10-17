import type { DayExercise } from "../../../worker/lib/types";
import { fmtNum, instantShort, ytLink } from "../format";
import { programRules } from "../../../worker/lib/programRules";
import { DUE_LINES, dueList, dueText } from "../../../worker/lib/rotation";
import { askCoachAbout } from "../coach";
import { ProgramDrafts } from "../components/ProgramDrafts";
import { activeProgramInfo, exerciseMap, programName } from "../model";
import { IconPlay } from "../components/PulseIcons";
import { ScreenHead } from "../components/ScreenHead";
import { navigate, openProgramEditor, useStore } from "../store";

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

/** The question a due line's Ask Coach sends, in Persian like the Coach's suggested questions. */
export const dueQuestion = (name: string) => `${name} برای تعویض آماده است. این چند هفته کدام ناحیه را تمرین داده و چه حرکتی می‌تواند جایش بیاید؟`;

export function Program() {
  const boot = useStore((s) => s.boot)!;
  const exMap = exerciseMap(boot);
  const info = activeProgramInfo(boot);
  const days = boot.program.days;
  const list = programRules(info?.style ?? null, info?.days_per_week ?? days.length, days.some((d) => d.exercises.some((x) => x.superset_tag)), info?.style === "strength");
  const since = info?.activations[info.activations.length - 1]?.started_at;
  // Rotation (SPEC-v11 Phase B): one line per due exercise, most overdue first; nothing changes on its own.
  const due = dueList(boot.rotation ?? []).slice(0, DUE_LINES);
  return (
    <main class="page" data-testid="program">
      <ScreenHead title={<span data-testid="program-name">{programName(info, boot.program.name)}</span>} sub="Program" />
      <span class="ex-card__meta num">
        {info?.generated_by === "generator" ? "Made with New program" : "Original program"}
        {since ? ` · since ${instantShort(since, boot.settings.timezone)}` : ""}
      </span>
      {due.length ? (
        <section class="card l-col l-gap-10" aria-labelledby="program-due-title" data-testid="program-due">
          <h2 class="card__title l-m0" id="program-due-title">
            Due for a change
          </h2>
          <ul class="list-plain">
            {due.map((s) => {
              const name = exMap.get(s.exercise_id)?.name_en ?? s.exercise_id;
              return (
                <li class="list-row" data-testid="program-due-line" data-ex={s.exercise_id}>
                  <span class="list-row__text">
                    <span class="t-title">{name}</span>
                    <span class="caption num">{dueText(s)}</span>
                  </span>
                  <button
                    type="button"
                    class="clay press btn-sm t-pink"
                    data-testid="program-due-coach"
                    aria-label={`Ask Coach about ${name}`}
                    onClick={() => {
                      askCoachAbout(dueQuestion(name), { exercise_id: s.exercise_id });
                      navigate("coach");
                    }}
                  >
                    Ask Coach
                  </button>
                </li>
              );
            })}
          </ul>
          <span class="caption">Nothing changes until you pick a replacement.</span>
        </section>
      ) : null}
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
      <ProgramDrafts testId="program-screen-drafts" card />
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

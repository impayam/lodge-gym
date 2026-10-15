// The coach's data cards (SPEC-v9 M12 §4): each tool result drawn the way the app draws the same numbers elsewhere
// (bars vs target, columns per week, a line chart with a Table view), captioned as the app's own numbers. The program
// draft card has Add to Planner and Change.

import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { errorText } from "../api";
import { dayMonth, fmtNum } from "../format";
import { allExercises, navigate, refresh } from "../store";
import { Bars } from "./Bars";
import { Columns } from "./Columns";
import { TimeChart } from "./TimeChart";

/** What the typing line says while a tool runs. */
const TOOL_LABEL: Record<string, string> = {
  get_sessions: "Reading your sessions",
  get_e1rm_history: "Reading your estimated 1RM",
  get_volume: "Counting your weekly sets",
  get_adherence: "Counting your sessions",
  get_prs: "Looking at your records",
  get_program: "Reading your program",
  get_library: "Searching the exercise library",
  get_body_weight: "Reading your body weight",
  get_photos: "Listing your progress photos",
  get_recovery: "Checking your recovery",
  propose_program: "Writing a program draft",
};
export const toolLabel = (name: string) => TOOL_LABEL[name] ?? "Working";

const SOURCE = "Numbers calculated by the app from your logs";

function DataCard({ title, sub, testid, children, source = true }: { title: string; sub?: ComponentChildren; testid: string; children: ComponentChildren; source?: boolean }) {
  return (
    <section class="card l-col l-gap-10" data-testid="coach-card" data-card={testid}>
      <div class="card__head">
        <h2 class="card__title l-m0">{title}</h2>
        {sub ? <span class="caption num">{sub}</span> : null}
      </div>
      {children}
      {source ? <span class="caption">{SOURCE}</span> : null}
    </section>
  );
}

/* Result shapes (worker/lib/coach/tools.ts). */
type SetRow = { set: number; weight: number | null; reps: number | null; seconds: number | null; rir: number | null };
type Sessions = { unit: string; from: string; to: string; sessions: { id: string; date: string; status: string; day: string; duration_min: number | null; exercises: { name: string; sets: SetRow[] }[] }[] };
type E1rm = { unit: string; name: string; points: { date: string; weight: number; reps: number; e1rm: number }[]; latest_e1rm: number | null; change_pct: number | null };
type Volume = { weeks: { start: string; end: string; partial: boolean; groups: { group: string; name: string; direct_sets: number; fractional_sets: number; target: number | null; status: "none" | "under" | "on" | "over" | "untracked" }[] }[] };
type Adherence = { sessions_done: number; sessions_planned: number; adherence_pct: number | null; weeks: { start: string; done: number; planned: number }[] };
type Prs = { unit: string; records: { date: string; name: string; weight: number; reps: number; e1rm: number; previous_e1rm: number }[]; best: { name: string; date: string; weight: number; reps: number; e1rm: number }[] };
type ProgramDay = { name: string; exercises: { name?: string; exercise_id: string; sets: number; reps_min: number; reps_max: number; is_time?: boolean; group?: string | null; is_main?: boolean }[] };
type Program = { name: string; days_per_week: number; days: ProgramDay[] };
type Library = { total: number; exercises: { id: string; name: string; equipment: string; primary: string; done_before: boolean }[] };
type Body = { unit: string; days: { date: string; value: number }[]; latest: { value: number } | null; change: number | null };
type Photos = { total: number; photos: { id: string; date: string; pose: string; after_session: string | null }[] };
type Recovery = { groups: { group: string; date: string; hours_ago: number; exercise: string }[] };
type Draft = { name: string; summary_fa?: string; days: ProgramDay[] };
type DraftResult = { draft_id: string; names?: Record<string, string>; dropped: { exercise_id: string }[]; weekly_sets: { group: string; name: string; planned: number; current_target: number }[] };

const setText = (s: SetRow) => (s.seconds != null && s.reps == null ? `${fmtNum(s.seconds)} s` : `${s.weight == null ? "" : `${fmtNum(s.weight)}×`}${fmtNum(s.reps ?? 0)}${s.weight == null ? " reps" : ""}`) + (s.rir == null ? "" : ` RIR ${s.rir >= 3 ? "3+" : s.rir}`);
const reps = (x: { reps_min: number; reps_max: number; is_time?: boolean }) => `${x.reps_min === x.reps_max ? fmtNum(x.reps_max) : `${fmtNum(x.reps_min)}–${fmtNum(x.reps_max)}`}${x.is_time ? " s" : ""}`;

function DaysList({ days }: { days: ProgramDay[] }) {
  return (
    <div class="l-col l-gap-10">
      {days.map((d, i) => (
        <div class="l-row l-gap-10 l-top">
          <span class="well icon-well num">{fmtNum(i + 1)}</span>
          <span class="list-row__text">
            <span class="t-title">{d.name}</span>
            <span class="caption num">{d.exercises.map((x) => `${x.group ? `${x.group} ` : ""}${x.name ?? x.exercise_id} ${fmtNum(x.sets)} × ${reps(x)}`).join(", ")}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** The program draft card: Add to Planner saves it under Me → Program → Drafts; Change asks the coach for changes. */
function DraftCard({ input, result, messageId, toolUseId, onChange, onAdd }: { input: Draft; result: DraftResult; messageId: string; toolUseId: string; onChange: () => void; onAdd: (m: string, t: string) => Promise<unknown> }) {
  const [state, setState] = useState<"idle" | "busy" | "added">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const dropped = new Set(result.dropped.map((x) => x.exercise_id));
  const known = allExercises();
  const nameOf = (id: string) => result.names?.[id] ?? known.get(id)?.name_en ?? id;
  const days = input.days
    .map((d) => ({ ...d, exercises: d.exercises.filter((x) => !dropped.has(x.exercise_id)).map((x) => ({ ...x, name: nameOf(x.exercise_id) })) }))
    .filter((d) => d.exercises.length);
  const chest = result.weekly_sets.find((g) => g.group === "chest");
  const add = async () => {
    setState("busy");
    setProblem(null);
    try {
      await onAdd(messageId, toolUseId);
      setState("added");
      // The draft's exercises are now in a program, so the bootstrap carries them for the Drafts screen, offline too.
      void refresh().catch(() => undefined);
    } catch (e) {
      setProblem(errorText(e));
      setState("idle");
    }
  };
  return (
    <section class="card l-col l-gap-10" data-testid="coach-draft">
      <div class="card__head">
        <h2 class="card__title l-m0">{input.name}</h2>
        {chest ? <span class="caption num t-orange">Chest {fmtNum(chest.planned)} sets / week</span> : null}
      </div>
      {input.summary_fa ? (
        <p class="prose-fa fa" dir="rtl" lang="fa">
          {input.summary_fa}
        </p>
      ) : null}
      <DaysList days={days} />
      {result.dropped.length ? <span class="caption">Left out (not in the library): {result.dropped.map((x) => x.exercise_id).join(", ")}</span> : null}
      {state === "added" ? (
        <div class="l-row l-between l-gap-8" data-testid="coach-draft-added">
          <span class="caption">Added to Me → Program → Drafts.</span>
          <button type="button" class="clay press btn-sm t-pink" data-testid="coach-open-drafts" onClick={() => navigate("program")}>
            Open
          </button>
        </div>
      ) : (
        <div class="l-row l-gap-8">
          <button type="button" class="clay press btn l-grow t-pink" data-testid="coach-add-draft" disabled={state === "busy"} onClick={() => void add()}>
            Add to Planner
          </button>
          <button type="button" class="clay press btn l-grow t-muted" data-testid="coach-change-draft" onClick={onChange}>
            Change
          </button>
        </div>
      )}
      {problem ? <span class="caption t-orange">{problem}</span> : null}
    </section>
  );
}

export function CoachCard({ name, input, result, messageId, toolUseId, onChange, onAdd }: { name: string; input: unknown; result: unknown; messageId: string; toolUseId: string; onChange: () => void; onAdd: (m: string, t: string) => Promise<unknown> }) {
  switch (name) {
    case "get_sessions": {
      const r = result as Sessions;
      return (
        <DataCard title="Sessions" sub={`${dayMonth(r.from)} – ${dayMonth(r.to)}`} testid={name}>
          {r.sessions.length ? (
            r.sessions.map((s) => (
              <div class="l-col l-gap-4">
                <span class="t-title num">
                  {dayMonth(s.date)} · {s.day}
                  {s.status === "active" ? " · now" : s.duration_min != null ? ` · ${fmtNum(s.duration_min)} min` : ""}
                </span>
                {s.exercises.map((x) => (
                  <span class="caption num">
                    {x.name}: {x.sets.map((y) => setText(y)).join(", ")}
                  </span>
                ))}
              </div>
            ))
          ) : (
            <p class="state l-m0">No sessions in these dates.</p>
          )}
        </DataCard>
      );
    }
    case "get_e1rm_history": {
      const r = result as E1rm;
      return (
        <DataCard title={`${r.name}, estimated 1RM`} sub={r.change_pct != null ? `${r.change_pct > 0 ? "+" : ""}${fmtNum(r.change_pct)}%` : undefined} testid={name}>
          {r.points.length ? (
            <TimeChart series={[{ label: r.name, color: "--series-2", points: r.points.map((p) => ({ date: p.date, value: p.e1rm })) }]} height={120} label={`${r.name}, estimated 1RM in ${r.unit}`} unit={r.unit} yAxis pickLast />
          ) : (
            <p class="state l-m0">Not logged in these weeks.</p>
          )}
        </DataCard>
      );
    }
    case "get_volume": {
      const r = result as Volume;
      return (
        <>
          {r.weeks.map((w) => (
            <DataCard title="Sets vs target" sub={`Week of ${dayMonth(w.start)}${w.partial ? ", so far" : ""}`} testid={name}>
              <Bars
                testid="coach-volume-bars"
                markWord="Target"
                fmt={(n) => fmtNum(n, 1)}
                rows={w.groups.filter((g) => g.target != null || g.fractional_sets > 0).map((g) => ({ key: g.group, label: g.name, value: g.fractional_sets, mark: g.target, direct: g.direct_sets, status: g.status }))}
              />
            </DataCard>
          ))}
        </>
      );
    }
    case "get_adherence": {
      const r = result as Adherence;
      return (
        <DataCard title="Sessions done" sub={`${fmtNum(r.sessions_done)} of ${fmtNum(r.sessions_planned)}${r.adherence_pct != null ? ` · ${fmtNum(r.adherence_pct)}%` : ""}`} testid={name}>
          <Columns cols={r.weeks.map((w) => ({ date: w.start, value: w.done }))} unit="sessions" fmt={(n) => fmtNum(n)} label={`Sessions per week: ${r.sessions_done} of ${r.sessions_planned} planned`} />
        </DataCard>
      );
    }
    case "get_prs": {
      const r = result as Prs;
      const rows = r.records.length ? r.records : r.best;
      return (
        <DataCard title={r.records.length ? "Records" : "Best sets"} testid={name}>
          {rows.length ? (
            <table class="data-table num">
              <thead>
                <tr>
                  <th scope="col">Exercise</th>
                  <th scope="col">Set</th>
                  <th scope="col">e1RM</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr>
                    <td>
                      {x.name}
                      <span class="caption"> · {dayMonth(x.date)}</span>
                    </td>
                    <td>
                      {fmtNum(x.weight)}×{fmtNum(x.reps)}
                    </td>
                    <td>{fmtNum(x.e1rm)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="state l-m0">No records yet.</p>
          )}
        </DataCard>
      );
    }
    case "get_program": {
      const r = result as Program;
      return (
        <DataCard title={r.name} sub={`${fmtNum(r.days_per_week)} days a week`} testid={name}>
          <DaysList days={r.days} />
        </DataCard>
      );
    }
    case "get_library": {
      const r = result as Library;
      return (
        <DataCard title="Exercises" sub={`${fmtNum(r.exercises.length)} of ${fmtNum(r.total)}`} testid={name} source={false}>
          <div class="l-col l-gap-4">
            {r.exercises.slice(0, 12).map((x) => (
              <span class="caption">
                <span class="t-title">{x.name}</span> · {x.equipment}
                {x.done_before ? " · done before" : ""}
              </span>
            ))}
          </div>
        </DataCard>
      );
    }
    case "get_body_weight": {
      const r = result as Body;
      return (
        <DataCard title="Body weight" sub={r.change != null ? `${r.change > 0 ? "+" : ""}${fmtNum(r.change, 1)} ${r.unit}` : undefined} testid={name}>
          {r.days.length ? (
            <TimeChart series={[{ label: "Body weight", color: "--series-2", points: r.days.map((d) => ({ date: d.date, value: d.value })) }]} height={110} label={`Body weight in ${r.unit}`} unit={r.unit} yAxis pickLast />
          ) : (
            <p class="state l-m0">No body weight in these weeks.</p>
          )}
        </DataCard>
      );
    }
    case "get_photos": {
      const r = result as Photos;
      return (
        <DataCard title="Progress photos" sub={`${fmtNum(r.total)} in all`} testid={name} source={false}>
          <span class="caption">{r.photos.slice(0, 8).map((p) => `${dayMonth(p.date)} ${p.pose}`).join(", ") || "No progress photos."}</span>
        </DataCard>
      );
    }
    case "get_recovery": {
      const r = result as Recovery;
      return (
        <DataCard title="Last heavy compound" sub="48-hour rule" testid={name}>
          {r.groups.length ? (
            <table class="data-table num">
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Lift</th>
                  <th scope="col">Hours ago</th>
                </tr>
              </thead>
              <tbody>
                {r.groups.map((g) => (
                  <tr>
                    <td>{g.group}</td>
                    <td>{g.exercise}</td>
                    <td class={g.hours_ago < 48 ? "t-orange" : undefined}>{fmtNum(g.hours_ago)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="state l-m0">No heavy compound lifts logged.</p>
          )}
        </DataCard>
      );
    }
    case "propose_program":
      return <DraftCard input={input as Draft} result={result as DraftResult} messageId={messageId} toolUseId={toolUseId} onChange={onChange} onAdd={onAdd} />;
    default:
      return null;
  }
}


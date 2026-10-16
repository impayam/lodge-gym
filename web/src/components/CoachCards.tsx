// The coach's data cards (SPEC-v9 M12 §4): each tool result drawn the way the app draws the same numbers elsewhere
// (a table of weeks vs target, columns per week, a line chart with a Table view), captioned as the app's own numbers.
// The program draft card has Add to Planner and Change; the one-exercise card has Only this session and Whole program.
// get_program, get_library and get_recovery draw a card only when the model passed show: true (he asked to see it).

import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { toMin } from "../../../worker/lib/calendar";
import { ulid } from "../../../worker/lib/ulid";
import { errorText } from "../api";
import { dateShort, dayMonth, fmtNum, plural } from "../format";
import { newGymPlan, streakNote } from "../lib/calendarView";
import { targetKey, targetLabel, type AdditionTarget } from "../../../worker/lib/coach/additionTarget";
import { inPlan } from "../../../worker/lib/plan";
import { openPlanFor } from "../model";
import { addCoachExtras, allExercises, coachTargets, flash, navigate, openCalendar, openPlan, refresh, saveGymPlan, today, useStore } from "../store";
import { Select } from "./Select";
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
  get_training_pattern: "Reading your training days",
  get_calendar: "Reading your calendar",
  find_free_slots: "Finding gym times",
  propose_schedule: "Writing a gym schedule",
  propose_exercise: "Placing the exercise",
  propose_session_additions: "Picking exercises for today",
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
type Pattern = {
  from: string;
  to: string;
  sessions: number;
  weekdays: { day: string; weeks: number; sessions: number }[];
  max_days_in_a_row: number;
  program_days: { day: string; usual_weekday: string }[];
  clear: boolean;
  summary: string;
  planned_this_week?: { date: string; weekday: string; start: string; day: string }[];
};
type CalendarResult = {
  from: string;
  to: string;
  shifts: { date: string; start: string; end: string; note: string }[];
  plans: { date: string; start: string; end: string; day: string; status: string }[];
  sessions: { date: string; start: string; end: string; day: string; status: string }[];
};
type SlotsResult = { week_start: string; week_end: string; need: number; slots: { date: string; start: string; end: string; day: string | null; selected: boolean; days_in_a_row: number }[] };
type Schedule = { week_start: string; sessions: { date: string; start: string; end: string; program_day_id: string; day: string; reason_fa: string; days_in_a_row?: number }[]; dropped: { date: string; start: string; reason: string }[] };
type Draft = { name: string; summary_fa?: string; days: ProgramDay[] };
type DraftResult = { draft_id: string; names?: Record<string, string>; day_minutes?: number[]; warnings?: string[]; dropped: { exercise_id: string }[]; weekly_sets: { group: string; name: string; planned: number; current_target: number }[] };

const setText = (s: SetRow) => (s.seconds != null && s.reps == null ? `${fmtNum(s.seconds)} s` : `${s.weight == null ? "" : `${fmtNum(s.weight)}×`}${fmtNum(s.reps ?? 0)}${s.weight == null ? " reps" : ""}`) + (s.rir == null ? "" : ` RIR ${s.rir >= 3 ? "3+" : s.rir}`);
const reps = (x: { reps_min: number; reps_max: number; is_time?: boolean }) => `${x.reps_min === x.reps_max ? fmtNum(x.reps_max) : `${fmtNum(x.reps_min)}–${fmtNum(x.reps_max)}`}${x.is_time ? " s" : ""}`;

function DaysList({ days, minutes }: { days: ProgramDay[]; minutes?: number[] }) {
  return (
    <div class="l-col l-gap-10">
      {days.map((d, i) => (
        <div class="l-row l-gap-10 l-top">
          <span class="well icon-well num">{fmtNum(i + 1)}</span>
          <span class="list-row__text">
            <span class="t-title num">
              {d.name}
              {minutes?.[i] != null ? ` · about ${fmtNum(minutes[i])} min` : ""}
            </span>
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
    <>
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
        <DaysList days={days} minutes={result.day_minutes} />
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
      {result.warnings?.length ? (
        // The program generator's check (as New program shows it), warnings only: Add to Planner is never blocked.
        <section class="callout" data-bad="false" data-testid="coach-draft-warnings">
          <h2 class="card__title l-m0">Worth knowing</h2>
          <ul class="prose-list ex-card__meta">
            {result.warnings.map((w) => (
              <li>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/**
 * The coach's gym schedule (SPEC-v10 §6): one row per session (day, time, program day, the coach's reason in Persian),
 * only the finder's times. Add to calendar puts them on the calendar (source coach); Change opens Find times on that
 * week. Nothing is saved before the tap.
 */
function ScheduleCard({ result }: { result: Schedule }) {
  const plans = useStore((s) => s.gymPlans);
  const on = (x: Schedule["sessions"][number]) => Object.values(plans).some((p) => p.date === x.date && p.start_min === toMin(x.start));
  const added = result.sessions.every(on);
  const add = async () => {
    const now = new Date().toISOString();
    const todo = result.sessions.filter((x) => !on(x));
    for (const x of todo) await saveGymPlan(newGymPlan(ulid(), x.date, toMin(x.start), { id: x.program_day_id, minutes: toMin(x.end) - toMin(x.start) }, "coach", now));
    flash(`Added ${plural(todo.length, "gym session")} to the calendar.`);
  };
  return (
    <section class="card l-col l-gap-10" data-testid="coach-schedule">
      <div class="card__head">
        <h2 class="card__title l-m0">Gym schedule</h2>
        <span class="caption num">{plural(result.sessions.length, "session")}</span>
      </div>
      <ul class="list-plain">
        {result.sessions.map((x) => (
          <li class="list-row" data-testid="coach-schedule-row" data-date={x.date}>
            <span class="cal-mark" aria-hidden="true">
              <span class="cal-dot" data-kind={on(x) ? "done" : "planned"} />
            </span>
            <span class="list-row__text">
              <span class="t-title num">
                {dateShort(x.date)} · {x.start}–{x.end}
              </span>
              <span class="list-row__note">{x.day}</span>
              {x.reason_fa ? (
                <span class="caption fa" dir="rtl" lang="fa">
                  {x.reason_fa}
                </span>
              ) : null}
              {streakNote(x.days_in_a_row ?? 1) ? <span class="caption">{streakNote(x.days_in_a_row ?? 1)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {result.dropped.length ? <span class="caption">Left out (not one of the app's free times): {result.dropped.map((x) => `${dateShort(x.date)} ${x.start}`).join(", ")}</span> : null}
      <span class="caption">Times from the app's free-time finder</span>
      {added ? (
        <div class="l-row l-between l-gap-8" data-testid="coach-schedule-added">
          <span class="caption">On your calendar.</span>
          <button type="button" class="clay press btn-sm t-pink" onClick={() => openCalendar({ week: result.week_start })}>
            Open
          </button>
        </div>
      ) : (
        <div class="l-row l-gap-8">
          <button type="button" class="clay press btn l-grow t-pink" data-testid="coach-add-schedule" onClick={() => void add()}>
            Add to calendar
          </button>
          <button type="button" class="clay press btn l-grow t-muted" data-testid="coach-change-schedule" onClick={() => openCalendar({ week: result.week_start, find: true })}>
            Change
          </button>
        </div>
      )}
    </section>
  );
}

/* propose_session_additions (worker/lib/coach/sessionTools.ts). */
type Addition = {
  exercise_id: string;
  name: string;
  sets: number;
  reps_min: number;
  reps_max: number;
  is_time: boolean;
  weight: number | null;
  weight_unit: string | null;
  basis: "program" | "history" | "none";
  rule: string;
  last: { date: string; sets: string } | null;
  reason_fa: string;
};
type Additions = { target: AdditionTarget & { label: string }; named_day_id: string | null; items: Addition[]; dropped: { exercise_id: string; reason: string }[] };

const repsText = (x: Pick<Addition, "reps_min" | "reps_max" | "is_time">) =>
  `${x.reps_min === x.reps_max ? fmtNum(x.reps_max) : `${fmtNum(x.reps_min)}–${fmtNum(x.reps_max)}`}${x.is_time ? " s" : ""}`;
const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * The coach's exercises for a session (Payam, 2026-10-16): each with sets × reps and weight from the app's
 * progression, the step it took, and the coach's reason in Persian. The heading says where they go, chosen by date
 * from this device's state (a session open today, today's day, or the next planned session); Change picks another.
 * Add puts them into the open session, or into the day's plan (nothing is started). The program never changes.
 */
function AdditionsCard({ result }: { result: Additions }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const plans = useStore((s) => s.plans);
  useStore((s) => s.gymPlans);
  const [picked, setPicked] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const { target: auto, choices } = coachTargets(result.named_day_id);
  const target = choices.find((c) => targetKey(c) === picked) ?? auto;
  const t = today();
  const dayName = (id: string) => boot.program.days.find((d) => d.id === id)?.name_en ?? id;
  const label = (x: AdditionTarget) => targetLabel(x, dayName(x.day_id), t);
  const ids = result.items.map((x) => x.exercise_id);
  // Already there: every exercise in the open session, or in the day's open plan.
  const session = target.kind === "open_session" ? sessions[target.session_id] : null;
  // Today's day or a session ahead: that day's plan (nothing is started until he taps Start).
  const plan = target.kind === "open_session" ? null : openPlanFor(plans, target.day_id);
  const added = session ? ids.every((id) => session.sets.some((x) => x.exercise_id === id)) : plan ? ids.every((id) => inPlan(plan, id)) : false;

  const add = async () => {
    setBusy(true);
    try {
      const r = await addCoachExtras(
        result.items.map((x) => ({ exercise_id: x.exercise_id, sets: x.sets, reps_min: x.reps_min, reps_max: x.reps_max, is_time: x.is_time, weight: x.weight, weight_unit: x.weight_unit === "kg" || x.weight_unit === "lb" ? x.weight_unit : null })),
        target
      );
      setChanging(false);
      flash(r.added ? `Added ${plural(r.added, "exercise")} to ${label(target)}.` : r.missing ? "The exercise library did not load. Try again online." : `They are already in ${label(target)}.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card l-col l-gap-10" data-testid="coach-additions" data-target={target.kind}>
      <h2 class="card__title l-m0" data-testid="coach-additions-target">
        Add to {label(target)}
        {target.kind === "open_session" ? "?" : ""}
      </h2>
      {changing ? (
        <div class="form-field">
          <label class="form-field__label" for="coach-additions-where">
            Add to
          </label>
          <Select id="coach-additions-where" value={targetKey(target)} onChange={(e) => setPicked((e.currentTarget as HTMLSelectElement).value)}>
            {choices.map((c) => (
              <option value={targetKey(c)}>{capital(label(c))}</option>
            ))}
          </Select>
        </div>
      ) : null}
      <ul class="list-plain">
        {result.items.map((x) => (
          <li class="list-row" data-testid="coach-addition-row" data-ex={x.exercise_id}>
            <span class="list-row__text">
              <span class="t-title">{x.name}</span>
              <span class="list-row__note num">
                {fmtNum(x.sets)} × {repsText(x)}
              </span>
              <span class="caption">{x.rule}</span>
              {x.reason_fa ? (
                <span class="caption fa" dir="rtl" lang="fa">
                  {x.reason_fa}
                </span>
              ) : null}
            </span>
            <span class="list-row__value t-title num" data-testid="coach-addition-weight">
              {x.weight != null ? `${fmtNum(x.weight)} ${x.weight_unit}` : "–"}
            </span>
          </li>
        ))}
      </ul>
      {result.dropped.length ? <span class="caption">Left out: {result.dropped.map((x) => `${x.exercise_id} (${x.reason})`).join(", ")}</span> : null}
      <span class="caption">Sets, reps and weights from the app's progression; your program does not change.</span>
      {added ? (
        <div class="l-row l-between l-gap-8" data-testid="coach-additions-added">
          <span class="caption">{session ? "In today's session." : "In the plan: they are there when you tap Start."}</span>
          <button type="button" class="clay press btn-sm t-pink" onClick={() => (session ? navigate("session", session.id) : plan && openPlan(plan.id))}>
            Open
          </button>
        </div>
      ) : (
        <div class="l-row l-gap-8">
          <button type="button" class="clay press btn l-grow t-pink" data-testid="coach-add-additions" disabled={busy} onClick={() => void add()}>
            Add
          </button>
          <button type="button" class="clay press btn l-grow t-muted" data-testid="coach-change-additions" aria-expanded={changing} onClick={() => setChanging(!changing)}>
            Change
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Sets vs target (Payam, 2026-10-16): one card for every week of the call, muscle groups as rows and weeks as columns
 * (the current week marked "so far"), plus the target of the latest week's program. The same rows and fractional sets
 * as the Reports screen; each row carries the latest week's status.
 */
function VolumeCard({ result }: { result: Volume }) {
  const weeks = result.weeks;
  const latest = weeks.at(-1);
  const keys = [...new Set(weeks.flatMap((w) => w.groups.filter((g) => g.target != null || g.fractional_sets > 0).map((g) => g.group)))];
  const order = latest?.groups.map((g) => g.group) ?? [];
  keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const cell = (w: Volume["weeks"][number], key: string) => w.groups.find((g) => g.group === key);
  return (
    <DataCard title="Sets vs target" sub={plural(weeks.length, "week")} testid="get_volume">
      {weeks.length && keys.length ? (
        <div class="timeline__scroll">
          <table class="data-table num" data-testid="coach-volume-table">
            <thead>
              <tr>
                <th scope="col">Muscle</th>
                {weeks.map((w) => (
                  <th scope="col">
                    {dayMonth(w.start)}
                    {w.partial ? "*" : ""}
                  </th>
                ))}
                <th scope="col">Target</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const now = latest ? cell(latest, key) : undefined;
                return (
                  <tr data-row={key} data-status={now?.status ?? "none"}>
                    <td>{now?.name ?? weeks.map((w) => cell(w, key)?.name).find(Boolean) ?? key}</td>
                    {weeks.map((w) => (
                      <td>{fmtNum(cell(w, key)?.fractional_sets ?? 0, 1)}</td>
                    ))}
                    <td>{now?.target != null ? fmtNum(now.target, 1) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="state l-m0">No sets in these dates.</p>
      )}
      <span class="caption">{weeks.some((w) => w.partial) ? "* this week so far. " : ""}Sets: direct 1, secondary 0.5, as on Reports.</span>
    </DataCard>
  );
}

/** get_program, get_library and get_recovery: a card only when he asked to see it (the model passed show: true). */
const asked = (input: unknown) => (input as { show?: unknown } | null)?.show === true;

/* propose_exercise (worker/lib/coach/exerciseTool.ts). */
type ExerciseChange = {
  draft_id: string;
  prefer: "session" | "program" | null;
  day: { id: string; name: string; position: number };
  exercise: Omit<Addition, "reason_fa"> & { rest_sec: number };
  after: { exercise_id: string; name: string } | null;
  notes: string[];
};

/**
 * One more exercise for a day (Payam, 2026-10-16): only the change ("Day 1 · Chest: + Butterfly", 3 × 10–15 after
 * Seated Cable Row, the weight from the app's progression), what it causes under Worth knowing, and two buttons, the
 * one he asked for first. Only this session takes the propose_session_additions path (a session open today, else
 * that day's plan, in the same place); Whole program saves the app's draft under Me → Program → Drafts. The reason is
 * in the coach's text only, so it is said once.
 */
function ExerciseCard({ result, messageId, toolUseId, onAdd }: { result: ExerciseChange; messageId: string; toolUseId: string; onAdd: (m: string, t: string) => Promise<unknown> }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const plans = useStore((s) => s.plans);
  useStore((s) => s.gymPlans);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const x = result.exercise;
  // The day is still in his active program: its next session can take the exercise.
  const dayKnown = boot.program.days.some((d) => d.id === result.day.id);
  const { target } = coachTargets(dayKnown ? result.day.id : null);
  const dayName = (id: string) => boot.program.days.find((d) => d.id === id)?.name_en ?? id;
  const label = targetLabel(target, dayName(target.day_id), today());
  const session = target.kind === "open_session" ? sessions[target.session_id] : null;
  const plan = target.kind === "open_session" ? null : openPlanFor(plans, target.day_id);
  const inSession = session ? session.sets.some((s) => s.exercise_id === x.exercise_id) : plan ? inPlan(plan, x.exercise_id) : false;
  const inDrafts = saved || (boot.programs ?? []).some((p) => p.id === result.draft_id);
  // Where it goes (Payam, 2026-10-16): a session open today takes it at its end; the day's plan and the program, after
  // that exercise. With a session open the card offers both, so it names both places.
  const after = result.after ? `after ${result.after.name}` : null;
  const place = dayKnown && session ? ` · at the end of this session${after ? `; in the program ${after}` : ""}` : after ? ` · ${after}` : "";

  const addSession = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await addCoachExtras(
        [{ exercise_id: x.exercise_id, sets: x.sets, reps_min: x.reps_min, reps_max: x.reps_max, is_time: x.is_time, weight: x.weight, weight_unit: x.weight_unit === "kg" || x.weight_unit === "lb" ? x.weight_unit : null, rest_sec: x.rest_sec }],
        target,
        result.after?.exercise_id ?? null
      );
      flash(r.added ? `Added ${x.name} to ${label}.` : r.missing ? "The exercise library did not load. Try again online." : `It is already in ${label}.`);
    } finally {
      setBusy(false);
    }
  };
  const addProgram = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onAdd(messageId, toolUseId);
      setSaved(true);
      // The draft is now a program: the bootstrap carries it for the Drafts screen, offline too.
      void refresh().catch(() => undefined);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const sessionDone = (
    <div class="l-row l-between l-gap-8" data-testid="coach-exercise-session-added">
      <span class="caption">{session ? "In today's session." : "In the plan: it is there when you tap Start."}</span>
      <button type="button" class="clay press btn-sm t-pink" onClick={() => (session ? navigate("session", session.id) : plan && openPlan(plan.id))}>
        Open
      </button>
    </div>
  );
  const programDone = (
    <div class="l-row l-between l-gap-8" data-testid="coach-exercise-program-added">
      <span class="caption">Added to Me → Program → Drafts.</span>
      <button type="button" class="clay press btn-sm t-pink" onClick={() => navigate("program")}>
        Open
      </button>
    </div>
  );
  const choices = [
    { key: "session", done: inSession, shown: dayKnown, line: sessionDone, label: "Only this session", testid: "coach-exercise-session", run: addSession },
    { key: "program", done: inDrafts, shown: true, line: programDone, label: "Whole program", testid: "coach-exercise-program", run: addProgram },
  ].filter((c) => c.shown);
  if (result.prefer === "program") choices.reverse();
  const open = choices.filter((c) => !c.done);

  return (
    <section class="card l-col l-gap-10" data-testid="coach-exercise-change" data-prefer={result.prefer ?? "none"}>
      <h2 class="card__title l-m0">
        {result.day.name}: + {x.name}
      </h2>
      <ul class="list-plain">
        <li class="list-row" data-testid="coach-exercise-row" data-ex={x.exercise_id}>
          <span class="list-row__text">
            <span class="t-title">{x.name}</span>
            <span class="list-row__note num">
              {fmtNum(x.sets)} × {repsText(x)}
              {place}
            </span>
            <span class="caption">{x.rule}</span>
          </span>
          {x.weight != null ? (
            // No history, no weight: the rule line under the name says to enter it (Payam, 2026-10-16).
            <span class="list-row__value t-title num" data-testid="coach-exercise-weight">
              {fmtNum(x.weight)} {x.weight_unit}
            </span>
          ) : null}
        </li>
      </ul>
      {result.notes.length ? (
        // Only what this change causes, as information: neither button is ever blocked.
        <section class="callout" data-bad="false" data-testid="coach-exercise-notes">
          <h2 class="card__title l-m0">Worth knowing</h2>
          <ul class="prose-list ex-card__meta">
            {result.notes.map((n) => (
              <li>{n}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {choices.filter((c) => c.done).map((c) => c.line)}
      {open.length ? (
        <div class="l-row l-gap-8">
          {open.map((c, i) => (
            <button type="button" class={`clay press btn l-grow ${i === 0 ? "t-pink" : "t-muted"}`} data-testid={c.testid} disabled={busy} onClick={() => void c.run()}>
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
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
    case "get_volume":
      return <VolumeCard result={result as Volume} />;
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
      if (!asked(input)) return null;
      const r = result as Program;
      return (
        <DataCard title={r.name} sub={`${fmtNum(r.days_per_week)} days a week`} testid={name}>
          <DaysList days={r.days} />
        </DataCard>
      );
    }
    case "get_library": {
      if (!asked(input)) return null;
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
      if (!asked(input)) return null;
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
    case "get_training_pattern": {
      const r = result as Pattern;
      return (
        <DataCard title="Training days" sub={`${dayMonth(r.from)} – ${dayMonth(r.to)}`} testid={name}>
          <span class="t-title num">{r.summary}</span>
          {r.weekdays.length ? (
            <table class="data-table num">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Weeks of 4</th>
                  <th scope="col">Sessions</th>
                </tr>
              </thead>
              <tbody>
                {r.weekdays.map((w) => (
                  <tr>
                    <td>{w.day}</td>
                    <td>{fmtNum(w.weeks)}</td>
                    <td>{fmtNum(w.sessions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="state l-m0">No sessions in the last 4 weeks.</p>
          )}
          {r.max_days_in_a_row ? <span class="caption num">Longest run: {plural(r.max_days_in_a_row, "day")} in a row</span> : null}
          {r.program_days.length ? <span class="caption">{r.program_days.map((p) => `${p.day}: usually ${p.usual_weekday}`).join(" · ")}</span> : null}
        </DataCard>
      );
    }
    case "get_calendar": {
      const r = result as CalendarResult;
      const dates = [...new Set([...r.shifts, ...r.plans, ...r.sessions].map((x) => x.date))].sort();
      return (
        <DataCard title="Calendar" sub={`${dayMonth(r.from)} – ${dayMonth(r.to)}`} testid={name} source={false}>
          {dates.length ? (
            <table class="data-table data-table--text num">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Work</th>
                  <th scope="col">Gym</th>
                </tr>
              </thead>
              <tbody>
                {dates.map((d) => (
                  <tr>
                    <td>{dateShort(d)}</td>
                    <td>{r.shifts.filter((x) => x.date === d).map((x) => `${x.start}–${x.end}`).join(", ")}</td>
                    <td>
                      {[...r.sessions.filter((x) => x.date === d).map((x) => `${x.start} ${x.status === "active" ? "in progress" : "done"}`), ...r.plans.filter((x) => x.date === d && x.status !== "done").map((x) => `${x.start} ${x.status}`)].join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="state l-m0">Nothing on the calendar for these days.</p>
          )}
        </DataCard>
      );
    }
    case "find_free_slots": {
      const r = result as SlotsResult;
      return (
        <DataCard title="Free times" sub={`${dayMonth(r.week_start)} – ${dayMonth(r.week_end)}`} testid={name} source={false}>
          {r.slots.length ? (
            <table class="data-table data-table--text num">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Time</th>
                  <th scope="col">Session</th>
                </tr>
              </thead>
              <tbody>
                {r.slots.map((x) => (
                  <tr>
                    <td>{dateShort(x.date)}</td>
                    <td>
                      {x.start}–{x.end}
                    </td>
                    <td>{x.selected ? x.day : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="state l-m0">No time fits a session this week.</p>
          )}
          <span class="caption">Times from the app's free-time finder</span>
        </DataCard>
      );
    }
    case "propose_schedule":
      return <ScheduleCard result={result as Schedule} />;
    case "propose_exercise":
      return <ExerciseCard result={result as ExerciseChange} messageId={messageId} toolUseId={toolUseId} onAdd={onAdd} />;
    case "propose_session_additions":
      return <AdditionsCard result={result as Additions} />;
    case "propose_program":
      return <DraftCard input={input as Draft} result={result as DraftResult} messageId={messageId} toolUseId={toolUseId} onChange={onChange} onAdd={onAdd} />;
    default:
      return null;
  }
}


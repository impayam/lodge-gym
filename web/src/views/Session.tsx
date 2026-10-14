// Session screen (SPEC §7, SPEC-v8 §6.02). An active session is full screen on the session background: one exercise at a
// time (Prev / "Next: <exercise>" and a swipe on the card), the set's weight and reps open a sheet, RIR under the current
// set, the session's other tools in the More sheet, effort in the chip, bar, glow and accents. A finished session
// (opened from History) lists all its exercises. Every change autosaves.

import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { localHM } from "../../../worker/lib/time";
import type { HealthWorkout, SetEntry, Unit, WorkoutSession } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { restAfterGroupSet } from "../../../worker/lib/plan";
import { groupKind, PlanList } from "../components/PlanList";
import { IconBack, IconCheck, IconChevron, IconMore, IconPlay, IconPlus, IconProgram } from "../components/PulseIcons";
import { Sheet } from "../components/Sheet";
import { Stepper } from "../components/Stepper";
import { SyncStatus } from "../components/SyncStatus";
import { clock, dateShort, fmtNum, hm, minutesBetween, ytLink } from "../format";
import { effortColor, effortLabel } from "../lib/effort";
import { dayTitle } from "../lib/lifts";
import { cardIndex, cardSwipeOutcome, currentSetIndex, sessionEffort } from "../lib/session";
import { effortStops } from "../lib/tokens";
import { dayInfo, guidance, planForSession, retime, sessionBlocks, sessionPlan, type ExerciseBlock, type Guidance } from "../model";
import {
  addExtraExercise,
  allExercises,
  flash,
  getState,
  navigate,
  openPhotos,
  openReport,
  photoSrc,
  removeExtraExercise,
  removeSession,
  removeSessionExercise,
  saveBodyMass,
  savePlan,
  saveSession,
  startRest,
  stopRest,
  useStore,
} from "../store";
import { ExercisePicker } from "./Library";
import { poseLabel } from "./Photos";
import { rirText, targetText } from "./Program";
import { WatchStats, workoutTypeName } from "./Watch";

function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen");
        if (cancelled) void lock?.release();
      } catch {
        /* rejection is tolerated silently (SPEC §3) */
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => undefined);
    };
  }, [enabled]);
}

function Elapsed({ from }: { from: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = (now - Date.parse(from)) / 1000;
  return <span data-testid="elapsed">{sec < 86_400 ? clock(sec) : "–"}</span>;
}

/** The exercise each session's card showed last, so leaving and reopening the session keeps it. */
const shownExercise = new Map<string, string>();

type SheetState = { kind: "set"; exerciseId: string; set: number } | { kind: "more" } | { kind: "delete" } | null;

export function Session({ id }: { id: string }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const s = sessions[id];
  const [sheet, setSheet] = useState<SheetState>(null);
  const [picking, setPicking] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [, setShown] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  // The card changed by Prev / Next, a swipe or a superset round: focus follows it to the new exercise's title.
  const moved = useRef(false);
  useStore((st) => st.library);
  const plans = useStore((st) => st.plans);
  const photos = useStore((st) => st.photos);
  const resting = useStore((st) => st.rest !== null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [note, setNote] = useState(s?.note ?? "");
  useWakeLock(s?.status === "active");

  useEffect(() => {
    if (!s) navigate("home");
  }, [s]);
  if (!s) return null;

  const active = s.status === "active";
  const tz = boot.settings.timezone;
  const day = dayInfo(boot, s.program_day_id);
  const watch = (boot.watch ?? []).filter((w) => w.matched_session_id === s.id).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const exMap = allExercises();
  const plan = sessionPlan(plans, s.id);
  const blocks = sessionBlocks(boot, s, exMap, plan);
  const sessionPhotos = photos.filter((p) => p.session_id === s.id);
  const startHM = localHM(tz, s.started_at);
  const endHM = s.ended_at ? localHM(tz, s.ended_at) : "";
  const effort = sessionEffort(s.sets);
  const vars = { "--effort": effortColor(effort.e, effortStops()), "--e": String(effort.e) };

  // The card keeps its exercise; the first time it opens on the first exercise with a set left.
  const idx = cardIndex(
    blocks.map((b) => ({ id: b.ex.id, sets: b.sets })),
    shownExercise.get(id) ?? null
  );
  const cur = blocks[idx] ?? null;
  if (cur) shownExercise.set(id, cur.ex.id);
  const show = (i: number) => {
    const b = blocks[i];
    if (!b) return;
    shownExercise.set(id, b.ex.id);
    moved.current = true;
    setShown(b.ex.id);
    setSaid(`Exercise ${i + 1} of ${blocks.length}: ${b.ex.name_en}`);
  };

  const update = (mut: (x: WorkoutSession) => WorkoutSession) => {
    const now = getState().sessions[id];
    if (now) void saveSession(mut(now));
  };
  const updateSets = (exerciseId: string, fn: (sets: SetEntry[]) => SetEntry[]) =>
    update((x) => {
      const mine = x.sets.filter((z) => z.exercise_id === exerciseId).sort((a, b) => a.set_index - b.set_index);
      const others = x.sets.filter((z) => z.exercise_id !== exerciseId);
      const now = new Date().toISOString();
      const next = fn(mine).map((z, i) => ({ ...z, set_index: i }));
      const before = new Map(mine.map((z) => [z.id, z]));
      const stamped = next.map((z) => {
        const b = before.get(z.id);
        const changed = !b || b.weight !== z.weight || b.reps !== z.reps || b.seconds !== z.seconds || b.done !== z.done || b.set_index !== z.set_index;
        return changed ? { ...z, updated_at: now } : z;
      });
      return { ...x, sets: [...others, ...stamped] };
    });

  /**
   * Rest after a checked set (SPEC-v3 M9c). In a superset or tri-set a round is set i of each member: no timer inside
   * the round (the card moves to the next member), the group's rest after its last set; a member's extra sets beyond
   * the others' counts are done alone with their own rest.
   */
  const restAfterSet = (b: ExerciseBlock, i: number) => {
    const g = b.group;
    if (!g) return startRest(b.plan.rest_sec, `Rest after ${b.ex.name_en}`);
    const members = blocks.filter((x) => x.group?.tag === g.tag);
    const done = members.map((m) => m.sets.map((x, j) => (m.ex.id === b.ex.id && j === i ? true : x.done)));
    const rest = restAfterGroupSet(done, i, g.rest, b.plan.rest_sec);
    if (rest === null) {
      const k = members.findIndex((m) => m.ex.id === b.ex.id);
      const next = [...members.slice(k + 1), ...members.slice(0, k)].find((m) => m.sets[i] && !m.sets[i].done);
      if (next) show(blocks.indexOf(next));
      return;
    }
    const round = done.filter((d) => d.length > i).length >= 2;
    startRest(rest, round ? `Rest after ${groupKind(g.size)} ${g.tag}` : `Rest after ${b.ex.name_en}`);
  };

  const removeExercise = async (exerciseId: string, name: string) => {
    if (!(await removeSessionExercise(s.id, exerciseId))) flash(`${name} has done sets. Uncheck them first; history is never removed silently.`);
  };

  // SPEC-v3 M9a: the report screen opens (with the progress-photo prompt); the report is written once the session syncs.
  const finish = () => {
    stopRest();
    update((x) => ({ ...x, status: "done", ended_at: new Date().toISOString() }));
    flash("Session saved.");
    openReport(s.id, true);
  };
  const leave = () => navigate(getState().tab);
  const saveNote = (v: string) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    if (v !== getState().sessions[id]?.note) update((x) => ({ ...x, note: v }));
  };

  if (picking)
    return (
      <ExercisePicker
        sessionId={s.id}
        onCancel={() => setPicking(false)}
        onPick={(ex) => {
          setPicking(false);
          // The card shows the new exercise once it is in the session.
          void addExtraExercise(s.id, ex).then(() => {
            shownExercise.set(id, ex.id);
            setShown(ex.id);
          });
        }}
      />
    );

  if (arranging && active)
    return (
      <div class="page page--session" style={vars} data-testid="arrange-panel">
        <div class="session-glow" aria-hidden="true" />
        <header class="screen-head">
          <div class="l-col l-grow">
            <h1 class="screen-head__title l-m0">Reorder and group</h1>
            <span class="screen-head__sub">{dayTitle(day.name_en)}</span>
          </div>
          <button type="button" class="clay press btn t-pink" onClick={() => setArranging(false)}>
            Done
          </button>
        </header>
        <p class="ex-card__cue">Drag or use the arrows to reorder. Select 2 or 3 exercises to group them. An exercise with done sets can't be removed.</p>
        <div class="legacy legacy--overlay">
          <div class="stack">
            <PlanList
              plan={planForSession(boot, s, plan, exMap, new Date().toISOString())}
              exMap={exMap}
              mode="session"
              onChange={(next) => void savePlan(next)}
              progress={(eid) => {
                const mine = s.sets.filter((x) => x.exercise_id === eid);
                return `${mine.filter((x) => x.done).length} of ${mine.length} sets done`;
              }}
              onRemove={(it) => void removeExercise(it.exercise_id, exMap.get(it.exercise_id)?.name_en ?? it.exercise_id)}
            />
          </div>
        </div>
      </div>
    );

  const card = (b: ExerciseBlock, i: number, current: boolean) => (
    <ExerciseCard
      key={b.ex.id}
      block={b}
      n={i + 1}
      total={blocks.length}
      session={s}
      g={guidance(b, s, sessions)}
      current={current}
      updateSets={(fn) => updateSets(b.ex.id, fn)}
      onSetDone={(k) => restAfterSet(b, k)}
      onEdit={(k) => setSheet({ kind: "set", exerciseId: b.ex.id, set: k })}
    />
  );
  const next = blocks[idx + 1] ?? null;
  const editing = sheet?.kind === "set" ? (blocks.find((b) => b.ex.id === sheet.exerciseId) ?? null) : null;
  const minutes = minutesBetween(s.started_at, s.ended_at);

  return (
    <>
      <div class="page page--session" style={vars} inert={sheet !== null} data-resting={resting ? "true" : "false"} data-testid="session">
        <div class="session-glow" aria-hidden="true" />
        <header class="screen-head">
          <button type="button" class="clay press btn-icon t-muted" aria-label="Back" onClick={leave}>
            <IconBack size={20} />
          </button>
          <div class="l-col l-grow">
            <h1 class="screen-head__title l-m0">{dayTitle(day.name_en)}</h1>
            <span class="screen-head__sub num">
              {active ? (
                <>
                  <Elapsed from={s.started_at} /> elapsed
                </>
              ) : (
                `${dateShort(s.local_date)}${minutes != null ? ` · ${fmtNum(minutes)} min` : ""}`
              )}
            </span>
          </div>
          {active ? (
            <>
              <span class="effort-chip" data-testid="effort-chip">
                {effortLabel(effort.e)}
              </span>
              <button type="button" class="clay press btn t-effort" onClick={finish} data-testid="finish">
                Finish
              </button>
            </>
          ) : (
            <>
              <button type="button" class="clay press btn t-pink" data-testid="open-report" onClick={() => openReport(s.id)}>
                Report
              </button>
              <button type="button" class="clay press btn-icon t-muted" aria-label="More" aria-haspopup="dialog" data-testid="more" onClick={() => setSheet({ kind: "more" })}>
                <IconMore />
              </button>
            </>
          )}
        </header>
        {active ? (
          <div
            class="effort-bar"
            role="progressbar"
            aria-label="Session effort"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(effort.e * 100)}
            aria-valuetext={`${fmtNum(effort.done)} of ${fmtNum(effort.planned)} sets done`}
            data-testid="effort-bar"
          >
            <span class="effort-bar__fill" />
          </div>
        ) : null}

        <main class="l-col l-gap-12">
          {active ? (
            cur ? (
              <SwipeCard key={cur.ex.id} focus={moved.current} canPrev={idx > 0} canNext={next !== null} onSwipe={(dir) => show(dir === "next" ? idx + 1 : idx - 1)}>
                {card(cur, idx, true)}
              </SwipeCard>
            ) : (
              <div class="state card card--session">
                <span>No exercises in this session yet.</span>
                <button type="button" class="clay press btn t-pink" data-testid="add-exercise" onClick={() => setPicking(true)}>
                  + Add exercise
                </button>
              </div>
            )
          ) : (
            <>
              {blocks.map((b, i) => card(b, i, false))}
              {watch.length ? <WatchCard watch={watch} session={s} tz={tz} cls="card card--session" /> : null}
              {sessionPhotos.length ? (
                <section class="card card--session l-gap-12" data-testid="session-photos">
                  <h2 class="t-title l-m0">Photos</h2>
                  <div class="l-grid-4 l-gap-8">
                    {sessionPhotos.map((p) => (
                      <button type="button" class="photo-thumb press" aria-label={`${poseLabel(p.pose)} photo`} onClick={() => openPhotos({ open: p.id })}>
                        <span class="photo-thumb__frame well">
                          <img src={photoSrc(p, "thumb")} alt="" loading="lazy" />
                        </span>
                        <span>{poseLabel(p.pose)}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          )}
        </main>

        {active ? (
          <footer class="session-foot">
            <button type="button" class="clay press btn-icon btn-icon--lg t-muted" aria-label="Previous exercise" data-testid="prev" disabled={idx <= 0} onClick={() => show(idx - 1)}>
              <IconBack size={20} />
            </button>
            <button type="button" class="clay press btn-lg t-effort" data-testid="next" disabled={next === null} onClick={() => show(idx + 1)}>
              {next ? `Next: ${next.ex.name_en}` : "Last exercise"}
            </button>
            <button type="button" class="clay press btn-icon btn-icon--lg t-muted" aria-label="More" aria-haspopup="dialog" data-testid="more" onClick={() => setSheet({ kind: "more" })}>
              <IconMore />
            </button>
          </footer>
        ) : null}
        <span class="l-sr" role="status">
          {said}
        </span>
      </div>

      <Sheet open={sheet?.kind === "set" && editing !== null} onClose={() => setSheet(null)} title={editing?.ex.name_en ?? ""} sub={editing && sheet?.kind === "set" ? `Set ${sheet.set + 1} of ${editing.sets.length}` : undefined} testId="set-sheet">
        {editing && sheet?.kind === "set" ? (
          <SetEditor block={editing} i={sheet.set} session={s} g={guidance(editing, s, sessions)} updateSets={(fn) => updateSets(editing.ex.id, fn)} onDone={() => setSheet(null)} />
        ) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "more"} onClose={() => setSheet(null)} title={active ? "Session" : "Session details"} sub={dateShort(s.local_date)} testId="more-sheet">
        <div class="l-col l-gap-12">
          <SyncStatus />
          <div class="card card--list">
            <button
              type="button"
              class="list-row press"
              data-testid="add-exercise"
              onClick={() => {
                setSheet(null);
                setPicking(true);
              }}
            >
              <span class="well icon-well t-pink">
                <IconPlus size={18} />
              </span>
              <span class="list-row__text">
                <span class="t-title">Add exercise</span>
                <span class="caption">To this session only</span>
              </span>
              <span class="list-row__chevron">
                <IconChevron size={16} />
              </span>
            </button>
            {active && blocks.length ? (
              <button
                type="button"
                class="list-row press"
                data-testid="arrange"
                onClick={() => {
                  setSheet(null);
                  setArranging(true);
                }}
              >
                <span class="well icon-well t-orange">
                  <IconProgram size={18} />
                </span>
                <span class="list-row__text">
                  <span class="t-title">Reorder / group</span>
                  <span class="caption">Supersets and tri-sets</span>
                </span>
                <span class="list-row__chevron">
                  <IconChevron size={16} />
                </span>
              </button>
            ) : null}
          </div>
          <div class="form-field">
            <label class="form-field__label" for="f-note">
              Note
            </label>
            <textarea
              id="f-note"
              class="input"
              placeholder="How you felt today, any pain, anything to remember…"
              value={note}
              onInput={(e) => {
                const v = (e.currentTarget as HTMLTextAreaElement).value;
                setNote(v);
                if (noteTimer.current) clearTimeout(noteTimer.current);
                noteTimer.current = setTimeout(() => update((x) => ({ ...x, note: v })), 500);
              }}
              onBlur={() => saveNote(note)}
            />
          </div>
          <BodyWeight session={s} />
          <div class="form-field">
            <label class="form-field__label" for="f-date">
              Date
            </label>
            <input
              id="f-date"
              class="input"
              type="date"
              value={s.local_date}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                if (v) update((x) => retime(x, tz, v, startHM, endHM || null));
              }}
            />
          </div>
          <div class="l-grid-2 l-gap-8">
            <div class="form-field">
              <label class="form-field__label" for="f-start">
                Start
              </label>
              <input
                id="f-start"
                class="input"
                type="time"
                value={startHM}
                onChange={(e) => {
                  const v = (e.currentTarget as HTMLInputElement).value;
                  if (v) update((x) => retime(x, tz, x.local_date, v, endHM || null));
                }}
              />
            </div>
            <div class="form-field">
              <label class="form-field__label" for="f-end">
                End
              </label>
              <input
                id="f-end"
                class="input"
                type="time"
                value={endHM}
                onChange={(e) => {
                  const v = (e.currentTarget as HTMLInputElement).value;
                  update((x) => retime(x, tz, x.local_date, startHM, v || null));
                }}
              />
            </div>
          </div>
          <div class="l-row l-between l-gap-12">
            <span class="t-title" id="unit-label">
              Weight unit
            </span>
            <span class="segmented" role="group" aria-labelledby="unit-label" data-testid="unit">
              {(["lb", "kg"] as Unit[]).map((u) => (
                <button type="button" class="press" aria-pressed={s.unit === u} onClick={() => update((x) => ({ ...x, unit: u }))}>
                  {u}
                </button>
              ))}
            </span>
          </div>
          {active && watch.length ? <WatchCard watch={watch} session={s} tz={tz} cls="card" /> : null}
          <button type="button" class="clay press btn t-danger" onClick={() => setSheet({ kind: "delete" })}>
            Delete session
          </button>
        </div>
      </Sheet>

      <Sheet open={sheet?.kind === "delete"} onClose={() => setSheet({ kind: "more" })} role="alertdialog" title="Delete this session permanently?" testId="delete-sheet">
        <div class="l-col l-gap-8">
          <button
            type="button"
            class="clay press btn-lg t-danger"
            onClick={() => {
              stopRest();
              setSheet(null);
              shownExercise.delete(s.id);
              void removeSession(s.id);
              navigate(getState().tab);
            }}
          >
            Yes, delete
          </button>
          <button type="button" class="clay press btn t-muted" onClick={() => setSheet({ kind: "more" })}>
            No
          </button>
        </div>
      </Sheet>
    </>
  );
}

/** The session's body weight (optional, for the reports), in the session's unit. */
function BodyWeight({ session: s }: { session: WorkoutSession }) {
  const boot = useStore((st) => st.boot)!;
  const manualBody = (boot.body ?? []).filter((m) => m.kind === "body_mass" && m.source === "manual");
  const bodyToday = manualBody.find((m) => m.local_date === s.local_date) ?? null;
  const lastBody = [...manualBody].reverse().find((m) => m.unit === s.unit)?.value ?? null;
  return (
    <div class="form-field">
      <span class="form-field__label" aria-hidden="true">
        Body weight today ({s.unit}), optional, saved for the reports
      </span>
      <Stepper
        pulse
        value={bodyToday?.unit === s.unit || !bodyToday ? (bodyToday?.value ?? null) : null}
        placeholder={bodyToday && bodyToday.unit !== s.unit ? `${fmtNum(bodyToday.value)} ${bodyToday.unit}` : "–"}
        base={lastBody ?? 0}
        step={0.1}
        min={0}
        label={`Body weight (${s.unit})`}
        testId="body-weight"
        onChange={(v) => void saveBodyMass(s.local_date, v, s.unit)}
      />
    </div>
  );
}

function WatchCard({ watch, session, tz, cls }: { watch: HealthWorkout[]; session: WorkoutSession; tz: string; cls: string }) {
  return (
    <section class={`${cls} l-col l-gap-8`} data-testid="session-watch">
      <h2 class="t-title l-m0">Apple Watch</h2>
      {watch.map((w) => (
        <div class="l-col l-gap-2">
          <span class="ex-card__meta">
            {w.kind === "session" ? (
              "During the session"
            ) : (
              <>
                {workoutTypeName(w.activity_type)} ·{" "}
                <span class="num">
                  {hm(w.started_at, tz)}
                  {w.ended_at ? `–${hm(w.ended_at, tz)}` : ""}
                </span>
              </>
            )}
          </span>
          <WatchStats w={w} session={session} />
        </div>
      ))}
    </section>
  );
}

/**
 * The active session's exercise card: a horizontal drag follows the finger; past 35% of the width or a flick it slides
 * out and the next (left) or previous (right) exercise shows, otherwise it springs back. A drag is never a tap.
 */
function SwipeCard({
  focus,
  canPrev,
  canNext,
  onSwipe,
  children,
}: {
  /** Move focus to the card's title when it mounts, unless a control outside the card (Next, Prev) keeps it. */
  focus: boolean;
  canPrev: boolean;
  canNext: boolean;
  onSwipe: (dir: "next" | "prev") => void;
  children: preact.ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef({ canPrev, canNext, onSwipe });
  live.current = { canPrev, canNext, onSwipe };

  useEffect(() => {
    const a = document.activeElement;
    if (focus && (a === null || a === document.body)) ref.current?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const el = ref.current!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let pointer: number | null = null;
    let mode: "pending" | "drag" | null = null;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let suppressClick = false;

    const down = (e: PointerEvent) => {
      if (!e.isPrimary || pointer !== null) return;
      pointer = e.pointerId;
      mode = "pending";
      x0 = lastX = e.clientX;
      y0 = e.clientY;
      lastT = e.timeStamp;
      dx = velocity = 0;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer || !mode) return;
      const mx = e.clientX - x0;
      const my = e.clientY - y0;
      if (mode === "pending") {
        if (Math.hypot(mx, my) < 8) return;
        if (Math.abs(my) > Math.abs(mx)) {
          pointer = null;
          mode = null;
          return;
        }
        mode = "drag";
        el.dataset.dragging = "true";
        el.setPointerCapture(e.pointerId);
      }
      const { canPrev: p, canNext: n } = live.current;
      // Toward an end with no exercise the card resists.
      dx = (mx > 0 && !p) || (mx < 0 && !n) ? mx / 3 : mx;
      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (e.clientX - lastX) / dt;
      lastX = e.clientX;
      lastT = e.timeStamp;
      el.style.transform = `translateX(${dx}px)`;
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const dragged = mode === "drag";
      pointer = null;
      mode = null;
      if (!dragged) return;
      suppressClick = true;
      window.setTimeout(() => (suppressClick = false), 0);
      el.dataset.dragging = "false";
      const { canPrev: p, canNext: n, onSwipe: go } = live.current;
      const outcome = e.type === "pointercancel" ? "cancel" : cardSwipeOutcome(dx, el.clientWidth, velocity, p, n);
      if (outcome === "cancel") {
        el.style.transform = "";
        return;
      }
      if (reduce.matches) {
        el.style.transform = "";
        return go(outcome);
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        go(outcome);
      };
      el.addEventListener("transitionend", finish, { once: true });
      window.setTimeout(finish, 450);
      el.style.transform = `translateX(${outcome === "next" ? "-110%" : "110%"})`;
    };
    const click = (e: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // A native drag (the form-video link under the finger) would cancel the swipe; nothing in the card is dragged.
    const nativeDrag = (e: DragEvent) => e.preventDefault();
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", click, true);
    el.addEventListener("dragstart", nativeDrag);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("click", click, true);
      el.removeEventListener("dragstart", nativeDrag);
    };
  }, []);

  return (
    <div ref={ref} class="swipe" data-testid="swipe-card">
      {children}
    </div>
  );
}

function lastText(g: Guidance, isTime: boolean): string {
  if (!g.last) return "";
  const parts = g.last.sets
    .filter((x) => x.reps != null || x.weight != null || x.seconds != null)
    .map((x) => (isTime ? `${fmtNum(x.seconds)} s` : (x.weight != null ? fmtNum(x.weight) + "×" : "") + fmtNum(x.reps)));
  return parts.join(", ") + (isTime ? "" : ` ${g.last.unit}`);
}

function suggestionText(g: Guidance): string {
  const sg = g.suggestion;
  if (sg.kind === "weight")
    return sg.allHit
      ? `Suggested: ${fmtNum(sg.weight)} ${sg.unit}${sg.easy ? " (two steps: every set had 3+ reps in reserve)" : ""}`
      : `Stay at ${fmtNum(sg.weight)} ${sg.unit} until every set is complete`;
  if (sg.kind === "bodyweight") return sg.allHit ? (sg.easy ? "Two more reps, or less assistance" : "One more rep, or less assistance") : "Same as last time";
  if (sg.kind === "time") return sg.allHit ? `Target: ${fmtNum(sg.seconds)} s` : "Same time";
  return "";
}

const RIR_CHOICES: [number, string][] = [
  [0, "0"],
  [1, "1"],
  [2, "2"],
  [3, "3+"],
];

/** Labels of a card's weight and reps (long for the sheet and screen readers, short for the column heads). */
function fieldLabels(block: ExerciseBlock, unit: Unit) {
  const { ex, plan } = block;
  const isBw = ex.equipment === "bodyweight";
  const isDb = ex.equipment === "dumbbell";
  return {
    weight: isBw ? `Added/assist (${unit})` : isDb ? `Per dumbbell (${unit})` : `Weight (${unit})`,
    weightHead: isBw ? `Added ${unit}` : isDb ? `Per dumbbell ${unit}` : `Weight ${unit}`,
    reps: plan.is_time ? "Seconds" : plan.per_leg ? "Reps per leg" : "Reps",
  };
}

/** What a set shows before anything is entered: the suggestion (prefilled when the set is checked). */
function setDefaults(block: ExerciseBlock, g: Guidance) {
  const { plan, extra, ex } = block;
  return {
    weight: g.prefillWeight,
    weightText: g.prefillWeight != null ? fmtNum(g.prefillWeight) : ex.equipment === "bodyweight" ? "0" : "–",
    reps: extra ? null : plan.reps_max,
    seconds: g.prefillSeconds ?? plan.reps_max,
  };
}

function ExerciseCard({
  block,
  n,
  total,
  session,
  g,
  current,
  updateSets,
  onSetDone,
  onEdit,
}: {
  block: ExerciseBlock;
  n: number;
  total: number;
  session: WorkoutSession;
  g: Guidance;
  /** The active session's single card: the current set is highlighted and has the RIR chips. */
  current: boolean;
  updateSets: (fn: (sets: SetEntry[]) => SetEntry[]) => void;
  /** A set was checked in an active session: starts the rest timer (or, inside a group's round, moves on). */
  onSetDone: (setIndex: number) => void;
  onEdit: (setIndex: number) => void;
}) {
  const { ex, plan, sets, extra, group } = block;
  const isTime = plan.is_time;
  const labels = fieldLabels(block, session.unit);
  const defaults = setDefaults(block, g);
  const sgText = suggestionText(g);
  const lt = lastText(g, isTime);
  const now = current ? currentSetIndex(sets) : -1;
  // A finished session shows what was done: no first-time hint and no suggestion for a day already trained.
  const live = session.status === "active";
  const target = extra ? "" : [targetText(plan), rirText(plan)].filter(Boolean).join(" · ");

  const setField = (i: number, patch: Partial<SetEntry>) => updateSets((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const toggle = (i: number) => {
    const x = sets[i];
    const done = !x.done;
    const patch: Partial<SetEntry> = { done };
    if (done) {
      if (isTime) {
        if (x.seconds == null) patch.seconds = defaults.seconds;
      } else {
        if (x.reps == null && !extra) patch.reps = plan.reps_max;
        if (x.weight == null && g.prefillWeight != null) patch.weight = g.prefillWeight;
      }
    }
    setField(i, patch);
    if (done && session.status === "active") onSetDone(i);
  };

  const addSet = () =>
    updateSets((list) => {
      const prev = list[list.length - 1];
      return [
        ...list,
        {
          id: ulid(),
          exercise_id: ex.id,
          set_index: list.length,
          weight: prev ? prev.weight : null,
          reps: null,
          seconds: null,
          done: false,
          rir: null,
          ...(extra ? { is_extra: true, position: prev?.position ?? null } : {}),
          updated_at: new Date().toISOString(),
        },
      ];
    });
  // Only an undone set is removed: a done set is history and must be unchecked first (SPEC-v3 M9c).
  const lastUndone = sets.map((x) => x.done).lastIndexOf(false);
  const removeSet = () =>
    updateSets((list) => {
      const k = list.map((x) => x.done).lastIndexOf(false);
      return k < 0 ? list : list.filter((_, j) => j !== k);
    });
  const copyLast = () => {
    if (!g.last) return;
    const sameUnit = g.last.unit === session.unit;
    const src = g.last.sets;
    updateSets((list) =>
      src.map((x, i) => ({
        id: list[i]?.id ?? ulid(),
        exercise_id: ex.id,
        set_index: i,
        weight: sameUnit ? x.weight : (list[i]?.weight ?? null),
        reps: x.reps,
        seconds: x.seconds,
        done: false,
        rir: null,
        ...(extra ? { is_extra: true, position: list[0]?.position ?? null } : {}),
        updated_at: new Date().toISOString(),
      }))
    );
  };

  return (
    <article class={`card card--session${group ? " card--grouped" : ""}`} data-ex={ex.id} data-testid="ex-card" aria-labelledby={`ex-title-${ex.id}`}>
      <div class="l-row l-top l-gap-12">
        <div class="l-col l-gap-4 l-grow">
          <span class="ex-card__kicker num">
            Exercise {fmtNum(n)} of {fmtNum(total)}
            {plan.is_main ? " · Main lift" : ""}
            {extra ? " · Added today" : ""}
            {target ? (
              <>
                {" · "}
                <span data-testid="target">{target}</span>
              </>
            ) : null}
          </span>
          {group ? (
            <span class="ex-card__group num" data-testid={`sgroup-${group.tag}`}>
              {plan.superset_tag ?? `${group.tag}${group.index + 1}`} · {groupKind(group.size)} {group.tag} · rest {fmtNum(group.rest)} s after each round
            </span>
          ) : null}
          <h2 class="big-num big-num--36 l-m0" id={`ex-title-${ex.id}`} tabIndex={-1}>
            {ex.name_en}
          </h2>
          {g.last ? (
            <span class="ex-card__meta num" data-testid="last-perf">
              Last time {lt}
            </span>
          ) : live ? (
            <span class="ex-card__meta">{extra ? "Added to this session only; no target." : "First time: choose your weight."}</span>
          ) : null}
          {live && g.last && sgText ? (
            <span class="ex-card__suggest" data-testid="suggestion">
              {sgText}
            </span>
          ) : null}
        </div>
        <a class="btn-icon btn-icon--soft press" href={ytLink(ex.name_en)} target="_blank" rel="noopener noreferrer" aria-label={`Form video: ${ex.name_en}`} data-testid="form-video">
          <IconPlay />
        </a>
      </div>
      <div class="l-col l-gap-4">
        {sets.length ? null : <span class="ex-card__meta">No sets logged.</span>}
        <div class={`set-head${isTime ? " set-head--timed" : ""}`} aria-hidden="true" hidden={!sets.length}>
          <span>Set</span>
          {isTime ? null : <span>{labels.weightHead}</span>}
          <span>{labels.reps}</span>
          <span>Done</span>
        </div>
        {sets.map((x, i) => {
          const wSet = x.weight != null;
          const rVal = isTime ? x.seconds : x.reps;
          const rDefault = isTime ? defaults.seconds : defaults.reps;
          const rText = rVal != null ? fmtNum(rVal) : rDefault != null ? fmtNum(rDefault) : "–";
          return (
            <Fragment key={x.id}>
              <div class={`set-row${isTime ? " set-row--timed" : ""}${i === now ? " set-row--current" : ""}${x.done ? " set-row--done" : ""}`} data-set={`${ex.id}-${i}`}>
                <span class="set-row__n num">{fmtNum(i + 1)}</span>
                {isTime ? null : (
                  <button
                    type="button"
                    class="set-value press"
                    aria-haspopup="dialog"
                    aria-label={`${labels.weight}, set ${i + 1}: ${wSet ? fmtNum(x.weight) : defaults.weight != null ? `suggested ${defaults.weightText}` : "not entered"}`}
                    data-suggested={wSet ? "false" : "true"}
                    data-testid={`w-${ex.id}-${i}`}
                    onClick={() => onEdit(i)}
                  >
                    {wSet ? fmtNum(x.weight) : defaults.weightText}
                  </button>
                )}
                <button
                  type="button"
                  class="set-value press"
                  aria-haspopup="dialog"
                  aria-label={`${labels.reps}, set ${i + 1}: ${rVal != null ? fmtNum(rVal) : rDefault != null ? `target ${fmtNum(rDefault)}` : "not entered"}`}
                  data-suggested={rVal != null ? "false" : "true"}
                  data-testid={`${isTime ? "s" : "r"}-${ex.id}-${i}`}
                  onClick={() => onEdit(i)}
                >
                  {rText}
                </button>
                <button type="button" class="set-check press" aria-pressed={x.done} aria-label={`Set ${i + 1} done`} data-testid={`check-${ex.id}-${i}`} onClick={() => toggle(i)}>
                  {x.done ? <IconCheck /> : null}
                </button>
              </div>
              {i === now && !isTime ? (
                <div class="rir-row" role="group" aria-label={`Reps in reserve (RIR), set ${i + 1}`} data-testid={`rir-${ex.id}-${i}`}>
                  <span aria-hidden="true">RIR</span>
                  <span class="segmented">
                    {RIR_CHOICES.map(([v, label]) => (
                      <button type="button" class="press" aria-pressed={x.rir === v} onClick={() => setField(i, { rir: x.rir === v ? null : v })}>
                        {label}
                      </button>
                    ))}
                  </span>
                </div>
              ) : null}
            </Fragment>
          );
        })}
      </div>
      {ex.cue_en ? (
        <p class="ex-card__cue" data-testid="cue">
          {ex.cue_en}
        </p>
      ) : null}
      <div class="l-row l-wrap l-gap-8">
        <button type="button" class="clay press btn-sm t-muted" onClick={addSet}>
          + Add set
        </button>
        {lastUndone >= 0 ? (
          <button type="button" class="clay press btn-sm t-muted" onClick={removeSet}>
            − Remove set
          </button>
        ) : null}
        {g.last ? (
          <button type="button" class="clay press btn-sm t-muted" onClick={copyLast}>
            Same as last time
          </button>
        ) : null}
        {extra && !sets.some((x) => x.done) ? (
          <button type="button" class="clay press btn-sm t-muted" data-testid={`remove-${ex.id}`} onClick={() => void removeExtraExercise(session.id, ex.id)}>
            Remove exercise
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** The set sheet: weight and reps (or seconds) with −/+ and typing, and the set's RIR. Changes save as they happen. */
function SetEditor({
  block,
  i,
  session,
  g,
  updateSets,
  onDone,
}: {
  block: ExerciseBlock;
  i: number;
  session: WorkoutSession;
  g: Guidance;
  updateSets: (fn: (sets: SetEntry[]) => SetEntry[]) => void;
  onDone: () => void;
}) {
  const x = block.sets[i];
  if (!x) return null;
  const { ex, plan, extra } = block;
  const isTime = plan.is_time;
  const isBw = ex.equipment === "bodyweight";
  const labels = fieldLabels(block, session.unit);
  const defaults = setDefaults(block, g);
  const setField = (patch: Partial<SetEntry>) => updateSets((list) => list.map((z, j) => (j === i ? { ...z, ...patch } : z)));
  return (
    <div class="l-col l-gap-14">
      {isTime ? (
        <div class="form-field">
          <span class="form-field__label" aria-hidden="true">
            Seconds
          </span>
          <Stepper
            pulse
            value={x.seconds}
            placeholder={fmtNum(defaults.seconds)}
            base={defaults.seconds}
            step={5}
            min={0}
            decimals={false}
            label={`Seconds, set ${i + 1}`}
            testId="sheet-s"
            onChange={(v) => setField({ seconds: v })}
          />
        </div>
      ) : (
        <>
          <div class="form-field">
            <span class="form-field__label" aria-hidden="true">
              {labels.weight}
            </span>
            <Stepper
              pulse
              value={x.weight}
              placeholder={defaults.weightText}
              base={g.prefillWeight ?? 0}
              step={g.step}
              min={isBw ? undefined : 0}
              label={`${labels.weight}, set ${i + 1}`}
              testId="sheet-w"
              onChange={(v) => setField({ weight: v })}
            />
          </div>
          <div class="form-field">
            <span class="form-field__label" aria-hidden="true">
              {labels.reps}
            </span>
            <Stepper
              pulse
              value={x.reps}
              placeholder={extra ? "–" : fmtNum(plan.reps_max)}
              base={extra ? 0 : plan.reps_max}
              step={1}
              min={0}
              decimals={false}
              label={`${labels.reps}, set ${i + 1}`}
              testId="sheet-r"
              onChange={(v) => setField({ reps: v })}
            />
          </div>
          <div class="l-row l-between l-gap-12">
            <span class="form-field__label" id="sheet-rir-label">
              Reps in reserve (RIR)
            </span>
            <span class="segmented" role="group" aria-labelledby="sheet-rir-label" data-testid="sheet-rir">
              {RIR_CHOICES.map(([v, label]) => (
                <button type="button" class="press" aria-pressed={x.rir === v} onClick={() => setField({ rir: x.rir === v ? null : v })}>
                  {label}
                </button>
              ))}
            </span>
          </div>
        </>
      )}
      <button type="button" class="clay press btn-lg t-pink l-full" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

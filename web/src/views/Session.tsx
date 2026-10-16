// Session screen (SPEC §7, SPEC-v8 §6.02). An active session is full screen on the session background: one exercise at a
// time (Prev / "Next: <exercise>" and a swipe on the card), the set's weight and reps open a sheet, RIR under the current
// set, the session's other tools in the More sheet, effort in the chip, bar, glow and accents. A finished session
// (opened from History) lists all its exercises. Every change autosaves.

import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { localHM } from "../../../worker/lib/time";
import type { HealthWorkout, SetEntry, Unit, WorkoutSession } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { REST_DEFAULTS, restAfterSet as restRule, restLabel, roundRows, type RestUnit } from "../../../worker/lib/rest";
import { BodyWeight } from "../components/BodyWeight";
import { groupKind, PlanList } from "../components/PlanList";
import { IconBack, IconCheck, IconChevron, IconMore, IconPlay, IconPlus, IconProgram, IconSpark } from "../components/PulseIcons";
import { Sheet } from "../components/Sheet";
import { Stepper } from "../components/Stepper";
import { SyncStatus } from "../components/SyncStatus";
import { clock, dateShort, fmtNum, hm, minutesBetween, ytLink } from "../format";
import { effortColor, effortLabel } from "../lib/effort";
import { dayTitle } from "../lib/lifts";
import { cardIndex, cardSwipeOutcome, currentSetIndex, groupCurrent, sessionEffort, sessionUnits } from "../lib/session";
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
  savePlan,
  saveSession,
  startRest,
  stopRest,
  useStore,
} from "../store";
import { Coach } from "./Coach";
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

/** The card (exercise or group key) each session showed last, so leaving and reopening the session keeps it. */
const shownExercise = new Map<string, string>();

type Card = { key: string; blocks: ExerciseBlock[] };
/** A card's name: the exercise, or "Superset A". */
const unitName = (u: Card) => (u.blocks.length >= 2 ? `${groupKind(u.blocks.length)} ${u.blocks[0].group!.tag}` : u.blocks[0].ex.name_en);

type SheetState = { kind: "set"; exerciseId: string; set: number } | { kind: "more" } | { kind: "delete" } | { kind: "coach" } | null;

export function Session({ id }: { id: string }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const s = sessions[id];
  const [sheet, setSheet] = useState<SheetState>(null);
  const [picking, setPicking] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [, setShown] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  // The card changed by Prev / Next or a swipe: focus follows it to the new card's title.
  const moved = useRef(false);
  useStore((st) => st.library);
  const plans = useStore((st) => st.plans);
  const photos = useStore((st) => st.photos);
  const resting = useStore((st) => st.rest !== null);
  const online = useStore((st) => st.sync.online);
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
  // One card per exercise, one per superset or tri-set (Payam, 2026-10-16).
  const units: Card[] = sessionUnits(blocks);
  const sessionPhotos = photos.filter((p) => p.session_id === s.id);
  const startHM = localHM(tz, s.started_at);
  const endHM = s.ended_at ? localHM(tz, s.ended_at) : "";
  const effort = sessionEffort(s.sets);
  const vars = { "--effort": effortColor(effort.e, effortStops()), "--e": String(effort.e) };

  // The card keeps its exercise (or group); the first time it opens on the first card with a set left.
  const idx = cardIndex(
    units.map((u) => ({ id: u.key, sets: u.blocks.flatMap((b) => b.sets) })),
    shownExercise.get(id) ?? null
  );
  const cur = units[idx] ?? null;
  if (cur) shownExercise.set(id, cur.key);
  const show = (i: number) => {
    const u = units[i];
    if (!u) return;
    shownExercise.set(id, u.key);
    moved.current = true;
    setShown(u.key);
    setSaid(`Card ${i + 1} of ${units.length}: ${unitName(u)}`);
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
   * Rest after a checked set (Payam, 2026-10-16; worker/lib/rest.ts): the between-sets rest while the exercise has a
   * set left, the next-exercise rest after its last; a group rests by its own rest after each round and the
   * next-exercise rest after the last round, with no timer inside a round. The label says what comes next. Nothing
   * left: no timer.
   */
  const rules = {
    rest_between_sets_sec: boot.settings.rest_between_sets_sec ?? REST_DEFAULTS.rest_between_sets_sec,
    rest_next_exercise_sec: boot.settings.rest_next_exercise_sec ?? REST_DEFAULTS.rest_next_exercise_sec,
  };
  const restAfterSet = (b: ExerciseBlock, i: number) => {
    const at = units.findIndex((u) => u.blocks.some((x) => x.ex.id === b.ex.id));
    const restUnits: RestUnit[] = units.map((u) => ({
      members: u.blocks.map((m) => ({ id: m.ex.id, name: m.ex.name_en, done: m.sets.map((x, j) => (m.ex.id === b.ex.id && j === i ? true : x.done)) })),
      groupRest: u.blocks.length >= 2 ? (u.blocks[0].group?.rest ?? null) : null,
    }));
    const r = restRule(restUnits, at, b.ex.id, i, rules);
    if (r.kind === "rest") return startRest(r.seconds, restLabel(r.next));
    // Inside a round the rest is over: the next member's set is highlighted on the same card.
    stopRest();
    if (r.kind === "in_round") setSaid(`Next: ${exMap.get(r.exerciseId)?.name_en ?? ""}, set ${r.set + 1}`);
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
    );

  const card = (u: Card, current: boolean) => {
    const n = blocks.indexOf(u.blocks[0]) + 1;
    if (u.blocks.length >= 2)
      return (
        <GroupCard
          key={u.key}
          unit={u.blocks}
          n={n}
          total={blocks.length}
          session={s}
          gs={u.blocks.map((b) => guidance(b, s, sessions))}
          current={current}
          updateSets={updateSets}
          onSetDone={(b, k) => restAfterSet(b, k)}
          onEdit={(b, k) => setSheet({ kind: "set", exerciseId: b.ex.id, set: k })}
        />
      );
    const b = u.blocks[0];
    return (
      <ExerciseCard
        key={b.ex.id}
        block={b}
        n={n}
        total={blocks.length}
        session={s}
        g={guidance(b, s, sessions)}
        current={current}
        updateSets={(fn) => updateSets(b.ex.id, fn)}
        onSetDone={(k) => restAfterSet(b, k)}
        onEdit={(k) => setSheet({ kind: "set", exerciseId: b.ex.id, set: k })}
      />
    );
  };
  const next = units[idx + 1] ?? null;
  /** Ask Coach's context: this session and the exercise and set on the card (the group's next row). */
  const sessionRef = () => {
    const u = cur;
    if (!u) return { id: s.id, exercise_id: null, set: null };
    if (u.blocks.length >= 2) {
      const at = groupCurrent(u.blocks.map((b) => ({ id: b.ex.id, sets: b.sets })));
      return { id: s.id, exercise_id: at?.exerciseId ?? u.blocks[0].ex.id, set: at?.set ?? null };
    }
    const k = currentSetIndex(u.blocks[0].sets);
    return { id: s.id, exercise_id: u.blocks[0].ex.id, set: k >= 0 ? k : null };
  };
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
              <SwipeCard key={cur.key} focus={moved.current} canPrev={idx > 0} canNext={next !== null} onSwipe={(dir) => show(dir === "next" ? idx + 1 : idx - 1)}>
                {card(cur, true)}
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
              {units.map((u) => card(u, false))}
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
              {next ? `Next: ${unitName(next)}` : "Last exercise"}
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
            {active ? (
              // Payam, 2026-10-16: the coach in a sheet over the session; the session and its timer keep running.
              <button type="button" class="list-row press" data-testid="ask-coach" disabled={!online} onClick={() => setSheet({ kind: "coach" })}>
                <span class="well icon-well t-violet">
                  <IconSpark size={18} />
                </span>
                <span class="list-row__text">
                  <span class="t-title">Ask Coach</span>
                  <span class="caption" data-testid="ask-coach-note">
                    {online ? "About this session; the timer keeps running" : "Needs connection"}
                  </span>
                </span>
                <span class="list-row__chevron">
                  <IconChevron size={16} />
                </span>
              </button>
            ) : null}
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
          <BodyWeight date={s.local_date} unit={s.unit} label={`Body weight today (${s.unit}), optional, saved for the reports`} testId="body-weight" />
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

      <Sheet open={sheet?.kind === "coach"} onClose={() => setSheet(null)} title="Coach" sub={`${dayTitle(day.name_en)} · the session keeps running`} testId="coach-sheet">
        {sheet?.kind === "coach" ? <Coach inSession={{ session: sessionRef }} /> : null}
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

/** What a card's set controls do for one exercise: check (filling in the suggestion), add, remove, copy last time. */
function setActions(block: ExerciseBlock, g: Guidance, session: WorkoutSession, updateSets: (fn: (sets: SetEntry[]) => SetEntry[]) => void, onSetDone: (setIndex: number) => void) {
  const { ex, plan, sets, extra } = block;
  const isTime = plan.is_time;
  const defaults = setDefaults(block, g);
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
  return { defaults, setField, toggle, addSet, removeSet, copyLast, lastUndone };
}

type SetActions = ReturnType<typeof setActions>;

/**
 * One set's row: its number (or, on a group card, the member's label), weight and reps (or seconds), and the check.
 * `filler`: a timed exercise's row on a group card whose other members have weights keeps the weight column empty.
 */
function SetRow({ block, i, mark, who, session, act, current, filler, onEdit }: { block: ExerciseBlock; i: number; mark: string; who: string; session: WorkoutSession; act: SetActions; current: boolean; filler: boolean; onEdit: (setIndex: number) => void }) {
  const { ex, plan } = block;
  const x = block.sets[i];
  const isTime = plan.is_time;
  const labels = fieldLabels(block, session.unit);
  const { defaults } = act;
  const wSet = x.weight != null;
  const rVal = isTime ? x.seconds : x.reps;
  const rDefault = isTime ? defaults.seconds : defaults.reps;
  const rText = rVal != null ? fmtNum(rVal) : rDefault != null ? fmtNum(rDefault) : "–";
  return (
    <div class={`set-row${isTime && !filler ? " set-row--timed" : ""}${current ? " set-row--current" : ""}${x.done ? " set-row--done" : ""}`} data-set={`${ex.id}-${i}`}>
      <span class="set-row__n num">{mark}</span>
      {isTime ? (
        filler ? (
          <span aria-hidden="true" />
        ) : null
      ) : (
        <button
          type="button"
          class="set-value press"
          aria-haspopup="dialog"
          aria-label={`${labels.weight}, ${who}set ${i + 1}: ${wSet ? fmtNum(x.weight) : defaults.weight != null ? `suggested ${defaults.weightText}` : "not entered"}`}
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
        aria-label={`${labels.reps}, ${who}set ${i + 1}: ${rVal != null ? fmtNum(rVal) : rDefault != null ? `target ${fmtNum(rDefault)}` : "not entered"}`}
        data-suggested={rVal != null ? "false" : "true"}
        data-testid={`${isTime ? "s" : "r"}-${ex.id}-${i}`}
        onClick={() => onEdit(i)}
      >
        {rText}
      </button>
      <button type="button" class="set-check press" aria-pressed={x.done} aria-label={`${who ? who : ""}Set ${i + 1} done`} data-testid={`check-${ex.id}-${i}`} onClick={() => act.toggle(i)}>
        {x.done ? <IconCheck /> : null}
      </button>
    </div>
  );
}

/** Reps in reserve for the current set (not for timed holds). */
function RirRow({ block, i, who, act }: { block: ExerciseBlock; i: number; who: string; act: SetActions }) {
  const x = block.sets[i];
  return (
    <div class="rir-row" role="group" aria-label={`Reps in reserve (RIR), ${who}set ${i + 1}`} data-testid={`rir-${block.ex.id}-${i}`}>
      <span aria-hidden="true">RIR</span>
      <span class="segmented">
        {RIR_CHOICES.map(([v, label]) => (
          <button type="button" class="press" aria-pressed={x.rir === v} onClick={() => act.setField(i, { rir: x.rir === v ? null : v })}>
            {label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** + Add set, − Remove set, Same as last time and (an exercise added today without a done set) Remove exercise. */
function SetTools({ block, g, session, act }: { block: ExerciseBlock; g: Guidance; session: WorkoutSession; act: SetActions }) {
  const { ex, sets, extra } = block;
  return (
    <div class="l-row l-wrap l-gap-8">
      <button type="button" class="clay press btn-sm t-muted" data-testid={`add-set-${ex.id}`} onClick={act.addSet}>
        + Add set
      </button>
      {act.lastUndone >= 0 ? (
        <button type="button" class="clay press btn-sm t-muted" onClick={act.removeSet}>
          − Remove set
        </button>
      ) : null}
      {g.last ? (
        <button type="button" class="clay press btn-sm t-muted" onClick={act.copyLast}>
          Same as last time
        </button>
      ) : null}
      {extra && !sets.some((x) => x.done) ? (
        <button type="button" class="clay press btn-sm t-muted" data-testid={`remove-${ex.id}`} onClick={() => void removeExtraExercise(session.id, ex.id)}>
          Remove exercise
        </button>
      ) : null}
    </div>
  );
}

/** Last time and the suggestion, or the first-time hint, under an exercise's name. */
function GuidanceLines({ block, g, live }: { block: ExerciseBlock; g: Guidance; live: boolean }) {
  const sgText = suggestionText(g);
  return (
    <>
      {g.last ? (
        <span class="ex-card__meta num" data-testid="last-perf">
          Last time {lastText(g, block.plan.is_time)}
        </span>
      ) : live ? (
        <span class="ex-card__meta">{block.extra ? "Added to this session only; no target." : "First time: choose your weight."}</span>
      ) : null}
      {live && g.last && sgText ? (
        <span class="ex-card__suggest" data-testid="suggestion">
          {sgText}
        </span>
      ) : null}
    </>
  );
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
  /** A set was checked in an active session: starts the rest timer. */
  onSetDone: (setIndex: number) => void;
  onEdit: (setIndex: number) => void;
}) {
  const { ex, plan, sets, extra, group } = block;
  const isTime = plan.is_time;
  const labels = fieldLabels(block, session.unit);
  const act = setActions(block, g, session, updateSets, onSetDone);
  const now = current ? currentSetIndex(sets) : -1;
  // A finished session shows what was done: no first-time hint and no suggestion for a day already trained.
  const live = session.status === "active";
  const target = extra ? "" : [targetText(plan), rirText(plan)].filter(Boolean).join(" · ");

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
          <GuidanceLines block={block} g={g} live={live} />
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
        {sets.map((x, i) => (
          <Fragment key={x.id}>
            <SetRow block={block} i={i} mark={fmtNum(i + 1)} who="" session={session} act={act} current={i === now} filler={false} onEdit={onEdit} />
            {i === now && !isTime ? <RirRow block={block} i={i} who="" act={act} /> : null}
          </Fragment>
        ))}
      </div>
      {ex.cue_en ? (
        <p class="ex-card__cue" data-testid="cue">
          {ex.cue_en}
        </p>
      ) : null}
      <SetTools block={block} g={g} session={session} act={act} />
    </article>
  );
}

/**
 * A superset or tri-set on one card (Payam, 2026-10-16): each member's name, Last time, suggestion, target, form video,
 * cue and tools, and the sets round by round (set 1 of each member, then set 2 …; a member's extra sets are rounds of
 * their own at the end). The current row has the RIR chips. No timer inside a round; the group's rest after it.
 */
function GroupCard({
  unit,
  n,
  total,
  session,
  gs,
  current,
  updateSets,
  onSetDone,
  onEdit,
}: {
  unit: ExerciseBlock[];
  n: number;
  total: number;
  session: WorkoutSession;
  gs: Guidance[];
  current: boolean;
  updateSets: (exerciseId: string, fn: (sets: SetEntry[]) => SetEntry[]) => void;
  onSetDone: (block: ExerciseBlock, setIndex: number) => void;
  onEdit: (block: ExerciseBlock, setIndex: number) => void;
}) {
  const g0 = unit[0].group!;
  const live = session.status === "active";
  const allTimed = unit.every((b) => b.plan.is_time);
  const mark = (b: ExerciseBlock) => b.plan.superset_tag ?? `${g0.tag}${(b.group?.index ?? 0) + 1}`;
  const acts = unit.map((b, k) => setActions(b, gs[k], session, (fn) => updateSets(b.ex.id, fn), (i) => onSetDone(b, i)));
  const now = current ? groupCurrent(unit.map((b) => ({ id: b.ex.id, sets: b.sets }))) : null;
  const rows = roundRows(unit.map((b) => ({ id: b.ex.id, sets: b.sets.length })));
  const rounds = [...new Set(rows.map((r) => r.round))];
  const weightHead = unit.every((b) => b.plan.is_time || b.ex.equipment === "dumbbell") && !allTimed ? `Per dumbbell ${session.unit}` : `Weight ${session.unit}`;
  return (
    <article class="card card--session card--grouped" data-testid="group-card" data-group={g0.tag} data-ex={unit.map((b) => b.ex.id).join(" ")} aria-labelledby={`group-title-${unit[0].ex.id}`}>
      <div class="l-col l-gap-4">
        <span class="ex-card__kicker num">
          Exercises {fmtNum(n)}–{fmtNum(n + unit.length - 1)} of {fmtNum(total)} · rest {fmtNum(g0.rest)} s after each round
        </span>
        <h2 class="big-num big-num--36 l-m0" id={`group-title-${unit[0].ex.id}`} tabIndex={-1}>
          {groupKind(unit.length)} {g0.tag}
        </h2>
      </div>
      {unit.map((b, k) => {
        const target = b.extra ? "" : [targetText(b.plan), rirText(b.plan)].filter(Boolean).join(" · ");
        return (
          <div class="l-row l-top l-gap-12" data-testid="group-member" data-ex={b.ex.id}>
            <div class="l-col l-gap-4 l-grow">
              <span class="ex-card__group num">
                {mark(b)}
                {b.plan.is_main ? " · Main lift" : ""}
                {b.extra ? " · Added today" : ""}
                {target ? (
                  <>
                    {" · "}
                    <span data-testid="target">{target}</span>
                  </>
                ) : null}
              </span>
              <h3 class="t-title l-m0">{b.ex.name_en}</h3>
              <GuidanceLines block={b} g={gs[k]} live={live} />
            </div>
            <a class="btn-icon btn-icon--soft press" href={ytLink(b.ex.name_en)} target="_blank" rel="noopener noreferrer" aria-label={`Form video: ${b.ex.name_en}`} data-testid="form-video">
              <IconPlay />
            </a>
          </div>
        );
      })}
      <div class="l-col l-gap-8">
        <div class={`set-head${allTimed ? " set-head--timed" : ""}`} aria-hidden="true" hidden={!rows.length}>
          <span>Set</span>
          {allTimed ? null : <span>{weightHead}</span>}
          <span>{allTimed ? "Seconds" : "Reps"}</span>
          <span>Done</span>
        </div>
        {rows.length ? null : <span class="ex-card__meta">No sets logged.</span>}
        {rounds.map((r) => (
          <div class="l-col l-gap-4" role="group" aria-label={`Round ${r + 1}`} data-testid={`round-${r + 1}`}>
            <span class="ex-card__kicker num" aria-hidden="true">
              Round {fmtNum(r + 1)}
            </span>
            {rows
              .filter((x) => x.round === r)
              .map((x) => {
                const k = unit.findIndex((b) => b.ex.id === x.exerciseId);
                const b = unit[k];
                const isNow = now?.exerciseId === b.ex.id && now.set === x.set;
                const who = `${b.ex.name_en}, `;
                return (
                  <Fragment key={b.sets[x.set].id}>
                    <SetRow block={b} i={x.set} mark={mark(b)} who={who} session={session} act={acts[k]} current={isNow} filler={!allTimed} onEdit={(i) => onEdit(b, i)} />
                    {isNow && !b.plan.is_time ? <RirRow block={b} i={x.set} who={who} act={acts[k]} /> : null}
                  </Fragment>
                );
              })}
          </div>
        ))}
      </div>
      {unit.map((b, k) => (
        <div class="l-col l-gap-8" data-testid="group-tools" data-ex={b.ex.id}>
          <span class="ex-card__group num">
            {mark(b)} · {b.ex.name_en}
          </span>
          {b.ex.cue_en ? (
            <p class="ex-card__cue" data-testid="cue">
              {b.ex.cue_en}
            </p>
          ) : null}
          <SetTools block={b} g={gs[k]} session={session} act={acts[k]} />
        </div>
      ))}
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

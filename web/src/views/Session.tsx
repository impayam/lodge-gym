// Session screen (SPEC §7): fewest taps — prefilled suggestions, one-tap check, steppers, rest timer, autosave.

import { useEffect, useRef, useState } from "preact/hooks";
import { localHM } from "../../../worker/lib/time";
import type { SetEntry, Unit, WorkoutSession } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { IconCheck } from "../components/Icons";
import { Stepper } from "../components/Stepper";
import { clock, dateLong, fmtNum, hm, ytLink } from "../format";
import { dayInfo, guidance, retime, sessionBlocks, type ExerciseBlock, type Guidance } from "../model";
import { addExtraExercise, allExercises, flash, getState, navigate, photoSrc, removeExtraExercise, removeSession, saveBodyMass, saveSession, startRest, stopRest, useStore } from "../store";
import { ExercisePicker, ExerciseThumb } from "./Library";
import { targetText } from "./Program";
import { WatchStats, workoutTypeName } from "./Watch";
import { PhotoPicker, poseLabel } from "./Photos";

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
  return (
    <div class="clock num" data-testid="elapsed">
      {sec < 86_400 ? clock(sec) : "–"}
    </div>
  );
}

export function Session({ id }: { id: string }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const s = sessions[id];
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [justFinished, setJustFinished] = useState(false);
  const [picking, setPicking] = useState(false);
  useStore((st) => st.library);
  const photos = useStore((st) => st.photos);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [note, setNote] = useState(s?.note ?? "");
  useWakeLock(s?.status === "active");

  useEffect(() => {
    if (!s) navigate("home");
  }, [s]);
  if (!s) return null;

  const tz = boot.settings.timezone;
  const day = dayInfo(boot, s.program_day_id);
  const watch = (boot.watch ?? []).filter((w) => w.matched_session_id === s.id).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const blocks = sessionBlocks(boot, s, allExercises());
  const hasSuperset = blocks.some((b) => b.plan.superset_tag);
  const sessionPhotos = photos.filter((p) => p.session_id === s.id);
  const manualBody = (boot.body ?? []).filter((m) => m.kind === "body_mass" && m.source === "manual");
  const bodyToday = manualBody.find((m) => m.local_date === s.local_date) ?? null;
  const lastBody = [...manualBody].reverse().find((m) => m.unit === s.unit)?.value ?? null;
  const startHM = localHM(tz, s.started_at);
  const endHM = s.ended_at ? localHM(tz, s.ended_at) : "";

  const update = (mut: (x: WorkoutSession) => WorkoutSession) => {
    const cur = getState().sessions[id];
    if (cur) void saveSession(mut(cur));
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

  const finish = () => {
    stopRest();
    update((x) => ({ ...x, status: "done", ended_at: new Date().toISOString() }));
    flash("Session saved.");
    setJustFinished(true);
    window.scrollTo(0, 0);
  };

  if (picking)
    return (
      <ExercisePicker
        onCancel={() => setPicking(false)}
        onPick={(ex) => {
          setPicking(false);
          void addExtraExercise(s.id, ex).then(() => {
            requestAnimationFrame(() => document.querySelector(`[data-ex="${CSS.escape(ex.id)}"]`)?.scrollIntoView({ block: "center" }));
          });
        }}
      />
    );

  return (
    <>
      <section class="sess-head">
        <div class="sess-title">
          <div>
            <b>{day.name_en}</b>
          </div>
          <div style={{ textAlign: "right" }}>
            {s.status === "active" ? (
              <>
                <Elapsed from={s.started_at} />
                <small class="muted" style={{ fontSize: "12px" }}>
                  Elapsed
                </small>
              </>
            ) : (
              <span class="pill done">Done</span>
            )}
          </div>
        </div>
        <div class="when">
          <div class="field">
            <label for="f-date">Date</label>
            <input
              id="f-date"
              type="date"
              value={s.local_date}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                if (v) update((x) => retime(x, tz, v, startHM, endHM || null));
              }}
            />
          </div>
          <div class="field">
            <label for="f-start">Start</label>
            <input
              id="f-start"
              type="time"
              value={startHM}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                if (v) update((x) => retime(x, tz, x.local_date, v, endHM || null));
              }}
            />
          </div>
          <div class="field">
            <label for="f-end">End</label>
            <input
              id="f-end"
              type="time"
              value={endHM}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                update((x) => retime(x, tz, x.local_date, startHM, v || null));
              }}
            />
          </div>
        </div>
        <div class="jal">
          <span>{dateLong(s.local_date)}</span>
          <span class="seg" role="group" aria-label="Weight unit for this session">
            {(["lb", "kg"] as Unit[]).map((u) => (
              <button type="button" aria-pressed={s.unit === u} onClick={() => update((x) => ({ ...x, unit: u }))}>
                {u}
              </button>
            ))}
          </span>
        </div>
        {hasSuperset ? <div class="ss-note">A1/A2 and B1/B2 are supersets: alternate them and rest 60–90 s after each round.</div> : null}
      </section>

      {justFinished ? (
        <section class="card photo-prompt stack" style={{ marginTop: "14px" }} data-testid="photo-prompt">
          <b>Progress photos today?</b>
          <span class="why">Front, side and back; optional.</span>
          {(["front", "side", "back"] as const).map((pose) => (
            <PhotoPicker pose={pose} date={s.local_date} sessionId={s.id} compact />
          ))}
          <button type="button" class="btn btn-ghost btn-block" onClick={() => setJustFinished(false)}>
            Later
          </button>
        </section>
      ) : null}
      {sessionPhotos.length ? (
        <div class="photos" style={{ marginTop: "10px" }} data-testid="session-photos">
          {sessionPhotos.map((p) => (
            <button type="button" class="ph" onClick={() => navigate("photos")}>
              <img src={photoSrc(p, "thumb")} alt={`${poseLabel(p.pose)} photo`} loading="lazy" />
              <span class="d">{poseLabel(p.pose)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {watch.length ? (
        <section class="card watch stack" style={{ marginTop: "14px" }} data-testid="session-watch">
          <div class="eyebrow">Apple Watch</div>
          {watch.map((w) => (
            <div class="row-w">
              <b>
                {w.kind === "session" ? (
                  "During the session"
                ) : (
                  <>
                    {workoutTypeName(w.activity_type)} · <span class="num">{hm(w.started_at, tz)}{w.ended_at ? `–${hm(w.ended_at, tz)}` : ""}</span>
                  </>
                )}
              </b>
              <WatchStats w={w} session={s} />
            </div>
          ))}
        </section>
      ) : null}

      <h2>Exercises</h2>
      <div class="stack">
        {blocks.map((b) => (
          <ExerciseCard key={b.ex.id} block={b} session={s} g={guidance(b, s, sessions)} updateSets={(fn) => updateSets(b.ex.id, fn)} />
        ))}
        <button type="button" class="btn btn-ghost btn-block" data-testid="add-exercise" onClick={() => setPicking(true)}>
          + Add exercise
        </button>
      </div>

      <h2>Note</h2>
      <textarea
        id="f-note"
        placeholder="How you felt today, any pain, anything to remember…"
        value={note}
        onInput={(e) => {
          const v = (e.currentTarget as HTMLTextAreaElement).value;
          setNote(v);
          if (noteTimer.current) clearTimeout(noteTimer.current);
          noteTimer.current = setTimeout(() => update((x) => ({ ...x, note: v })), 500);
        }}
        onBlur={() => {
          if (noteTimer.current) clearTimeout(noteTimer.current);
          if (note !== getState().sessions[id]?.note) update((x) => ({ ...x, note }));
        }}
      />

      <h2>Body weight today</h2>
      <div class="card bodyw" data-testid="body-weight">
        <Stepper
          value={bodyToday?.unit === s.unit || !bodyToday ? (bodyToday?.value ?? null) : null}
          placeholder={bodyToday && bodyToday.unit !== s.unit ? `${fmtNum(bodyToday.value)} ${bodyToday.unit}` : "–"}
          base={lastBody ?? 0}
          step={0.1}
          min={0}
          label={`Body weight (${s.unit})`}
          onChange={(v) => void saveBodyMass(s.local_date, v, s.unit)}
        />
        <span>{s.unit}</span>
        <small class="muted">Optional; saved for the reports.</small>
      </div>

      <div class="stack" style={{ marginTop: "14px" }}>
        {s.status === "active" ? (
          <button class="btn btn-primary btn-block" type="button" onClick={finish} data-testid="finish">
            Finish session
          </button>
        ) : null}
        <div class="row">
          <button class="btn btn-ghost" type="button" onClick={() => navigate("home")}>
            Back
          </button>
          <button class="btn btn-danger" type="button" onClick={() => setConfirmDelete(true)}>
            Delete session
          </button>
        </div>
        {confirmDelete ? (
          <div class="card" style={{ borderColor: "var(--danger)" }}>
            <div style={{ marginBottom: "8px" }}>Delete this session permanently?</div>
            <div class="row">
              <button
                class="btn btn-danger"
                type="button"
                onClick={() => {
                  stopRest();
                  void removeSession(s.id);
                  navigate("home");
                }}
              >
                Yes, delete
              </button>
              <button class="btn btn-ghost" type="button" onClick={() => setConfirmDelete(false)}>
                No
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
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

function ExerciseCard({ block, session, g, updateSets }: { block: ExerciseBlock; session: WorkoutSession; g: Guidance; updateSets: (fn: (sets: SetEntry[]) => SetEntry[]) => void }) {
  const { ex, plan, sets, extra } = block;
  const unit = session.unit;
  const isTime = plan.is_time;
  const isBw = ex.equipment === "bodyweight";
  const allDone = sets.length > 0 && sets.every((x) => x.done);
  const wLabel = isBw ? `Added/assist (${unit})` : ex.equipment === "dumbbell" ? `Per dumbbell (${unit})` : `Weight (${unit})`;
  const rLabel = isTime ? "Seconds" : plan.per_leg ? "Reps per leg" : "Reps";
  const sgText = suggestionText(g);
  const lt = lastText(g, isTime);

  const setField = (i: number, patch: Partial<SetEntry>) => updateSets((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const toggle = (i: number) => {
    const cur = sets[i];
    const done = !cur.done;
    const patch: Partial<SetEntry> = { done };
    if (done) {
      if (isTime) {
        if (cur.seconds == null) patch.seconds = g.prefillSeconds ?? plan.reps_max;
      } else {
        if (cur.reps == null && !extra) patch.reps = plan.reps_max;
        if (cur.weight == null && g.prefillWeight != null) patch.weight = g.prefillWeight;
      }
    }
    setField(i, patch);
    if (done && session.status === "active") startRest(plan.rest_sec, `Rest after ${ex.name_en}`);
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
  const removeSet = () => updateSets((list) => list.slice(0, -1));
  const copyLast = () => {
    if (!g.last) return;
    const sameUnit = g.last.unit === unit;
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
    <article class={`ex${allDone ? " done" : ""}${extra ? " extra" : ""}`} data-ex={ex.id}>
      <div class="ex-top">
        {extra ? <ExerciseThumb ex={ex} /> : null}
        <div class="ex-name">
          <b>
            {plan.is_main ? <span class="mainb">Main</span> : null}
            {extra ? <span class="extrab">Extra</span> : null}
            {ex.name_en}
            {plan.superset_tag ? <span class="tag">{plan.superset_tag}</span> : null}
          </b>
        </div>
        {extra ? null : <div class="target num">{targetText(plan)}</div>}
      </div>
      {ex.cue_en ? <div class="cue">{ex.cue_en}</div> : null}
      <div class="ex-links">
        <a href={ytLink(ex.name_en)} target="_blank" rel="noopener noreferrer">
          Watch form video ↗
        </a>
        {g.last ? (
          <>
            <span class="last" data-testid="last-perf">
              Last time: <span class="num">{lt}</span>
            </span>
            {sgText ? (
              <span class="suggest" data-testid="suggestion">
                {sgText}
              </span>
            ) : null}
          </>
        ) : extra ? (
          <span class="last">Added to this session only; no target.</span>
        ) : (
          <span class="last">First time: start light.</span>
        )}
      </div>
      <div class={`colhead${isTime ? " timed" : ""}`}>
        <span>Set</span>
        {isTime ? null : <span>{wLabel}</span>}
        <span>{rLabel}</span>
        <span />
      </div>
      <div class="sets">
        {sets.map((x, i) => (
          <div class="setwrap" key={x.id}>
          <div class={`setrow${isTime ? " timed" : ""}${x.done ? " ok" : ""}`}>
            <span class="n num">{i + 1}</span>
            {isTime ? null : (
              <Stepper
                value={x.weight}
                placeholder={g.prefillWeight != null ? fmtNum(g.prefillWeight) : isBw ? "0" : "–"}
                base={g.prefillWeight ?? 0}
                step={g.step}
                min={isBw ? undefined : 0}
                label={`${wLabel}, set ${i + 1}`}
                testId={`w-${ex.id}-${i}`}
                onChange={(v) => setField(i, { weight: v })}
              />
            )}
            {isTime ? (
              <Stepper
                value={x.seconds}
                placeholder={fmtNum(g.prefillSeconds ?? plan.reps_max)}
                base={g.prefillSeconds ?? plan.reps_max}
                step={5}
                min={0}
                decimals={false}
                label={`Seconds, set ${i + 1}`}
                testId={`s-${ex.id}-${i}`}
                onChange={(v) => setField(i, { seconds: v })}
              />
            ) : (
              <Stepper
                value={x.reps}
                placeholder={extra ? "–" : fmtNum(plan.reps_max)}
                base={extra ? 0 : plan.reps_max}
                step={1}
                min={0}
                decimals={false}
                label={`${rLabel}, set ${i + 1}`}
                testId={`r-${ex.id}-${i}`}
                onChange={(v) => setField(i, { reps: v })}
              />
            )}
            <button type="button" class="check" aria-pressed={x.done} aria-label={`Set ${i + 1} done`} data-testid={`check-${ex.id}-${i}`} onClick={() => toggle(i)}>
              <IconCheck />
            </button>
          </div>
          {isTime ? null : (
            <div class="rir" role="group" aria-label={`Reps in reserve (RIR), set ${i + 1}`} data-testid={`rir-${ex.id}-${i}`}>
              <span>RIR</span>
              {RIR_CHOICES.map(([v, label]) => (
                <button type="button" aria-pressed={x.rir === v} aria-label={label} onClick={() => setField(i, { rir: x.rir === v ? null : v })}>
                  {label}
                </button>
              ))}
            </div>
          )}
          </div>
        ))}
      </div>
      <div class="ex-actions">
        <span>
          <button type="button" onClick={addSet}>
            + Add set
          </button>
          {sets.length > 0 ? (
            <button type="button" onClick={removeSet} style={{ marginInlineStart: "14px" }}>
              − Remove set
            </button>
          ) : null}
        </span>
        {extra && !sets.some((x) => x.done) ? (
          <button type="button" data-testid={`remove-${ex.id}`} onClick={() => void removeExtraExercise(session.id, ex.id)}>
            Remove exercise
          </button>
        ) : null}
        {g.last ? (
          <button type="button" class="copy" onClick={copyLast}>
            Same as last time
          </button>
        ) : null}
      </div>
    </article>
  );
}

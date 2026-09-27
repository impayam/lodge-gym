// Session screen (SPEC §7): fewest taps — prefilled suggestions, one-tap check, steppers, rest timer, autosave.

import { useEffect, useRef, useState } from "preact/hooks";
import { faNum } from "../../../worker/lib/digits";
import { localHM } from "../../../worker/lib/time";
import type { SetEntry, Unit, WorkoutSession } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { IconCheck } from "../components/Icons";
import { Stepper } from "../components/Stepper";
import { clock, faHM, greg, jalali, ytLink } from "../format";
import { dayInfo, guidance, retime, sessionBlocks, type ExerciseBlock, type Guidance } from "../model";
import { flash, getState, navigate, photoSrc, removeSession, saveBodyMass, saveSession, startRest, stopRest, useStore } from "../store";
import { targetText } from "./Program";
import { WatchStats, workoutTypeFa } from "./Watch";
import { PhotoPicker, poseFa } from "./Photos";

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
  const blocks = sessionBlocks(boot, s);
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
    flash("جلسه ثبت شد.");
    setJustFinished(true);
    window.scrollTo(0, 0);
  };

  return (
    <>
      <section class="sess-head">
        <div class="sess-title">
          <div>
            <b>{day.name_fa}</b>
            <small class="ltr" style={{ textAlign: "right" }}>
              {day.name_en}
            </small>
            {day.focus_fa ? <small>{day.focus_fa}</small> : null}
          </div>
          <div style={{ textAlign: "left" }}>
            {s.status === "active" ? (
              <>
                <Elapsed from={s.started_at} />
                <small class="muted" style={{ fontSize: "12px" }}>
                  زمان سپری‌شده
                </small>
              </>
            ) : (
              <span class="pill done">تمام‌شده</span>
            )}
          </div>
        </div>
        <div class="when">
          <div class="field">
            <label for="f-date">تاریخ</label>
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
            <label for="f-start">شروع</label>
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
            <label for="f-end">پایان</label>
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
          <span>
            {jalali(s.local_date)} · <span class="ltr">{greg(s.local_date)}</span>
          </span>
          <span class="seg" role="group" aria-label="واحد وزن این جلسه">
            {(["lb", "kg"] as Unit[]).map((u) => (
              <button type="button" aria-pressed={s.unit === u} onClick={() => update((x) => ({ ...x, unit: u }))}>
                {u}
              </button>
            ))}
          </span>
        </div>
        {hasSuperset ? <div class="ss-note">حرکت‌های A1/A2 و B1/B2 سوپرست هستند: یکی در میان، بعد از هر دور ۶۰ تا ۹۰ ثانیه استراحت.</div> : null}
      </section>

      {justFinished ? (
        <section class="card photo-prompt stack" style={{ marginTop: "14px" }} data-testid="photo-prompt">
          <b>عکس پیشرفت امروز؟</b>
          <span class="why">جلو، بغل و پشت؛ اختیاری است.</span>
          {(["front", "side", "back"] as const).map((pose) => (
            <PhotoPicker pose={pose} date={s.local_date} sessionId={s.id} compact />
          ))}
          <button type="button" class="btn btn-ghost btn-block" onClick={() => setJustFinished(false)}>
            بعداً
          </button>
        </section>
      ) : null}
      {sessionPhotos.length ? (
        <div class="photos" style={{ marginTop: "10px" }} data-testid="session-photos">
          {sessionPhotos.map((p) => (
            <button type="button" class="ph" onClick={() => navigate("photos")}>
              <img src={photoSrc(p, "thumb")} alt={`عکس ${poseFa(p.pose)}`} loading="lazy" />
              <span class="d">{poseFa(p.pose)}</span>
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
                  "در طول جلسه"
                ) : (
                  <>
                    {workoutTypeFa(w.activity_type)} · <span class="num">{faHM(w.started_at, tz)}{w.ended_at ? `–${faHM(w.ended_at, tz)}` : ""}</span>
                  </>
                )}
              </b>
              <WatchStats w={w} session={s} />
            </div>
          ))}
        </section>
      ) : null}

      <h2>حرکت‌ها</h2>
      <div class="stack">
        {blocks.map((b) => (
          <ExerciseCard key={b.ex.id} block={b} session={s} g={guidance(b, s, sessions)} updateSets={(fn) => updateSets(b.ex.id, fn)} />
        ))}
      </div>

      <h2>یادداشت</h2>
      <textarea
        id="f-note"
        placeholder="حالت امروز، درد یا نکته‌ای که باید یادت بماند…"
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

      <h2>وزن بدن امروز</h2>
      <div class="card bodyw" data-testid="body-weight">
        <Stepper
          value={bodyToday?.unit === s.unit || !bodyToday ? (bodyToday?.value ?? null) : null}
          placeholder={bodyToday && bodyToday.unit !== s.unit ? `${faNum(bodyToday.value)} ${bodyToday.unit}` : "–"}
          base={lastBody ?? 0}
          step={0.1}
          min={0}
          label={`وزن بدن (${s.unit})`}
          onChange={(v) => void saveBodyMass(s.local_date, v, s.unit)}
        />
        <span class="ltr">{s.unit}</span>
        <small class="muted">اختیاری؛ برای گزارش‌ها ذخیره می‌شود.</small>
      </div>

      <div class="stack" style={{ marginTop: "14px" }}>
        {s.status === "active" ? (
          <button class="btn btn-primary btn-block" type="button" onClick={finish} data-testid="finish">
            پایان جلسه
          </button>
        ) : null}
        <div class="row">
          <button class="btn btn-ghost" type="button" onClick={() => navigate("home")}>
            بازگشت
          </button>
          <button class="btn btn-danger" type="button" onClick={() => setConfirmDelete(true)}>
            حذف جلسه
          </button>
        </div>
        {confirmDelete ? (
          <div class="card" style={{ borderColor: "var(--danger)" }}>
            <div style={{ marginBottom: "8px" }}>این جلسه برای همیشه حذف شود؟</div>
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
                بله، حذف کن
              </button>
              <button class="btn btn-ghost" type="button" onClick={() => setConfirmDelete(false)}>
                نه
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
    .map((x) => (isTime ? `${faNum(x.seconds)} ث` : (x.weight != null ? faNum(x.weight) + "×" : "") + faNum(x.reps)));
  return parts.join("، ") + (isTime ? "" : ` ${g.last.unit}`);
}

function suggestionText(g: Guidance): string {
  const sg = g.suggestion;
  const easy = "، همه‌ی ست‌ها با ۳+ تکرار ذخیره";
  if (sg.kind === "weight")
    return sg.allHit ? `پیشنهاد: ${faNum(sg.weight)} ${sg.unit}${sg.easy ? ` (دو پله${easy})` : ""}` : `همان ${faNum(sg.weight)} ${sg.unit} تا همه‌ی ست‌ها کامل شود`;
  if (sg.kind === "bodyweight") return sg.allHit ? (sg.easy ? "دو تکرار بیشتر، یا وزنه‌ی کمکی کمتر" : "یک تکرار بیشتر، یا وزنه‌ی کمکی کمتر") : "همان";
  if (sg.kind === "time") return sg.allHit ? `هدف: ${faNum(sg.seconds)} ثانیه` : "همان زمان";
  return "";
}

const RIR_CHOICES: [number, string][] = [
  [0, "۰"],
  [1, "۱"],
  [2, "۲"],
  [3, "۳+"],
];

function ExerciseCard({ block, session, g, updateSets }: { block: ExerciseBlock; session: WorkoutSession; g: Guidance; updateSets: (fn: (sets: SetEntry[]) => SetEntry[]) => void }) {
  const { ex, plan, sets } = block;
  const unit = session.unit;
  const isTime = plan.is_time;
  const isBw = ex.equipment === "bodyweight";
  const allDone = sets.length > 0 && sets.every((x) => x.done);
  const wLabel = isBw ? `وزنه‌ی اضافه/کمکی (${unit})` : ex.equipment === "dumbbell" ? `هر دمبل (${unit})` : `وزنه (${unit})`;
  const rLabel = isTime ? "ثانیه" : plan.per_leg ? "تکرار هر پا" : "تکرار";
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
        if (cur.reps == null) patch.reps = plan.reps_max;
        if (cur.weight == null && g.prefillWeight != null) patch.weight = g.prefillWeight;
      }
    }
    setField(i, patch);
    if (done && session.status === "active") startRest(plan.rest_sec, `استراحت بعد از ${ex.name_fa}`);
  };

  const addSet = () =>
    updateSets((list) => {
      const prev = list[list.length - 1];
      return [
        ...list,
        { id: ulid(), exercise_id: ex.id, set_index: list.length, weight: prev ? prev.weight : null, reps: null, seconds: null, done: false, rir: null, updated_at: new Date().toISOString() },
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
        updated_at: new Date().toISOString(),
      }))
    );
  };

  return (
    <article class={`ex${allDone ? " done" : ""}`} data-ex={ex.id}>
      <div class="ex-top">
        <div class="ex-name">
          <b>
            {plan.is_main ? <span class="mainb">اصلی</span> : null}
            {ex.name_fa}
            {plan.superset_tag ? <span class="tag ltr">{plan.superset_tag}</span> : null}
          </b>
          <span class="en ltr">{ex.name_en}</span>
        </div>
        <div class="target num">{targetText(plan)}</div>
      </div>
      {ex.cue_fa ? <div class="cue">{ex.cue_fa}</div> : null}
      <div class="ex-links">
        <a href={ytLink(ex.name_en)} target="_blank" rel="noopener noreferrer">
          ویدیوی فرم ↗
        </a>
        {g.last ? (
          <>
            <span class="last" data-testid="last-perf">
              دفعه‌ی قبل: <span class="num">{lt}</span>
            </span>
            {sgText ? (
              <span class="suggest" data-testid="suggestion">
                {sgText}
              </span>
            ) : null}
          </>
        ) : (
          <span class="last">اولین بار؛ سبک شروع کن.</span>
        )}
      </div>
      <div class={`colhead${isTime ? " timed" : ""}`}>
        <span>ست</span>
        {isTime ? null : <span>{wLabel}</span>}
        <span>{rLabel}</span>
        <span />
      </div>
      <div class="sets">
        {sets.map((x, i) => (
          <div class="setwrap" key={x.id}>
          <div class={`setrow${isTime ? " timed" : ""}${x.done ? " ok" : ""}`}>
            <span class="n num">{faNum(i + 1)}</span>
            {isTime ? null : (
              <Stepper
                value={x.weight}
                placeholder={g.prefillWeight != null ? faNum(g.prefillWeight) : isBw ? "۰" : "–"}
                base={g.prefillWeight ?? 0}
                step={g.step}
                min={isBw ? undefined : 0}
                label={`${wLabel} ست ${faNum(i + 1)}`}
                testId={`w-${ex.id}-${i}`}
                onChange={(v) => setField(i, { weight: v })}
              />
            )}
            {isTime ? (
              <Stepper
                value={x.seconds}
                placeholder={faNum(g.prefillSeconds ?? plan.reps_max)}
                base={g.prefillSeconds ?? plan.reps_max}
                step={5}
                min={0}
                decimals={false}
                label={`ثانیه ست ${faNum(i + 1)}`}
                testId={`s-${ex.id}-${i}`}
                onChange={(v) => setField(i, { seconds: v })}
              />
            ) : (
              <Stepper
                value={x.reps}
                placeholder={faNum(plan.reps_max)}
                base={plan.reps_max}
                step={1}
                min={0}
                decimals={false}
                label={`${rLabel} ست ${faNum(i + 1)}`}
                testId={`r-${ex.id}-${i}`}
                onChange={(v) => setField(i, { reps: v })}
              />
            )}
            <button type="button" class="check" aria-pressed={x.done} aria-label={`ست ${faNum(i + 1)} انجام شد`} data-testid={`check-${ex.id}-${i}`} onClick={() => toggle(i)}>
              <IconCheck />
            </button>
          </div>
          {isTime ? null : (
            <div class="rir" role="group" aria-label={`تکرار ذخیره (RIR) ست ${faNum(i + 1)}`} data-testid={`rir-${ex.id}-${i}`}>
              <span>RIR</span>
              {RIR_CHOICES.map(([v, label]) => (
                <button type="button" aria-pressed={x.rir === v} aria-label={label} onClick={() => setField(i, { rir: x.rir === v ? null : v })}>
                  <span class="ltr">{label}</span>
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
            + افزودن ست
          </button>
          {sets.length > 0 ? (
            <button type="button" onClick={removeSet} style={{ marginInlineStart: "14px" }}>
              − حذف ست
            </button>
          ) : null}
        </span>
        {g.last ? (
          <button type="button" class="copy" onClick={copyLast}>
            مثل دفعه‌ی قبل
          </button>
        ) : null}
      </div>
    </article>
  );
}

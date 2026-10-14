// Session planner (SPEC-v3 M9c): a planned session built from a program day. Replace, delete, add, reorder, edit
// sets/reps/rest and group, then Save (works offline through the outbox), Start session at the gym, Discard plan, or
// Apply to program (a new program version, after a confirm). Changes apply to this session only by default.
// Get advice (needs a connection) saves the plan and asks the model once; each suggestion changes the plan only when
// its Apply is tapped, and can be undone.

import { useEffect, useState } from "preact/hooks";
import { applySuggestion, undoSuggestion, type AdviceSuggestion, type AppliedChange } from "../../../worker/lib/ai/suggestions";
import { addItem, inPlan, isEdited, liveItems, planFromDay, planMinutes, removeItem, replaceItem, seqIds, type SessionPlan } from "../../../worker/lib/plan";
import type { ProgramDay } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { PlanList } from "../components/PlanList";
import { fetchAdvice, type AdviceResponse } from "../ai";
import { ApiError, NetworkError } from "../api";
import { fmtNum, plural } from "../format";
import { activeSession, dayInfo, openPlanFor } from "../model";
import { allExercises, applyPlanToProgram, discardPlan, flash, getState, goBack, navigate, openPlan, rememberExercise, savePlan, sendPlan, startPlan, useStore } from "../store";
import { ExercisePicker } from "./Library";
import { IconBack, IconPlus } from "../components/PulseIcons";

/** Unsaved planner edits, kept while the app is open (a tab switch does not lose them; Cancel does). */
const drafts = new Map<string, SessionPlan>();

/** The last advice per plan and the suggestions applied from it (index → what Undo needs), while the app is open. */
const advices = new Map<string, { res: AdviceResponse; applied: Map<number, AppliedChange> }>();

/** Home → Plan session: the day's open plan, an unsaved draft for the day, or a new draft copying the day. */
export function planDay(day: ProgramDay) {
  const st = getState();
  const saved = openPlanFor(st.plans, day.id);
  if (saved) return openPlan(saved.id);
  const draft = [...drafts.values()].find((p) => p.program_day_id === day.id && !st.plans[p.id]);
  if (draft) return openPlan(draft.id);
  const id = ulid();
  drafts.set(id, planFromDay(day, id, new Date().toISOString(), seqIds(id)));
  openPlan(id);
}

type Picking = { kind: "add" } | { kind: "replace"; itemId: string; name: string };

export function Planner({ id }: { id: string }) {
  const boot = useStore((s) => s.boot)!;
  const saved = useStore((s) => s.plans[id] ?? null);
  const sessions = useStore((s) => s.sessions);
  useStore((s) => s.library);
  const [, rerender] = useState(0);
  const plan = drafts.get(id) ?? saved;
  const [picking, setPicking] = useState<Picking | null>(null);
  const [confirm, setConfirm] = useState<"apply" | "discard" | null>(null);
  const [busy, setBusy] = useState(false);
  const [advising, setAdvising] = useState(false);
  const [adviceMsg, setAdviceMsg] = useState<string | null>(null);
  const online = useStore((s) => s.sync.online);

  // Started (here or elsewhere): its session; discarded elsewhere, or a stale link: Home.
  useEffect(() => {
    if (plan?.status === "started") navigate("session", plan.id);
    else if (!plan || plan.status !== "planned") navigate("home");
  }, [plan]);
  if (!plan || plan.status !== "planned") return null;

  const exMap = allExercises();
  const day = boot.program.days.find((d) => d.id === plan.program_day_id) ?? null;
  const dayName = dayInfo(boot, plan.program_day_id).name_en;
  const edited = day ? isEdited(plan, day) : true;
  const act = activeSession(sessions);
  const dirty = drafts.has(id);

  const change = (next: SessionPlan) => {
    drafts.set(id, next);
    rerender((n) => n + 1);
  };
  const done = () => drafts.delete(id);

  const save = async () => {
    await savePlan(plan);
    done();
    flash("Plan saved.");
    navigate("home");
  };
  const start = async () => {
    if (act) return;
    done();
    await startPlan(plan);
  };
  const discard = async () => {
    if (saved) await discardPlan(saved);
    done();
    flash(`Plan discarded. ${dayName} is back to the program.`);
    navigate("home");
  };
  const apply = async () => {
    setBusy(true);
    try {
      await applyPlanToProgram(plan);
      done();
      flash(`Program updated: ${dayName} now follows this plan. The previous version is archived.`);
      navigate("home");
    } catch (e) {
      setBusy(false);
      setConfirm(null);
      if (e instanceof NetworkError) flash("Apply to program needs a connection. Your plan is saved.");
      else flash(e instanceof ApiError ? e.messageText : "Apply to program failed.");
    }
  };

  const advice = advices.get(id) ?? null;
  const getAdvice = async () => {
    setAdvising(true);
    setAdviceMsg(null);
    try {
      // Advice is about the plan as it is now: it is saved and sent first (approved with migration 0009).
      await savePlan(plan);
      done();
      const sentId = await sendPlan(plan);
      const res = await fetchAdvice(sentId);
      advices.set(sentId, { res, applied: new Map() });
      if (sentId !== id) openPlan(sentId);
      else rerender((n) => n + 1);
    } catch (e) {
      if (e instanceof NetworkError) setAdviceMsg("Get advice needs a connection. Your plan is saved.");
      else if (e instanceof ApiError) setAdviceMsg(e.code === "ai_auth" ? "Advice unavailable — API key expired or invalid." : e.messageText);
      else setAdviceMsg("Advice unavailable. Try again.");
    } finally {
      setAdvising(false);
    }
  };
  const applyAdvice = (i: number, sug: AdviceSuggestion) => {
    if (!advice) return;
    const r = applySuggestion(plan, sug, new Date().toISOString(), ulid());
    if (!r) return flash("This suggestion no longer fits the plan.");
    advice.applied.set(i, r.change);
    change(r.plan);
  };
  const undoAdvice = (i: number) => {
    const c = advice?.applied.get(i);
    if (!advice || !c) return;
    advice.applied.delete(i);
    change(undoSuggestion(plan, c, new Date().toISOString()));
  };

  if (picking)
    return (
      <ExercisePicker
        sessionId={`plan:${id}`}
        title={picking.kind === "add" ? "Add an exercise" : `Replace ${picking.name}`}
        note={
          picking.kind === "add"
            ? "Added to this plan with 3 sets of 8–12 reps and 90 s rest. Your program does not change."
            : "The new exercise keeps this slot's sets, reps and rest. Your program does not change."
        }
        onCancel={() => setPicking(null)}
        onPick={(ex) => {
          const p = picking;
          setPicking(null);
          void rememberExercise(ex);
          if (inPlan(plan, ex.id)) return flash(`${ex.name_en} is already in this plan.`);
          const now = new Date().toISOString();
          change(p.kind === "add" ? addItem(plan, ex.id, now, ulid()) : replaceItem(plan, p.itemId, ex.id, now));
          requestAnimationFrame(() => document.querySelector(`[data-testid="pitem-${CSS.escape(ex.id)}"]`)?.scrollIntoView({ block: "center" }));
        }}
      />
    );

  const state = !saved ? "Not saved" : dirty ? "Unsaved changes" : edited ? "Planned · edited" : "Planned";
  return (
    <main class="page" data-testid="planner">
      <header class="screen-head">
        <button type="button" class="clay press btn-icon t-muted" aria-label="Back" data-testid="back" onClick={goBack}>
          <IconBack size={20} />
        </button>
        <div class="l-col l-grow">
          <span class="screen-head__sub">Plan session</span>
          <h1 class="screen-head__title l-m0">{dayName}</h1>
        </div>
        {/* Not saved yet, or edited since: worth a glance before leaving. */}
        <span class={!saved || dirty ? "badge" : "caption"} data-testid="plan-state">
          {state}
        </span>
      </header>
      <div class="l-col l-gap-4">
        {day ? (
          <span class="ex-card__meta num" data-testid="plan-estimate">
            {plural(liveItems(plan).length, "exercise")} · about {fmtNum(planMinutes(plan, day))} min
          </span>
        ) : null}
        <span class="caption">Changes apply to this session only. Nothing is timed until you start.</span>
      </div>

      <section class="l-col l-gap-8" aria-labelledby="plan-exercises">
        <h2 class="section-label" id="plan-exercises">
          Exercises
        </h2>
        <PlanList
          plan={plan}
          exMap={exMap}
          mode="plan"
          onChange={change}
          onReplace={(it) => setPicking({ kind: "replace", itemId: it.id, name: exMap.get(it.exercise_id)?.name_en ?? it.exercise_id })}
          onRemove={(it) => change(removeItem(plan, it.id, new Date().toISOString()))}
        />
        {liveItems(plan).length ? null : <p class="state l-m0">No exercises. Add one, or discard the plan.</p>}
        <button type="button" class="clay press btn t-muted l-row l-center l-gap-8" data-testid="plan-add" onClick={() => setPicking({ kind: "add" })}>
          <IconPlus size={18} /> Add exercise
        </button>
      </section>

      <section class="card l-col l-gap-10" aria-labelledby="plan-advice-title">
        <div class="l-row l-gap-12">
          <div class="l-col l-gap-2 l-grow">
            <h2 class="card__title l-m0" id="plan-advice-title">
              Advice
            </h2>
            <span class="caption">The coach reads this plan once. Nothing changes until you tap Apply.</span>
          </div>
          <button type="button" class="clay press btn btn--fit t-orange" data-testid="plan-advice" disabled={!online || advising || !liveItems(plan).length} onClick={() => void getAdvice()}>
            {advising ? "Getting advice…" : advice ? "Get new advice" : "Get advice"}
          </button>
        </div>
        {!online ? (
          <p class="caption l-m0" data-testid="advice-offline">
            Needs connection
          </p>
        ) : null}
        {adviceMsg ? (
          <p class="ex-card__meta t-orange l-m0" role="status" data-testid="advice-error">
            {adviceMsg}
          </p>
        ) : null}
        {advice ? <AdviceCard res={advice.res} applied={advice.applied} names={exMap} onApply={applyAdvice} onUndo={undoAdvice} /> : null}
      </section>

      <section class="l-col l-gap-10" aria-label="Plan actions">
        <button type="button" class="clay press btn-lg t-pink" data-testid="plan-start" disabled={!!act || !liveItems(plan).length} onClick={() => void start()}>
          Start session
        </button>
        {act ? <p class="caption l-m0">Finish your open session first.</p> : null}
        <div class="l-row l-gap-8">
          <button type="button" class="clay press btn t-muted l-grow" data-testid="plan-save" onClick={() => void save()}>
            Save plan
          </button>
          {dirty ? (
            <button
              type="button"
              class="clay press btn t-muted l-grow"
              onClick={() => {
                done();
                navigate("home");
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
        <button type="button" class="clay press btn t-muted" data-testid="plan-apply" disabled={!day || !edited || busy} onClick={() => setConfirm("apply")}>
          Apply to program…
        </button>
        {confirm === "apply" ? (
          <div class="callout" data-testid="apply-confirm">
            <p class="ex-card__meta l-m0">
              Make this the program's <b>{dayName}</b> from now on? A new program version becomes active; the current one is archived, not deleted. Your history does not change.
            </p>
            <div class="l-row l-gap-8">
              <button type="button" class="clay press btn btn--fit t-pink" disabled={busy} onClick={() => void apply()}>
                {busy ? "Applying…" : "Yes, apply"}
              </button>
              <button type="button" class="clay press btn btn--fit t-muted" disabled={busy} onClick={() => setConfirm(null)}>
                No
              </button>
            </div>
          </div>
        ) : null}
        {saved ? (
          <button type="button" class="clay press btn t-danger" data-testid="plan-discard" onClick={() => setConfirm("discard")}>
            Discard plan
          </button>
        ) : null}
        {confirm === "discard" ? (
          <div class="callout" data-testid="discard-confirm">
            <p class="ex-card__meta l-m0">Discard this plan? {dayName} goes back to the program's default.</p>
            <div class="l-row l-gap-8">
              <button type="button" class="clay press btn btn--fit t-danger" onClick={() => void discard()}>
                Yes, discard
              </button>
              <button type="button" class="clay press btn btn--fit t-muted" onClick={() => setConfirm(null)}>
                No
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

const what = (s: AdviceSuggestion, name: (id: string) => string): string => {
  switch (s.type) {
    case "add":
      return `Add ${name(s.exercise_id)} · ${s.sets} sets, at #${s.position}`;
    case "remove":
      return `Remove ${name(s.exercise_id)}`;
    case "replace":
      return `Replace ${name(s.replace_exercise_id!)} with ${name(s.exercise_id)}`;
    case "reorder":
      return `Move ${name(s.exercise_id)} to #${s.position}`;
    case "sets":
      return `${name(s.exercise_id)}: ${s.sets} sets`;
  }
};

/** The advice in Persian (right-to-left); each suggestion changes the plan only through its Apply button. */
function AdviceCard({
  res,
  applied,
  names,
  onApply,
  onUndo,
}: {
  res: AdviceResponse;
  applied: Map<number, AppliedChange>;
  names: Map<string, { name_en: string }>;
  onApply: (i: number, s: AdviceSuggestion) => void;
  onUndo: (i: number) => void;
}) {
  const fromCandidates = new Map(res.candidates.map((c) => [c.id, c.name]));
  const name = (id: string) => names.get(id)?.name_en ?? fromCandidates.get(id) ?? id;
  return (
    <div class="l-col l-gap-10" data-testid="advice-card">
      <p class="fa prose-fa l-m0" dir="rtl" lang="fa" data-testid="advice-assessment">
        {res.advice.assessment_fa}
      </p>
      {res.advice.suggestions.length ? (
        <ul class="l-col list-plain">
          {res.advice.suggestions.map((s, i) => {
            const done = applied.has(i);
            return (
              <li class="list-row l-top" data-testid={`advice-sug-${i}`} data-type={s.type} data-applied={done ? "true" : "false"}>
                <span class="list-row__text">
                  <span class="t-title">
                    {what(s, name)} {done ? <span class="badge">Applied</span> : null}
                  </span>
                  <span class="fa prose-fa ex-card__meta" dir="rtl" lang="fa">
                    {s.reason_fa}
                  </span>
                </span>
                {done ? (
                  <button type="button" class="clay press btn-sm btn--fit t-muted" data-testid={`advice-undo-${i}`} onClick={() => onUndo(i)}>
                    Undo
                  </button>
                ) : (
                  <button type="button" class="clay press btn-sm btn--fit t-pink" data-testid={`advice-apply-${i}`} onClick={() => onApply(i, s)}>
                    Apply
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="caption l-m0">No changes suggested.</p>
      )}
    </div>
  );
}

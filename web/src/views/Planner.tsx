// Session planner (SPEC-v3 M9c): a planned session built from a program day. Replace, delete, add, reorder, edit
// sets/reps/rest and group, then Save (works offline through the outbox), Start session at the gym, Discard plan, or
// Apply to program (a new program version, after a confirm). Changes apply to this session only by default.

import { useEffect, useState } from "preact/hooks";
import { addItem, inPlan, isEdited, liveItems, planFromDay, planMinutes, removeItem, replaceItem, seqIds, type SessionPlan } from "../../../worker/lib/plan";
import type { ProgramDay } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { PlanList } from "../components/PlanList";
import { ApiError, NetworkError } from "../api";
import { fmtNum, plural } from "../format";
import { activeSession, dayInfo, openPlanFor } from "../model";
import { allExercises, applyPlanToProgram, discardPlan, flash, getState, navigate, openPlan, rememberExercise, savePlan, startPlan, useStore } from "../store";
import { ExercisePicker } from "./Library";

/** Unsaved planner edits, kept while the app is open (a tab switch does not lose them; Cancel does). */
const drafts = new Map<string, SessionPlan>();

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

  return (
    <>
      <section class="sess-head" data-testid="planner">
        <div class="sess-title">
          <div>
            <div class="eyebrow">Plan session</div>
            <b>{dayName}</b>
          </div>
          <span class={`pill${saved ? " done" : ""}`} data-testid="plan-state">
            {!saved ? "Not saved" : dirty ? "Unsaved changes" : edited ? "Planned · edited" : "Planned"}
          </span>
        </div>
        {day ? (
          <div class="why num" data-testid="plan-estimate">
            {plural(liveItems(plan).length, "exercise")} · about {fmtNum(planMinutes(plan, day))} min
          </div>
        ) : null}
        <div class="why">Changes apply to this session only. Nothing is timed until you start.</div>
      </section>

      <h2>Exercises</h2>
      <div class="stack">
        <PlanList
          plan={plan}
          exMap={exMap}
          mode="plan"
          onChange={change}
          onReplace={(it) => setPicking({ kind: "replace", itemId: it.id, name: exMap.get(it.exercise_id)?.name_en ?? it.exercise_id })}
          onRemove={(it) => change(removeItem(plan, it.id, new Date().toISOString()))}
        />
        {liveItems(plan).length ? null : <div class="empty">No exercises. Add one, or discard the plan.</div>}
        <button type="button" class="btn btn-ghost btn-block" data-testid="plan-add" onClick={() => setPicking({ kind: "add" })}>
          + Add exercise
        </button>
      </div>

      <div class="stack" style={{ marginTop: "16px" }}>
        <button type="button" class="btn btn-primary btn-block" data-testid="plan-start" disabled={!!act || !liveItems(plan).length} onClick={() => void start()}>
          Start session
        </button>
        {act ? <div class="why">Finish your open session first.</div> : null}
        <div class="row">
          <button type="button" class="btn btn-ghost" data-testid="plan-save" onClick={() => void save()}>
            Save plan
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => {
              done();
              navigate("home");
            }}
          >
            {dirty ? "Cancel" : "Back"}
          </button>
        </div>
        <button type="button" class="btn btn-ghost btn-block" data-testid="plan-apply" disabled={!day || !edited || busy} onClick={() => setConfirm("apply")}>
          Apply to program…
        </button>
        {confirm === "apply" ? (
          <div class="card stack" style={{ borderColor: "var(--accent)" }} data-testid="apply-confirm">
            <div>
              Make this the program's <b>{dayName}</b> from now on? A new program version becomes active; the current one is archived, not deleted. Your history does not change.
            </div>
            <div class="row">
              <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void apply()}>
                {busy ? "Applying…" : "Yes, apply"}
              </button>
              <button type="button" class="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>
                No
              </button>
            </div>
          </div>
        ) : null}
        {saved ? (
          <button type="button" class="btn btn-danger btn-block" data-testid="plan-discard" onClick={() => setConfirm("discard")}>
            Discard plan
          </button>
        ) : null}
        {confirm === "discard" ? (
          <div class="card stack" style={{ borderColor: "var(--danger)" }} data-testid="discard-confirm">
            <div>Discard this plan? {dayName} goes back to the program's default.</div>
            <div class="row">
              <button type="button" class="btn btn-danger" onClick={() => void discard()}>
                Yes, discard
              </button>
              <button type="button" class="btn btn-ghost" onClick={() => setConfirm(null)}>
                No
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

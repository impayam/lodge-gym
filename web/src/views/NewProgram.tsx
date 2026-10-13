// Settings → Program → New program (SPEC-v2 §8.6): generator inputs, the proposal with its weekly volume and warnings,
// editing (swap an exercise for one with the same pattern and primary muscle, change sets within the slot's range;
// the check re-runs after every edit), save as a draft, and approve. Generating and approving need the internet.

import { useEffect, useState } from "preact/hooks";
import { countsVolume } from "../../../worker/lib/category";
import {
  ALLOWED_DAYS,
  EQUIPMENT_OK,
  SEED_PRIORITY,
  SESSION_MINUTES,
  STYLES,
  STYLE_NAME,
  checkPlan,
  groupName,
  looksPerLeg,
  looksTimed,
  planFromEdits,
  programVolume,
  resolveStyle,
  weeklyTargets,
  type CheckResult,
  type EditedExercise,
  type EquipmentChoice,
  type GeneratorInput,
  type Plan,
  type PlanExercise,
  type ResolvedStyle,
  type Slot,
  type Style,
  type TargetGroup,
} from "../../../worker/lib/generator";
import { TARGET_GROUPS } from "../../../worker/lib/muscles";
import type { Exercise } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { errorText } from "../api";
import { dateShort, fmtNum, plural } from "../format";
import { activeProgramInfo, activeSession, programName, recentSwitch } from "../model";
import { allExercises, flash, generateProposal, loadLibrary, loadProgramVersions, navigate, saveProgramDraft, switchProgram, useStore } from "../store";
import { ExerciseThumb } from "./Library";
import { rirText, targetText } from "./Program";

const SLOT_LABEL: Readonly<Record<Slot, string>> = { main: "Main", secondary: "Secondary", accessory: "Accessory", isolation: "Isolation", core: "Core" };
const WEEKDAY_SLOTS = 7;
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] % 2_147_483_647;

function styleOption(s: Style): string {
  if (s === "auto") return "Auto (from the days)";
  const days = ALLOWED_DAYS[s];
  return `${STYLE_NAME[s]} (${days.length === 1 ? days[0] : `${days.slice(0, -1).join(", ")} or ${days[days.length - 1]}`} days)`;
}

const toEdited = (x: Pick<PlanExercise, "exercise_id" | "slot" | "sets" | "per_leg" | "is_time" | "superset_tag">): EditedExercise => ({
  exercise_id: x.exercise_id,
  slot: x.slot,
  sets: x.sets,
  per_leg: x.per_leg,
  is_time: x.is_time,
  superset_tag: x.superset_tag,
});

export function NewProgram() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const programId = useStore((s) => s.view.programId);
  useStore((s) => s.library);
  const active = activeProgramInfo(boot);
  const currentPriority = active?.params?.priority_muscles ?? SEED_PRIORITY;

  const [input, setInput] = useState<GeneratorInput>({
    days_per_week: active?.days_per_week ?? boot.program.days.length,
    style: "auto",
    session_minutes: 60,
    priority_muscles: [...currentPriority],
    avoid: [],
    equipment: "full_gym",
    seed: newSeed(),
  });
  const [draftId, setDraftId] = useState(() => programId ?? ulid());
  const [params, setParams] = useState<GeneratorInput | null>(null);
  const [days, setDays] = useState<{ exercises: EditedExercise[] }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [swapAt, setSwapAt] = useState<{ day: number; index: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void loadLibrary();
    if (!programId) return;
    setBusy(true);
    loadProgramVersions()
      .then((list) => {
        const p = list.find((x) => x.id === programId);
        if (!p || p.status !== "draft" || !p.params) return setMsg("This draft is no longer available.");
        setInput(p.params);
        setParams(p.params);
        setDays(p.days.map((d) => ({ exercises: d.exercises.map((x) => toEdited({ ...x, slot: x.slot ?? "accessory" })) })));
      })
      .catch((e) => setMsg(errorText(e)))
      .finally(() => setBusy(false));
  }, [programId]);

  const exMap = allExercises();
  let plan: Plan | null = null;
  let check: CheckResult | null = null;
  let targets: Record<TargetGroup, number> | null = null;
  if (params && days) {
    try {
      plan = planFromEdits(params, days);
      targets = weeklyTargets(programVolume(boot.program, exMap), currentPriority, params.priority_muscles);
      check = checkPlan(plan, exMap, targets);
    } catch (e) {
      plan = null;
    }
  }

  const generate = async (inp: GeneratorInput) => {
    setBusy(true);
    setMsg("");
    setSwapAt(null);
    setConfirming(false);
    try {
      const p = await generateProposal(inp);
      setParams(p.params);
      setDays(p.days.map((d) => ({ exercises: d.exercises.map(toEdited) })));
      window.scrollTo(0, 0);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const edit = (day: number, index: number, patch: Partial<EditedExercise>) => {
    setDays((list) => list && list.map((d, i) => (i !== day ? d : { exercises: d.exercises.map((x, k) => (k === index ? { ...x, ...patch } : x)) })));
    setConfirming(false);
  };

  const save = async () => {
    if (!params || !days) return null;
    const r = await saveProgramDraft({ id: draftId, params, days });
    return r;
  };

  const saveDraft = async () => {
    setBusy(true);
    setMsg("");
    try {
      await save();
      flash("Draft saved. Find it under Settings → Program.");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await save();
      if (r && r.check.violations.length) {
        setMsg(r.check.violations[0].message);
        return;
      }
      await switchProgram(draftId, "approve");
      flash("Your new program is active from the next session.");
      navigate("program");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!plan || !params || !days || !check || !targets)
    return (
      <>
        <button type="button" class="btn btn-ghost btn-small" onClick={() => navigate("settings")}>
          ← Settings
        </button>
        <h2>New program</h2>
        <Inputs input={input} setInput={setInput} exMap={exMap} />
        {msg ? (
          <div class="banner" role="alert">
            {msg}
          </div>
        ) : null}
        <button
          type="button"
          class="btn btn-primary btn-block"
          data-testid="np-generate"
          disabled={busy || !resolveStyle(input.style, input.days_per_week) || (input.style === "strength" && input.equipment !== "full_gym")}
          onClick={() => void generate({ ...input, seed: newSeed() })}
        >
          {busy ? "Working…" : "Make a proposal"}
        </button>
        <p class="why">Needs an internet connection. Nothing changes until you approve the program.</p>
      </>
    );

  const usedRole = new Map<string, Slot>();
  for (const d of plan.days) for (const x of d.exercises) if (!usedRole.has(x.exercise_id)) usedRole.set(x.exercise_id, x.slot);
  const historyIds = new Set(Object.values(sessions).flatMap((s) => s.sets.filter((x) => x.done).map((x) => x.exercise_id)));
  const alternatives = (day: number, x: PlanExercise): Exercise[] => {
    const cur = exMap.get(x.exercise_id);
    if (!cur) return [];
    const onDay = new Set(plan!.days[day].exercises.map((y) => y.exercise_id));
    return [...exMap.values()]
      .filter(
        (e) =>
          !e.archived_at &&
          countsVolume(e.category) &&
          e.pattern === cur.pattern &&
          e.muscle_primary === cur.muscle_primary &&
          EQUIPMENT_OK[params.equipment].has(e.equipment) &&
          !onDay.has(e.id) &&
          (usedRole.get(e.id) ?? x.slot) === x.slot
      )
      .sort((a, b) => Number(historyIds.has(b.id)) - Number(historyIds.has(a.id)) || a.name_en.localeCompare(b.name_en));
  };
  const switchedAt = recentSwitch(boot);
  const openSession = activeSession(sessions);
  const minutes = check.minutes;
  const name = `${STYLE_NAME[plan.style as ResolvedStyle]} · ${plan.days_per_week} days`;

  return (
    <>
      <button type="button" class="btn btn-ghost btn-small" onClick={() => (programId ? navigate("settings") : setDays(null))}>
        ← {programId ? "Settings" : "Change the inputs"}
      </button>
      <h2 data-testid="np-name">
        {name} <small>· {params.session_minutes} min sessions{programId ? " · draft" : ""}</small>
      </h2>
      <div class="card stack">
        <WeekStrip offsets={plan.days.map((d) => d.offset)} />
        <div class="why">
          {plural(plan.days_per_week, "session")} a week, about {fmtNum(Math.min(...minutes))}–{fmtNum(Math.max(...minutes))} min each. New programs start at full volume
          and the target RIR from the first session; weights continue from your last sessions.
        </div>
      </div>

      {check.violations.length ? (
        <div class="card issues bad" data-testid="np-violations" role="alert">
          <b>Fix before approving</b>
          <ul>
            {check.violations.map((v) => (
              <li>{v.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {check.warnings.length ? (
        <div class="card issues" data-testid="np-warnings">
          <b>Worth knowing</b>
          <ul>
            {check.warnings.map((w) => (
              <li>{w.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {plan.days.map((d, di) => (
        <section data-testid={`np-day-${di}`}>
          <h2>
            {d.name_en} <small>· about {fmtNum(minutes[di])} min</small>
          </h2>
          <div class="card prog-day">
            {d.exercises.map((x, k) => {
              const e = exMap.get(x.exercise_id);
              const swapping = swapAt?.day === di && swapAt.index === k;
              const alts = swapping ? alternatives(di, x) : [];
              return (
                <div class="np-item" data-ex={x.exercise_id}>
                  <div class="np-row">
                    <div class="np-meta">
                      <b>
                        <span class={`slotb s-${x.slot}`}>{SLOT_LABEL[x.slot]}</span>
                        {e?.name_en ?? x.exercise_id}
                        {x.superset_tag ? <span class="tag">{x.superset_tag}</span> : null}
                      </b>
                      <small>
                        {targetText(x)} · {rirText(x)} · rest {fmtNum(x.rest_sec)} s
                      </small>
                    </div>
                    <div class="np-ctl">
                      <span class="seg" role="group" aria-label={`Sets of ${e?.name_en ?? "exercise"}`}>
                        <button type="button" aria-label="One set less" data-testid={`np-minus-${di}-${k}`} disabled={x.sets <= x.set_range[0]} onClick={() => edit(di, k, { sets: x.sets - 1 })}>
                          −
                        </button>
                        <button type="button" aria-label="One set more" data-testid={`np-plus-${di}-${k}`} disabled={x.sets >= x.set_range[1]} onClick={() => edit(di, k, { sets: x.sets + 1 })}>
                          +
                        </button>
                      </span>
                      <button type="button" class="btn btn-ghost btn-small" data-testid={`np-swap-${di}-${k}`} aria-expanded={swapping} onClick={() => setSwapAt(swapping ? null : { day: di, index: k })}>
                        Swap
                      </button>
                    </div>
                  </div>
                  {swapping ? (
                    <div class="np-swap" data-testid="np-swap-list">
                      <div class="why">Same movement and main muscle{e ? ` as ${e.name_en}` : ""}:</div>
                      {alts.length ? (
                        alts.map((a) => (
                          <button
                            type="button"
                            class="exrow"
                            data-testid="np-swap-option"
                            data-id={a.id}
                            onClick={() => {
                              edit(di, k, { exercise_id: a.id, is_time: looksTimed(a), per_leg: looksPerLeg(a) });
                              setSwapAt(null);
                            }}
                          >
                            <ExerciseThumb ex={a} />
                            <span class="meta">
                              <b>{a.name_en}</b>
                              <small>
                                {a.equipment}
                                {historyIds.has(a.id) ? " · you have done this" : ""}
                              </small>
                            </span>
                          </button>
                        ))
                      ) : (
                        <div class="empty">No other exercise in the library has the same movement and main muscle.</div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <h2>Weekly sets per muscle</h2>
      <div class="card">
        <table class="fields np-volume" data-testid="np-volume">
          <thead>
            <tr>
              <th>Muscle</th>
              <th>Planned</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {check.volume.map((v) => {
              const st = v.target ? (v.planned < 0.8 * v.target ? "under" : v.planned > 1.2 * v.target ? "over" : "on") : "on";
              return (
                <tr data-group={v.group} class={`vol-${st}`}>
                  <td>{groupName(v.group)}</td>
                  <td class="num">{fmtNum(v.planned)}</td>
                  <td class="num">{fmtNum(v.target)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p class="why">Fractional sets: a set counts 1 for its main muscle and 0.5 for a muscle it trains secondarily. Targets start from your current program.</p>
      </div>

      {msg ? (
        <div class="banner" role="alert" data-testid="np-msg">
          {msg}
        </div>
      ) : null}

      {confirming ? (
        <div class="card stack np-confirm" data-testid="np-confirm">
          <div>
            <b>{name}</b> becomes your program from the next session. {active ? <>“{programName(active)}” is archived; its sessions stay in History and you can switch back.</> : null}
          </div>
          {switchedAt ? (
            <div class="ss-note" data-testid="np-switch-notice">
              You last switched programs on {dateShort(switchedAt.slice(0, 10))}. Switching more than once in 3 weeks makes progress hard to judge.
            </div>
          ) : null}
          {openSession ? <div class="ss-note">Finish or delete the open session first.</div> : null}
          <div class="row">
            <button type="button" class="btn btn-primary" data-testid="np-confirm-yes" disabled={busy || !!openSession} onClick={() => void approve()}>
              {busy ? "Working…" : "Yes, start this program"}
            </button>
            <button type="button" class="btn btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div class="stack" style={{ marginTop: "12px" }}>
          <button type="button" class="btn btn-primary btn-block" data-testid="np-approve" disabled={busy || check.violations.length > 0} onClick={() => setConfirming(true)}>
            Approve program
          </button>
          <div class="row">
            <button type="button" class="btn btn-ghost" data-testid="np-save" disabled={busy} onClick={() => void saveDraft()}>
              Save draft
            </button>
            <button
              type="button"
              class="btn btn-ghost"
              data-testid="np-regenerate"
              disabled={busy}
              onClick={() => {
                setDraftId(programId ?? ulid());
                void generate({ ...params, seed: newSeed() });
              }}
            >
              Another proposal
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** The suggested week: which of seven days are training days. */
function WeekStrip({ offsets }: { offsets: number[] }) {
  return (
    <div class="weekstrip" aria-label={`Suggested week: training on days ${offsets.map((o) => o + 1).join(", ")} of 7`}>
      {Array.from({ length: WEEKDAY_SLOTS }, (_, i) => (
        <span class={offsets.includes(i) ? "on" : ""}>{offsets.includes(i) ? `Day ${offsets.indexOf(i) + 1}` : "Rest"}</span>
      ))}
    </div>
  );
}

function Inputs({ input, setInput, exMap }: { input: GeneratorInput; setInput: (f: (i: GeneratorInput) => GeneratorInput) => void; exMap: Map<string, Exercise> }) {
  const [q, setQ] = useState("");
  const set = (patch: Partial<GeneratorInput>) => setInput((i) => ({ ...i, ...patch }));
  const resolved = resolveStyle(input.style, input.days_per_week);
  const needle = q.trim().toLowerCase();
  const matches = needle
    ? [...exMap.values()].filter((e) => !e.archived_at && countsVolume(e.category) && !input.avoid.includes(e.id) && e.name_en.toLowerCase().includes(needle)).slice(0, 8)
    : [];
  return (
    <div class="card stack np-inputs">
      <div class="field">
        <span class="lbl">Days per week</span>
        <span class="seg wide" role="group" aria-label="Days per week">
          {[2, 3, 4, 5, 6].map((d) => (
            <button type="button" aria-pressed={input.days_per_week === d} data-testid={`np-days-${d}`} onClick={() => set({ days_per_week: d })}>
              {fmtNum(d)}
            </button>
          ))}
        </span>
      </div>
      <div class="field">
        <label for="np-style">Style</label>
        <select id="np-style" data-testid="np-style" value={input.style} onChange={(e) => set({ style: (e.currentTarget as HTMLSelectElement).value as Style })}>
          {STYLES.map((s) => (
            <option value={s}>{styleOption(s)}</option>
          ))}
        </select>
        <small class="why">
          {resolved
            ? input.style === "auto"
              ? `Auto picks ${STYLE_NAME[resolved]} for ${input.days_per_week} days.`
              : ""
            : `${STYLE_NAME[input.style as ResolvedStyle]} runs ${ALLOWED_DAYS[input.style as ResolvedStyle].join(" or ")} days a week.`}
        </small>
      </div>
      <div class="field">
        <span class="lbl">Session length</span>
        <span class="seg wide" role="group" aria-label="Session length">
          {SESSION_MINUTES.map((m) => (
            <button type="button" aria-pressed={input.session_minutes === m} onClick={() => set({ session_minutes: m })}>
              {fmtNum(m)} min
            </button>
          ))}
        </span>
      </div>
      <div class="field">
        <span class="lbl">Equipment</span>
        <span class="seg wide" role="group" aria-label="Equipment">
          {(
            [
              ["full_gym", "Full gym"],
              ["dumbbells", "Dumbbells only"],
            ] as [EquipmentChoice, string][]
          ).map(([v, label]) => (
            <button type="button" aria-pressed={input.equipment === v} onClick={() => set({ equipment: v })}>
              {label}
            </button>
          ))}
        </span>
        {input.style === "strength" && input.equipment !== "full_gym" ? <small class="why">The strength style needs a barbell: choose the full gym.</small> : null}
      </div>
      <fieldset class="chipset">
        <legend class="lbl">Priority muscles (+3 sets a week each)</legend>
        {TARGET_GROUPS.map((g) => (
          <label class="chipcheck">
            <input
              type="checkbox"
              checked={input.priority_muscles.includes(g)}
              onChange={(e) => {
                const on = (e.currentTarget as HTMLInputElement).checked;
                set({ priority_muscles: on ? [...input.priority_muscles, g] : input.priority_muscles.filter((x) => x !== g) });
              }}
            />
            {groupName(g)}
          </label>
        ))}
      </fieldset>
      <div class="field">
        <label for="np-avoid">Leave out (an injury, a machine your gym lacks)</label>
        <input id="np-avoid" class="search" type="search" placeholder="Search exercises" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
        {matches.length ? (
          <div class="exlist" style={{ marginTop: "6px" }}>
            {matches.map((e) => (
              <button
                type="button"
                class="exrow"
                onClick={() => {
                  set({ avoid: [...input.avoid, e.id] });
                  setQ("");
                }}
              >
                <span class="meta">
                  <b>{e.name_en}</b>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {input.avoid.length ? (
          <div class="chips">
            {input.avoid.map((id) => (
              <button type="button" class="chipcheck" aria-label={`Allow ${exMap.get(id)?.name_en ?? id} again`} onClick={() => set({ avoid: input.avoid.filter((x) => x !== id) })}>
                {exMap.get(id)?.name_en ?? id} ×
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

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
import { fmtNum, instantShort, plural } from "../format";
import { activeProgramInfo, activeSession, programName, recentSwitch } from "../model";
import { IconSearch } from "../components/PulseIcons";
import { ScreenHead } from "../components/ScreenHead";
import { Select } from "../components/Select";
import { LoadError, Loading } from "../components/States";
import { allExercises, flash, generateProposal, loadLibrary, loadProgramVersions, navigate, saveProgramDraft, switchProgram, useStore } from "../store";
import { EquipmentIcon, equipmentLabel } from "./Library";
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
  // Opening a saved draft: loading, or why it failed (with Retry).
  const [draftLoading, setDraftLoading] = useState(Boolean(programId));
  const [draftFailure, setDraftFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    void loadLibrary();
    if (!programId) return;
    setBusy(true);
    setDraftLoading(true);
    setDraftFailure(null);
    loadProgramVersions()
      .then((list) => {
        const p = list.find((x) => x.id === programId);
        if (!p || p.status !== "draft" || !p.params) return setMsg("This draft is no longer available.");
        setInput(p.params);
        setParams(p.params);
        setDays(p.days.map((d) => ({ exercises: d.exercises.map((x) => toEdited({ ...x, slot: x.slot ?? "accessory" })) })));
      })
      .catch((e) => setDraftFailure(e))
      .finally(() => {
        setBusy(false);
        setDraftLoading(false);
      });
  }, [programId, round]);

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
      <main class="page" data-testid="new-program-screen">
        <ScreenHead title="New program" sub="Settings" onBack={() => navigate("settings")} />
        {draftFailure !== null ? (
          <LoadError what="Couldn't open this draft." error={draftFailure} onRetry={() => setRound((n) => n + 1)} />
        ) : draftLoading ? (
          <Loading label="Opening the draft" heights={[220, 160]} />
        ) : (
          <Inputs input={input} setInput={setInput} exMap={exMap} />
        )}
        {msg ? (
          <p class="callout l-m0 ex-card__meta" data-bad="true" role="alert">
            <b class="t-orange">{msg}</b>
          </p>
        ) : null}
        <button
          type="button"
          class="clay press btn-lg t-pink"
          data-testid="np-generate"
          disabled={busy || draftFailure !== null || !resolveStyle(input.style, input.days_per_week) || (input.style === "strength" && input.equipment !== "full_gym")}
          onClick={() => void generate({ ...input, seed: newSeed() })}
        >
          {busy ? "Working…" : "Make a proposal"}
        </button>
        <p class="caption l-m0">Needs an internet connection. Nothing changes until you approve the program.</p>
      </main>
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

  const issues = (title: string, list: { message: string }[], testid: string, bad: boolean) => (
    <section class="callout" data-bad={String(bad)} data-testid={testid} role={bad ? "alert" : undefined}>
      <h2 class="card__title l-m0">{title}</h2>
      <ul class="prose-list ex-card__meta">
        {list.map((v) => (
          <li>{v.message}</li>
        ))}
      </ul>
    </section>
  );
  return (
    <main class="page" data-testid="new-program-screen">
      <ScreenHead
        title={<span data-testid="np-name">{name}</span>}
        sub={programId ? "Draft" : "Proposal"}
        backLabel={programId ? "Back to Settings" : "Change the inputs"}
        onBack={() => (programId ? navigate("settings") : setDays(null))}
      />
      <span class="ex-card__meta num">{params.session_minutes} min sessions</span>
      <section class="card l-col l-gap-10" aria-label="Suggested week">
        <WeekStrip offsets={plan.days.map((d) => d.offset)} />
        <p class="caption l-m0">
          {plural(plan.days_per_week, "session")} a week, about {fmtNum(Math.min(...minutes))}–{fmtNum(Math.max(...minutes))} min each. New programs start at full volume and the target RIR from
          the first session; weights continue from your last sessions.
        </p>
      </section>

      {check.violations.length ? issues("Fix before approving", check.violations, "np-violations", true) : null}
      {check.warnings.length ? issues("Worth knowing", check.warnings, "np-warnings", false) : null}

      {plan.days.map((d, di) => (
        <section class="l-col l-gap-8" data-testid={`np-day-${di}`} aria-label={d.name_en}>
          <h2 class="section-label num">
            {d.name_en} · about {fmtNum(minutes[di])} min
          </h2>
          <div class="card card--list">
            {d.exercises.map((x, k) => {
              const e = exMap.get(x.exercise_id);
              const swapping = swapAt?.day === di && swapAt.index === k;
              const alts = swapping ? alternatives(di, x) : [];
              const label = e?.name_en ?? x.exercise_id;
              return (
                <div class="list-row l-col l-top l-gap-8" data-testid="np-item" data-ex={x.exercise_id}>
                  <div class="l-row l-gap-8 l-full">
                    <span class="list-row__text">
                      <span class={x.slot === "main" ? "ex-card__kicker t-pink" : "ex-card__kicker"}>
                        {SLOT_LABEL[x.slot]}
                        {x.superset_tag ? <span class="t-violet"> · {x.superset_tag}</span> : null}
                      </span>
                      <span class="t-title">{label}</span>
                      <span class="caption num" data-testid="np-target">
                        {targetText(x)} · {rirText(x)} · rest {fmtNum(x.rest_sec)} s
                      </span>
                    </span>
                    <span class="plan-move" role="group" aria-label={`Sets of ${label}`}>
                      <button type="button" class="clay press t-muted" aria-label="One set less" data-testid={`np-minus-${di}-${k}`} disabled={x.sets <= x.set_range[0]} onClick={() => edit(di, k, { sets: x.sets - 1 })}>
                        −
                      </button>
                      <button type="button" class="clay press t-muted" aria-label="One set more" data-testid={`np-plus-${di}-${k}`} disabled={x.sets >= x.set_range[1]} onClick={() => edit(di, k, { sets: x.sets + 1 })}>
                        +
                      </button>
                    </span>
                    <button type="button" class="clay press btn-sm btn--fit t-muted" data-testid={`np-swap-${di}-${k}`} aria-expanded={swapping} onClick={() => setSwapAt(swapping ? null : { day: di, index: k })}>
                      Swap
                    </button>
                  </div>
                  {swapping ? (
                    <div class="l-col l-gap-8 l-full" data-testid="np-swap-list">
                      <span class="caption">Same movement and main muscle{e ? ` as ${e.name_en}` : ""}:</span>
                      {alts.length ? (
                        alts.map((a) => (
                          <button
                            type="button"
                            class="card press ex-row"
                            data-testid="np-swap-option"
                            data-id={a.id}
                            onClick={() => {
                              edit(di, k, { exercise_id: a.id, is_time: looksTimed(a), per_leg: looksPerLeg(a) });
                              setSwapAt(null);
                            }}
                          >
                            <span class={`well icon-well ${historyIds.has(a.id) ? "t-violet" : "icon-well--off"}`}>
                              <EquipmentIcon equipment={a.equipment} size={22} />
                            </span>
                            <span class="list-row__text">
                              <b class="t-title">{a.name_en}</b>
                              <span class="caption">
                                {equipmentLabel(a.equipment)}
                                {historyIds.has(a.id) ? " · you have done this" : ""}
                              </span>
                            </span>
                          </button>
                        ))
                      ) : (
                        <p class="state l-m0">No other exercise in the library has the same movement and main muscle.</p>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <h2 class="section-label">Weekly sets per muscle</h2>
      <section class="card l-col l-gap-10" aria-label="Weekly sets per muscle">
        <table class="data-table num" data-testid="np-volume">
          <thead>
            <tr>
              <th scope="col">Muscle</th>
              <th scope="col">Planned</th>
              <th scope="col">Target</th>
            </tr>
          </thead>
          <tbody>
            {check.volume.map((v) => {
              const st = v.target ? (v.planned < 0.8 * v.target ? "under" : v.planned > 1.2 * v.target ? "over" : "on") : "on";
              return (
                <tr data-group={v.group} data-status={st}>
                  <td>{groupName(v.group)}</td>
                  <td class={st === "on" ? "" : "t-orange"}>
                    {st === "under" ? <span aria-hidden="true">▼ </span> : st === "over" ? <span aria-hidden="true">▲ </span> : null}
                    {fmtNum(v.planned)}
                    {st === "on" ? null : <span class="l-sr">, {st === "under" ? "under target" : "over target"}</span>}
                  </td>
                  <td>{fmtNum(v.target)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p class="caption l-m0">Fractional sets: a set counts 1 for its main muscle and 0.5 for a muscle it trains secondarily. Targets start from your current program.</p>
      </section>

      {msg ? (
        <p class="callout l-m0 ex-card__meta" data-bad="true" role="alert" data-testid="np-msg">
          <b class="t-orange">{msg}</b>
        </p>
      ) : null}

      {confirming ? (
        <section class="callout" data-testid="np-confirm" aria-label="Approve program">
          <p class="ex-card__meta l-m0">
            <b>{name}</b> becomes your program from the next session. {active ? <>“{programName(active)}” is archived; its sessions stay in History and you can switch back.</> : null}
          </p>
          {switchedAt ? (
            <p class="ex-card__meta t-orange l-m0" data-testid="np-switch-notice">
              You last switched programs on {instantShort(switchedAt, boot.settings.timezone)}. Switching more than once in 3 weeks makes progress hard to judge.
            </p>
          ) : null}
          {openSession ? <p class="ex-card__meta t-orange l-m0">Finish or delete the open session first.</p> : null}
          <div class="l-row l-gap-8">
            <button type="button" class="clay press btn btn--fit t-pink" data-testid="np-confirm-yes" disabled={busy || !!openSession} onClick={() => void approve()}>
              {busy ? "Working…" : "Yes, start this program"}
            </button>
            <button type="button" class="clay press btn btn--fit t-muted" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </section>
      ) : (
        <div class="l-col l-gap-10">
          <button type="button" class="clay press btn-lg t-pink" data-testid="np-approve" disabled={busy || check.violations.length > 0} onClick={() => setConfirming(true)}>
            Approve program
          </button>
          <div class="l-row l-gap-8">
            <button type="button" class="clay press btn t-muted l-grow" data-testid="np-save" disabled={busy} onClick={() => void saveDraft()}>
              Save draft
            </button>
            <button
              type="button"
              class="clay press btn t-muted l-grow"
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
    </main>
  );
}

/** The suggested week: which of seven days are training days. */
function WeekStrip({ offsets }: { offsets: number[] }) {
  return (
    <div class="week-strip" role="img" aria-label={`Suggested week: training on days ${offsets.map((o) => o + 1).join(", ")} of 7`}>
      {Array.from({ length: WEEKDAY_SLOTS }, (_, i) => (
        <span data-on={offsets.includes(i) ? "true" : undefined}>{offsets.includes(i) ? `Day ${offsets.indexOf(i) + 1}` : "Rest"}</span>
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
  const toggle = <T,>(label: string, list: readonly [T, string][], value: T, pick: (v: T) => void, testid?: (v: T) => string) => (
    <span class="segmented l-full" role="group" aria-label={label}>
      {list.map(([v, text]) => (
        <button type="button" class="press l-grow" aria-pressed={value === v} data-testid={testid?.(v)} onClick={() => pick(v)}>
          {text}
        </button>
      ))}
    </span>
  );
  return (
    <section class="card l-col l-gap-14" aria-label="What the program should fit">
      <div class="form-field">
        <span class="form-field__label">Days per week</span>
        {toggle(
          "Days per week",
          [2, 3, 4, 5, 6].map((d) => [d, fmtNum(d)] as [number, string]),
          input.days_per_week,
          (d) => set({ days_per_week: d }),
          (d) => `np-days-${d}`
        )}
      </div>
      <div class="form-field">
        <label class="form-field__label" for="np-style">
          Style
        </label>
        <Select id="np-style" data-testid="np-style" value={input.style} onChange={(e) => set({ style: (e.currentTarget as HTMLSelectElement).value as Style })}>
          {STYLES.map((s) => (
            <option value={s}>{styleOption(s)}</option>
          ))}
        </Select>
        <span class="caption">
          {resolved
            ? input.style === "auto"
              ? `Auto picks ${STYLE_NAME[resolved]} for ${input.days_per_week} days.`
              : ""
            : `${STYLE_NAME[input.style as ResolvedStyle]} runs ${ALLOWED_DAYS[input.style as ResolvedStyle].join(" or ")} days a week.`}
        </span>
      </div>
      <div class="form-field">
        <span class="form-field__label">Session length</span>
        {toggle(
          "Session length",
          SESSION_MINUTES.map((m) => [m, `${fmtNum(m)} min`] as [GeneratorInput["session_minutes"], string]),
          input.session_minutes,
          (m) => set({ session_minutes: m })
        )}
      </div>
      <div class="form-field">
        <span class="form-field__label">Equipment</span>
        {toggle(
          "Equipment",
          [
            ["full_gym", "Full gym"],
            ["dumbbells", "Dumbbells only"],
          ] as [EquipmentChoice, string][],
          input.equipment,
          (v) => set({ equipment: v })
        )}
        {input.style === "strength" && input.equipment !== "full_gym" ? <span class="caption t-orange">The strength style needs a barbell: choose the full gym.</span> : null}
      </div>
      <fieldset class="form-field">
        <legend class="form-field__label">Priority muscles (+3 sets a week each)</legend>
        <div class="chip-wrap">
          {TARGET_GROUPS.map((g) => (
            <label class="check-chip">
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
        </div>
      </fieldset>
      <div class="form-field">
        <label class="form-field__label" for="np-avoid">
          Leave out (an injury, a machine your gym lacks)
        </label>
        <span class="search-field well">
          <IconSearch />
          <input id="np-avoid" class="search-field__input" type="search" placeholder="Search exercises" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
        </span>
        {matches.length ? (
          <div class="l-col">
            {matches.map((e) => (
              <button
                type="button"
                class="list-row press"
                onClick={() => {
                  set({ avoid: [...input.avoid, e.id] });
                  setQ("");
                }}
              >
                <span class="list-row__text t-title">{e.name_en}</span>
                <span class="caption">Leave out</span>
              </button>
            ))}
          </div>
        ) : null}
        {input.avoid.length ? (
          <div class="chip-wrap">
            {input.avoid.map((id) => (
              <button type="button" class="clay press chip" aria-label={`Allow ${exMap.get(id)?.name_en ?? id} again`} onClick={() => set({ avoid: input.avoid.filter((x) => x !== id) })}>
                {exMap.get(id)?.name_en ?? id} ×
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

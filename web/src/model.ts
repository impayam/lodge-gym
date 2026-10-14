// Session helpers built on the bootstrap data.

import { nextDay, restAdvised, versionAliases, weekRange } from "../../worker/lib/cycle";
import { lastPerformance, stepperIncrement, suggest, type Suggestion } from "../../worker/lib/progression";
import { localDate, zonedToUtcISO } from "../../worker/lib/time";
import type { DayExercise, Exercise, ProgramDay, ProgramInfo, SetEntry, WorkoutSession } from "../../worker/lib/types";
import { MAX_TWO_IN_A_ROW, STYLE_NAME, type ResolvedStyle } from "../../worker/lib/generator/model";
import { ulid } from "../../worker/lib/ulid";
import { addItem, groupLabels, isEdited, itemAsDayExercise, liveItems, planBlocks, seqIds, type PlanItem, type SessionPlan } from "../../worker/lib/plan";
import type { BootData } from "./localdb";

export const exerciseMap = (boot: BootData) => new Map(boot.exercises.map((e) => [e.id, e]));

/* ---------------- programs (SPEC-v2 M8) ---------------- */

/** The active program's metadata; a bootstrap cached before M8 has none. */
export const activeProgramInfo = (boot: BootData): ProgramInfo | null => (boot.programs ?? []).find((p) => p.status === "active") ?? null;

/** Planned sessions per week of the active program. */
/** The local date the first program was activated: when training in the app began (Me and Coach headers). */
export function trainingSince(boot: BootData): string | null {
  const starts = (boot.programs ?? []).flatMap((p) => p.activations.map((a) => localDate(boot.settings.timezone, a.started_at)));
  return starts.length ? starts.sort()[0] : null;
}

export const daysPerWeek = (boot: BootData) => activeProgramInfo(boot)?.days_per_week ?? boot.program.days.length;

export function styleLabel(style: string | null): string {
  if (style === "seed_full_body") return "Full body (original program)";
  if (style === "seed_upper_lower") return "Upper/lower (original program)";
  return style && style in STYLE_NAME ? STYLE_NAME[style as ResolvedStyle] : "Program";
}

/** English display name: the seed programs carry Persian names in data (SPEC §6), the UI stays English (SPEC-v2 M6). */
export function programName(p: Pick<ProgramInfo, "name" | "style"> | null | undefined, fallback = "Program"): string {
  if (!p) return fallback;
  if (p.style === "seed_full_body") return "Full body · 4 days";
  if (p.style === "seed_upper_lower") return "Upper/lower · 4 days";
  return p.name || fallback;
}

/** Full-body and strength weeks (and the seed programs) allow at most two training days in a row (§8.4); split days
 *  are sequenced instead. */
export function twoInARowRule(boot: BootData): boolean {
  const style = activeProgramInfo(boot)?.style ?? "seed_full_body";
  return style.startsWith("seed_") || MAX_TWO_IN_A_ROW.has(style as ResolvedStyle);
}

/** The latest program switch within the last 3 weeks (§8.5 "too many switches"), not counting the first activation. */
export function recentSwitch(boot: BootData, now = Date.now()): string | null {
  const starts = (boot.programs ?? []).flatMap((p) => p.activations.map((a) => a.started_at)).sort();
  const recent = starts.slice(1).filter((t) => now - Date.parse(t) < 21 * 86_400_000);
  return recent.length ? recent[recent.length - 1] : null;
}

export function dayInfo(boot: BootData, dayId: string): { id: string; name_en: string; legacy: boolean; position: number } {
  const d = boot.program.days.find((x) => x.id === dayId) ?? boot.other_days.find((x) => x.id === dayId);
  if (!d) return { id: dayId, name_en: dayId, legacy: true, position: 0 };
  return { id: d.id, name_en: d.name_en, legacy: d.program_id !== boot.program.id, position: d.position };
}

export const sortedSessions = (sessions: Record<string, WorkoutSession>) =>
  Object.values(sessions).sort((a, b) => (b.local_date + b.started_at).localeCompare(a.local_date + a.started_at));

export const activeSession = (sessions: Record<string, WorkoutSession>) => sortedSessions(sessions).find((s) => s.status === "active") ?? null;

export function homeModel(boot: BootData, sessions: Record<string, WorkoutSession>, today: string) {
  const all = Object.values(sessions);
  const next = nextDay(
    boot.program.days.map((d) => d.id),
    all,
    versionAliases(boot.programs ?? [], boot.other_days, boot.program.days)
  );
  const week = weekRange(today, boot.settings.week_start);
  const weekDone = all.filter((s) => s.status === "done" && s.local_date >= week.start && s.local_date <= week.end).length;
  return {
    next,
    rest: twoInARowRule(boot) && restAdvised(today, all),
    weekDone,
    recent: sortedSessions(sessions)
      .filter((s) => s.status === "done")
      .slice(0, 4),
  };
}

/* ---------------- session plans (SPEC-v3 M9c) ---------------- */

/** The open plan of a program day, if any. */
export const openPlanFor = (plans: Record<string, SessionPlan>, dayId: string) =>
  Object.values(plans).find((p) => p.status === "planned" && p.program_day_id === dayId) ?? null;

/** "Planned: Day 1 · Chest (edited)", or without the day name "Planned (edited)". */
export function plannedLabel(boot: BootData, plan: SessionPlan, withDay = true): string {
  const day = boot.program.days.find((d) => d.id === plan.program_day_id);
  return `Planned${withDay ? `: ${dayInfo(boot, plan.program_day_id).name_en}` : ""}${day && isEdited(plan, day) ? " (edited)" : ""}`;
}

/** The plan a session follows: the started plan with the session's id. */
export const sessionPlan = (plans: Record<string, SessionPlan>, sessionId: string) => {
  const p = plans[sessionId];
  return p && p.status === "started" ? p : null;
};

/** A started plan's workout session: same id, the plan's exercises and set counts in order; timed from now. */
export function sessionFromPlan(boot: BootData, plan: SessionPlan, today: string, now = new Date().toISOString()): WorkoutSession {
  const sets: SetEntry[] = [];
  for (const it of liveItems(plan))
    for (let i = 0; i < it.sets; i++)
      sets.push({ id: ulid(), exercise_id: it.exercise_id, set_index: i, weight: null, reps: null, seconds: null, done: false, updated_at: now });
  return {
    id: plan.id,
    program_day_id: plan.program_day_id,
    local_date: today,
    started_at: now,
    ended_at: null,
    status: "active",
    unit: boot.settings.unit,
    note: "",
    created_at: now,
    updated_at: now,
    source: "app",
    sets,
  };
}

/**
 * The plan to edit for a session (approved default 7): its started plan with any exercise added during the session
 * appended, or, for a session started without a plan, a new started plan with the session's id copying the session's
 * exercises, order and groups as they are.
 */
export function planForSession(boot: BootData, s: WorkoutSession, plan: SessionPlan | null, exMap: Map<string, Exercise>, now: string): SessionPlan {
  const blocks = sessionBlocks(boot, s, exMap, plan);
  if (plan) {
    let p = plan;
    // Same ids on every render until saved: "<plan id>-<n>", n after every item the plan ever had.
    for (const b of blocks)
      if (!b.itemId)
        p = addItem(p, b.ex.id, now, `${p.id}-${p.items.length + 1}`, { sets: clampSets(b.sets.length), is_time: b.plan.is_time, reps_min: null, reps_max: null, rest_sec: b.plan.rest_sec });
    return p;
  }
  const newId = seqIds(s.id);
  const items: PlanItem[] = blocks.map((b, i) => ({
    id: newId(),
    exercise_id: b.ex.id,
    position: i,
    sets: clampSets(b.extra ? b.sets.length : b.plan.sets),
    reps_min: b.extra ? null : b.plan.reps_min,
    reps_max: b.extra ? null : b.plan.reps_max,
    per_leg: b.plan.per_leg,
    is_time: b.plan.is_time,
    rest_sec: b.plan.rest_sec,
    target_rir_min: b.plan.target_rir_min,
    target_rir_max: b.plan.target_rir_max,
    origin: b.extra || b.plan.id.startsWith("extra_") ? "added" : "program",
    replaced_exercise_id: null,
    group_tag: b.group?.tag ?? null,
    group_rest_sec: b.group?.rest ?? null,
    removed_at: null,
    created_at: now,
    updated_at: now,
  }));
  return { id: s.id, program_day_id: s.program_day_id, status: "started", started_at: s.started_at, created_at: now, updated_at: now, items };
}

const clampSets = (n: number) => Math.min(10, Math.max(1, n));

export function newSession(boot: BootData, day: ProgramDay, today: string): WorkoutSession {
  const now = new Date().toISOString();
  const sets: SetEntry[] = [];
  for (const de of day.exercises)
    for (let i = 0; i < de.sets; i++)
      sets.push({ id: ulid(), exercise_id: de.exercise_id, set_index: i, weight: null, reps: null, seconds: null, done: false, updated_at: now });
  return {
    id: ulid(),
    program_day_id: day.id,
    local_date: today,
    started_at: now,
    ended_at: null,
    status: "active",
    unit: boot.settings.unit,
    note: "",
    created_at: now,
    updated_at: now,
    source: "app",
    sets,
  };
}

/** A superset or tri-set in a session: its letter, the member's place in it, and the rest after a full round. */
export interface BlockGroup {
  tag: string;
  index: number;
  size: number;
  rest: number;
}

export interface ExerciseBlock {
  ex: Exercise;
  plan: DayExercise;
  sets: SetEntry[];
  /** Added during this session from the library (SPEC-v2 §7.3): no plan and no progression target. */
  extra: boolean;
  /** The session plan's item for this exercise (SPEC-v3 M9c), when the session follows a plan. */
  itemId: string | null;
  group: BlockGroup | null;
}

/**
 * Exercise cards for a session: the plan's exercises in order when the session follows one (SPEC-v3 M9c), otherwise
 * the day's exercises in order; then the exercises added during the session (by position), then any other exercise
 * present in the logged sets (e.g. imported history). Groups come from the plan, or from the day's superset tags.
 * @param exMap every known exercise (library plus bootstrap), so extra exercises resolve offline.
 */
export function sessionBlocks(boot: BootData, s: WorkoutSession, exMap: Map<string, Exercise> = exerciseMap(boot), plan: SessionPlan | null = null): ExerciseBlock[] {
  const day = boot.program.days.find((d) => d.id === s.program_day_id);
  const dayExercises = day ? day.exercises : [];
  const blocks: ExerciseBlock[] = [];
  const seen = new Set<string>();
  const setsOf = (id: string) => s.sets.filter((x) => x.exercise_id === id).sort((a, b) => a.set_index - b.set_index);
  if (plan) {
    const labels = groupLabels(plan);
    for (const b of planBlocks(plan))
      b.items.forEach((it, i) => {
        const ex = exMap.get(it.exercise_id);
        if (!ex) return;
        seen.add(it.exercise_id);
        const sets = setsOf(it.exercise_id);
        const label = labels.get(it.id) ?? null;
        const extra = sets.some((x) => x.is_extra);
        const slot = it.origin === "added" ? undefined : dayExercises.find((x) => x.exercise_id === (it.replaced_exercise_id ?? it.exercise_id));
        blocks.push({
          ex,
          plan: extra ? { ...extraPlan(it.exercise_id, sets), superset_tag: label } : itemAsDayExercise(it, label, slot),
          sets,
          extra,
          itemId: it.id,
          group: b.tag ? { tag: b.tag, index: i, size: b.items.length, rest: it.group_rest_sec ?? it.rest_sec ?? 90 } : null,
        });
      });
  } else {
    const ordered = [...dayExercises].sort((a, b) => a.position - b.position);
    for (const de of ordered) {
      const ex = exMap.get(de.exercise_id);
      if (!ex) continue;
      seen.add(de.exercise_id);
      blocks.push({ ex, plan: de, sets: setsOf(de.exercise_id), extra: false, itemId: null, group: null });
    }
    dayGroups(blocks);
  }
  const positionOf = (id: string) => {
    const p = s.sets.find((x) => x.exercise_id === id && x.is_extra)?.position;
    return p ?? Number.MAX_SAFE_INTEGER;
  };
  const extra = [...new Set(s.sets.map((x) => x.exercise_id))].filter((id) => !seen.has(id)).sort((a, b) => positionOf(a) - positionOf(b));
  for (const id of extra) {
    const ex = exMap.get(id);
    if (!ex) continue;
    const sets = setsOf(id);
    blocks.push({ ex, plan: extraPlan(id, sets), sets, extra: sets.some((x) => x.is_extra), itemId: null, group: null });
  }
  return blocks;
}

/** The stand-in plan of an exercise without one (added during the session, or imported): read from its sets. */
function extraPlan(id: string, sets: SetEntry[]): DayExercise {
  const maxReps = Math.max(0, ...sets.map((x) => x.reps ?? 0));
  const isTime = sets.some((x) => x.seconds != null) && !sets.some((x) => x.reps != null);
  return {
    id: `extra_${id}`,
    exercise_id: id,
    position: 99,
    sets: sets.length,
    reps_min: maxReps,
    reps_max: maxReps,
    per_leg: false,
    is_time: isTime,
    rest_sec: 90,
    superset_tag: null,
    is_main: false,
    target_rir_min: null,
    target_rir_max: null,
    slot: null,
  };
}

/** A day's supersets (A1, A2…) are groups in the session too: adjacent members of one letter, resting after the round
 *  for the longest planned rest of the members (approved default 4). */
function dayGroups(blocks: ExerciseBlock[]) {
  for (let i = 0; i < blocks.length; ) {
    const tag = blocks[i].plan.superset_tag?.[0] ?? null;
    let j = i + 1;
    while (tag && j < blocks.length && blocks[j].plan.superset_tag?.[0] === tag) j++;
    if (tag && j - i >= 2) {
      const members = blocks.slice(i, j);
      const rest = Math.max(...members.map((b) => b.plan.rest_sec));
      members.forEach((b, k) => (b.group = { tag, index: k, size: members.length, rest }));
    }
    i = j;
  }
}

export interface Guidance {
  last: ReturnType<typeof lastPerformance>;
  suggestion: Suggestion;
  /** Suggested weight to prefill (only when the last session used the same unit). */
  prefillWeight: number | null;
  prefillSeconds: number | null;
  step: number;
}

export function guidance(block: ExerciseBlock, s: WorkoutSession, sessions: Record<string, WorkoutSession>): Guidance {
  const last = lastPerformance(block.ex.id, Object.values(sessions), s.id);
  // An exercise added during the session has no progression target (SPEC-v2 §7.3).
  const suggestion: Suggestion = block.extra ? { kind: "none" } : suggest(block.plan, block.ex, last);
  let prefillWeight: number | null = null;
  if ((suggestion.kind === "weight" || suggestion.kind === "bodyweight") && suggestion.unit === s.unit) prefillWeight = suggestion.weight;
  const prefillSeconds = block.plan.is_time ? (suggestion.kind === "time" ? suggestion.seconds : block.plan.reps_max) : null;
  return { last, suggestion, prefillWeight, prefillSeconds, step: stepperIncrement(block.ex, s.unit) };
}

/** Re-anchors started_at/ended_at when the local date or times are edited. */
export function retime(s: WorkoutSession, tz: string, date: string, startHM: string, endHM: string | null): WorkoutSession {
  const started_at = zonedToUtcISO(date, startHM, tz);
  let ended_at: string | null = null;
  if (endHM) {
    ended_at = zonedToUtcISO(date, endHM, tz);
    if (Date.parse(ended_at) < Date.parse(started_at)) ended_at = zonedToUtcISO(addOne(date), endHM, tz);
  }
  return { ...s, local_date: date, started_at, ended_at };
}

function addOne(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

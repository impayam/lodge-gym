// AI plan advice (SPEC-v3 M9c "Get advice"), the pure part: the model's input for a planned session, the candidate
// list it may choose exercises from, the system prompt, the output schema, and the validation that drops suggestions
// whose exercise ids are not real (not in the candidate list, or not in the plan where they must be). The plan edits
// an Apply tap makes are in ./suggestions.ts (no Zod, so the PWA bundle stays small).

import { z } from "zod";
import { countsVolume } from "../category";
import { weekRange } from "../cycle";
import { groupOf, setContribution, TARGET_GROUPS } from "../muscles";
import { ADD_DEFAULTS, groupLabels, inPlan, liveItems, MAX_SETS, MIN_SETS, type SessionPlan } from "../plan";
import { balanceStatus, epley, muscleTargets, programOn, setsPerMuscle, type BalanceStatus, type ReportData } from "../reports";
import { addDays } from "../time";
import type { Exercise, ProgramDay, WorkoutSession } from "../types";
import { GROUP_NAME, sessionDay } from "./report";
import { SUGGESTION_TYPES, type AdviceSuggestion, type PlanAdvice, type SuggestionType } from "./suggestions";

export { applySuggestion, undoSuggestion, SUGGESTION_TYPES, type AdviceSuggestion, type AppliedChange, type PlanAdvice, type SuggestionType } from "./suggestions";

const round1 = (n: number) => Math.round(n * 10) / 10;
const rangeText = (min: number | null, max: number | null) => (min == null && max == null ? null : min === max || max == null ? String(min ?? max) : min == null ? String(max) : `${min}–${max}`);

/** Library exercises per discussed group in the candidate list (approved: the model only picks real exercises). */
export const CANDIDATES_PER_GROUP = 10;
/** Suggestions kept from one answer. */
export const MAX_SUGGESTIONS = 6;

export interface Candidate {
  id: string;
  name: string;
  equipment: string;
  primary_muscle: string;
  secondary_muscles: string[];
  category: string | null;
  mechanic: string | null;
  in_plan: boolean;
  last_done: string | null;
}

export interface AdviceInput {
  today: string;
  program_style: string | null;
  preferences: string[];
  plan: {
    program_day: string;
    exercises: { position: number; exercise_id: string; name: string; sets: number; reps: string | null; seconds: number | null; rest_sec: number | null; group: string | null; group_rest_sec: number | null }[];
  };
  original_day: { exercise_id: string; name: string; sets: number; reps: string | null; seconds: number | null; rest_sec: number; superset: string | null }[];
  recent_sessions: { date: string; program_day: string; exercises: { name: string; done_sets: number; best_set: string | null }[] }[];
  volume: { group: string; week_so_far: number; last_7_days: number; weekly_target: number; status_week_so_far: BalanceStatus; this_plan_adds: number }[];
  last_heavy_compound: { group: string; date: string; hours_ago: number; exercise: string }[];
  candidates: Candidate[];
}

const done = (d: ReportData) => d.sessions.filter((s) => s.status === "done");

/** One row of the recovery list: the last heavy compound lift of a muscle group and how long ago it ended. */
export interface HeavyCompound {
  group: string;
  date: string;
  hours_ago: number;
  exercise: string;
}

/**
 * Recovery for the 48-hour rule, shared by the planner advice and the coach (get_recovery): per report group, the last
 * heavy compound (a done compound set with load) over all of `sessions`, the most recent first. `now` is an instant.
 */
export function lastHeavyCompound(sessions: WorkoutSession[], ex: Map<string, Exercise>, now: string): HeavyCompound[] {
  const heavy = new Map<string, { s: WorkoutSession; id: string }>();
  for (const s of sessions) {
    for (const x of s.sets) {
      const e = ex.get(x.exercise_id);
      if (!x.done || !e || e.mechanic !== "compound" || !x.weight || x.weight <= 0) continue;
      const g = groupOf(e.muscle_primary);
      if (!g) continue;
      const prev = heavy.get(g);
      if (!prev || prev.s.started_at < s.started_at) heavy.set(g, { s, id: e.id });
    }
  }
  return [...heavy]
    .map(([g, v]) => ({ group: GROUP_NAME[g] ?? g, date: v.s.local_date, hours_ago: Math.max(0, Math.round((Date.parse(now) - Date.parse(v.s.ended_at ?? v.s.started_at)) / 3_600_000)), exercise: ex.get(v.id)?.name_en ?? v.id }))
    .sort((a, b) => a.hours_ago - b.hours_ago);
}

/**
 * The model's input for a planned session: the plan in order, the program day it came from, the last 14 days of done
 * sets, group volume (this week so far and the last 7 days) against the weekly targets, the last heavy compound per
 * group, the program style, Payam's preferences, and the candidate exercises.
 * @param library every library exercise (archived ones are skipped)
 */
export function buildAdviceInput(d: ReportData, plan: SessionPlan, library: Exercise[], now: string, today: string, style: string | null): AdviceInput {
  const ex = new Map(library.map((e) => [e.id, e]));
  for (const e of d.exercises) if (!ex.has(e.id)) ex.set(e.id, e);
  const name = (id: string) => ex.get(id)?.name_en ?? id;
  const day: ProgramDay | null = sessionDay(d, plan.program_day_id);
  const live = liveItems(plan);
  const labels = groupLabels(plan);
  const sessions = done(d);

  const from14 = addDays(today, -13);
  const recent = sessions.filter((s) => s.local_date >= from14 && s.local_date <= today).sort((a, b) => (a.local_date + a.started_at).localeCompare(b.local_date + b.started_at));
  const recent_sessions = recent.map((s) => {
    const ids = [...new Set(s.sets.filter((x) => x.done).map((x) => x.exercise_id))];
    return {
      date: s.local_date,
      program_day: sessionDay(d, s.program_day_id)?.name_en ?? s.program_day_id,
      exercises: ids.map((id) => {
        const sets = s.sets.filter((x) => x.exercise_id === id && x.done);
        const best = sets.filter((x) => x.weight && x.reps && x.weight > 0 && x.reps > 0).sort((a, b) => epley(b.weight!, b.reps!) - epley(a.weight!, a.reps!))[0];
        return { name: name(id), done_sets: sets.length, best_set: best ? `${best.weight} ${s.unit} × ${best.reps}` : null };
      }),
    };
  });

  // Volume against the weekly targets of the program active this week.
  const range = weekRange(today, d.settings.week_start);
  const targets = muscleTargets({ program: programOn(d, range.end).program, exercises: [...ex.values()] });
  const week = setsPerMuscle(sessions.filter((s) => s.local_date >= range.start && s.local_date <= range.end), ex);
  const last7 = setsPerMuscle(sessions.filter((s) => s.local_date >= addDays(today, -6) && s.local_date <= today), ex);
  const adds: Record<string, number> = {};
  for (const it of live) {
    const e = ex.get(it.exercise_id);
    if (!e || !countsVolume(e.category)) continue;
    for (const [g, w] of setContribution(e.muscle_primary, e.muscles_secondary)) adds[g] = (adds[g] ?? 0) + w * it.sets;
  }
  const volume = TARGET_GROUPS.map((g) => ({
    group: GROUP_NAME[g],
    week_so_far: round1(week[g].fractional),
    last_7_days: round1(last7[g].fractional),
    weekly_target: round1(targets[g] ?? 0),
    status_week_so_far: balanceStatus(week[g].fractional, targets[g] ?? 0),
    this_plan_adds: round1(adds[g] ?? 0),
  }));

  const last_heavy_compound = lastHeavyCompound(sessions, ex, now);

  const under = TARGET_GROUPS.filter((_, i) => volume[i].status_week_so_far === "under" || volume[i].status_week_so_far === "none");
  const candidates = candidateList(d, plan, [...ex.values()], under);

  return {
    today,
    program_style: style,
    preferences: [
      "Strength and balance.",
      "Chest is the current priority.",
      "No deloads, no light weeks, no intro weeks; he reduces sets himself when tired.",
      "He groups any 2–3 exercises as he likes; his own groups are accepted as they are.",
    ],
    plan: {
      program_day: day?.name_en ?? plan.program_day_id,
      exercises: live.map((it, i) => ({
        position: i + 1,
        exercise_id: it.exercise_id,
        name: name(it.exercise_id),
        sets: it.sets,
        reps: it.is_time ? null : rangeText(it.reps_min, it.reps_max),
        seconds: it.is_time ? it.reps_max : null,
        rest_sec: it.rest_sec,
        group: labels.get(it.id) ?? null,
        group_rest_sec: it.group_tag ? it.group_rest_sec : null,
      })),
    },
    original_day: [...(day?.exercises ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((x) => ({ exercise_id: x.exercise_id, name: name(x.exercise_id), sets: x.sets, reps: x.is_time ? null : rangeText(x.reps_min, x.reps_max), seconds: x.is_time ? x.reps_max : null, rest_sec: x.rest_sec, superset: x.superset_tag })),
    recent_sessions,
    volume,
    last_heavy_compound,
    candidates,
  };
}

/**
 * Real exercises the model may suggest: every exercise in the plan, then for each group the plan trains (primary or
 * secondary) and each targeted group under its weekly target, up to CANDIDATES_PER_GROUP strength exercises with that
 * primary group. Order: done before (most recent first), in the current program, compound before isolation, name.
 */
export function candidateList(d: ReportData, plan: SessionPlan, library: Exercise[], underGroups: readonly string[]): Candidate[] {
  const live = liveItems(plan);
  const byId = new Map(library.map((e) => [e.id, e]));
  const lastDone = new Map<string, string>();
  for (const s of done(d)) for (const x of s.sets) if (x.done && (lastDone.get(x.exercise_id) ?? "") < s.local_date) lastDone.set(x.exercise_id, s.local_date);
  const inProgram = new Set(d.program.days.flatMap((day) => day.exercises.map((x) => x.exercise_id)));
  const groups = new Set<string>(underGroups);
  for (const it of live) {
    const e = byId.get(it.exercise_id);
    if (e) for (const g of setContribution(e.muscle_primary, e.muscles_secondary).keys()) groups.add(g);
  }
  const row = (e: Exercise, inPlanNow: boolean): Candidate => ({
    id: e.id,
    name: e.name_en,
    equipment: e.equipment,
    primary_muscle: e.muscle_primary,
    secondary_muscles: e.muscles_secondary,
    category: e.category,
    mechanic: e.mechanic,
    in_plan: inPlanNow,
    last_done: lastDone.get(e.id) ?? null,
  });
  const out: Candidate[] = live.map((it) => byId.get(it.exercise_id)).filter((e): e is Exercise => !!e).map((e) => row(e, true));
  const taken = new Set(out.map((c) => c.id));
  const rank = (e: Exercise) => [lastDone.get(e.id) ? 0 : 1, inProgram.has(e.id) ? 0 : 1, e.mechanic === "compound" ? 0 : 1] as const;
  for (const g of [...TARGET_GROUPS, ...[...groups].filter((g) => !(TARGET_GROUPS as readonly string[]).includes(g))]) {
    if (!groups.has(g)) continue;
    const pool = library
      .filter((e) => !e.archived_at && countsVolume(e.category) && groupOf(e.muscle_primary) === g && !taken.has(e.id))
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
        const la = lastDone.get(a.id) ?? "";
        const lb = lastDone.get(b.id) ?? "";
        if (la !== lb) return lb.localeCompare(la);
        return a.name_en.localeCompare(b.name_en);
      })
      .slice(0, CANDIDATES_PER_GROUP);
    for (const e of pool) {
      taken.add(e.id);
      out.push(row(e, false));
    }
  }
  return out;
}

/* ---------------- model output ---------------- */

export const AdviceOutput = z.object({
  assessment_fa: z.string().min(1).max(1500).describe("2–4 sentences in Persian on the plan against recent training."),
  suggestions: z
    .array(
      z.object({
        // Checked per suggestion in validateAdvice (an unknown type drops that suggestion, not the answer).
        type: z.string().max(20).describe("add | remove | replace | reorder | sets"),
        exercise_id: z.string().max(100).describe("add: the new exercise (from candidates); replace: the new exercise (from candidates); remove, reorder, sets: the plan's exercise."),
        replace_exercise_id: z.string().max(100).nullable().describe("replace: the plan's exercise being replaced; otherwise null."),
        position: z.number().int().nullable().describe("add, reorder: 1-based place in the plan after the change; otherwise null."),
        sets: z.number().int().nullable().describe("add: number of sets; sets: the new number of sets; otherwise null."),
        reason_fa: z.string().min(1).max(400).describe("One sentence in Persian."),
      })
    )
    .describe("At most 5; empty when the plan is fine."),
});
export type AdviceOutput = z.infer<typeof AdviceOutput>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/**
 * Keeps the suggestions that can apply to this plan with real exercises: ids outside the candidate list are dropped,
 * as are adds/replacements of an exercise already in the plan, and removes/reorders/set changes of one not in it.
 * Positions and set counts are brought into range; duplicates and no-op changes go.
 */
export function validateAdvice(out: AdviceOutput, plan: SessionPlan, candidates: readonly Pick<Candidate, "id">[]): { advice: PlanAdvice; dropped: number } {
  const known = new Set(candidates.map((c) => c.id));
  const live = liveItems(plan);
  const n = live.length;
  const inIt = (id: string) => inPlan(plan, id);
  const seen = new Set<string>();
  const kept: AdviceSuggestion[] = [];
  for (const s of out.suggestions) {
    let v: AdviceSuggestion | null = null;
    if (!(SUGGESTION_TYPES as readonly string[]).includes(s.type)) continue;
    const base = { exercise_id: s.exercise_id, reason_fa: s.reason_fa.trim(), type: s.type as SuggestionType };
    if (!known.has(s.exercise_id)) v = null;
    else if (s.type === "add" && !inIt(s.exercise_id))
      v = { ...base, replace_exercise_id: null, position: clamp(s.position ?? n + 1, 1, n + 1), sets: clamp(s.sets ?? ADD_DEFAULTS.sets, MIN_SETS, MAX_SETS) };
    else if (s.type === "remove" && inIt(s.exercise_id)) v = { ...base, replace_exercise_id: null, position: null, sets: null };
    else if (s.type === "replace" && !inIt(s.exercise_id) && s.replace_exercise_id && known.has(s.replace_exercise_id) && inIt(s.replace_exercise_id))
      v = { ...base, replace_exercise_id: s.replace_exercise_id, position: null, sets: null };
    else if (s.type === "reorder" && inIt(s.exercise_id) && s.position != null) {
      const to = clamp(s.position, 1, n);
      if (live.findIndex((it) => it.exercise_id === s.exercise_id) + 1 !== to) v = { ...base, replace_exercise_id: null, position: to, sets: null };
    } else if (s.type === "sets" && inIt(s.exercise_id) && s.sets != null) {
      const sets = clamp(s.sets, MIN_SETS, MAX_SETS);
      if (live.find((it) => it.exercise_id === s.exercise_id)!.sets !== sets) v = { ...base, replace_exercise_id: null, position: null, sets };
    }
    if (!v) continue;
    const key = `${v.type}|${v.exercise_id}|${v.replace_exercise_id}|${v.position}|${v.sets}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(v);
  }
  return { advice: { assessment_fa: out.assessment_fa.trim(), suggestions: kept.slice(0, MAX_SUGGESTIONS) }, dropped: out.suggestions.length - Math.min(kept.length, MAX_SUGGESTIONS) };
}

export const ADVICE_SYSTEM = `You advise Payam on one planned gym session before he trains, for the GYM time app. He tapped "Get advice"; he decides.

Rules:
- Write assessment_fa and every reason_fa in Persian (Farsi). Exercise names may stay in English.
- Be honest and concise: 2–4 sentences of assessment, one sentence per suggestion.
- Evaluate the plan against his recent training, using only the numbers in the input:
  - weekly volume per group against its weekly target (volume, with what this plan adds);
  - recovery: no heavy compound for a muscle group within 48 hours of the last one (last_heavy_compound.hours_ago);
  - order: heavy compounds first, isolation last;
  - balance: pulling volume at least equal to pushing volume.
- Suggest complementary work only when it is needed, e.g. "chest today and triceps is under target this week, so add X after the presses".
- Respect his choices: advise, never insist. When the plan is fine, say so and return no suggestions. At most 5 suggestions.
- His own supersets and tri-sets (plan.exercises[].group) are accepted as they are, including same-muscle groups: never criticize them or suggest changing them. You may mention a grouping idea in the assessment only for non-competing muscles (e.g. chest + back, biceps + triceps).
- No deloads, no light weeks, no reducing volume for rest. No medical advice.
- Every exercise_id must come from the candidates list, exactly as written. Suggestion types:
  - add: exercise_id = the new exercise (not already in the plan), position = its 1-based place in the plan after adding, sets = number of sets;
  - remove: exercise_id = an exercise in the plan;
  - replace: exercise_id = the new exercise (not in the plan), replace_exercise_id = the plan exercise it replaces;
  - reorder: exercise_id = an exercise in the plan, position = its new 1-based place;
  - sets: exercise_id = an exercise in the plan, sets = the new number of sets.
  Fields a type does not use are null.`;


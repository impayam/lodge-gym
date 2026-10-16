// The coach's program draft (SPEC-v9 M12 §4, propose_program, approved 2026-10-15): validated with Zod, exercise ids
// not in the library (or archived) dropped and reported back to the model, and the draft's own weekly sets against the
// current targets. Nothing is stored by the tool: "Add to Planner" saves the cleaned draft as an inactive program
// (generated_by 'coach') under Me → Program → Drafts; approving it stays a separate tap there.

import { z } from "zod";
import { checkPlan, dayMinutes, groupName, type Plan } from "../generator/check";
import { isHeavyHinge } from "../generator/pick";
import type { TargetGroup } from "../generator/model";
import type { Exercise } from "../types";
import { groupOf, isTargetGroup, setContribution, TARGET_GROUPS } from "../muscles";
import { countsVolume } from "../category";
import { muscleTargets, programOn, type ReportData } from "../reports";
import { GROUP_NAME } from "../ai/report";
import { daysBetween, weekday } from "../time";

const GROUP_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export const PROPOSE_PROGRAM_TOOL = {
  name: "propose_program",
  description:
    'Show Payam a program draft as a card with "Add to Planner" and "Change". Nothing is saved until he taps Add to Planner, and his active program is never replaced. Use only exercise ids from get_library; unknown ids are dropped.',
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 60, description: 'Short program name, e.g. "Chest priority · 4 days".' },
      summary_fa: { type: "string", maxLength: 400, description: "One or two Persian sentences on what the draft changes and why." },
      days: {
        type: "array",
        minItems: 1,
        maxItems: 7,
        items: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 40, description: 'E.g. "Day 1 · Chest".' },
            exercises: {
              type: "array",
              minItems: 1,
              maxItems: 12,
              items: {
                type: "object",
                properties: {
                  exercise_id: { type: "string" },
                  sets: { type: "integer", minimum: 1, maximum: 10 },
                  reps_min: { type: "integer", minimum: 1, maximum: 600, description: "Reps, or seconds when is_time." },
                  reps_max: { type: "integer", minimum: 1, maximum: 600 },
                  is_time: { type: "boolean" },
                  per_leg: { type: "boolean" },
                  rest_sec: { type: "integer", minimum: 0, maximum: 600 },
                  group: { type: ["string", "null"], enum: ["A", "B", "C", "D", "E", "F", null], description: "Same letter for 2-3 consecutive exercises done as a superset or tri-set." },
                  is_main: { type: "boolean", description: "The day's main lift; at most one per day." },
                  target_rir_min: { type: ["integer", "null"], minimum: 0, maximum: 4 },
                  target_rir_max: { type: ["integer", "null"], minimum: 0, maximum: 4 },
                },
                required: ["exercise_id", "sets", "reps_min", "reps_max", "rest_sec"],
                additionalProperties: false,
              },
            },
          },
          required: ["name", "exercises"],
          additionalProperties: false,
        },
      },
    },
    required: ["name", "days"],
    additionalProperties: false,
  },
} as const;

const draftExercise = z
  .object({
    exercise_id: z.string().min(1).max(120),
    sets: z.number().int().min(1).max(10),
    reps_min: z.number().int().min(1).max(600),
    reps_max: z.number().int().min(1).max(600),
    is_time: z.boolean().optional(),
    per_leg: z.boolean().optional(),
    rest_sec: z.number().int().min(0).max(600),
    group: z.enum(GROUP_LETTERS).nullable().optional(),
    is_main: z.boolean().optional(),
    target_rir_min: z.number().int().min(0).max(4).nullable().optional(),
    target_rir_max: z.number().int().min(0).max(4).nullable().optional(),
  })
  .strict();

const draftDay = z.object({ name: z.string().trim().min(1).max(40), exercises: z.array(draftExercise).min(1).max(12) }).strict();

export const draftSchema = z
  .object({ name: z.string().trim().min(1).max(60), summary_fa: z.string().max(400).optional(), days: z.array(draftDay).min(1).max(7) })
  .strict()
  .superRefine((draft, ctx) => {
    draft.days.forEach((day, di) => {
      const where = `days.${di} (${day.name})`;
      day.exercises.forEach((x, xi) => {
        if (x.reps_min > x.reps_max) ctx.addIssue({ code: "custom", message: `${where}, exercise ${xi + 1}: reps_min is above reps_max.` });
        const a = x.target_rir_min ?? null;
        const b = x.target_rir_max ?? null;
        if ((a == null) !== (b == null)) ctx.addIssue({ code: "custom", message: `${where}, exercise ${xi + 1}: give both target_rir_min and target_rir_max, or neither.` });
        else if (a != null && b != null && a > b) ctx.addIssue({ code: "custom", message: `${where}, exercise ${xi + 1}: target_rir_min is above target_rir_max.` });
      });
      if (day.exercises.filter((x) => x.is_main).length > 1) ctx.addIssue({ code: "custom", message: `${where}: at most one is_main exercise per day.` });
      for (const letter of new Set(day.exercises.map((x) => x.group).filter(Boolean))) {
        const at = day.exercises.flatMap((x, i) => (x.group === letter ? [i] : []));
        const consecutive = at.every((i, k) => k === 0 || i === at[k - 1] + 1);
        if (at.length < 2 || at.length > 3 || !consecutive) ctx.addIssue({ code: "custom", message: `${where}: group ${letter} must be 2-3 consecutive exercises.` });
      }
    });
  });

export type DraftInput = z.infer<typeof draftSchema>;
export type DraftExercise = z.infer<typeof draftExercise>;

/** A draft with every exercise in the library, ready to show and to save. */
export interface CleanDraft {
  name: string;
  summary_fa: string | null;
  days: { name: string; exercises: DraftExercise[] }[];
}

export interface Dropped {
  day: string;
  exercise_id: string;
  reason: "not in the library" | "archived";
}

export type ProposeResult =
  | {
      ok: true;
      draft: CleanDraft;
      result: {
        shown: true;
        draft_id: string;
        days: number;
        exercises: number;
        /** The English name of every kept exercise; the card shows names, and the phone may not have the library. */
        names: Record<string, string>;
        /** Each day's estimated length (minutes), shown as information; drafts have no length limit. */
        day_minutes: number[];
        /** The program generator's check, as advice only: shown under the card, never blocking Add to Planner. */
        warnings: string[];
        dropped: Dropped[];
        weekly_sets: { group: string; name: string; planned: number; current_target: number }[];
      };
    }
  | { ok: false; error: string };

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The generator's checks that need no weekdays (Payam, 2026-10-15), as advice. Left out: the day length (no limit for
 * drafts; each day's estimate is shown as information instead), the 1×/week note (it names a generator style), set
 * ranges (generator slots) and the weekday rules, which draftSpacing below runs on the day order instead.
 */
const DRAFT_CHECKS = new Set(["not_strength", "duplicate", "two_roles", "squat_deadlift_mains", "session_cap", "pull_push", "no_hinge", "no_squat", "rear_delts", "floor", "under_target", "over_target"]);

function draftChecks(days: CleanDraft["days"], ex: ReadonlyMap<string, Exercise>, targets: Record<string, number>): string[] {
  const plan: Plan = {
    style: "full_body", // read only by checks a draft skips
    days_per_week: days.length,
    session_minutes: Number.POSITIVE_INFINITY, // drafts get no length warning
    days: days.map((day, i) => ({
      name_en: day.name,
      kind: "full",
      offset: i, // read only by the weekday checks a draft skips
      exercises: day.exercises.map((x) => ({
        exercise_id: x.exercise_id,
        slot: x.is_main ? "main" : "accessory",
        sets: x.sets,
        reps_min: x.reps_min,
        reps_max: x.reps_max,
        rest_sec: x.rest_sec,
        target_rir_min: x.target_rir_min ?? 0,
        target_rir_max: x.target_rir_max ?? 0,
        per_leg: x.per_leg ?? false,
        is_time: x.is_time ?? false,
        superset_tag: null,
        set_range: [1, 10] as const,
      })),
    })),
  };
  const r = checkPlan(plan, ex, targets as Record<TargetGroup, number>);
  return [...r.violations, ...r.warnings].filter((i) => DRAFT_CHECKS.has(i.code)).map((i) => i.message);
}

/**
 * The generator's spacing rules on the draft's day order, as advice only (Payam, 2026-10-15). A draft has no weekdays;
 * his days run Day 1 → 2 → 3 → 4 and again, so two adjacent days (and the last day and Day 1) may fall on consecutive
 * calendar days: the warning is conditional. When this week has planned gym sessions (calendar, SPEC-v10 §10), their
 * real dates replace that guess: `planned` maps a day's position (Day 1 = 1) to its planned date, a pair planned on
 * consecutive days gets a plain warning and a pair planned apart none.
 */
export function draftSpacing(days: CleanDraft["days"], ex: ReadonlyMap<string, Exercise>, planned: ReadonlyMap<number, string> = new Map()): string[] {
  const groupOfEx = (id: string) => {
    const g = groupOf(ex.get(id)?.muscle_primary);
    return g && isTargetGroup(g) ? (g as TargetGroup) : null;
  };
  const names = (list: Iterable<TargetGroup>) => [...list].map(groupName).join(", ");
  const pairs: [number, number][] = days.slice(1).map((_, i) => [i, i + 1]);
  if (days.length >= 3) pairs.push([days.length - 1, 0]);
  const out: string[] = [];
  const weekdayOf = (date: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(date)];
  for (const [a, b] of pairs) {
    const [da, db] = [planned.get(a + 1), planned.get(b + 1)];
    if (da && db && Math.abs(daysBetween(da, db)) !== 1) continue;
    const lead = da && db ? `Day ${a + 1} (${weekdayOf(da)}) and Day ${b + 1} (${weekdayOf(db)}) are planned on consecutive days:` : `If you train Day ${a + 1} and Day ${b + 1} back to back,`;
    const mains = (i: number) => new Set(days[i].exercises.filter((x) => x.is_main).map((x) => groupOfEx(x.exercise_id)).filter((g): g is TargetGroup => g !== null));
    const direct = (i: number) => new Set(days[i].exercises.map((x) => groupOfEx(x.exercise_id)).filter((g): g is TargetGroup => g !== null));
    const hinge = (i: number) => days[i].exercises.some((x) => {
      const e = ex.get(x.exercise_id);
      return e !== undefined && isHeavyHinge(e);
    });
    if (hinge(a) && hinge(b)) out.push(`${lead} that is two heavy hinges within 24 h.`);
    const bothMain = [...mains(a)].filter((g) => mains(b).has(g));
    if (bothMain.length) out.push(`${lead} ${names(bothMain)} ${bothMain.length > 1 ? "have" : "has"} a main lift on both days.`);
    const bothDays = [...direct(a)].filter((g) => direct(b).has(g) && !bothMain.includes(g));
    if (bothDays.length) out.push(`${lead} ${names(bothDays)} ${bothDays.length > 1 ? "are" : "is"} trained on both days.`);
  }
  return out;
}

/**
 * Validates a draft, drops exercises that are not in the library (or archived), re-checks groups that lost a member,
 * and computes its weekly sets against the current targets. `draftId` becomes the program id on Add to Planner.
 */
export function proposeProgram(d: Pick<ReportData, "exercises" | "program" | "programs" | "settings">, input: unknown, draftId: string, today?: string, plannedDates?: ReadonlyMap<number, string>): ProposeResult {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") };
  const ex = new Map(d.exercises.map((e) => [e.id, e]));
  const dropped: Dropped[] = [];
  const days = parsed.data.days.flatMap((day) => {
    const kept = day.exercises.filter((x) => {
      const e = ex.get(x.exercise_id);
      if (e && !e.archived_at) return true;
      dropped.push({ day: day.name, exercise_id: x.exercise_id, reason: e ? "archived" : "not in the library" });
      return false;
    });
    // A group left with one exercise after a drop is no longer a group.
    const exercises = kept.map((x) => ({ ...x, group: x.group && kept.filter((y) => y.group === x.group).length >= 2 ? x.group : null }));
    return exercises.length ? [{ name: day.name, exercises }] : [];
  });
  if (!days.length) return { ok: false, error: `No exercise of the draft is in the library (dropped: ${dropped.map((x) => x.exercise_id).join(", ")}). Use ids from get_library.` };

  const planned: Record<string, number> = Object.fromEntries(TARGET_GROUPS.map((g) => [g, 0]));
  for (const day of days)
    for (const x of day.exercises) {
      const e = ex.get(x.exercise_id)!;
      if (!countsVolume(e.category)) continue;
      for (const [g, w] of setContribution(e.muscle_primary, e.muscles_secondary)) if (g in planned) planned[g] += w * x.sets;
    }
  const scored = today ? programOn(d as ReportData, today).program : d.program;
  const targets = muscleTargets({ program: scored, exercises: d.exercises });
  return {
    ok: true,
    draft: { name: parsed.data.name, summary_fa: parsed.data.summary_fa ?? null, days },
    result: {
      shown: true,
      draft_id: draftId,
      days: days.length,
      exercises: days.reduce((a, x) => a + x.exercises.length, 0),
      names: Object.fromEntries(days.flatMap((day) => day.exercises.map((x) => [x.exercise_id, ex.get(x.exercise_id)!.name_en]))),
      day_minutes: days.map((day) => dayMinutes({ exercises: day.exercises })),
      warnings: [...draftChecks(days, ex, targets), ...draftSpacing(days, ex, plannedDates)],
      dropped,
      weekly_sets: TARGET_GROUPS.map((g) => ({ group: g, name: GROUP_NAME[g], planned: round1(planned[g]), current_target: round1(targets[g] ?? 0) })),
    },
  };
}

/** Day rows of a saved coach draft: superset tags A1, A2 … in order within each group; minutes as the generator counts. */
export function draftDayRows(draft: CleanDraft) {
  return draft.days.map((day) => {
    const seen = new Map<string, number>();
    const exercises = day.exercises.map((x, i) => {
      const n = x.group ? (seen.get(x.group) ?? 0) + 1 : 0;
      if (x.group) seen.set(x.group, n);
      return {
        position: i + 1,
        exercise_id: x.exercise_id,
        sets: x.sets,
        reps_min: x.reps_min,
        reps_max: x.reps_max,
        per_leg: x.per_leg ?? false,
        is_time: x.is_time ?? false,
        rest_sec: x.rest_sec,
        superset_tag: x.group ? `${x.group}${n}` : null,
        is_main: x.is_main ?? false,
        target_rir_min: x.target_rir_min ?? null,
        target_rir_max: x.target_rir_max ?? null,
      };
    });
    return { name: day.name, est_minutes: dayMinutes({ exercises }), exercises };
  });
}

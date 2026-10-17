// Coach tool suggest_replacements (SPEC-v11 Phase B, Payam 2026-10-17): the due line on the Program screen opens the
// Coach with an exercise that is due for a change. The coach says which region it has trained these weeks, then
// suggests 2–3 replacements; Payam picks one through the one-exercise card (propose_exercise with
// replaces_exercise_id: "Only this session" or "Whole program"). The app picks the candidates by the rotation rules:
//   - a different region of the same muscle (for a muscle with one region: the same region with other equipment);
//   - a main lift stays a barbell variation that can be loaded heavy (main lifts stay barbell); a secondary lift stays
//     a compound lift of the same pattern; other work stays the same kind (isolation, core);
//   - nothing he used in the last 8 weeks and nothing in his program already;
//   - a region with no main-focus exercise in his program first, then the block's equipment mix, then known
//     exercises, then curated sources.
// Each candidate comes with the facts the coach explains it by: the region it adds, whether that region is a gap, and
// the equipment's role (barbell: strength and easy load progression; dumbbell and cable: a region, angle or stretch).
// Pure; nothing changes before his tap.

import { z } from "zod";
import { countsVolume } from "../category";
import { blockLetter, blockMix, currentBlock, equipKind, EQUIPMENT_ROLES, mixFamilyOf, type EquipmentChoice } from "../generator";
import { regionCoverage } from "../generator/check";
import { EQUIPMENT_OK, isOlympicLift, mainLiftOk, sourceRank, type Candidate } from "../generator/pick";
import { groupOf } from "../muscles";
import { REGION_INFO, type Region } from "../regions";
import { bestSet } from "../reports";
import { dueText, programRotation, type RotationStatus } from "../rotation";
import { addDays } from "../time";
import type { DayExercise, Exercise, ProgramDay } from "../types";
import type { CoachData, ToolOutcome } from "./tools";

/** Suggestions one call returns. */
export const REPLACEMENTS = 3;
/** A replacement is never an exercise he used in this many days (8 weeks). */
export const RECENT_DAYS = 56;

export const SUGGEST_REPLACEMENTS_TOOL = {
  name: "suggest_replacements",
  description:
    "Replacements for one exercise of his active program that is due for a change (the due line on the Program screen) or that he wants to change: up to 3 from the library, chosen by the app's rotation rules. Each trains a different region of the same muscle (for a muscle with one region: the same region with other equipment); a main lift stays a barbell variation; nothing he used in the last 8 weeks. Each comes with its main-focus regions, the regions it fills that have no main-focus exercise in his program now, what changes (region or equipment), the equipment's role and whether he has done it. The result also gives the exercise's own rotation facts (weeks in the program, due and why), its region tags and, for loaded lifts, its e1RM trend since it entered the program. Then call propose_exercise once per replacement with replaces_exercise_id.",
  input_schema: {
    type: "object",
    properties: { exercise_id: { type: "string", description: "An exercise id of his active program, from get_program or the CONTEXT block." } },
    required: ["exercise_id"],
    additionalProperties: false,
  },
} as const;

const input = z.object({ exercise_id: z.string().min(1) }).strict();

/** A region tag as the coach reads it. */
export interface RegionView {
  region: Region;
  label: string;
  evidence: "strong" | "moderate" | "weak";
}

export const regionView = (ex: Pick<Exercise, "regions">, emphasis: "primary" | "secondary"): RegionView[] =>
  ex.regions.filter((r) => r.emphasis === emphasis).map((r) => ({ region: r.region, label: REGION_INFO[r.region].label, evidence: r.evidence }));

/** The equipment's role for the exercise's muscle (the approved table): why this equipment fits. */
export function equipmentRole(ex: Pick<Exercise, "equipment" | "name_en" | "muscle_primary">): string {
  const family = mixFamilyOf(ex.muscle_primary);
  const kind = equipKind(ex);
  const role = family ? EQUIPMENT_ROLES[family][kind] : undefined;
  const general = kind === "barbell" ? "strength and easy load progression" : kind === "dumbbell" || kind === "cable" ? "a specific region, angle or stretch" : kind === "machine" ? "a stable path, safe close to failure" : "load from bodyweight, reps or a hold";
  return role ? `${role} (${general})` : general;
}

/** The active program's days, in order. */
const activeDays = (d: CoachData): ProgramDay[] => {
  const info = (d.programs ?? []).find((p) => p.status === "active") ?? null;
  return [...(info?.days ?? d.program.days)].sort((a, b) => a.position - b.position);
};

/** The rotation status of the active program as of today. */
export const rotationOf = (d: CoachData): RotationStatus[] => programRotation(d, d.today);

/** The role an entry has, in words. */
const roleText = (x: Pick<DayExercise, "is_main" | "slot">, s: RotationStatus | undefined) => (x.is_main || x.slot === "main" ? "main lift" : s?.role === "main" ? "secondary lift" : "accessory work");

/** suggest_replacements: the candidates and the facts behind them. */
export function suggestReplacements(d: CoachData, raw: unknown): ToolOutcome {
  const parsed = input.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  const days = activeDays(d);
  const entries = days.flatMap((day) => day.exercises.filter((x) => x.exercise_id === parsed.data.exercise_id).map((x) => ({ day, x })));
  const old = d.exercises.find((e) => e.id === parsed.data.exercise_id);
  if (!old || !entries.length) return { ok: false, error: `"${parsed.data.exercise_id}" is not in his active program: use an exercise id from get_program.` };
  const statuses = rotationOf(d);
  const status = statuses.find((s) => s.exercise_id === old.id);
  const main = entries.some(({ x }) => x.is_main || x.slot === "main");
  const role = roleText(entries[0].x, status);

  const info = (d.programs ?? []).find((p) => p.status === "active") ?? null;
  const equipment: EquipmentChoice = info?.params?.equipment ?? "full_gym";
  const block = currentBlock(d.programs ?? []);
  const inProgram = new Set(days.flatMap((day) => day.exercises.map((x) => x.exercise_id)));
  const done = d.sessions.filter((s) => s.status === "done");
  const since = addDays(d.today, -(RECENT_DAYS - 1));
  const recent = new Set(done.filter((s) => s.local_date >= since).flatMap((s) => s.sets.filter((x) => x.done).map((x) => x.exercise_id)));
  const history = new Set(done.flatMap((s) => s.sets.filter((x) => x.done).map((x) => x.exercise_id)));
  // The program without this exercise: a region it leaves uncovered counts as a gap.
  const coverage = regionCoverage(days.map((day) => ({ exercises: day.exercises.filter((x) => x.exercise_id !== old.id) })), new Map(d.exercises.map((e) => [e.id, e])));
  const gaps = new Set(coverage.filter((c) => !c.exercises.length).map((c) => c.region));

  const oldRegions = old.regions.filter((r) => r.emphasis === "primary").map((r) => r.region);
  const group = groupOf(old.muscle_primary);
  // The same muscle: the same report group, and for the shoulders the same head (front and side delts are muscles of
  // their own, each with one region).
  const sameMuscle = (e: Exercise) => groupOf(e.muscle_primary) === group && (group !== "shoulders" || e.muscle_primary === old.muscle_primary);
  const family = mixFamilyOf(old.muscle_primary);
  const kind = equipKind(old);
  // The generator's slot kinds: core work, compound (its mechanic says so) and isolation (everything else, custom
  // exercises without a mechanic included).
  const slotKind = (e: Exercise) => (e.pattern === "core" ? "core" : e.mechanic === "compound" && e.pattern !== "isolation" ? "compound" : "isolation");
  const sameKind = (e: Exercise) => (main || status?.role === "main" ? e.mechanic === "compound" && e.pattern === old.pattern : slotKind(e) === slotKind(old));
  const pool = d.exercises.filter(
    (e) =>
      e.id !== old.id &&
      !e.archived_at &&
      countsVolume(e.category) &&
      !isOlympicLift(e) &&
      sameMuscle(e) &&
      EQUIPMENT_OK[equipment].has(e.equipment) &&
      !inProgram.has(e.id) &&
      !recent.has(e.id) &&
      sameKind(e) &&
      e.regions.some((r) => r.emphasis === "primary") &&
      // Main lifts stay barbell (Payam, 2026-10-17): a close variation that can be loaded heavy.
      (!main || ((equipment !== "full_gym" || e.equipment === "barbell") && mainLiftOk({ ex: e, regions: e.regions.filter((r) => r.emphasis === "primary").map((r) => r.region) } as Pick<Candidate, "ex" | "regions">)))
  );
  const primary = (e: Exercise) => e.regions.filter((r) => r.emphasis === "primary").map((r) => r.region);
  // "A different region of the same muscle": a main-focus region the exercise does not have, in its muscle's chip.
  const otherRegion = (e: Exercise) => primary(e).some((r) => !oldRegions.includes(r) && oldRegions.some((o) => REGION_INFO[o].muscle === REGION_INFO[r].muscle));
  const change = (e: Exercise): "different region" | "different equipment" | "barbell variation" => (otherRegion(e) ? "different region" : main ? "barbell variation" : "different equipment");
  // A different region first; then (a muscle with one region, or too few in reach) the same region with other
  // equipment, or for a main lift another barbell variation of it.
  const sameRegion = (e: Exercise) => !otherRegion(e) && primary(e).some((r) => oldRegions.includes(r)) && (main || equipKind(e) !== kind);
  const mix = family ? blockMix(family, block) : [];
  const key = (e: Exercise): (number | string)[] => [
    primary(e).some((r) => gaps.has(r)) ? 0 : 1,
    otherRegion(e) ? 0 : 1,
    mix.includes(equipKind(e)) ? 0 : 1,
    history.has(e.id) ? 0 : 1,
    sourceRank({ ex: e }),
    e.level === "expert" ? 1 : 0,
    e.name_en,
  ];
  const byKey = (a: Exercise, b: Exercise) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
  const ranked = [...pool.filter(otherRegion).sort(byKey), ...pool.filter(sameRegion).sort(byKey)];
  // Different options, not three of a kind: each pick differs from the others in region or equipment.
  const picks: Exercise[] = [];
  for (const e of ranked) {
    if (picks.length >= REPLACEMENTS) break;
    const sig = `${primary(e).sort().join("+")}|${equipKind(e)}`;
    if (picks.some((p) => `${primary(p).sort().join("+")}|${equipKind(p)}` === sig)) continue;
    picks.push(e);
  }

  // A loaded lift's e1RM since it entered the program: the "strength progress" a barbell is for.
  const unit = d.settings.unit;
  const points = done
    .filter((s) => !status?.since || s.local_date >= status.since)
    .sort((a, b) => (a.local_date + a.started_at).localeCompare(b.local_date + b.started_at))
    .flatMap((s) => {
      const b = bestSet(s, old.id, unit);
      return b ? [{ date: s.local_date, e1rm: b.e1rm }] : [];
    });
  const first = points[0]?.e1rm ?? null;
  const latest = points.at(-1)?.e1rm ?? null;

  return {
    ok: true,
    result: {
      exercise: {
        exercise_id: old.id,
        name: old.name_en,
        equipment: old.equipment,
        role,
        days: entries.map(({ day }) => ({ day_id: day.id, name: day.name_en })),
        main_focus: regionView(old, "primary"),
        also_trained: regionView(old, "secondary"),
        equipment_role: equipmentRole(old),
      },
      rotation: status
        ? { weeks: status.weeks, since: status.since, keeps_at_least: status.min, changes_by: status.max, due: status.due, reason: status.due ? dueText(status) : null, stalled: status.stalled, new_best_last_2_weeks: status.new_best }
        : null,
      strength: points.length >= 2 ? { unit, first_e1rm: first, latest_e1rm: latest, change_pct: first ? Math.round((((latest ?? 0) - first) / first) * 1000) / 10 : null, sessions: points.length } : null,
      block: { block, letter: blockLetter(block), equipment_mix: mix },
      replacements: picks.map((e) => ({
        exercise_id: e.id,
        name: e.name_en,
        equipment: e.equipment,
        main_focus: regionView(e, "primary"),
        fills_gap: primary(e)
          .filter((r) => gaps.has(r))
          .map((r) => REGION_INFO[r].label),
        change: change(e),
        equipment_role: equipmentRole(e),
        in_block_mix: mix.includes(equipKind(e)),
        done_before: history.has(e.id),
      })),
      ...(picks.length < 2 ? { note: `Only ${picks.length} exercise${picks.length === 1 ? "" : "s"} of the library fit the rotation rules for ${old.name_en} (same muscle, not used in the last 8 weeks, not in his program).` } : {}),
    },
  };
}

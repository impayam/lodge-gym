// "Ask Coach" from a due line on the Program screen (SPEC-v11 Phase B, Payam 2026-10-17): the message carries the due
// exercise, and the app writes its rotation facts and region tags into the message's CONTEXT block, so the coach can
// say which region it trained these weeks before it suggests replacements. Pure.

import { REGION_INFO } from "../regions";
import { dueText, programRotation, type RotationStatus } from "../rotation";
import type { ReportData } from "../reports";

export interface RotationFacts {
  exercise_id: string;
  name: string;
  equipment: string;
  status: RotationStatus;
  /** Region labels from its tags. */
  main_focus: string[];
  also_trained: string[];
}

/** The facts for a due line's exercise; null when it is no longer in the active program. */
export function rotationFacts(d: Pick<ReportData, "settings" | "program" | "programs" | "exercises" | "sessions">, exerciseId: string, today: string): RotationFacts | null {
  const status = programRotation(d, today).find((s) => s.exercise_id === exerciseId);
  const ex = d.exercises.find((e) => e.id === exerciseId);
  if (!status || !ex) return null;
  const labels = (emphasis: "primary" | "secondary") => ex.regions.filter((r) => r.emphasis === emphasis).map((r) => `${REGION_INFO[r.region].label} (${r.evidence} evidence)`);
  return { exercise_id: ex.id, name: ex.name_en, equipment: ex.equipment, status, main_focus: labels("primary"), also_trained: labels("secondary") };
}

const ROLE_TEXT = { main: "a main or secondary lift (the 6–8 week rule)", other: "accessory, isolation or core work (the 3–4 week rule)" } as const;

/** The CONTEXT block's lines for the due exercise. */
export function rotationLines(f: RotationFacts): string[] {
  const s = f.status;
  return [
    `He tapped Ask Coach on the due line of the Program screen for ${f.name} (${f.exercise_id}, ${f.equipment}); the app wrote his question. Answer in Persian.`,
    `Rotation: ${ROLE_TEXT[s.role]}; ${s.weeks} training ${s.weeks === 1 ? "week" : "weeks"} in his program${s.since ? ` since ${s.since}` : ""}; ${s.due ? `due: ${dueText(s)}` : `not due yet (${s.weeks} of at most ${s.max} weeks)`}.`,
    `Its main focus (region tags): ${f.main_focus.length ? f.main_focus.join(", ") : "none"}. Also trained: ${f.also_trained.length ? f.also_trained.join(", ") : "none"}.`,
  ];
}

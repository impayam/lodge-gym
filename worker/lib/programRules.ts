// The "How it works" rules of a program, shown on the Program screen and given to the coach by get_program (SPEC-v9
// M12), so both say the same thing.

import { STYLE_NAME, type ResolvedStyle } from "./generator/model";
import type { ProgramInfo } from "./types";

/** English display name: the seed programs carry Persian names in data (SPEC §6), the UI stays English (SPEC-v2 M6). */
export function programName(p: Pick<ProgramInfo, "name" | "style"> | null | undefined, fallback = "Program"): string {
  if (!p) return fallback;
  if (p.style === "seed_full_body") return "Full body · 4 days";
  if (p.style === "seed_upper_lower") return "Upper/lower · 4 days";
  return p.name || fallback;
}

export function styleLabel(style: string | null): string {
  if (style === "seed_full_body") return "Full body (original program)";
  if (style === "seed_upper_lower") return "Upper/lower (original program)";
  return style && style in STYLE_NAME ? STYLE_NAME[style as ResolvedStyle] : "Program";
}

/** Rules for the active program: the seed program keeps its approved rules (SPEC §6); generated programs get theirs
 *  from the style (SPEC-v2 §8.3–§8.4). No light-week or intro-week rule (decided 2026-10-12). */
export function programRules(style: string | null, days: number, hasSupersets: boolean, strength: boolean): string[] {
  const progression = "All sets completed? Next session add: upper body 5 lb (2.5 kg), lower body 10 lb (5 kg), dumbbells 5 lb (2 kg) per hand.";
  const rotation = "Exercises change on a plan: main and secondary lifts after 6–8 weeks, the others after 3–4. A due exercise shows at the top; nothing changes until you approve a new program or pick a replacement.";
  const food = "To keep muscle: don't eat below maintenance, 130–150 g of protein a day, 7–9 hours of sleep.";
  const supersets = "A1/A2 and B1/B2 are supersets: alternate them and rest 60–90 s after each round.";
  if (style === null || style === "seed_full_body")
    return [
      "Full body with a daily focus: every session trains the whole body, and the first exercise is the main, heavy lift of the day.",
      "Order: Day 1 → 2 → 3 → 4. Whenever you train, do the next day. No more than two training days in a row.",
      "Goal: 4 sessions in 7 days.",
      "Weeks 1 and 2: end each set with 3–4 reps in reserve. From week 3: 1–2 reps in reserve.",
      progression,
      rotation,
      food,
      supersets,
    ];
  const order = `Order: ${Array.from({ length: days }, (_, i) => `Day ${i + 1}`).join(" → ")}. Whenever you train, do the next day.`;
  const sequencing =
    style === "full_body" || style === "strength" || style === "seed_upper_lower"
      ? "No more than two training days in a row."
      : "The days are arranged so no muscle is trained on two days in a row; keep the order.";
  return [
    `${styleLabel(style)}: ${days} sessions a week. The first exercise of each day is its main lift.`,
    `${order} ${sequencing}`,
    `Goal: ${days} sessions in 7 days.`,
    style === "seed_upper_lower"
      ? "End each set with 1–2 reps in reserve."
      : strength
        ? "Main lifts: 3–5 reps, ending each set with 1–2 reps in reserve. Accessories: 6–12 reps."
        : "Each exercise shows its target reps in reserve (RIR): main and secondary lifts 1–3, accessories 1–2, isolation 0–2.",
    progression,
    rotation,
    food,
    ...(hasSupersets ? [supersets] : []),
  ];
}

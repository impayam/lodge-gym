// Exercise categories (SPEC-v2 §7.4, decided 2026-10-12). Only strength work counts toward weekly muscle volume and
// the muscle map; stretching, plyometrics, cardio and strongman stay in the library and can be logged, but count 0 sets.

export const CATEGORIES = ["strength", "powerlifting", "olympic_weightlifting", "strongman", "stretching", "plyometrics", "cardio"] as const;
export type Category = (typeof CATEGORIES)[number];

const COUNTED: ReadonlySet<string> = new Set<Category>(["strength", "powerlifting", "olympic_weightlifting"]);

/** Whether done sets of an exercise in this category count toward muscle volume. A missing category never counts. */
export const countsVolume = (category: string | null | undefined): boolean => !!category && COUNTED.has(category);

export const isCategory = (v: unknown): v is Category => typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);

/** free-exercise-db's category ("olympic weightlifting", …) as the stored key. Unknown values are refused, not guessed. */
export function fedbCategory(v: string | null | undefined): Category {
  const k = (v ?? "").trim().replace(/\s+/g, "_");
  if (!isCategory(k)) throw new Error(`unknown free-exercise-db category "${v}"`);
  return k;
}

// Short names of the big three for compact places: the Home 1RM chips and the session cards (Payam, 2026-10-14).
// Every other exercise shows its full English name.

export const BIG_THREE: readonly { id: string; label: string }[] = [
  { id: "bench", label: "Bench" },
  { id: "squat", label: "Squat" },
  { id: "deadlift", label: "Deadlift" },
];

/** "Bench" for the bench press, the full name for anything outside the big three. */
export function liftLabel(id: string, nameEn: string): string {
  return BIG_THREE.find((l) => l.id === id)?.label ?? nameEn;
}

/** A program day's own name without its "Day N · " prefix: "Day 2 · Legs" → "Legs". */
export function dayTitle(nameEn: string): string {
  const m = /^Day \d+ · (.+)$/.exec(nameEn);
  return m ? m[1] : nameEn;
}

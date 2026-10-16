// Rest after a checked set (Payam, 2026-10-16), pure and shared by the session screen and its tests:
//   - an exercise alone: the between-sets rest (default 30 s) while it has a set left; after its last set, the
//     next-exercise rest (default 2 min) before the next card;
//   - a superset or tri-set: its sets go round by round (set 1 of each member, then set 2 …); no timer inside a round,
//     the group's own rest (from the program or the plan) after each round, the next-exercise rest after the last one.
//     A member's sets beyond the others' counts are rounds of their own at the end.
// Nothing is left in the session: no timer. The label says what comes next ("Rest · next: set 3 of 4").
// The program's own per-exercise rest is no longer the session's timer; the defaults are in Settings → Training.

/** The session timer's defaults (Settings → Training), in seconds. */
export interface RestDefaults {
  rest_between_sets_sec: number;
  rest_next_exercise_sec: number;
}

export const REST_DEFAULTS: RestDefaults = { rest_between_sets_sec: 30, rest_next_exercise_sec: 120 };

/** One card of the session: an exercise alone, or a group's members in order. */
export interface RestUnit {
  members: { id: string; name: string; done: readonly boolean[] }[];
  /** The group's rest after each round; null for an exercise alone. */
  groupRest: number | null;
}

/** What comes after the rest. Set and round numbers are 1-based. */
export type RestNext = { kind: "set"; set: number; of: number } | { kind: "round"; round: number; of: number } | { kind: "exercise"; name: string };

export type AfterSet =
  /** Start the timer. */
  | { kind: "rest"; seconds: number; next: RestNext }
  /** Inside a group's round: no timer; this member's set is next. */
  | { kind: "in_round"; exerciseId: string; set: number }
  /** Every set of the session is done. */
  | { kind: "none" };

/** A group's rows round by round: set 0 of each member that has one, then set 1 … (the card's order). */
export function roundRows(members: readonly { id: string; sets: number }[]): { round: number; exerciseId: string; set: number }[] {
  const rounds = Math.max(0, ...members.map((m) => m.sets));
  const out: { round: number; exerciseId: string; set: number }[] = [];
  for (let r = 0; r < rounds; r++) for (const m of members) if (m.sets > r) out.push({ round: r, exerciseId: m.id, set: r });
  return out;
}

const isGroup = (u: RestUnit) => u.groupRest !== null && u.members.length >= 2;

/**
 * The rest after checking `set` of `exerciseId` in card `unit`, from the done flags after the check. The next card is
 * the first one after this one (wrapping round) that still has a set to do.
 */
export function restAfterSet(units: readonly RestUnit[], unit: number, exerciseId: string, set: number, rules: RestDefaults): AfterSet {
  const u = units[unit];
  if (!u) return { kind: "none" };
  const nextCard = (): AfterSet => {
    for (let k = 1; k < units.length; k++) {
      const v = units[(unit + k) % units.length];
      const m = v.members.find((x) => x.done.some((d) => !d));
      if (m) return { kind: "rest", seconds: rules.rest_next_exercise_sec, next: { kind: "exercise", name: m.name } };
    }
    return { kind: "none" };
  };

  if (!isGroup(u)) {
    const m = u.members.find((x) => x.id === exerciseId) ?? u.members[0];
    const left = m ? m.done.findIndex((d) => !d) : -1;
    if (left >= 0) return { kind: "rest", seconds: rules.rest_between_sets_sec, next: { kind: "set", set: left + 1, of: m.done.length } };
    return nextCard();
  }

  // Inside a round of two or more members: the next member's set, no timer.
  const at = u.members.findIndex((m) => m.id === exerciseId);
  const order = [...u.members.slice(at + 1), ...u.members.slice(0, Math.max(0, at))];
  const inRound = u.members.filter((m) => m.done.length > set);
  const pending = inRound.length >= 2 ? order.find((m) => m.done.length > set && !m.done[set]) : undefined;
  if (pending) return { kind: "in_round", exerciseId: pending.id, set };

  // The round is complete: the group's rest before its next round, or the next card.
  const rows = roundRows(u.members.map((m) => ({ id: m.id, sets: m.done.length })));
  const of = Math.max(0, ...u.members.map((m) => m.done.length));
  const open = rows.find((r) => !u.members.find((m) => m.id === r.exerciseId)!.done[r.set]);
  if (open) return { kind: "rest", seconds: u.groupRest!, next: { kind: "round", round: open.round + 1, of } };
  return nextCard();
}

/** The timer's label: "Rest · next: set 3 of 4", "Rest · next: round 2 of 3", "Rest · next: Pull-Up". */
export function restLabel(next: RestNext): string {
  if (next.kind === "set") return `Rest · next: set ${next.set} of ${next.of}`;
  if (next.kind === "round") return `Rest · next: round ${next.round} of ${next.of}`;
  return `Rest · next: ${next.name}`;
}

/** The "Rest is over" push's text, from the timer's label: "Next: set 3 of 4", "Next: Pull-Up". */
export function restPushBody(label: string | undefined): string {
  const next = label?.match(/^Rest · next: (.+)$/)?.[1];
  return next ? `Next: ${next}` : "Time for the next set.";
}

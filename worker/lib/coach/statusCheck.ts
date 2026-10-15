// Coach answers vs the app's numbers (Payam, 2026-10-15): when an answer's text says a muscle group is under, on or
// over target and get_volume in the same answer says otherwise, the chat shows a note under the answer ("The numbers in
// the card are the app's; the text may be wrong."). The answer itself is never hidden or changed.
//
// The check is deliberately cautious, because a wrong note is worse than a missed one: a clause counts only when it
// names exactly one status and has no negation, and a claim is a mismatch only when no get_volume week in the answer
// gives that group the claimed status.

import type { BalanceStatus } from "../reports";

export type Band = "under" | "on" | "over";

/** The ten groups with weekly targets, as the coach may name them in English or Persian. Longest names match first. */
const GROUP_WORDS: Readonly<Record<string, readonly string[]>> = {
  chest: ["chest", "pecs", "سینه"],
  back: ["back", "lats", "پشت", "زیربغل", "زیر بغل"],
  quads: ["quads", "quadriceps", "چهارسر", "چهار سر", "جلو ران", "جلوی ران"],
  hamstrings_glutes: ["hamstrings & glutes", "hamstrings and glutes", "hamstrings", "glutes", "همسترینگ", "پشت ران", "پشت پا", "باسن"],
  shoulders: ["shoulders", "delts", "سرشانه", "سرشانه ها", "شانه", "شانه ها"],
  rear_delts: ["rear delts", "rear deltoids", "سرشانه عقب", "سرشانه ی عقب", "دلتوئید خلفی", "دلت عقب", "پشت شانه"],
  calves: ["calves", "ساق", "ساق پا"],
  core: ["core", "abs", "شکم", "میان تنه"],
  biceps: ["biceps", "جلو بازو", "جلوبازو", "دوسر", "دو سر", "دوسر بازو"],
  triceps: ["triceps", "پشت بازو", "پشتبازو", "سه سر", "سهسر"],
};

const STATUS_WORDS: Readonly<Record<Band, readonly string[]>> = {
  under: ["under target", "under its target", "under the target", "below target", "below its target", "below the target", "short of its target", "short of the target", "under-target", "زیر هدف", "کمتر از هدف", "پایین تر از هدف", "زیر حد هدف"],
  on: ["on target", "at target", "at its target", "within target", "within its target", "روی هدف", "در حد هدف", "مطابق هدف", "به هدف رسیده", "در محدوده هدف", "در محدوده ی هدف"],
  over: ["over target", "over its target", "over the target", "above target", "above its target", "above the target", "more than its target", "more than the target", "over-target", "بالای هدف", "بیشتر از هدف", "بالاتر از هدف", "فراتر از هدف"],
};

/** Words that end a clause in English and Persian (plus punctuation, split separately). */
const CLAUSE_WORDS = /\b(?:but|however|while|whereas|although|though|yet)\b|(?:^|\s)(?:ولی|اما|در حالی که|درحالیکه|درحالی که)(?=\s|$)/g;
const NEGATION = /\b(?:not|no longer|never|isn't|aren't|wasn't|weren't)\b|(?:^|\s)(?:نیست|نیستند|نبود|نبودند|نه|نمی\S*)(?=\s|$)/;

/** Lower case, Persian ZWNJ as a space, Arabic yeh and kaf as Persian, single spaces. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u200c/g, " ")
    .replace(/\u064a/g, "\u06cc")
    .replace(/\u0643/g, "\u06a9")
    .replace(/[*_`#>]/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Whole-word positions of `word` in `s`. With `suffix`, Persian letters may follow a Persian word (a possessive:
 * "زیر هدفش", under its target).
 */
function find(s: string, word: string, suffix = false): number[] {
  const at: number[] = [];
  for (let i = s.indexOf(word); i >= 0; i = s.indexOf(word, i + 1)) {
    const before = s[i - 1] ?? " ";
    const after = s[i + word.length] ?? " ";
    const endOk = !/[\p{L}\p{N}]/u.test(after) || (suffix && /[\u0600-\u06ff]/.test(after) && /[\u0600-\u06ff]$/.test(word));
    if (!/[\p{L}\p{N}]/u.test(before) && endOk) at.push(i);
  }
  return at;
}

/** The groups a clause names; a longer name wins over a shorter one inside it ("پشت بازو" is triceps, not back). */
function groupsIn(clause: string): string[] {
  const words = Object.entries(GROUP_WORDS)
    .flatMap(([group, list]) => list.map((w) => ({ group, w: normalize(w) })))
    .sort((a, b) => b.w.length - a.w.length);
  const taken: [number, number][] = [];
  const found = new Set<string>();
  for (const { group, w } of words)
    for (const i of find(clause, w)) {
      if (taken.some(([a, b]) => i < b && i + w.length > a)) continue;
      taken.push([i, i + w.length]);
      found.add(group);
    }
  return [...found];
}

function statusesIn(clause: string): Band[] {
  const out = new Set<Band>();
  for (const [band, list] of Object.entries(STATUS_WORDS) as [Band, readonly string[]][]) if (list.some((w) => find(clause, normalize(w), true).length)) out.add(band);
  return [...out];
}

/** What the text says about groups' status: one claim per group named in a clause with exactly one status. */
export function statusClaims(text: string): { group: string; status: Band }[] {
  const claims = new Map<string, Band>();
  const clauses = normalize(text)
    .replace(CLAUSE_WORDS, "|")
    .split(/[|.!?؟;؛,،\n]/);
  for (const clause of clauses) {
    if (NEGATION.test(clause)) continue;
    const statuses = statusesIn(clause);
    if (statuses.length !== 1) continue;
    for (const g of groupsIn(clause)) claims.set(g, statuses[0]);
  }
  return [...claims].map(([group, status]) => ({ group, status }));
}

/** One get_volume result (worker/lib/coach/tools.ts getVolume). */
export interface VolumeResult {
  weeks: { groups: { group: string; target: number | null; status: BalanceStatus }[] }[];
}

/** With a target, 0 sets ("none") is under it. */
const bandOf = (s: BalanceStatus): Band | null => (s === "none" ? "under" : s === "untracked" ? null : s);

/**
 * The claims in `text` that no get_volume week in the same answer supports. Groups without a target in those results
 * are not checked.
 */
export function statusMismatches(text: string, volumes: VolumeResult[]): { group: string; status: Band }[] {
  if (!volumes.length) return [];
  return statusClaims(text).filter(({ group, status }) => {
    const rows = volumes.flatMap((v) => v.weeks.flatMap((w) => w.groups.filter((r) => r.group === group && r.target != null && r.target > 0)));
    return rows.length > 0 && !rows.some((r) => bandOf(r.status) === status);
  });
}

// Numbers in the model's Persian prose (SPEC-v7 M9d): every number a sentence writes must be one the app supplied in
// the model's input, exactly or rounded the way prose rounds it; a sentence with any other number is not shown. Shared
// by the training overview and the after-session report's "Where you are".

import { toLatinDigits } from "../digits";

const round1 = (n: number) => Math.round(n * 10) / 10;

// "1RM" / "e1RM" is a term, not a number the prose states.
const normal = (text: string) =>
  toLatinDigits(text)
    .replace(/(?<![\d.])e?1\s?RM/gi, "RM")
    .replace(/٫/g, ".")
    .replace(/(\d),(?=\d{3}\b)/g, "$1");

/** Every number in a text: Latin, Persian and Arabic-Indic digits, "." or "٫" decimals; signs and "1RM" are ignored. */
export function numbersIn(text: string): number[] {
  return [...normal(text).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

/** The numbers written as a percentage ("4%", "۴٪", "۴ درصد"). */
export function percentsIn(text: string): number[] {
  return [...normal(text).matchAll(/(\d+(?:\.\d+)?)\s*(?:%|٪|درصد)/g)].map((m) => Number(m[1]));
}

export interface Supplied {
  /** Every number in the input, as given and rounded the ways prose rounds them. */
  all: Set<number>;
  /** The percentages the app computed (fields named *_pct). */
  pct: Set<number>;
}

/** The numbers the app supplied in the input. */
export function suppliedNumbers(input: unknown): Supplied {
  const all = new Set<number>();
  const pct = new Set<number>();
  const add = (set: Set<number>, n: number) => {
    const a = Math.abs(n);
    set.add(a);
    set.add(Math.round(a));
    set.add(round1(a));
  };
  const walk = (v: unknown, key: string) => {
    if (typeof v === "number") {
      add(all, v);
      if (key.endsWith("_pct")) add(pct, v);
    } else if (typeof v === "string") numbersIn(v).forEach((x) => add(all, x));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  walk(input, "");
  return { all, pct };
}

/** Whether every number in `text` is one the app supplied, and every percentage one the app computed. */
export const onlySupplied = (text: string, s: Supplied) => numbersIn(text).every((n) => s.all.has(n)) && percentsIn(text).every((n) => s.pct.has(n));

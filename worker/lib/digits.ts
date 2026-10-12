// Number input/output. Inputs still accept Persian and Arabic-Indic digits (SPEC-v2 M6) with comma or dot
// decimals; output is always Latin digits.

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";

export function toLatinDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));
}

/**
 * Parses a user-typed number. Accepts Persian/Arabic/Latin digits, "." "," "٫" as the decimal
 * separator, "−"/"-" as minus, and surrounding whitespace. Returns null for empty or invalid input.
 */
export function parseNumber(input: string | null | undefined): number | null {
  if (input == null) return null;
  let s = toLatinDigits(String(input)).trim();
  if (s === "") return null;
  s = s.replace(/[−‒–—﹣－]/g, "-").replace(/[٫,]/g, ".").replace(/[\s‌‎‏]/g, "");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Formats a number with up to `maxFrac` decimals, no grouping. */
export function fmtNum(n: number | null | undefined, maxFrac = 2): string {
  if (n == null || !Number.isFinite(n)) return "";
  const rounded = Math.round(n * 10 ** maxFrac) / 10 ** maxFrac;
  return String(rounded === 0 ? 0 : rounded);
}

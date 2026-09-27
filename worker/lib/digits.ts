// Persian / Arabic-Indic digit handling. Inputs accept Persian and Latin digits with comma or dot decimals.

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";

export function toLatinDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));
}

export function toPersianDigits(s: string | number): string {
  return String(s).replace(/\d/g, (d) => FA[Number(d)]);
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

/** Formats a number with Persian digits, up to `maxFrac` decimals, no grouping. */
export function faNum(n: number | null | undefined, maxFrac = 2): string {
  if (n == null || !Number.isFinite(n)) return "";
  const rounded = Math.round(n * 10 ** maxFrac) / 10 ** maxFrac;
  const neg = rounded < 0;
  const txt = toPersianDigits(String(Math.abs(rounded))).replace(".", "٫");
  return (neg ? "‎-" : "") + txt;
}

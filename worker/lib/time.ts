// Time-zone aware helpers built on Intl only (no dependencies). Dates are "YYYY-MM-DD" strings.

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

function wall(date: Date, tz: string): Wall {
  const o: Record<string, number> = {};
  for (const p of parts(tz).formatToParts(date)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, min: o.minute, s: o.second };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date in `tz` for the given instant. */
export function localDate(tz: string, at: Date | string = new Date()): string {
  const w = wall(typeof at === "string" ? new Date(at) : at, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** Local "HH:MM" in `tz` for the given instant. */
export function localHM(tz: string, at: Date | string): string {
  const w = wall(typeof at === "string" ? new Date(at) : at, tz);
  return `${pad(w.h)}:${pad(w.min)}`;
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function offsetAt(tz: string, instant: number): number {
  const w = wall(new Date(instant), tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Converts a wall-clock time (date + "HH:MM") in `tz` to a UTC ISO string. */
export function zonedToUtcISO(date: string, hm: string, tz: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = hm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  let ts = guess - offsetAt(tz, guess);
  const second = guess - offsetAt(tz, ts);
  if (second !== ts) ts = second;
  return new Date(ts).toISOString();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

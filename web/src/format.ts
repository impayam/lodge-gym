// Display helpers: Gregorian dates, Latin digits, clocks.

import { fmtNum } from "../../worker/lib/digits";
import { localHM } from "../../worker/lib/time";

const atNoon = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
const longFmt = fmt({ weekday: "short", month: "short", day: "numeric", year: "numeric" });
const shortFmt = fmt({ weekday: "short", month: "short", day: "numeric" });
const dayMonthFmt = fmt({ month: "short", day: "numeric" });
const monthFmt = fmt({ month: "long", year: "numeric" });

/** "Mon, Oct 12, 2026" */
export const dateLong = (date: string) => longFmt.format(atNoon(date));
/** "Mon, Oct 12" */
export const dateShort = (date: string) => shortFmt.format(atNoon(date));
/** "Oct 12" */
export const dayMonth = (date: string) => dayMonthFmt.format(atNoon(date));
/** "October 2026" */
export const monthLabel = (date: string) => monthFmt.format(atNoon(date));

/** Local "HH:MM" (24 h) for an ISO instant, or "". */
export const hm = (iso: string | null, tz: string) => (iso ? localHM(tz, iso) : "");

export function clock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return h ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${mm}:${String(sec).padStart(2, "0")}`;
}

export const minutesBetween = (a: string, b: string | null) => (b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : null);

/** "1 set", "3 sets" */
export const plural = (n: number, one: string, many = one + "s") => `${fmtNum(n)} ${n === 1 ? one : many}`;

export { fmtNum };

/** YouTube search for the exercise's form (SPEC-v2 §7.1): English name + " form", built at render time. */
export const ytLink = (en: string) => "https://www.youtube.com/results?search_query=" + encodeURIComponent(`${en} form`);

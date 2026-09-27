// Display helpers: Jalali + Gregorian dates, Persian digits, clocks.

import { faNum, toPersianDigits } from "../../worker/lib/digits";
import { localHM } from "../../worker/lib/time";

const atNoon = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};

const fmt = (locale: string, opts: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" });
  } catch {
    return null;
  }
};
const jalaliLong = fmt("fa-IR-u-ca-persian", { weekday: "long", day: "numeric", month: "long" });
const jalaliMonth = fmt("fa-IR-u-ca-persian", { month: "long", year: "numeric" });
const gregShort = fmt("en-US", { weekday: "short", month: "short", day: "numeric" });

export const jalali = (date: string) => jalaliLong?.format(atNoon(date)) ?? date;
export const jalaliMonthYear = (date: string) => jalaliMonth?.format(atNoon(date)) ?? date.slice(0, 7);
export const greg = (date: string) => gregShort?.format(atNoon(date)) ?? date;

export const faHM = (iso: string | null, tz: string) => (iso ? toPersianDigits(localHM(tz, iso)) : "");

export function clock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return toPersianDigits(h ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${mm}:${String(sec).padStart(2, "0")}`);
}

export const minutesBetween = (a: string, b: string | null) => (b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : null);

export { faNum, toPersianDigits };

export const ytLink = (en: string) => "https://www.youtube.com/results?search_query=" + encodeURIComponent(`${en} proper form`);

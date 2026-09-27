// Parser for raw iOS Shortcuts payloads (approved SPEC §9 change: POST /api/health/raw).
// The shortcut does no computation. It sends "Find Health Samples" results as text (optionally with a
// property picked per field), so everything here is tolerant: locale date formats, units, comma decimals,
// Persian digits and Jalali dates, newline-joined lists or JSON arrays, and differences between iOS versions.

import { toLatinDigits } from "./digits";
import { addDays, localDate, zonedToUtcISO } from "./time";

/* ---------------- text normalisation ---------------- */

/** Latin digits, plain spaces, no bidi marks. */
export function clean(s: string): string {
  return toLatinDigits(s)
    .replace(/[\u200e\u200f‪-‮⁦-⁩\ufeff]/g, "")
    .replace(/[\u00a0 -​\u202f 　]/g, " ")
    .replace(/٫/g, ".")
    .replace(/٬/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

/** A Shortcuts list inserted into text is newline-joined; JSON arrays and nested arrays are flattened. */
export function toLines(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(toLines);
  if (typeof v === "number" || typeof v === "boolean") return [String(v)];
  if (typeof v === "object") return [JSON.stringify(v)];
  return String(v)
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .map(clean)
    .filter((l) => l !== "");
}

/* ---------------- numbers ---------------- */

/**
 * First number in a string. "1,234" and "1 234" are thousands; "312,5" is a decimal comma;
 * "1.234,5" and "1,234.5" are both handled. Returns null when there is no number.
 */
export function parseLooseNumber(input: string): number | null {
  const s = clean(input);
  const m = s.match(/-?\d+(?:[ ',.]\d+)*/);
  if (!m) return null;
  let t = m[0];
  if (/[ ']/.test(t)) {
    // Space/apostrophe groups are thousands only when every following group has three digits.
    const parts = t.split(/[ ']/);
    t = parts.slice(1).every((p) => /^\d{3}([.,]\d+)?$/.test(p)) ? parts.join("") : parts[0];
  }
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // The later separator is the decimal one.
    t = lastDot > lastComma ? t.replace(/,/g, "") : t.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    const parts = t.split(",");
    const intPart = parts[0].replace("-", "");
    const thousands = parts.slice(1).every((p) => p.length === 3) && intPart.length <= 3 && intPart !== "0";
    t = thousands ? parts.join("") : parts.length === 2 ? parts.join(".") : parts[0];
  } else if (lastDot >= 0 && t.indexOf(".") !== lastDot) {
    t = t.replace(/\./g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Energy in kcal: "312 kcal", "312 Cal", "312,5 kcal", "1 306 kJ", "۳۱۲ کیلوکالری". */
export function parseEnergyKcal(input: string): number | null {
  const s = clean(input);
  const n = parseLooseNumber(s);
  if (n === null) return null;
  if (/\bkj\b|kilojoule|کیلوژول/i.test(s)) return round1(n / 4.184);
  return round1(n);
}

/** Heart rate in beats per minute: "118 count/min", "118 bpm", "1.97 count/s", "۱۱۸". */
export function parseHeartRate(input: string): number | null {
  const s = clean(input);
  const n = parseLooseNumber(s);
  if (n === null) return null;
  const bpm = /count\s*\/\s*s(ec)?\b|beats?\s*\/\s*s(ec)?\b/i.test(s) ? n * 60 : n;
  return bpm >= 20 && bpm <= 260 ? bpm : null;
}

/** Duration in seconds: "57 min", "1 hr 5 min", "1h 5m 12s", "57:12", "1:02:03", "3420 s", "۵۷ دقیقه". */
export function parseDurationSec(input: string): number | null {
  const s = clean(input).toLowerCase();
  const hms = s.match(/^(\d+):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (hms) {
    const [a, b, c] = [Number(hms[1]), Number(hms[2]), hms[3] !== undefined ? Number(hms[3]) : null];
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  let total = 0;
  let matched = false;
  const re = /(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h|ساعت|minutes?|mins?|m|دقیقه|seconds?|secs?|s|ثانیه)(?![a-z])/g;
  for (const m of s.matchAll(re)) {
    const v = Number(m[1].replace(",", "."));
    const u = m[2];
    matched = true;
    if (/^h|ساعت/.test(u)) total += v * 3600;
    else if (/^m|دقیقه/.test(u)) total += v * 60;
    else total += v;
  }
  if (matched) return Math.round(total);
  const n = parseLooseNumber(s);
  if (n === null) return null;
  // A bare number: minutes when small (Shortcuts shows durations in minutes), seconds otherwise.
  return Math.round(n <= 600 ? n * 60 : n);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/* ---------------- dates ---------------- */

const EN_MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const FA_MONTHS: Record<string, number> = {
  فروردین: 1, اردیبهشت: 2, خرداد: 3, تیر: 4, مرداد: 5, امرداد: 5, شهریور: 6, مهر: 7, آبان: 8, آذر: 9, دی: 10, بهمن: 11, اسفند: 12,
};

const TZ_ABBR: Record<string, number> = {
  UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420, AKST: -540, AKDT: -480, HST: -600, IRST: 210, IRDT: 270,
};

/** Jalali (Solar Hijri) → Gregorian. */
export function jalaliToGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    days--;
    gy += 100 * Math.floor(days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 12 && gd > months[gm]) gd -= months[gm++];
  return [gy, gm + 1, gd];
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function validYMD(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

interface TimeParts {
  h: number;
  min: number;
  s: number;
}

/** Time of day anywhere in the string: "5:05 PM", "17:05:12", "5:05 ب.ظ", "ساعت ۱۷:۰۵". */
function findTime(s: string): TimeParts | null {
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(am|pm|a\.m\.|p\.m\.|ق\.?\s?ظ|ب\.?\s?ظ|صبح|عصر|بعدازظهر)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  const mer = (m[4] ?? "").toLowerCase().replace(/[.\s]/g, "");
  if (mer === "pm" || mer === "بظ" || mer === "عصر" || mer === "بعدازظهر") {
    if (h < 12) h += 12;
  } else if ((mer === "am" || mer === "قظ" || mer === "صبح") && h === 12) h = 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return { h, min, s: sec };
}

/** Explicit zone in the string, in minutes east of UTC: "-06:00", "-0600", "GMT-6", "MDT", "Z". */
function findOffset(s: string): number | null {
  const iso = s.match(/(?:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})\s*$/);
  if (iso) {
    if (iso[1] === "Z") return 0;
    const sign = iso[1][0] === "-" ? -1 : 1;
    const digits = iso[1].slice(1).replace(":", "");
    return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }
  const gmt = s.match(/\b(?:GMT|UTC)\s*([+-])(\d{1,2})(?::?(\d{2}))?\b/i);
  if (gmt) return (gmt[1] === "-" ? -1 : 1) * (Number(gmt[2]) * 60 + Number(gmt[3] ?? 0));
  const abbr = s.match(/\b([A-Z]{1,4}T|UTC|GMT|Z)\b\s*$/);
  if (abbr && abbr[1] in TZ_ABBR) return TZ_ABBR[abbr[1]];
  return null;
}

function toISO(date: string, t: TimeParts, offset: number | null, tz: string): string {
  if (offset !== null) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, t.h, t.min, t.s) - offset * 60_000).toISOString();
  }
  const base = Date.parse(zonedToUtcISO(date, `${pad(t.h)}:${pad(t.min)}`, tz));
  return new Date(base + t.s * 1000).toISOString();
}

/**
 * Parses a date-time as Shortcuts may print it. Without an explicit zone the settings time zone is used.
 * Supports ISO 8601, RFC 2822, "yyyy-MM-dd HH:mm:ss Z", en-US/en-GB long and short styles (with the iOS 17
 * narrow no-break space before AM/PM), dotted European dates, relative "Today/Yesterday", Unix seconds,
 * and Persian-locale output (Persian digits, Jalali month names or yyyy/m/d Jalali dates, ق.ظ/ب.ظ).
 */
export function parseLooseDate(input: string, tz: string, now: Date = new Date()): string | null {
  const s = clean(input);
  if (!s) return null;

  // Unix timestamp (seconds or milliseconds).
  if (/^\d{10}(\.\d+)?$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();

  const time = findTime(s) ?? { h: 0, min: 0, s: 0 };
  const offset = findOffset(s);
  let m: RegExpMatchArray | null;

  // ISO-like: 2026-09-28T17:05:00-06:00, 2026-09-28 17:05:00 +0000, 2026/09/28 17:05 (or Jalali 1405/07/06)
  if ((m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    let [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y >= 1300 && y < 1500) [y, mo, d] = jalaliToGregorian(y, mo, d);
    if (validYMD(y, mo, d)) return toISO(ymd(y, mo, d), time, offset, tz);
  }

  const lower = s.toLowerCase();

  // English month names: "Sep 28, 2026 at 5:05 PM", "Monday, September 28, 2026", "28 Sep 2026 at 17:05".
  const monthRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\b/;
  if ((m = lower.match(monthRe))) {
    const mo = EN_MONTHS[m[1]];
    const after = lower.slice((m.index ?? 0) + m[0].length);
    const before = lower.slice(0, m.index);
    let d: number | null = null;
    let y: number | null = null;
    const md = after.match(/^\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/);
    const dm = before.match(/(\d{1,2})(?:st|nd|rd|th)?\s*$/);
    if (md && (!dm || md[2])) {
      d = Number(md[1]);
      y = md[2] ? Number(md[2]) : null;
    } else if (dm) {
      d = Number(dm[1]);
      const yy = after.match(/^\s*,?\s*(\d{4})/);
      y = yy ? Number(yy[1]) : null;
    }
    if (d !== null) {
      if (y === null) y = Number(localDate(tz, now).slice(0, 4));
      if (validYMD(y, mo, d)) return toISO(ymd(y, mo, d), time, offset, tz);
    }
  }

  // Persian month names (Jalali): "۶ مهر ۱۴۰۵، ساعت ۱۷:۰۵", "دوشنبه ۶ مهر ۱۴۰۵ ۵:۰۵ ب.ظ".
  for (const [name, mo] of Object.entries(FA_MONTHS)) {
    const re = new RegExp(`(\\d{1,2})\\s*${name}(?:\\s*(?:ماه)?)?\\s*(\\d{4})?`);
    if ((m = s.match(re))) {
      const d = Number(m[1]);
      const jy = m[2] ? Number(m[2]) : jalaliYearOf(localDate(tz, now));
      const [y, gm, gd] = jalaliToGregorian(jy, mo, d);
      if (validYMD(y, gm, gd)) return toISO(ymd(y, gm, gd), time, offset, tz);
    }
  }

  // Numeric: 9/28/26, 9/28/2026, 28/09/2026, 28.09.26 (dotted = day first).
  if ((m = s.match(/\b(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})\b/))) {
    let a = Number(m[1]);
    let b = Number(m[3]);
    let y = Number(m[4]);
    if (y < 100) y += 2000;
    const dayFirst = m[2] === "." || a > 12;
    const [mo, d] = dayFirst ? [b, a] : [a, b];
    if (y >= 1300 && y < 1500) {
      const [gy, gm, gd] = jalaliToGregorian(y, mo, d);
      a = gm;
      b = gd;
      y = gy;
      if (validYMD(y, a, b)) return toISO(ymd(y, a, b), time, offset, tz);
    } else if (validYMD(y, mo, d)) return toISO(ymd(y, mo, d), time, offset, tz);
  }

  // Relative (Shortcuts "Relative" date style).
  const today = localDate(tz, now);
  if (/\btoday\b|امروز/.test(lower) && findTime(s)) return toISO(today, time, offset, tz);
  if (/\byesterday\b|دیروز/.test(lower) && findTime(s)) return toISO(addDays(today, -1), time, offset, tz);

  // Anything else with an explicit zone that the JS engine understands (RFC 2822 variants).
  if (offset !== null) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

function jalaliYearOf(gregorianDate: string): number {
  // Jalali year starts around 20–21 March.
  const [y, m, d] = gregorianDate.split("-").map(Number);
  const [, nm, nd] = jalaliToGregorian(y - 621, 1, 1);
  return m > nm || (m === nm && d >= nd) ? y - 621 : y - 622;
}

/** Every date-time in a line (e.g. "Sep 28, 2026 at 5:05 PM – Sep 28, 2026 at 6:02 PM"). */
export function findDates(line: string, tz: string, now: Date): string[] {
  const parts = clean(line)
    .split(/\s+(?:–|—|-|to|تا)\s+|\s*[|;]\s*|\t/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const d = parseLooseDate(p, tz, now);
    if (d) out.push(d);
  }
  return out;
}

/* ---------------- workout activity types ---------------- */

const ACTIVITY_TYPES = [
  "Traditional Strength Training",
  "Functional Strength Training",
  "High Intensity Interval Training",
  "Core Training",
  "Cross Training",
  "Mixed Cardio",
  "Cooldown",
  "Flexibility",
  "Walking",
  "Running",
  "Cycling",
  "Elliptical",
  "Rowing",
  "Stair Climbing",
  "Stairs",
  "Hiking",
  "Yoga",
  "Pilates",
  "Swimming",
  "Dance",
  "Kickboxing",
  "Boxing",
  "Jump Rope",
  "Other",
];
const ACTIVITY_ALIASES: Record<string, string> = {
  hiit: "High Intensity Interval Training",
  "strength training": "Traditional Strength Training",
  "تمرین قدرتی سنتی": "Traditional Strength Training",
  "تمرین قدرتی عملکردی": "Functional Strength Training",
  "تمرین قدرتی": "Traditional Strength Training",
  پیاده‌روی: "Walking",
  دویدن: "Running",
  دوچرخه‌سواری: "Cycling",
};

/** Canonical activity type from text such as "Traditional Strength Training", "HKWorkoutActivityTypeTraditionalStrengthTraining", "traditionalStrengthTraining". */
export function parseActivityType(input: string): string | null {
  const s = clean(input);
  if (!s) return null;
  const flat = s.replace(/^HKWorkoutActivityType/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  for (const t of ACTIVITY_TYPES) if (flat.includes(t.toLowerCase())) return t;
  for (const [k, v] of Object.entries(ACTIVITY_ALIASES)) if (flat.includes(k)) return v;
  return null;
}

/* ---------------- payload ---------------- */

type Field = "workouts" | "workout_type" | "workout_start" | "workout_end" | "workout_duration" | "workout_energy" | "workout_total_energy" | "hr" | "hr_time";

const ALIASES: Record<Field, string[]> = {
  workouts: ["workouts", "workout", "workoutsamples", "healthsamples", "samples", "تمرین", "تمرینها"],
  workout_type: ["workouttype", "type", "activitytype", "activity", "name", "workoutname"],
  workout_start: ["workoutstart", "workoutstartdate", "workoutstarts", "start", "startdate", "starts", "begin"],
  workout_end: ["workoutend", "workoutenddate", "workoutends", "end", "enddate", "ends", "finish"],
  workout_duration: ["workoutduration", "duration", "durations"],
  workout_energy: ["workoutenergy", "energy", "activeenergy", "activeenergyburned", "activekcal", "kcal", "calories", "activecalories"],
  workout_total_energy: ["workouttotalenergy", "totalenergy", "totalenergyburned", "totalkcal", "totalcalories"],
  hr: ["hr", "heartrate", "heartrates", "hrvalue", "hrvalues", "heartratevalue", "heartratevalues", "heartratesamples", "bpm", "ضربان"],
  hr_time: ["hrtime", "hrtimes", "hrdate", "hrdates", "hrstart", "hrstartdate", "heartratetime", "heartratetimes", "heartratedate", "heartratedates", "heartratestart", "heartratestartdate"],
};

const keyOf = (k: string) => k.toLowerCase().replace(/[\s_\-.:()‌]/g, "");

function collect(payload: Record<string, unknown>): Partial<Record<Field, string[]>> {
  const out: Partial<Record<Field, string[]>> = {};
  for (const [rawKey, value] of Object.entries(payload)) {
    const k = keyOf(rawKey);
    for (const [field, aliases] of Object.entries(ALIASES) as [Field, string[]][]) {
      if (aliases.includes(k)) {
        out[field] = [...(out[field] ?? []), ...toLines(value)];
        break;
      }
    }
  }
  return out;
}

export interface ParsedWorkout {
  activity_type: string | null;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
  active_kcal: number | null;
  total_kcal: number | null;
  hr_avg: number | null;
  hr_max: number | null;
  hr_count: number;
}

export interface ParseResult {
  workouts: ParsedWorkout[];
  hr_samples: number;
  warnings: string[];
}

interface HrSample {
  t: number | null;
  bpm: number;
}

/** Turns the raw payload into workouts with duration, energy and heart-rate stats. */
export function parseShortcutsPayload(payload: unknown, tz: string, now: Date = new Date()): ParseResult {
  const warnings: string[] = [];
  const obj: Record<string, unknown> =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : { workouts: payload };
  const f = collect(obj);

  /* heart rate */
  const hrLines = f.hr ?? [];
  const hrTimes = (f.hr_time ?? []).map((l) => parseLooseDate(l, tz, now));
  const samples: HrSample[] = [];
  hrLines.forEach((line, i) => {
    // A line may carry its own date ("118 count/min, Sep 28, 2026 at 5:06 PM") or rely on the hr_time list.
    const inline = parseLooseDate(line, tz, now);
    const withUnit = line.match(/(\d+(?:[.,]\d+)?)\s*(count\s*\/\s*min|bpm|beats?\s*\/\s*min|count\s*\/\s*s(?:ec)?)/i);
    const leading = line.match(/^(\d+(?:[.,]\d+)?)\s*(?:[,;|\t]|$)/);
    const bpm = withUnit ? parseHeartRate(withUnit[0]) : inline ? (leading ? parseHeartRate(leading[1]) : null) : parseHeartRate(line);
    if (bpm === null) return;
    const t = inline ?? hrTimes[i] ?? null;
    samples.push({ t: t ? Date.parse(t) : null, bpm });
  });
  if (f.hr_time && f.hr_time.length !== hrLines.length) warnings.push("hr_time_count_mismatch");

  /* workouts */
  const starts = (f.workout_start ?? []).map((l) => parseLooseDate(l, tz, now));
  const ends = (f.workout_end ?? []).map((l) => parseLooseDate(l, tz, now));
  const wLines = f.workouts ?? [];
  const typeLines = f.workout_type ?? [];
  const durLines = f.workout_duration ?? [];
  const energyLines = f.workout_energy ?? [];
  const totalLines = f.workout_total_energy ?? [];

  // Without explicit start dates, take them from the workout text (a line may hold "start – end").
  const textWithDates = wLines.map((l, i) => ({ d: findDates(l, tz, now), i })).filter((x) => x.d.length);
  const n = starts.length ? starts.length : textWithDates.length;

  const found: ParsedWorkout[] = [];
  for (let i = 0; i < n; i++) {
    const start = starts.length ? starts[i] : textWithDates[i]?.d[0];
    if (!start) {
      warnings.push(`workout_${i}_no_start`);
      continue;
    }
    const srcLine = starts.length ? (wLines.length === starts.length ? wLines[i] : wLines.length === 1 ? wLines[0] : "") : wLines[textWithDates[i].i];
    let end = ends.length ? ends[i] ?? null : starts.length ? null : (textWithDates[i]?.d[1] ?? null);
    let duration: number | null = null;
    if (durLines[i] !== undefined) duration = parseDurationSec(durLines[i]);
    if (end && Date.parse(end) <= Date.parse(start)) end = null;
    if (end) duration = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
    else if (duration !== null) end = new Date(Date.parse(start) + duration * 1000).toISOString();

    const type = parseActivityType(typeLines[i] ?? "") ?? parseActivityType(srcLine ?? "") ?? (typeLines.length === 1 ? parseActivityType(typeLines[0]) : null);
    let active = energyLines[i] !== undefined ? parseEnergyKcal(energyLines[i]) : null;
    if (active === null && srcLine && /kcal|\bcal\b|kj|کالری/i.test(srcLine)) {
      const m = clean(srcLine).match(/(\d[\d.,]*)\s*(kcal|cal|kj|کیلوکالری|کالری)/i);
      if (m) active = parseEnergyKcal(m[0]);
    }
    const total = totalLines[i] !== undefined ? parseEnergyKcal(totalLines[i]) : null;
    found.push({ activity_type: type, started_at: start, ended_at: end, duration_sec: duration, active_kcal: active, total_kcal: total, hr_avg: null, hr_max: null, hr_count: 0 });
  }

  // Dedupe inside the payload (same type + start).
  const seen = new Set<string>();
  const workouts = found.filter((w) => {
    const k = `${w.activity_type ?? ""}|${w.started_at}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  /* heart rate per workout */
  const timed = samples.filter((s) => s.t !== null);
  const untimed = samples.filter((s) => s.t === null);
  for (const w of workouts) {
    const a = Date.parse(w.started_at);
    const b = w.ended_at ? Date.parse(w.ended_at) : null;
    let mine = b === null ? [] : timed.filter((s) => s.t! >= a - 30_000 && s.t! <= b + 30_000).map((s) => s.bpm);
    if (!mine.length && untimed.length && workouts.length === 1) {
      // No sample times at all: with a single workout every sample belongs to it.
      mine = untimed.map((s) => s.bpm);
      warnings.push("hr_without_time_assigned_to_single_workout");
    }
    if (mine.length) {
      w.hr_count = mine.length;
      w.hr_avg = round1(mine.reduce((x, y) => x + y, 0) / mine.length);
      w.hr_max = Math.max(...mine);
    }
  }
  if (untimed.length && workouts.length > 1) warnings.push("hr_without_time_ignored");

  return { workouts, hr_samples: samples.length, warnings: [...new Set(warnings)] };
}

import { describe, expect, it } from "vitest";
import {
  jalaliToGregorian,
  parseActivityType,
  parseDurationSec,
  parseEnergyKcal,
  parseHeartRate,
  parseLooseDate,
  parseLooseNumber,
  parseShortcutsPayload,
} from "../../worker/lib/shortcuts";
import euDotted from "../fixtures/shortcuts/european-dotted.json";
import hrNoTimes from "../fixtures/shortcuts/hr-without-times.json";
import ios17 from "../fixtures/shortcuts/ios17-en-us-default.json";
import ios18 from "../fixtures/shortcuts/ios18-iso8601.json";
import persian from "../fixtures/shortcuts/persian-locale.json";
import sevenDays from "../fixtures/shortcuts/seven-days-arrays.json";
import textOnly from "../fixtures/shortcuts/text-only-lines.json";

const TZ = "America/Denver";
const NOW = new Date("2026-09-29T02:00:00Z");

describe("numbers and units", () => {
  it("parses loose numbers", () => {
    expect(parseLooseNumber("312 kcal")).toBe(312);
    expect(parseLooseNumber("312,5 kcal")).toBe(312.5);
    expect(parseLooseNumber("1,204 kcal")).toBe(1204);
    expect(parseLooseNumber("1.234,5")).toBe(1234.5);
    expect(parseLooseNumber("1,234.5")).toBe(1234.5);
    expect(parseLooseNumber("1 306 kJ")).toBe(1306);
    expect(parseLooseNumber("۳۱۲٫۵")).toBe(312.5);
    expect(parseLooseNumber("0,5")).toBe(0.5);
    expect(parseLooseNumber("no number")).toBeNull();
  });
  it("parses energy to kcal", () => {
    expect(parseEnergyKcal("312 Cal")).toBe(312);
    expect(parseEnergyKcal("1306 kJ")).toBe(312.1);
    expect(parseEnergyKcal("۳۱۲ کیلوکالری")).toBe(312);
  });
  it("parses heart rate", () => {
    expect(parseHeartRate("118 count/min")).toBe(118);
    expect(parseHeartRate("118 bpm")).toBe(118);
    expect(parseHeartRate("1.97 count/s")).toBeCloseTo(118.2);
    expect(parseHeartRate("۱۱۸")).toBe(118);
    expect(parseHeartRate("5 count/min")).toBeNull();
  });
  it("parses durations", () => {
    expect(parseDurationSec("57 min")).toBe(3420);
    expect(parseDurationSec("1 hr 5 min")).toBe(3900);
    expect(parseDurationSec("1h 5m 12s")).toBe(3912);
    expect(parseDurationSec("57:28")).toBe(3448);
    expect(parseDurationSec("1:02:03")).toBe(3723);
    expect(parseDurationSec("3420 s")).toBe(3420);
    expect(parseDurationSec("۵۷ دقیقه")).toBe(3420);
    expect(parseDurationSec("57")).toBe(3420);
    expect(parseDurationSec("3448")).toBe(3448);
  });
  it("recognises workout activity types", () => {
    expect(parseActivityType("Traditional Strength Training")).toBe("Traditional Strength Training");
    expect(parseActivityType("HKWorkoutActivityTypeFunctionalStrengthTraining")).toBe("Functional Strength Training");
    expect(parseActivityType("traditionalStrengthTraining")).toBe("Traditional Strength Training");
    expect(parseActivityType("تمرین قدرتی سنتی")).toBe("Traditional Strength Training");
    expect(parseActivityType("312 kcal")).toBeNull();
  });
});

describe("dates", () => {
  const at = "2026-09-28T23:05:00.000Z"; // 17:05 MDT
  it.each([
    ["2026-09-28T17:05:00-06:00"],
    ["2026-09-28T23:05:00Z"],
    ["2026-09-28 17:05:00 -0600"],
    ["2026-09-28 17:05"],
    ["Mon, 28 Sep 2026 17:05:00 -0600"],
    ["Sep 28, 2026 at 5:05 PM"],
    ["September 28, 2026 at 5:05 PM"],
    ["Monday, September 28, 2026 at 5:05:00 PM MDT"],
    ["28 Sep 2026 at 17:05"],
    ["9/28/26, 5:05 PM"],
    ["9/28/2026 17:05"],
    ["28/09/2026 17:05"],
    ["28.09.26, 17:05"],
    ["۶ مهر ۱۴۰۵، ساعت ۵:۰۵ ب.ظ"],
    ["دوشنبه ۶ مهر ۱۴۰۵ ۱۷:۰۵"],
    ["۱۴۰۵/۰۷/۰۶، ۱۷:۰۵"],
    ["‎2026-09-28 17:05‎"],
  ])("%s", (s) => {
    expect(parseLooseDate(s, TZ, NOW)).toBe(at);
  });
  it("handles relative dates, AM/12 edge cases and garbage", () => {
    expect(parseLooseDate("Today at 5:05 PM", TZ, NOW)).toBe(at);
    expect(parseLooseDate("Yesterday at 5:05 PM", TZ, NOW)).toBe("2026-09-27T23:05:00.000Z");
    expect(parseLooseDate("Sep 28, 2026 at 12:10 AM", TZ, NOW)).toBe("2026-09-28T06:10:00.000Z");
    expect(parseLooseDate("Sep 28, 2026 at 12:10 PM", TZ, NOW)).toBe("2026-09-28T18:10:00.000Z");
    expect(parseLooseDate("1790636700", TZ, NOW)).toBe("2026-09-28T23:05:00.000Z");
    expect(parseLooseDate("118 count/min", TZ, NOW)).toBeNull();
    expect(parseLooseDate("Traditional Strength Training", TZ, NOW)).toBeNull();
    expect(parseLooseDate("", TZ, NOW)).toBeNull();
  });
  it("converts Jalali dates", () => {
    expect(jalaliToGregorian(1405, 7, 6)).toEqual([2026, 9, 28]);
    expect(jalaliToGregorian(1405, 1, 1)).toEqual([2026, 3, 21]);
    expect(jalaliToGregorian(1403, 12, 30)).toEqual([2025, 3, 20]);
  });
});

const single = {
  activity_type: "Traditional Strength Training",
  hr_avg: 129.7,
  hr_max: 161,
  hr_count: 7,
};

describe("payload fixtures", () => {
  it("iOS 18, ISO 8601 dates and units", () => {
    const r = parseShortcutsPayload(ios18, TZ, NOW);
    expect(r.workouts).toEqual([
      { ...single, started_at: "2026-09-28T23:05:12.000Z", ended_at: "2026-09-29T00:02:40.000Z", duration_sec: 3448, active_kcal: 312, total_kcal: null },
    ]);
    expect(r.hr_samples).toBe(9);
    expect(r.warnings).toEqual([]);
  });

  it("iOS 17 en-US default style: CRLF, narrow no-break spaces, Title Case keys, bare numbers", () => {
    const r = parseShortcutsPayload(ios17, TZ, NOW);
    expect(r.workouts).toEqual([
      { ...single, started_at: "2026-09-28T23:05:00.000Z", ended_at: "2026-09-29T00:02:00.000Z", duration_sec: 3420, active_kcal: 312, total_kcal: null },
    ]);
  });

  it("Persian locale: Persian digits, Jalali dates, ب.ظ, Persian units", () => {
    const r = parseShortcutsPayload(persian, TZ, NOW);
    expect(r.workouts).toEqual([
      { ...single, started_at: "2026-09-28T23:05:00.000Z", ended_at: "2026-09-29T00:02:00.000Z", duration_sec: 3420, active_kcal: 312, total_kcal: null },
    ]);
  });

  it("7-day sync: JSON arrays, en-GB dates, comma decimals, inline HR dates, duplicates", () => {
    const r = parseShortcutsPayload(sevenDays, TZ, NOW);
    expect(r.workouts.map((w) => [w.activity_type, w.started_at, w.duration_sec, w.active_kcal, w.hr_avg, w.hr_max])).toEqual([
      ["Traditional Strength Training", "2026-09-22T13:30:00.000Z", 3300, 280.5, 121, 130],
      ["Walking", "2026-09-24T18:00:00.000Z", 2400, 150, 99, 99],
      ["Functional Strength Training", "2026-09-27T00:00:00.000Z", 3000, 1204, 145, 150],
    ]);
    expect(r.hr_samples).toBe(6);
  });

  it("no HR timestamps: all samples go to the only workout; RFC 2822 dates; kJ", () => {
    const r = parseShortcutsPayload(hrNoTimes, TZ, NOW);
    expect(r.workouts).toHaveLength(1);
    expect(r.workouts[0]).toMatchObject({ activity_type: "Traditional Strength Training", duration_sec: 3420, active_kcal: 312.1, hr_avg: 130, hr_max: 142, hr_count: 3 });
    expect(r.warnings).toContain("hr_without_time_assigned_to_single_workout");
  });

  it("workout text lines with start – end and energy inline", () => {
    const r = parseShortcutsPayload(textOnly, TZ, NOW);
    expect(r.workouts.map((w) => [w.activity_type, w.started_at, w.ended_at, w.active_kcal])).toEqual([
      ["Traditional Strength Training", "2026-09-28T23:05:00.000Z", "2026-09-29T00:02:00.000Z", 312],
      ["Walking", "2026-09-27T14:00:00.000Z", "2026-09-27T14:30:00.000Z", 95],
    ]);
    expect(r.hr_samples).toBe(0);
  });

  it("dotted European dates with a duration instead of an end date", () => {
    const r = parseShortcutsPayload(euDotted, TZ, NOW);
    expect(r.workouts[0]).toMatchObject({
      activity_type: "Functional Strength Training",
      started_at: "2026-09-28T23:05:00.000Z",
      ended_at: "2026-09-29T00:02:28.000Z",
      duration_sec: 3448,
      active_kcal: 301.4,
      hr_avg: 122.5,
      hr_max: 125,
    });
  });

  it("empty or unrelated payloads produce nothing", () => {
    expect(parseShortcutsPayload({}, TZ, NOW).workouts).toEqual([]);
    expect(parseShortcutsPayload({ foo: "bar" }, TZ, NOW).workouts).toEqual([]);
    expect(parseShortcutsPayload("nonsense", TZ, NOW).workouts).toEqual([]);
    expect(parseShortcutsPayload(null, TZ, NOW).workouts).toEqual([]);
  });
});

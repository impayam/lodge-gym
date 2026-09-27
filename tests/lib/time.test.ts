import { describe, expect, it } from "vitest";
import { addDays, daysBetween, isValidTimeZone, localDate, localHM, weekday, zonedToUtcISO } from "../../worker/lib/time";

const TZ = "America/Denver";

describe("time", () => {
  it("computes the local date in the settings timezone", () => {
    // 2026-09-28 03:30 UTC is still 2026-09-27 21:30 in Denver (MDT, UTC-6).
    expect(localDate(TZ, "2026-09-28T03:30:00.000Z")).toBe("2026-09-27");
    expect(localHM(TZ, "2026-09-28T03:30:00.000Z")).toBe("21:30");
  });
  it("converts wall-clock time to UTC across DST", () => {
    expect(zonedToUtcISO("2026-09-28", "17:05", TZ)).toBe("2026-09-28T23:05:00.000Z"); // MDT
    expect(zonedToUtcISO("2026-12-01", "17:05", TZ)).toBe("2026-12-02T00:05:00.000Z"); // MST
    expect(zonedToUtcISO("2026-11-01", "12:00", TZ)).toBe("2026-11-01T19:00:00.000Z"); // day DST ends
  });
  it("round-trips", () => {
    const iso = zonedToUtcISO("2026-03-08", "10:15", TZ);
    expect(localDate(TZ, iso)).toBe("2026-03-08");
    expect(localHM(TZ, iso)).toBe("10:15");
  });
  it("does date arithmetic", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysBetween("2026-09-20", "2026-09-27")).toBe(7);
    expect(weekday("2026-09-27")).toBe(0); // Sunday
  });
  it("validates time zones", () => {
    expect(isValidTimeZone(TZ)).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});

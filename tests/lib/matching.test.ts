import { describe, expect, it } from "vitest";
import { matchSession, type MatchSession } from "../../worker/lib/matching";

const TZ = "America/Denver";
const s = (id: string, start: string, end: string | null, date = "2026-09-28"): MatchSession => ({ id, local_date: date, started_at: start, ended_at: end });

describe("watch workout matching (SPEC §9.1)", () => {
  const w = { started_at: "2026-09-28T23:05:00.000Z", ended_at: "2026-09-29T00:02:00.000Z" };

  it("matches an overlapping session", () => {
    expect(matchSession(w, [s("a", "2026-09-28T23:00:00.000Z", "2026-09-29T00:00:00.000Z")], TZ)).toBe("a");
  });
  it("matches a session starting within ±90 min on the same local date", () => {
    expect(matchSession(w, [s("a", "2026-09-28T21:40:00.000Z", "2026-09-28T22:00:00.000Z")], TZ)).toBe("a");
  });
  it("does not match beyond 90 min without overlap", () => {
    expect(matchSession(w, [s("a", "2026-09-28T21:00:00.000Z", "2026-09-28T21:30:00.000Z")], TZ)).toBeNull();
  });
  it("requires the same local date for the ±90 min rule", () => {
    // 2026-09-29 00:30 MDT is 06:30Z; a watch workout at 23:30 MDT on the 28th starts 05:30Z.
    const late = { started_at: "2026-09-29T05:30:00.000Z", ended_at: "2026-09-29T05:50:00.000Z" };
    expect(matchSession(late, [s("a", "2026-09-29T06:30:00.000Z", "2026-09-29T07:00:00.000Z", "2026-09-29")], TZ)).toBeNull();
  });
  it("prefers the larger overlap, then the closer start", () => {
    const sessions = [s("small", "2026-09-28T23:50:00.000Z", "2026-09-29T00:30:00.000Z"), s("big", "2026-09-28T23:00:00.000Z", "2026-09-29T00:00:00.000Z")];
    expect(matchSession(w, sessions, TZ)).toBe("big");
    const near = [s("far", "2026-09-28T22:00:00.000Z", "2026-09-28T22:30:00.000Z"), s("near", "2026-09-28T22:40:00.000Z", "2026-09-28T22:50:00.000Z")];
    expect(matchSession(w, near, TZ)).toBe("near");
  });
  it("treats an active session as running until now", () => {
    const active = s("act", "2026-09-28T23:00:00.000Z", null);
    expect(matchSession(w, [active], TZ, Date.parse("2026-09-28T23:30:00.000Z"))).toBe("act");
  });
  it("returns null with no sessions", () => {
    expect(matchSession(w, [], TZ)).toBeNull();
  });
});

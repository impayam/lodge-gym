import { describe, expect, it } from "vitest";
import { ID_RE, ulid } from "../../worker/lib/ulid";

describe("ulid", () => {
  it("is 26 Crockford base32 chars and sorts by time", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ID_RE.test(a)).toBe(true);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => ulid())).size).toBe(1000);
  });
});

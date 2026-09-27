import { describe, expect, it } from "vitest";
import { CSP } from "../../worker/headers";
import { Client } from "./helpers";

describe("security headers", () => {
  it("uses the CSP from SPEC §13", () => {
    expect(CSP).toBe("default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'");
  });
  for (const path of ["/", "/index.html", "/some/client/route", "/api/bootstrap", "/api/nope"]) {
    it(`sets CSP and nosniff on ${path}`, async () => {
      const res = await new Client().fetch(path);
      expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    });
  }
  it("returns JSON errors with a Persian message and no-store", async () => {
    const res = await new Client().fetch("/api/bootstrap");
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { error: { code: string; message_fa: string } };
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.message_fa).toMatch(/[؀-ۿ]/);
  });
});

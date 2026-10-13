import { describe, expect, it } from "vitest";
import { CSP } from "../../worker/headers";
import { Client } from "./helpers";

describe("security headers", () => {
  it("uses the CSP from SPEC §13 with the SPEC-v6 WebAssembly and blob-worker sources", () => {
    expect(CSP).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'"
    );
  });
  it("keeps eval blocked: scripts only from 'self', WebAssembly compilation the one exception", () => {
    const directives = new Map(CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
    expect(directives.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(CSP).not.toContain("'unsafe-eval'");
    expect(CSP).not.toContain("'unsafe-inline'");
    expect(directives.get("worker-src")).toEqual(["'self'", "blob:"]);
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
  });
  for (const path of ["/", "/index.html", "/some/client/route", "/api/bootstrap", "/api/nope"]) {
    it(`sets CSP and nosniff on ${path}`, async () => {
      const res = await new Client().fetch(path);
      expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
      expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'wasm-unsafe-eval';");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    });
  }
  it("returns JSON errors with an English message and no-store", async () => {
    const res = await new Client().fetch("/api/bootstrap");
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { error: { code: string; message_fa: string } };
    expect(body.error.code).toBe("unauthenticated");
    expect(body.error.message_fa).toBe("Sign in with Face ID to continue.");
  });
});

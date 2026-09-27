import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Client, ORIGIN, resetAuth, setupOwner, SoftAuthenticator } from "./helpers";

beforeEach(resetAuth);

async function login(client: Client, auth: SoftAuthenticator) {
  const opts = (await (await client.post("/api/auth/login/options")).json()) as { challenge: string };
  return client.post("/api/auth/login/verify", { response: await auth.assert(opts) });
}

describe("first-run setup", () => {
  it("serves /setup only while no credential exists", async () => {
    const c = new Client();
    const before = await c.fetch("/setup");
    expect(before.status).toBe(200);
    expect(before.headers.get("Location")).toBeNull();
    expect(await before.text()).toContain('id="app"');
    await setupOwner();
    const after = await c.fetch("/setup");
    expect(after.status).toBe(404);
  });

  it("rejects a wrong setup token", async () => {
    const c = new Client();
    const res = await c.post("/api/auth/register/options", { setup_token: "nope" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "bad_setup_token" } });
  });

  it("registers the first passkey, returns 10 recovery codes once and logs in", async () => {
    const { client, codes } = await setupOwner();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const stored = await env.DB.prepare("SELECT code_hash FROM recovery_codes").all<{ code_hash: string }>();
    expect(stored.results).toHaveLength(10);
    expect(stored.results.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash))).toBe(true);
    expect(stored.results.map((r) => r.code_hash)).not.toContain(codes[0]);
    const cred = await env.DB.prepare("SELECT * FROM credentials").all();
    expect(cred.results).toHaveLength(1);
    expect((await client.fetch("/api/bootstrap")).status).toBe(200);
  });

  it("sets a hardened session cookie and stores only its hash", async () => {
    const c = new Client();
    const auth = await new SoftAuthenticator().init();
    const opts = (await (await c.post("/api/auth/register/options", { setup_token: env.SETUP_TOKEN })).json()) as { challenge: string };
    const res = await c.post("/api/auth/register/verify", { setup_token: env.SETUP_TOKEN, response: await auth.register(opts) });
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^__Host-lg_session=[A-Za-z0-9_-]{43};/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) expect(cookie).toContain(attr);
    const token = cookie.split(";")[0].split("=")[1];
    const rows = await env.DB.prepare("SELECT token_hash, scope FROM auth_sessions").all<{ token_hash: string; scope: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].token_hash).not.toBe(token);
    expect(rows.results[0].scope).toBe("full");
  });

  it("does not allow the setup token once a credential exists", async () => {
    await setupOwner();
    const c = new Client("203.0.113.9");
    const res = await c.post("/api/auth/register/options", { setup_token: env.SETUP_TOKEN });
    expect(res.status).toBe(401);
  });

  it("rejects a replayed registration challenge", async () => {
    const c = new Client();
    const auth = await new SoftAuthenticator().init();
    const opts = (await (await c.post("/api/auth/register/options", { setup_token: env.SETUP_TOKEN })).json()) as { challenge: string };
    const response = await auth.register(opts);
    await env.DB.prepare("DELETE FROM auth_challenges").run();
    const res = await c.post("/api/auth/register/verify", { setup_token: env.SETUP_TOKEN, response });
    expect(res.status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("login", () => {
  it("logs in with the registered passkey", async () => {
    const { auth } = await setupOwner();
    const c = new Client("203.0.113.2");
    expect((await c.fetch("/api/bootstrap")).status).toBe(401);
    const res = await login(c, auth);
    expect(res.status).toBe(200);
    expect((await c.fetch("/api/bootstrap")).status).toBe(200);
    const cred = await env.DB.prepare("SELECT counter, last_used_at FROM credentials").first<{ counter: number; last_used_at: string }>();
    expect(cred!.counter).toBe(1);
    expect(cred!.last_used_at).toBeTruthy();
  });

  it("rejects an unknown passkey", async () => {
    await setupOwner();
    const other = await new SoftAuthenticator().init();
    const res = await login(new Client("203.0.113.3"), other);
    expect(res.status).toBe(401);
  });

  it("rejects an assertion for another origin", async () => {
    const { auth } = await setupOwner();
    const c = new Client("203.0.113.4");
    const opts = (await (await c.post("/api/auth/login/options")).json()) as { challenge: string };
    const res = await c.post("/api/auth/login/verify", { response: await auth.assert(opts, "https://evil.test", "evil.test") });
    expect(res.status).toBe(401);
  });

  it("uses each challenge once", async () => {
    const { auth } = await setupOwner();
    const c = new Client("203.0.113.5");
    const opts = (await (await c.post("/api/auth/login/options")).json()) as { challenge: string };
    const response = await auth.assert(opts);
    expect((await c.post("/api/auth/login/verify", { response })).status).toBe(200);
    expect((await c.post("/api/auth/login/verify", { response })).status).toBe(401);
  });

  it("logs out", async () => {
    const { client } = await setupOwner();
    expect((await client.post("/api/auth/logout")).status).toBe(200);
    expect(client.cookie).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_sessions").first<{ n: number }>())!.n).toBe(0);
  });

  it("slides the session expiry", async () => {
    const { client } = await setupOwner();
    const old = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await env.DB.prepare("UPDATE auth_sessions SET expires_at = ?").bind(old).run();
    const res = await client.fetch("/api/bootstrap");
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=2592000");
    const row = await env.DB.prepare("SELECT expires_at FROM auth_sessions").first<{ expires_at: string }>();
    expect(Date.parse(row!.expires_at)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("rejects expired sessions", async () => {
    const { client } = await setupOwner();
    await env.DB.prepare("UPDATE auth_sessions SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await client.fetch("/api/bootstrap")).status).toBe(401);
  });
});

describe("recovery", () => {
  it("a recovery code gives a session that can only register a new passkey", async () => {
    const { codes } = await setupOwner();
    const c = new Client("203.0.113.6");
    const bad = await c.post("/api/auth/recover", { code: "AAAA-BBBB-CCCC" });
    expect(bad.status).toBe(401);
    const res = await c.post("/api/auth/recover", { code: codes[3].toLowerCase().replace(/-/g, " ") });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=900");
    const blocked = await c.fetch("/api/bootstrap");
    expect(blocked.status).toBe(403);

    const fresh = await new SoftAuthenticator().init();
    const opts = (await (await c.post("/api/auth/register/options")).json()) as { challenge: string };
    const reg = await c.post("/api/auth/register/verify", { response: await fresh.register(opts), label: "iPhone تازه" });
    expect(reg.status).toBe(200);
    expect((await c.fetch("/api/bootstrap")).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials").first<{ n: number }>())!.n).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE scope = 'recovery'").first<{ n: number }>())!.n).toBe(0);

    // The new passkey logs in; the used code is spent.
    expect((await login(new Client("203.0.113.7"), fresh)).status).toBe(200);
    expect((await new Client("203.0.113.8").post("/api/auth/recover", { code: codes[3] })).status).toBe(401);
  });

  it("a full session can add another device", async () => {
    const { client } = await setupOwner();
    const second = await new SoftAuthenticator().init();
    const opts = (await (await client.post("/api/auth/register/options")).json()) as { challenge: string; excludeCredentials: unknown[] };
    expect(opts.excludeCredentials).toHaveLength(1);
    expect((await client.post("/api/auth/register/verify", { response: await second.register(opts) })).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials").first<{ n: number }>())!.n).toBe(2);
  });

  it("anonymous callers cannot add a device", async () => {
    await setupOwner();
    const res = await new Client("203.0.113.10").post("/api/auth/register/options");
    expect(res.status).toBe(401);
  });
});

describe("rate limiting and CSRF", () => {
  it("limits /api/auth/* to 10 requests per minute per IP", async () => {
    await setupOwner("198.51.100.1");
    await env.DB.prepare("DELETE FROM rate_limits").run();
    const c = new Client("198.51.100.2");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await c.post("/api/auth/login/options")).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Other IPs are unaffected.
    expect((await new Client("198.51.100.3").post("/api/auth/login/options")).status).toBe(200);
  });

  it("rejects state-changing requests without a matching Origin", async () => {
    const { client } = await setupOwner();
    const cross = await client.fetch("/api/auth/logout", { method: "POST", headers: { Origin: "https://evil.test" } });
    expect(cross.status).toBe(403);
    const none = await client.fetch("/api/sessions/X", { method: "DELETE", headers: { Origin: "" } });
    expect(none.status).toBe(403);
    const ok = await client.fetch("/api/auth/logout", { method: "POST", headers: { Origin: ORIGIN } });
    expect(ok.status).toBe(200);
  });
});

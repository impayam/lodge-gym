// Passkey auth (SPEC §4): first-run setup, login, recovery codes, sessions, rate limiting.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { normalizeRecoveryCode, randomToken, recoveryCode, safeEqual, sha256Hex } from "./crypto";
import type { AppBindings, Env, SessionScope } from "./env";
import { ApiError, fail, nowISO, readJson } from "./http";

export const SESSION_COOKIE = "__Host-lg_session";
const DAY = 86_400_000;
const FULL_TTL = 30 * DAY;
const RECOVERY_TTL = 15 * 60_000;
const CHALLENGE_TTL = 5 * 60_000;
const RATE_LIMIT = 10;
const RP_NAME = "Lodge Gym";
// Single user: a fixed WebAuthn user handle so every passkey belongs to the same account.
const USER_ID = new Uint8Array(new TextEncoder().encode("lodge-gym-owner"));
const RECOVERY_CODE_COUNT = 10;

/* ---------------- cookies & sessions ---------------- */

function readCookie(c: Context, name: string): string | null {
  const header = c.req.header("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function setSessionCookie(c: Context, token: string, maxAgeMs: number) {
  c.header("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`, {
    append: true,
  });
}

function clearSessionCookie(c: Context) {
  c.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`, { append: true });
}

async function createSession(c: Context<AppBindings>, scope: SessionScope) {
  const token = randomToken();
  const ttl = scope === "full" ? FULL_TTL : RECOVERY_TTL;
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO auth_sessions (token_hash, created_at, expires_at, scope) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), new Date(now).toISOString(), new Date(now + ttl).toISOString(), scope)
    .run();
  setSessionCookie(c, token, ttl);
}

interface SessionRow {
  token_hash: string;
  expires_at: string;
  scope: SessionScope;
}

async function currentSession(c: Context<AppBindings>): Promise<SessionRow | null> {
  const token = readCookie(c, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const hash = await sha256Hex(token);
  const row = await c.env.DB.prepare("SELECT token_hash, expires_at, scope FROM auth_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(hash, nowISO())
    .first<SessionRow>();
  if (!row) return null;
  // Sliding 30-day expiry for full sessions, refreshed at most once a day.
  if (row.scope === "full" && Date.parse(row.expires_at) - Date.now() < FULL_TTL - DAY) {
    const expires = new Date(Date.now() + FULL_TTL).toISOString();
    await c.env.DB.prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?").bind(expires, hash).run();
    setSessionCookie(c, token, FULL_TTL);
  }
  return row;
}

/** Requires a full (non-recovery) session. */
export const requireSession: MiddlewareHandler<AppBindings> = async (c, next) => {
  const s = await currentSession(c);
  if (!s) return fail(c, 401, "unauthenticated", "برای ادامه با Face ID وارد شو.");
  if (s.scope !== "full") return fail(c, 403, "recovery_only", "با کد بازیابی فقط می‌توانی یک passkey تازه ثبت کنی.");
  c.set("scope", s.scope);
  c.set("tokenHash", s.token_hash);
  await next();
};

/* ---------------- rate limiting ---------------- */

export const rateLimitAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const windowStart = Math.floor(Date.now() / 60_000);
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`
  )
    .bind(`auth:${ip}`, windowStart)
    .first<{ count: number }>();
  if (row && row.count > RATE_LIMIT) {
    c.header("Retry-After", "60");
    return fail(c, 429, "rate_limited", "تعداد تلاش‌ها زیاد بود. یک دقیقه صبر کن و دوباره امتحان کن.");
  }
  await next();
};

/* ---------------- helpers ---------------- */

function rp(c: Context) {
  const url = new URL(c.req.url);
  return { rpID: url.hostname, origin: url.origin };
}

async function credentialCount(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials").first<{ n: number }>();
  return r?.n ?? 0;
}

async function storeChallenge(env: Env, challenge: string, purpose: "register" | "login") {
  const now = nowISO();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO auth_challenges (challenge, purpose, expires_at) VALUES (?, ?, ?)").bind(
      challenge,
      purpose,
      new Date(Date.now() + CHALLENGE_TTL).toISOString()
    ),
  ]);
}

/** Atomically consumes a stored challenge; each challenge verifies at most once. */
function consumeChallenge(env: Env, purpose: "register" | "login") {
  return async (challenge: string) => {
    const r = await env.DB.prepare("DELETE FROM auth_challenges WHERE challenge = ? AND purpose = ? AND expires_at > ? RETURNING challenge")
      .bind(challenge, purpose, nowISO())
      .first();
    return r != null;
  };
}

type RegMode = { mode: "setup" } | { mode: "recovery"; tokenHash: string } | { mode: "add"; tokenHash: string };

/** Who may register a passkey: the setup token (no credential yet), a recovery session, or a full session. */
async function authorizeRegistration(c: Context<AppBindings>, setupToken: string | undefined): Promise<RegMode> {
  if ((await credentialCount(c.env)) === 0) {
    if (!c.env.SETUP_TOKEN) throw new ApiError(503, "setup_unavailable", "SETUP_TOKEN روی سرور تنظیم نشده است.");
    if (!setupToken || !(await safeEqual(setupToken, c.env.SETUP_TOKEN)))
      throw new ApiError(401, "bad_setup_token", "کد راه‌اندازی درست نیست.");
    return { mode: "setup" };
  }
  const s = await currentSession(c);
  if (!s) throw new ApiError(401, "unauthenticated", "برای افزودن دستگاه اول وارد شو.");
  return s.scope === "recovery" ? { mode: "recovery", tokenHash: s.token_hash } : { mode: "add", tokenHash: s.token_hash };
}

const toBytes = (v: unknown): Uint8Array<ArrayBuffer> => (v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v as number[]));

/* ---------------- routes ---------------- */

const regOptionsBody = z.object({ setup_token: z.string().max(512).optional() });
const regVerifyBody = z.object({
  setup_token: z.string().max(512).optional(),
  label: z.string().trim().max(60).optional(),
  response: z.custom<RegistrationResponseJSON>((v) => typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string"),
});
const loginVerifyBody = z.object({
  response: z.custom<AuthenticationResponseJSON>((v) => typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string"),
});
const recoverBody = z.object({ code: z.string().min(1).max(64) });

export const authRoutes = new Hono<AppBindings>();

authRoutes.use("*", rateLimitAuth);

authRoutes.post("/register/options", async (c) => {
  const body = await readJson(c, regOptionsBody);
  await authorizeRegistration(c, body.setup_token);
  const existing = await c.env.DB.prepare("SELECT id, transports FROM credentials").all<{ id: string; transports: string | null }>();
  const { rpID } = rp(c);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: USER_ID,
    userName: "Lodge Gym",
    userDisplayName: "Lodge Gym",
    attestationType: "none",
    excludeCredentials: existing.results.map((r) => ({
      id: r.id,
      transports: r.transports ? (JSON.parse(r.transports) as AuthenticatorTransport[]) : undefined,
    })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257],
  });
  await storeChallenge(c.env, options.challenge, "register");
  return c.json(options);
});

authRoutes.post("/register/verify", async (c) => {
  const body = await readJson(c, regVerifyBody);
  const auth = await authorizeRegistration(c, body.setup_token);
  const { rpID, origin } = rp(c);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: consumeChallenge(c.env, "register"),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return fail(c, 400, "registration_failed", "ثبت passkey انجام نشد. دوباره امتحان کن.");
  }
  if (!verification.verified) return fail(c, 400, "registration_failed", "ثبت passkey انجام نشد. دوباره امتحان کن.");
  const cred = verification.registrationInfo.credential;
  const now = nowISO();
  const label = body.label || (auth.mode === "setup" ? "دستگاه اصلی" : "دستگاه تازه");
  const values = [cred.id, cred.publicKey.slice().buffer, cred.counter, JSON.stringify(cred.transports ?? []), now, label] as const;

  if (auth.mode === "setup") {
    // Only the very first credential may be created through the setup token.
    const ins = await c.env.DB.prepare(
      `INSERT INTO credentials (id, public_key, counter, transports, created_at, label)
       SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM credentials)`
    )
      .bind(...values)
      .run();
    if (!ins.meta.changes) return fail(c, 409, "already_setup", "راه‌اندازی قبلاً انجام شده است.");
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    const hashes = await Promise.all(codes.map((code) => sha256Hex(normalizeRecoveryCode(code))));
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM recovery_codes"),
      ...hashes.map((h) => c.env.DB.prepare("INSERT INTO recovery_codes (code_hash, used_at) VALUES (?, NULL)").bind(h)),
    ]);
    await createSession(c, "full");
    return c.json({ ok: true, recovery_codes: codes });
  }

  await c.env.DB.prepare("INSERT INTO credentials (id, public_key, counter, transports, created_at, label) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(...values)
    .run();
  if (auth.mode === "recovery") {
    // Registering with user verification is itself an authentication: swap the recovery session for a full one.
    await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(auth.tokenHash).run();
    await createSession(c, "full");
  }
  return c.json({ ok: true });
});

authRoutes.post("/login/options", async (c) => {
  if ((await credentialCount(c.env)) === 0) return fail(c, 409, "not_setup", "هنوز هیچ دستگاهی ثبت نشده است.");
  const { rpID } = rp(c);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  await storeChallenge(c.env, options.challenge, "login");
  return c.json(options);
});

authRoutes.post("/login/verify", async (c) => {
  const body = await readJson(c, loginVerifyBody);
  const row = await c.env.DB.prepare("SELECT id, public_key, counter, transports FROM credentials WHERE id = ?")
    .bind(body.response.id)
    .first<{ id: string; public_key: ArrayBuffer | number[]; counter: number; transports: string | null }>();
  if (!row) return fail(c, 401, "unknown_credential", "این passkey برای این برنامه ثبت نشده است.");
  const { rpID, origin } = rp(c);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: consumeChallenge(c.env, "login"),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: row.id,
        publicKey: toBytes(row.public_key),
        counter: row.counter,
        transports: row.transports ? (JSON.parse(row.transports) as AuthenticatorTransport[]) : undefined,
      },
    });
  } catch {
    return fail(c, 401, "login_failed", "ورود انجام نشد. دوباره امتحان کن.");
  }
  if (!verification.verified) return fail(c, 401, "login_failed", "ورود انجام نشد. دوباره امتحان کن.");
  const now = nowISO();
  const stmts = [
    c.env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").bind(verification.authenticationInfo.newCounter, now, row.id),
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now),
  ];
  const previous = readCookie(c, SESSION_COOKIE);
  if (previous) stmts.push(c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256Hex(previous)));
  await c.env.DB.batch(stmts);
  await createSession(c, "full");
  return c.json({ ok: true });
});

authRoutes.post("/recover", async (c) => {
  const body = await readJson(c, recoverBody);
  const hash = await sha256Hex(normalizeRecoveryCode(body.code));
  const used = await c.env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING code_hash")
    .bind(nowISO(), hash)
    .first();
  if (!used) return fail(c, 401, "bad_recovery_code", "کد بازیابی درست نیست یا قبلاً استفاده شده است.");
  await createSession(c, "recovery");
  return c.json({ ok: true, scope: "recovery" });
});

authRoutes.post("/logout", async (c) => {
  const token = readCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});

export { credentialCount };

// Test helpers: an HTTP client with a cookie jar and a software passkey authenticator.

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

export const ORIGIN = "https://lodge.test";
export const RP_ID = "lodge.test";

export class Client {
  cookie: string | null = null;
  constructor(public ip = "203.0.113.1") {}

  async fetch(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("Origin") && init.method && init.method !== "GET") headers.set("Origin", ORIGIN);
    headers.set("CF-Connecting-IP", this.ip);
    if (this.cookie) headers.set("Cookie", this.cookie);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await (exports as unknown as { default: Fetcher }).default.fetch(new Request(ORIGIN + path, { ...init, headers, body }));
    const set = res.headers.get("Set-Cookie");
    if (set) {
      const [pair] = set.split(";");
      const value = pair.slice(pair.indexOf("=") + 1);
      this.cookie = value ? pair : null;
    }
    return res;
  }

  post(path: string, json: unknown = {}) {
    return this.fetch(path, { method: "POST", json });
  }
}

const b64u = (b: Uint8Array | ArrayBuffer) => isoBase64URL.fromBuffer(new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)));
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)));
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** Converts a raw (r||s) P-256 signature to ASN.1 DER, as authenticators emit. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

/** Minimal platform authenticator (ES256, "none" attestation, UV always performed). */
export class SoftAuthenticator {
  credentialId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  private keys!: CryptoKeyPair;

  get id() {
    return b64u(this.credentialId);
  }

  async init() {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return this;
  }

  async register(options: { challenge: string }, origin = ORIGIN, rpId = RP_ID) {
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, isoBase64URL.toBuffer(jwk.x!)],
      [-3, isoBase64URL.toBuffer(jwk.y!)],
    ]);
    const coseBytes = isoCBOR.encode(cose);
    const authData = concat(
      await sha256(new TextEncoder().encode(rpId)),
      new Uint8Array([0x45]), // UP | UV | AT
      u32(this.counter),
      new Uint8Array(16),
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      new Uint8Array(coseBytes)
    );
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never
    );
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  async assert(options: { challenge: string }, origin = ORIGIN, rpId = RP_ID) {
    this.counter++;
    const authData = concat(await sha256(new TextEncoder().encode(rpId)), new Uint8Array([0x05]), u32(this.counter));
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(rawToDer(raw)),
        userHandle: b64u(new TextEncoder().encode("lodge-gym-owner")),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

export async function resetAuth() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM credentials"),
    env.DB.prepare("DELETE FROM auth_sessions"),
    env.DB.prepare("DELETE FROM recovery_codes"),
    env.DB.prepare("DELETE FROM auth_challenges"),
    env.DB.prepare("DELETE FROM rate_limits"),
  ]);
}

/** Runs first-run setup and returns a logged-in client, its authenticator and the recovery codes. */
export async function setupOwner(ip?: string) {
  const client = new Client(ip);
  const auth = await new SoftAuthenticator().init();
  const opts = (await (await client.post("/api/auth/register/options", { setup_token: env.SETUP_TOKEN })).json()) as { challenge: string };
  const res = await client.post("/api/auth/register/verify", { setup_token: env.SETUP_TOKEN, response: await auth.register(opts) });
  const body = (await res.json()) as { ok: boolean; recovery_codes: string[] };
  if (!body.ok) throw new Error("setup failed: " + JSON.stringify(body));
  return { client, auth, codes: body.recovery_codes };
}

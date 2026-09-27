// A fake browser push subscription that can decrypt aes128gcm messages (RFC 8291), for tests.

import { b64u } from "../../worker/lib/webpush";

const enc = new TextEncoder();
const u8 = (x: ArrayBuffer | Uint8Array) => new Uint8Array(x instanceof Uint8Array ? x : new Uint8Array(x));
const concat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey("raw", u8(ikm), "HKDF", false, ["deriveBits"]);
  return u8(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: u8(salt), info: u8(info) }, key, len * 8));
}

export async function fakeSubscription(endpoint = "https://web.push.apple.com/QFake-device-token") {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = u8((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint, keys: { p256dh: b64u.encode(pub), auth: b64u.encode(auth) } };

  async function decrypt(body: Uint8Array): Promise<string> {
    const salt = body.slice(0, 16);
    const idlen = body[20];
    const asPublic = body.slice(21, 21 + idlen);
    const cipher = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const params = { name: "ECDH", public: asKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0];
    const ecdh = u8(await crypto.subtle.deriveBits(params, kp.privateKey, 256));
    const ikm = await hkdf(auth, ecdh, concat(enc.encode("WebPush: info\0"), pub, asPublic), 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = u8(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, cipher));
    if (plain[plain.length - 1] !== 2) throw new Error("missing last-record delimiter");
    return new TextDecoder().decode(plain.slice(0, -1));
  }
  return { sub, decrypt };
}

/** Verifies a "vapid t=…, k=…" header and returns the JWT claims. */
export async function verifyVapid(header: string) {
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
  const [h, c, s] = m[1].split(".");
  const key = await crypto.subtle.importKey("raw", b64u.decode(m[2]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u.decode(s), enc.encode(`${h}.${c}`));
  return { ok, header: JSON.parse(new TextDecoder().decode(b64u.decode(h))), claims: JSON.parse(new TextDecoder().decode(b64u.decode(c))), k: m[2] };
}

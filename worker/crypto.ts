const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison (compares SHA-256 digests so lengths never leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** Recovery code like "K7QM-2XPA-9RTD". */
export function recoveryCode(): string {
  // Rejection sampling keeps every character uniformly likely.
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  let chars = "";
  while (chars.length < 12) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    for (const x of b) if (x < limit && chars.length < 12) chars += RECOVERY_ALPHABET[x % RECOVERY_ALPHABET.length];
  }
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

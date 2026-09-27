// WebAuthn ceremonies against /api/auth (SPEC §4).

import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api } from "./api";

export async function registerPasskey(opts: { setupToken?: string; label?: string } = {}) {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>("POST", "/auth/register/options", { setup_token: opts.setupToken });
  const response = await startRegistration({ optionsJSON });
  return api<{ ok: true; recovery_codes?: string[] }>("POST", "/auth/register/verify", {
    setup_token: opts.setupToken,
    label: opts.label,
    response,
  });
}

export async function loginWithPasskey() {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>("POST", "/auth/login/options", {});
  const response = await startAuthentication({ optionsJSON });
  return api<{ ok: true }>("POST", "/auth/login/verify", { response });
}

export async function recover(code: string) {
  return api<{ ok: true }>("POST", "/auth/recover", { code });
}

/** Offline re-lock: a local Face ID check with a random challenge (the gate is client-side, SPEC §4.4). */
export async function localUnlock() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await startAuthentication({ optionsJSON: { challenge, rpId: location.hostname, userVerification: "required", allowCredentials: [], timeout: 60_000 } });
}

export const deviceLabel = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  return "دستگاه تازه";
};

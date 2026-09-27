// Rest-timer push notifications (Web Push). On iOS this works only in the Home Screen app (iOS 16.4+),
// and permission must be requested from a tap.

import { api } from "./api";
import * as ldb from "./localdb";

export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const b64uToBytes = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

let enabledCache: boolean | null = null;
export async function pushEnabled(): Promise<boolean> {
  if (enabledCache === null) enabledCache = (await ldb.kvGet<boolean>("push_enabled")) === true && Notification.permission === "granted";
  return enabledCache;
}

/** Must be called from a user gesture (button tap). */
export async function enablePush(): Promise<"enabled" | "denied" | "unsupported" | "not-standalone"> {
  if (!pushSupported()) return isStandalone() ? "unsupported" : "not-standalone";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const { public_key } = await api<{ public_key: string }>("GET", "/push/key");
  let sub = await reg.pushManager.getSubscription();
  const key = b64uToBytes(public_key);
  const current = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && current && current.join() !== key.join()) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api("POST", "/push/subscribe", sub.toJSON());
  await ldb.kvSet("push_enabled", true);
  enabledCache = true;
  return "enabled";
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api("POST", "/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  }
  await ldb.kvSet("push_enabled", false);
  enabledCache = false;
}

export async function testPush() {
  return api<{ sent: number; failed: number }>("POST", "/push/test", {});
}

/** Asks the server to push at rest end. Best effort: without network the in-app timer still works. */
export function schedulePush(id: string, endsAt: number, label: string) {
  void pushEnabled().then((on) => {
    if (on) api("POST", "/push/rest", { id, ends_at: endsAt, label }).catch(() => undefined);
  });
}

export function cancelPush(id: string) {
  void pushEnabled().then((on) => {
    if (on) api("POST", "/push/rest/cancel", { id }).catch(() => undefined);
  });
}

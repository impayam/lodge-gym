import { expect, test } from "@playwright/test";
import { resetWorkouts, signIn } from "./helpers";

test("rest push: enable from a tap, schedule on set check, reschedule on +30 s, cancel on close; SW shows the notification", async ({ page, context, baseURL, browserName }) => {
  test.skip(browserName !== "chromium", "uses CDP to deliver a push to the service worker");
  resetWorkouts();
  await context.grantPermissions(["notifications"], { origin: baseURL });
  await signIn(context, baseURL!);

  // Headless Chromium cannot reach a real push service: return a subscription with real P-256 keys instead.
  await page.addInitScript(() => {
    const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    PushManager.prototype.getSubscription = async () => null;
    PushManager.prototype.subscribe = async function (opts?: PushSubscriptionOptionsInit) {
      const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
      const p256dh = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
      const auth = b64u(crypto.getRandomValues(new Uint8Array(16)).buffer);
      const endpoint = "https://web.push.apple.com/QE2E-device";
      return {
        endpoint,
        options: opts,
        toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
        unsubscribe: async () => true,
      } as unknown as PushSubscription;
    };
  });

  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20_000 });
  await page.getByRole("button", { name: "تنظیمات" }).click();
  const card = page.getByTestId("push-settings");
  await expect(card.getByTestId("push-status")).toHaveText("خاموش");
  const subscribed = page.waitForRequest((r) => r.url().endsWith("/api/push/subscribe") && r.method() === "POST");
  await card.getByTestId("enable-push").click();
  const subReq = await subscribed;
  expect(subReq.postDataJSON()).toMatchObject({ endpoint: "https://web.push.apple.com/QE2E-device" });
  await expect(card.getByTestId("push-status")).toHaveText("فعال");
  const key = (await (await page.request.get(`${baseURL}/api/push/key`)).json()) as { subscriptions: number };
  expect(key.subscriptions).toBe(1);

  // Checking a set schedules the push at the rest end.
  await page.getByRole("button", { name: "تمرین" }).click();
  await page.getByRole("button", { name: "شروع", exact: true }).click();
  const scheduled = page.waitForRequest((r) => r.url().endsWith("/api/push/rest") && r.method() === "POST");
  const before = Date.now();
  await page.getByTestId("check-bench-0").click();
  const body = (await scheduled).postDataJSON() as { id: string; ends_at: number; label: string };
  expect(body.label).toBe("استراحت بعد از پرس سینه هالتر");
  expect(body.ends_at).toBeGreaterThanOrEqual(before + 179_000);
  expect(body.ends_at).toBeLessThanOrEqual(Date.now() + 181_000);

  const rescheduled = page.waitForRequest((r) => r.url().endsWith("/api/push/rest") && r.method() === "POST");
  await page.getByRole("button", { name: "+۳۰ ث" }).click();
  const again = (await rescheduled).postDataJSON() as { id: string; ends_at: number };
  expect(again.id).toBe(body.id);
  expect(again.ends_at).toBe(body.ends_at + 30_000);

  const cancelled = page.waitForRequest((r) => r.url().endsWith("/api/push/rest/cancel"));
  await page.getByRole("button", { name: "بستن" }).click();
  expect(((await cancelled).postDataJSON() as { id: string }).id).toBe(body.id);

  // Deliver a push to the service worker and check the notification it shows.
  const cdp = await context.newCDPSession(page);
  const regId = new Promise<string>((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e: { registrations: { registrationId: string; scopeURL: string; isDeleted: boolean }[] }) => {
      const r = e.registrations.find((x) => !x.isDeleted && x.scopeURL.startsWith(baseURL!));
      if (r) resolve(r.registrationId);
    });
  });
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: baseURL!,
    registrationId: await regId,
    data: JSON.stringify({ title: "استراحت تمام شد", body: "استراحت بعد از پرس سینه هالتر · ست بعدی", tag: "rest" }),
  });
  await expect
    .poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => [n.title, n.body, n.tag])))
    .toEqual([["استراحت تمام شد", "استراحت بعد از پرس سینه هالتر · ست بعدی", "rest"]]);
});

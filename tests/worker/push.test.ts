import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { RestPush } from "../../worker/push";
import { fakeSubscription, verifyVapid } from "../fixtures/push-client";
import { Client, ORIGIN, resetAuth, setupOwner } from "./helpers";

let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.97"));
});

const stub = () => env.REST_PUSH.get(env.REST_PUSH.idFromName("owner"));

describe("rest-timer push", () => {
  it("exposes a stable VAPID public key and stores subscriptions (deduped by endpoint)", async () => {
    const k1 = (await (await client.fetch("/api/push/key")).json()) as { public_key: string; subscriptions: number };
    const k2 = (await (await client.fetch("/api/push/key")).json()) as { public_key: string };
    expect(k1.public_key).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(k2.public_key).toBe(k1.public_key);
    const { sub } = await fakeSubscription("https://web.push.apple.com/QOne");
    expect(await (await client.post("/api/push/subscribe", sub)).json()).toEqual({ ok: true, subscriptions: 1 });
    expect(await (await client.post("/api/push/subscribe", sub)).json()).toEqual({ ok: true, subscriptions: 1 });
    expect((await client.post("/api/push/subscribe", { ...sub, endpoint: "http://insecure.test/x" })).status).toBe(400);
    expect(await (await client.post("/api/push/unsubscribe", { endpoint: sub.endpoint })).json()).toEqual({ ok: true, subscriptions: 0 });
  });

  it("schedules an alarm at rest end and sends an encrypted, VAPID-signed push; gone subscriptions are removed", async () => {
    const live = await fakeSubscription("https://web.push.apple.com/QLive");
    const gone = await fakeSubscription("https://fcm.googleapis.com/fcm/send/QGone");
    await client.post("/api/push/subscribe", live.sub);
    await client.post("/api/push/subscribe", gone.sub);
    const endsAt = Date.now() + 90_000;
    expect((await client.post("/api/push/rest", { id: "r1", ends_at: endsAt, label: "استراحت بعد از پرس سینه هالتر" })).status).toBe(200);

    const sent: { url: string; headers: Headers; body: Uint8Array }[] = [];
    await runInDurableObject(stub(), async (obj, state) => {
      const instance = obj as unknown as RestPush;
      expect(await state.storage.getAlarm()).toBe(endsAt);
      instance.pushFetch = async (input, init) => {
        // Read the body inside the Durable Object (I/O objects cannot cross into the test context).
        const req = new Request(input, init);
        sent.push({ url: req.url, headers: new Headers(req.headers), body: new Uint8Array(await req.arrayBuffer()) });
        return new Response(null, { status: req.url.includes("QGone") ? 410 : 201 });
      };
    });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(sent).toHaveLength(2);
    const req = sent.find((r) => r.url.includes("QLive"))!;
    const v = await verifyVapid(req.headers.get("Authorization")!);
    expect(v.ok).toBe(true);
    expect(v.claims.aud).toBe("https://web.push.apple.com");
    expect(v.claims.sub).toBe(ORIGIN);
    expect(req.headers.get("Topic")).toBe("rest");
    expect(JSON.parse(await live.decrypt(req.body))).toEqual({
      title: "استراحت تمام شد",
      body: "استراحت بعد از پرس سینه هالتر · ست بعدی",
      tag: "rest",
    });
    expect(((await (await client.fetch("/api/push/key")).json()) as { subscriptions: number }).subscriptions).toBe(1);
  });

  it("+30 s reschedules; closing the timer cancels", async () => {
    const t = Date.now() + 60_000;
    await client.post("/api/push/rest", { id: "r2", ends_at: t, label: "" });
    await client.post("/api/push/rest", { id: "r2", ends_at: t + 30_000, label: "" });
    await runInDurableObject(stub(), async (_i, state) => {
      expect(await state.storage.getAlarm()).toBe(t + 30_000);
    });
    // Cancelling another timer's id does nothing; its own id cancels.
    await client.post("/api/push/rest/cancel", { id: "other" });
    await runInDurableObject(stub(), async (_i, state) => expect(await state.storage.getAlarm()).toBe(t + 30_000));
    await client.post("/api/push/rest/cancel", { id: "r2" });
    await runInDurableObject(stub(), async (_i, state) => expect(await state.storage.getAlarm()).toBeNull());
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it("validates rest times and requires a session", async () => {
    expect((await client.post("/api/push/rest", { id: "x", ends_at: Date.now() + 2 * 3600_000 })).status).toBe(400);
    expect((await client.post("/api/push/rest", { id: "x", ends_at: Date.now() - 60_000 })).status).toBe(400);
    expect((await new Client("192.0.2.98").fetch("/api/push/key")).status).toBe(401);
  });

  it("test push reports sent and failed counts", async () => {
    await runInDurableObject(stub(), async (obj) => {
      (obj as unknown as RestPush).pushFetch = async () => new Response(null, { status: 201 });
    });
    const r = (await (await client.post("/api/push/test")).json()) as { sent: number; failed: number };
    expect(r).toMatchObject({ sent: 1, failed: 0 });
  });
});

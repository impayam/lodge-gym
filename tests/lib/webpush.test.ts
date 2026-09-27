import { describe, expect, it } from "vitest";
import { b64u, encryptPayload, generateVapidKeys, sendPush, vapidAuthorization } from "../../worker/lib/webpush";
import { fakeSubscription, verifyVapid } from "../fixtures/push-client";

describe("web push (RFC 8291 / RFC 8292)", () => {
  it("encrypts a payload the subscriber can decrypt; header layout per aes128gcm", async () => {
    const { sub, decrypt } = await fakeSubscription();
    const body = await encryptPayload(sub, new Uint8Array(new TextEncoder().encode('{"title":"استراحت تمام شد"}')));
    expect(Array.from(body.slice(16, 20))).toEqual([0, 0, 16, 0]);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(4);
    expect(await decrypt(body)).toBe('{"title":"استراحت تمام شد"}');
  });

  it("signs a VAPID JWT for the endpoint origin", async () => {
    const keys = await generateVapidKeys();
    expect(b64u.decode(keys.publicKey)).toHaveLength(65);
    const now = Date.parse("2026-09-27T12:00:00Z");
    const v = await verifyVapid(await vapidAuthorization("https://web.push.apple.com/QAbc/def", keys, "https://lodge.test", now));
    expect(v.ok).toBe(true);
    expect(v.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(v.claims).toEqual({ aud: "https://web.push.apple.com", exp: Math.floor(now / 1000) + 12 * 3600, sub: "https://lodge.test" });
    expect(v.k).toBe(keys.publicKey);
  });

  it("sends with the right headers and reports gone subscriptions", async () => {
    const keys = await generateVapidKeys();
    const { sub, decrypt } = await fakeSubscription();
    const seen: Request[] = [];
    const ok = await sendPush(sub, { title: "t", body: "b", tag: "rest" }, keys, {
      subject: "https://lodge.test",
      topic: "rest",
      fetcher: async (input, init) => {
        seen.push(new Request(input, init));
        return new Response(null, { status: 201 });
      },
    });
    expect(ok).toEqual({ ok: true, status: 201 });
    const req = seen[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(sub.endpoint);
    expect(req.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(req.headers.get("TTL")).toBe("120");
    expect(req.headers.get("Urgency")).toBe("high");
    expect(req.headers.get("Topic")).toBe("rest");
    expect((await verifyVapid(req.headers.get("Authorization")!)).ok).toBe(true);
    expect(JSON.parse(await decrypt(new Uint8Array(await req.arrayBuffer())))).toEqual({ title: "t", body: "b", tag: "rest" });
    const gone = await sendPush(sub, {}, keys, { subject: "https://lodge.test", fetcher: async () => new Response(null, { status: 410 }) });
    expect(gone).toEqual({ ok: false, status: 410, gone: true });
  });
});

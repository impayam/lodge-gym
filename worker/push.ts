// Rest-timer push (Web Push / VAPID). One Durable Object for the single user: it keeps the VAPID key pair
// (generated on first use, never leaves the object except the public key), the push subscriptions, and the
// pending rest end, and sends the push from an alarm at that moment.

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, Env } from "./env";
import { fail, readJson } from "./http";
import { generateVapidKeys, sendPush, type PushSubscriptionJSON, type VapidKeys } from "./lib/webpush";

interface Pending {
  id: string;
  endsAt: number;
  label: string;
}

export class RestPush extends DurableObject<Env> {
  /** Replaced in tests to capture outgoing pushes. */
  pushFetch: typeof fetch = (input, init) => fetch(input, init);

  private async keys(): Promise<VapidKeys> {
    let k = await this.ctx.storage.get<VapidKeys>("vapid");
    if (!k) {
      k = await generateVapidKeys();
      await this.ctx.storage.put("vapid", k);
    }
    return k;
  }

  private async subs(): Promise<PushSubscriptionJSON[]> {
    return (await this.ctx.storage.get<PushSubscriptionJSON[]>("subs")) ?? [];
  }

  async publicKey(): Promise<string> {
    return (await this.keys()).publicKey;
  }

  async subscribe(sub: PushSubscriptionJSON): Promise<number> {
    const list = (await this.subs()).filter((s) => s.endpoint !== sub.endpoint);
    list.push(sub);
    await this.ctx.storage.put("subs", list);
    return list.length;
  }

  async unsubscribe(endpoint: string): Promise<number> {
    const list = (await this.subs()).filter((s) => s.endpoint !== endpoint);
    await this.ctx.storage.put("subs", list);
    return list.length;
  }

  async subscriptionCount(): Promise<number> {
    return (await this.subs()).length;
  }

  /** Schedules (or reschedules) the rest-end push. */
  async schedule(p: Pending, origin: string): Promise<void> {
    await this.ctx.storage.put("pending", p);
    await this.ctx.storage.put("origin", origin);
    await this.ctx.storage.setAlarm(Math.max(Date.now(), p.endsAt));
  }

  async cancel(id?: string): Promise<void> {
    const p = await this.ctx.storage.get<Pending>("pending");
    if (id && p && p.id !== id) return;
    await this.ctx.storage.delete("pending");
    await this.ctx.storage.deleteAlarm();
  }

  async pending(): Promise<Pending | null> {
    return (await this.ctx.storage.get<Pending>("pending")) ?? null;
  }

  /** Sends to every subscription; drops subscriptions the push service says are gone. */
  async sendNow(payload: { title: string; body: string; tag: string }, origin: string): Promise<{ sent: number; failed: number; removed: number }> {
    const keys = await this.keys();
    const list = await this.subs();
    let sent = 0;
    let failed = 0;
    const keep: PushSubscriptionJSON[] = [];
    for (const s of list) {
      try {
        const r = await sendPush(s, payload, keys, { subject: origin, ttl: 120, urgency: "high", topic: payload.tag, fetcher: this.pushFetch });
        if (r.ok) sent++;
        else failed++;
        if (r.ok || !r.gone) keep.push(s);
      } catch {
        failed++;
        keep.push(s);
      }
    }
    if (keep.length !== list.length) await this.ctx.storage.put("subs", keep);
    return { sent, failed, removed: list.length - keep.length };
  }

  async alarm(): Promise<void> {
    const p = await this.ctx.storage.get<Pending>("pending");
    if (!p) return;
    await this.ctx.storage.delete("pending");
    const origin = (await this.ctx.storage.get<string>("origin")) ?? "https://lodge-gym.workers.dev";
    await this.sendNow({ title: "استراحت تمام شد", body: p.label ? `${p.label} · ست بعدی` : "وقت ست بعدی است.", tag: "rest" }, origin);
  }
}

const stub = (env: Env) => env.REST_PUSH.get(env.REST_PUSH.idFromName("owner"));

const subSchema = z.object({
  endpoint: z.string().url().max(2048).refine((u) => u.startsWith("https://"), "https"),
  keys: z.object({ p256dh: z.string().min(80).max(120), auth: z.string().min(16).max(40) }),
});

export const pushRoutes = new Hono<AppBindings>();

pushRoutes.get("/key", async (c) => c.json({ public_key: await stub(c.env).publicKey(), subscriptions: await stub(c.env).subscriptionCount() }));

pushRoutes.post("/subscribe", async (c) => {
  const sub = await readJson(c, subSchema);
  return c.json({ ok: true, subscriptions: await stub(c.env).subscribe(sub) });
});

pushRoutes.post("/unsubscribe", async (c) => {
  const body = await readJson(c, z.object({ endpoint: z.string().max(2048) }));
  return c.json({ ok: true, subscriptions: await stub(c.env).unsubscribe(body.endpoint) });
});

pushRoutes.post("/rest", async (c) => {
  const body = await readJson(c, z.object({ id: z.string().min(1).max(64), ends_at: z.number().int().positive(), label: z.string().max(200).default("") }));
  const now = Date.now();
  if (body.ends_at < now - 5_000 || body.ends_at > now + 60 * 60_000) return fail(c, 400, "invalid_time", "زمان پایان استراحت معتبر نیست.");
  await stub(c.env).schedule({ id: body.id, endsAt: body.ends_at, label: body.label }, new URL(c.req.url).origin);
  return c.json({ ok: true });
});

pushRoutes.post("/rest/cancel", async (c) => {
  const body = await readJson(c, z.object({ id: z.string().max(64).optional() }));
  await stub(c.env).cancel(body.id);
  return c.json({ ok: true });
});

pushRoutes.post("/test", async (c) => {
  const r = await stub(c.env).sendNow({ title: "Lodge Gym", body: "اعلان آزمایشی: اعلان پایان استراحت کار می‌کند.", tag: "test" }, new URL(c.req.url).origin);
  return c.json({ ok: true, ...r });
});

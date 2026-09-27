import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hasExif } from "../../worker/lib/jpeg";
import type { Photo, WorkoutSession } from "../../worker/lib/types";
import { ulid } from "../../worker/lib/ulid";
import { fakeJpeg } from "../fixtures/jpeg";
import { Client, resetAuth, setupOwner } from "./helpers";

let client: Client;
beforeAll(async () => {
  await resetAuth();
  ({ client } = await setupOwner("192.0.2.80"));
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM photos").run();
});

const meta = (over: Partial<Photo> = {}) => ({ id: ulid(), local_date: "2026-09-28", pose: "front", width: 1200, height: 1600, bytes: 1000, ...over });
const upload = (id: string, size: string, body: Uint8Array) =>
  client.fetch(`/api/photos/${id}/blob?size=${size}`, { method: "PUT", body, headers: { "Content-Type": "image/jpeg" } });

describe("photos API (SPEC §8)", () => {
  it("creates a photo, uploads both sizes once, strips EXIF, serves privately with long cache", async () => {
    const m = meta();
    const res = await client.post("/api/photos", m);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: m.id, upload: { full: `/api/photos/${m.id}/blob?size=full`, thumb: `/api/photos/${m.id}/blob?size=thumb` } });
    // Not uploaded yet.
    expect((await client.fetch(`/api/photos/${m.id}?size=thumb`)).status).toBe(404);

    expect(await (await upload(m.id, "full", fakeJpeg({ exif: true, comment: true }))).json()).toEqual({ ok: true, existed: false });
    expect(await (await upload(m.id, "thumb", fakeJpeg({ exif: true }))).json()).toEqual({ ok: true, existed: false });
    // One-time: a second upload never overwrites.
    expect(await (await upload(m.id, "full", fakeJpeg({}))).json()).toEqual({ ok: true, existed: true });

    const full = await client.fetch(`/api/photos/${m.id}?size=full`);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("image/jpeg");
    expect(full.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    const bytes = new Uint8Array(await full.arrayBuffer());
    expect(hasExif(bytes)).toBe(false);
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("GPS");
    const thumb = await client.fetch(`/api/photos/${m.id}`);
    expect(hasExif(new Uint8Array(await thumb.arrayBuffer()))).toBe(false);

    const obj = await env.PHOTOS.get(`photos/${m.id}/full.jpg`);
    expect(obj).not.toBeNull();
    await obj!.arrayBuffer();
    const list = (await (await client.fetch("/api/photos")).json()) as { photos: Photo[] };
    expect(list.photos).toHaveLength(1);
    expect(list.photos[0]).toMatchObject({ id: m.id, pose: "front", width: 1200, height: 1600, session_id: null });
  });

  it("is idempotent on create (outbox retries) and validates input", async () => {
    const m = meta();
    await client.post("/api/photos", m);
    await client.post("/api/photos", { ...m, pose: "side" });
    const list = (await (await client.fetch("/api/photos")).json()) as { photos: Photo[] };
    expect(list.photos.map((p) => p.pose)).toEqual(["side"]);
    expect((await client.post("/api/photos", { ...meta(), pose: "top" })).status).toBe(400);
    expect((await client.post("/api/photos", { ...meta(), local_date: "2026-02-30x" })).status).toBe(400);
    expect((await client.post("/api/photos", { ...meta(), session_id: "NOPE" })).status).toBe(400);
    expect((await upload(m.id, "huge", fakeJpeg({}))).status).toBe(400);
    expect((await upload("MISSING", "full", fakeJpeg({}))).status).toBe(404);
    expect((await upload(m.id, "full", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]))).status).toBe(415);
  });

  it("delete removes the R2 objects and the row", async () => {
    const m = meta();
    await client.post("/api/photos", m);
    await upload(m.id, "full", fakeJpeg({}));
    await upload(m.id, "thumb", fakeJpeg({}));
    expect((await client.fetch(`/api/photos/${m.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await env.PHOTOS.head(`photos/${m.id}/full.jpg`)).toBeNull();
    expect(await env.PHOTOS.head(`photos/${m.id}/thumb.jpg`)).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>())!.n).toBe(0);
    expect((await client.fetch(`/api/photos/${m.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("links to a session; deleting the session keeps the photo", async () => {
    const now = new Date().toISOString();
    const s: WorkoutSession = {
      id: ulid(), program_day_id: "D1", local_date: "2026-09-28", started_at: "2026-09-28T23:00:00.000Z", ended_at: null, status: "done",
      unit: "lb", note: "", created_at: now, updated_at: now, source: "app", sets: [],
    };
    await client.fetch(`/api/sessions/${s.id}`, { method: "PUT", json: s });
    const m = meta({ session_id: s.id });
    expect((await client.post("/api/photos", m)).status).toBe(200);
    await client.fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
    const row = await env.DB.prepare("SELECT session_id FROM photos WHERE id = ?").bind(m.id).first<{ session_id: string | null }>();
    expect(row!.session_id).toBeNull();
  });

  it("requires a session cookie", async () => {
    const anon = new Client("192.0.2.81");
    expect((await anon.fetch("/api/photos")).status).toBe(401);
    expect((await anon.fetch("/api/photos/X?size=thumb")).status).toBe(401);
  });
});

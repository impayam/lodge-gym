// Progress photos (SPEC §8): metadata in D1, full image and thumbnail in the private R2 bucket, served only
// through the Worker after auth.

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "./env";
import { fail, nowISO, readJson } from "./http";
import { isJpeg, stripJpegMetadata } from "./lib/jpeg";
import { DATE_RE } from "./lib/time";
import type { Photo } from "./lib/types";
import { ID_RE } from "./lib/ulid";

const MAX_FULL = 15 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;

const keyFor = (id: string, size: "full" | "thumb") => `photos/${id}/${size}.jpg`;

const createSchema = z.object({
  id: z.string().regex(ID_RE),
  session_id: z.string().regex(ID_RE).nullable().optional(),
  local_date: z.string().regex(DATE_RE),
  pose: z.enum(["front", "side", "back", "other"]),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  bytes: z.number().int().min(1).max(MAX_FULL),
  created_at: z.string().max(40).optional(),
});

const COLUMNS = "id, session_id, local_date, pose, width, height, bytes, created_at";

export const photoRoutes = new Hono<AppBindings>();

photoRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM photos ORDER BY local_date DESC, created_at DESC`).all<Photo>();
  return c.json({ photos: rows.results });
});

/** Creates (idempotently) the photo row and returns the one-time upload URLs for the two sizes. */
photoRoutes.post("/", async (c) => {
  const p = await readJson(c, createSchema);
  if (p.session_id) {
    const s = await c.env.DB.prepare("SELECT id FROM workout_sessions WHERE id = ?").bind(p.session_id).first();
    if (!s) return fail(c, 400, "unknown_session", "جلسه‌ی این عکس پیدا نشد.");
  }
  await c.env.DB.prepare(
    `INSERT INTO photos (id, session_id, local_date, pose, r2_key, thumb_r2_key, width, height, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, local_date = excluded.local_date, pose = excluded.pose,
       width = excluded.width, height = excluded.height, bytes = excluded.bytes`
  )
    .bind(p.id, p.session_id ?? null, p.local_date, p.pose, keyFor(p.id, "full"), keyFor(p.id, "thumb"), p.width, p.height, p.bytes, p.created_at ?? nowISO())
    .run();
  return c.json({ id: p.id, upload: { full: `/api/photos/${p.id}/blob?size=full`, thumb: `/api/photos/${p.id}/blob?size=thumb` } });
});

/** One-time upload: an existing object is never overwritten (retries of the same upload just succeed). */
photoRoutes.put("/:id/blob", async (c) => {
  const id = c.req.param("id");
  const size = c.req.query("size");
  if (!ID_RE.test(id) || (size !== "full" && size !== "thumb")) return fail(c, 400, "invalid_input", "درخواست آپلود معتبر نیست.");
  const row = await c.env.DB.prepare("SELECT r2_key, thumb_r2_key FROM photos WHERE id = ?").bind(id).first<{ r2_key: string; thumb_r2_key: string }>();
  if (!row) return fail(c, 404, "not_found", "عکس پیدا نشد.");
  const key = size === "full" ? row.r2_key : row.thumb_r2_key;
  if (await c.env.PHOTOS.head(key)) return c.json({ ok: true, existed: true });
  const max = size === "full" ? MAX_FULL : MAX_THUMB;
  if (Number(c.req.header("Content-Length") ?? "0") > max) return fail(c, 413, "too_large", "عکس خیلی بزرگ است.");
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.length > max) return fail(c, 413, "too_large", "عکس خیلی بزرگ است.");
  if (!isJpeg(raw)) return fail(c, 415, "not_jpeg", "فقط عکس JPEG پذیرفته می‌شود.");
  const clean = stripJpegMetadata(raw);
  await c.env.PHOTOS.put(key, clean, { httpMetadata: { contentType: "image/jpeg" } });
  if (size === "full") await c.env.DB.prepare("UPDATE photos SET bytes = ? WHERE id = ?").bind(clean.length, id).run();
  return c.json({ ok: true, existed: false });
});

photoRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const size = c.req.query("size") === "full" ? "full" : "thumb";
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "شناسه معتبر نیست.");
  const row = await c.env.DB.prepare("SELECT r2_key, thumb_r2_key FROM photos WHERE id = ?").bind(id).first<{ r2_key: string; thumb_r2_key: string }>();
  if (!row) return fail(c, 404, "not_found", "عکس پیدا نشد.");
  const obj = await c.env.PHOTOS.get(size === "full" ? row.r2_key : row.thumb_r2_key);
  if (!obj) return fail(c, 404, "not_uploaded", "عکس هنوز آپلود نشده است.");
  return new Response(obj.body, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", ETag: obj.httpEtag },
  });
});

photoRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "شناسه معتبر نیست.");
  const row = await c.env.DB.prepare("SELECT r2_key, thumb_r2_key FROM photos WHERE id = ?").bind(id).first<{ r2_key: string; thumb_r2_key: string }>();
  if (row) {
    await c.env.PHOTOS.delete([row.r2_key, row.thumb_r2_key]);
    await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
  }
  return c.json({ ok: true });
});

// Exercise library API (SPEC-v2 §7.3): the library list, custom exercises (create, edit, archive; never deleted)
// with an optional photo, and the library media served from the private R2 bucket.

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "./env";
import { fail, nowISO, readJson } from "./http";
import { mapExercise } from "./data";
import { isJpeg, stripJpegMetadata } from "./lib/jpeg";
import { CATEGORIES } from "./lib/category";
import { FEDB_PREFIX, PATTERNS } from "./lib/library";
import { CANONICAL_MUSCLES, isLowerBody } from "./lib/muscles";
import { ID_RE, ulid } from "./lib/ulid";

const MAX_PHOTO = 2 * 1024 * 1024;
export const CUSTOM_PREFIX = "library/custom/";
/** R2 prefixes the media route may serve. */
const MEDIA_PREFIXES = [`${FEDB_PREFIX}images/`, CUSTOM_PREFIX];

const muscle = z.enum(CANONICAL_MUSCLES);
const customSchema = z.object({
  name_en: z.string().trim().min(1).max(80),
  muscle_primary: muscle,
  muscles_secondary: z.array(muscle).max(8),
  equipment: z.enum(["barbell", "dumbbell", "cable", "machine", "bodyweight"]),
  pattern: z.enum(PATTERNS).nullable(),
  // SPEC-v2 §7.4. Optional so an edit queued by an older app version keeps the stored category; new rows are strength.
  category: z.enum(CATEGORIES).optional(),
  archived: z.boolean(),
});

export const exerciseRoutes = new Hono<AppBindings>();

/** The whole library, archived custom exercises included (the client hides them from the picker). */
exerciseRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM exercises ORDER BY name_en COLLATE NOCASE").all<Record<string, unknown>>();
  return c.json({ exercises: rows.results.map(mapExercise) });
});

/** Creates or edits a custom exercise, keyed by the client id. Archiving sets archived_at; nothing is deleted. */
exerciseRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "The id is not valid.");
  const body = await readJson(c, customSchema);
  const existing = await c.env.DB.prepare("SELECT source, archived_at FROM exercises WHERE id = ?").bind(id).first<{ source: string | null; archived_at: string | null }>();
  if (existing && existing.source !== "custom") return fail(c, 403, "not_custom", "Only your own exercises can be edited.");
  const secondary = [...new Set(body.muscles_secondary)].filter((m) => m !== body.muscle_primary);
  const archivedAt = body.archived ? (existing?.archived_at ?? nowISO()) : null;
  await c.env.DB.prepare(
    `INSERT INTO exercises (id, name_fa, name_en, muscle_primary, is_lower, equipment, cue_fa, source, source_id, muscles_secondary, pattern, media, instructions_en, archived_at, category)
     VALUES (?, '', ?, ?, ?, ?, '', 'custom', ?, ?, ?, '[]', '[]', ?, COALESCE(?, 'strength'))
     ON CONFLICT (id) DO UPDATE SET name_en = excluded.name_en, muscle_primary = excluded.muscle_primary, is_lower = excluded.is_lower,
       equipment = excluded.equipment, muscles_secondary = excluded.muscles_secondary, pattern = excluded.pattern, archived_at = excluded.archived_at,
       category = COALESCE(?, exercises.category)`
  )
    .bind(id, body.name_en, body.muscle_primary, isLowerBody(body.muscle_primary) ? 1 : 0, body.equipment, id, JSON.stringify(secondary), body.pattern, archivedAt, body.category ?? null, body.category ?? null)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM exercises WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return c.json({ ok: true, exercise: mapExercise(row!) });
});

/** Photo of a custom exercise (resized and stripped of EXIF on the phone; metadata stripped again here). */
exerciseRoutes.put("/:id/photo", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return fail(c, 400, "invalid_input", "The id is not valid.");
  const row = await c.env.DB.prepare("SELECT source, media FROM exercises WHERE id = ?").bind(id).first<{ source: string | null; media: string | null }>();
  if (!row) return fail(c, 404, "not_found", "Exercise not found.");
  if (row.source !== "custom") return fail(c, 403, "not_custom", "Only your own exercises can be edited.");
  if (Number(c.req.header("Content-Length") ?? "0") > MAX_PHOTO) return fail(c, 413, "too_large", "The photo is too large.");
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.length > MAX_PHOTO) return fail(c, 413, "too_large", "The photo is too large.");
  if (!isJpeg(raw)) return fail(c, 415, "not_jpeg", "Only JPEG photos are accepted.");
  // A new key per upload keeps the media URL immutable for caching.
  const key = `${CUSTOM_PREFIX}${id}/${ulid()}.jpg`;
  await c.env.PHOTOS.put(key, stripJpegMetadata(raw), { httpMetadata: { contentType: "image/jpeg" } });
  const old = (JSON.parse(row.media || "[]") as { r2_key?: string }[]).map((m) => m.r2_key).filter((k): k is string => !!k && k.startsWith(CUSTOM_PREFIX));
  await c.env.DB.prepare("UPDATE exercises SET media = ? WHERE id = ?").bind(JSON.stringify([{ kind: "image", r2_key: key }]), id).run();
  if (old.length) await c.env.PHOTOS.delete(old);
  return c.json({ ok: true, media: [{ kind: "image", r2_key: key }] });
});

export const mediaRoutes = new Hono<AppBindings>();

/** Library media from the private bucket: only the library prefixes, only after auth, immutable keys. */
mediaRoutes.get("/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/library\/media\//, ""));
  if (!MEDIA_PREFIXES.some((p) => key.startsWith(p)) || key.includes("..") || !/\.(jpe?g|gif|png)$/i.test(key)) return fail(c, 404, "not_found", "Media not found.");
  const obj = await c.env.PHOTOS.get(key);
  if (!obj) return fail(c, 404, "not_found", "Media not found.");
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType ?? "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", ETag: obj.httpEtag },
  });
});

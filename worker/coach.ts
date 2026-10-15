// Coach chat endpoints (SPEC-v9 M12), behind sign-in:
//   GET    /api/coach/threads?archived=0|1           the chat list or the Archived list, newest first
//   GET    /api/coach/threads/:id                    one chat with its messages (and how many are no longer sent)
//   POST   /api/coach/threads/:id/messages           Payam's message (creates the chat); answers as a server-sent event stream
//   POST   /api/coach/threads/:id/retry              answers the last question again after "Answer failed"
//   POST   /api/coach/threads/:id/archive|unarchive  hides or shows a chat
//   DELETE /api/coach/threads/:id                    deletes an archived chat for good: its messages, attachment rows and R2 objects
//   PUT    /api/coach/attachments/:id?thread=…       a photo for the next message (JPEG, metadata stripped again here)
//   POST   /api/coach/attachments/from-photo         a copy of a progress photo for the next message
//   GET    /api/coach/attachments/:id                a sent photo (auth only, like progress photos)
//   POST   /api/coach/drafts                         Add to Planner: saves a draft card as an inactive program (Me → Program → Drafts)
// The answer itself runs in the AiJobs Durable Object (worker/coachTurn.ts). Nothing here touches training data or
// progress photos, except Add to Planner, which only adds a draft program.

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, Env } from "./env";
import { fail, nowISO, readJson } from "./http";
import { readProgramVersions, readSettings } from "./data";
import { contextBlock } from "./lib/coach/prompt";
import { contextWindow, nextStamp, type StoredBlock } from "./lib/coach/context";
import { draftDayRows, proposeProgram, type CleanDraft } from "./lib/coach/draft";
import { coachContextOf, loadCoachData, readThreadRows } from "./coachTurn";
import { isJpeg, stripJpegMetadata } from "./lib/jpeg";
import { activeSince, programOn } from "./lib/reports";
import { programName } from "./lib/programRules";
import { loadReportData } from "./reports";
import { localDate } from "./lib/time";
import { ID_RE } from "./lib/ulid";

/** Photos per message (SPEC-v9 §5). */
export const MAX_IMAGES = 4;
/** A chat photo after the client's resize (1600 px, JPEG 0.85) is far smaller; this only stops abuse. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const TITLE_MAX = 80;

const id = z.string().regex(ID_RE);
const attachmentKey = (threadId: string, attId: string) => `coach/${threadId}/${attId}.jpg`;

interface ThreadRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived: number;
}

const threadView = (t: ThreadRow) => ({ id: t.id, title: t.title, created_at: t.created_at, updated_at: t.updated_at, archived: t.archived === 1 });

/** The chat title: the first question, shortened. */
export function threadTitle(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= TITLE_MAX ? one || "Photo" : `${one.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

const jobs = (env: Env) => env.AI_JOBS.get(env.AI_JOBS.idFromName("owner"));

/** The Durable Object's event stream as the HTTP response. */
async function answer(env: Env, threadId: string): Promise<Response> {
  const stream = await jobs(env).coachTurn(threadId);
  if (!stream) return new Response(JSON.stringify({ error: { code: "busy", message_fa: "The coach is still answering in this chat." } }), { status: 409, headers: { "Content-Type": "application/json" } });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

const sendSchema = z.object({
  id,
  text: z.string().max(8000),
  attachments: z.array(z.object({ id, width: z.number().int().min(1).max(10_000), height: z.number().int().min(1).max(10_000) })).max(MAX_IMAGES),
});

export const coachRoutes = new Hono<AppBindings>();

coachRoutes.get("/threads", async (c) => {
  const archived = c.req.query("archived") === "1" ? 1 : 0;
  const rows = await c.env.DB.prepare("SELECT id, title, created_at, updated_at, archived FROM coach_threads WHERE archived = ? ORDER BY updated_at DESC").bind(archived).all<ThreadRow>();
  return c.json({ threads: rows.results.map(threadView) });
});

coachRoutes.get("/threads/:id", async (c) => {
  const threadId = c.req.param("id");
  if (!ID_RE.test(threadId)) return fail(c, 400, "invalid_input", "The id is not valid.");
  const t = await c.env.DB.prepare("SELECT id, title, created_at, updated_at, archived FROM coach_threads WHERE id = ?").bind(threadId).first<ThreadRow>();
  if (!t) return fail(c, 404, "not_found", "Chat not found.");
  const rows = await readThreadRows(c.env, threadId);
  return c.json({
    thread: threadView(t),
    messages: rows.map(({ thread_id: _t, ...r }) => r),
    omitted: contextWindow(rows, coachContextOf(c.env)).omitted,
  });
});

coachRoutes.post("/threads/:id/messages", async (c) => {
  const threadId = c.req.param("id");
  if (!ID_RE.test(threadId)) return fail(c, 400, "invalid_input", "The id is not valid.");
  const body = await readJson(c, sendSchema);
  const text = body.text.trim();
  if (!text && !body.attachments.length) return fail(c, 400, "empty", "Write a question or attach a photo.");
  const exists = await c.env.DB.prepare("SELECT id FROM coach_messages WHERE id = ?").bind(body.id).first();
  if (!exists) {
    // Photos must already be uploaded under this chat.
    for (const a of body.attachments) if (!(await c.env.PHOTOS.head(attachmentKey(threadId, a.id)))) return fail(c, 400, "photo_missing", "A photo was not uploaded. Attach it again.");
    const settings = await readSettings(c.env);
    const d = await loadReportData(c.env);
    const today = localDate(settings.timezone);
    const active = (d.programs ?? []).find((p) => p.status === "active");
    const program = programOn(d, today).program;
    const content: StoredBlock[] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...body.attachments.map((a) => ({ type: "image" as const, attachment_id: a.id, width: a.width, height: a.height })),
      { type: "text", text: contextBlock({ today, timezone: settings.timezone, unit: settings.unit, week_start: settings.week_start, program: { name: programName(active ?? null, program.name), since: activeSince(d, today) } }) },
    ];
    const prev = await c.env.DB.prepare("SELECT MAX(created_at) AS at FROM coach_messages WHERE thread_id = ?").bind(threadId).first<{ at: string | null }>();
    const now = nextStamp(prev?.at);
    const stmts = [
      c.env.DB.prepare("INSERT INTO coach_threads (id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, 0) ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at").bind(threadId, threadTitle(text), now, now),
      c.env.DB.prepare("INSERT INTO coach_messages (id, thread_id, role, content_json, created_at) VALUES (?, ?, 'user', ?, ?)").bind(body.id, threadId, JSON.stringify(content), now),
    ];
    for (const a of body.attachments) {
      const head = await c.env.PHOTOS.head(attachmentKey(threadId, a.id));
      const source = head?.customMetadata?.source_photo_id ?? null;
      stmts.push(
        c.env.DB.prepare("INSERT INTO coach_attachments (id, message_id, r2_key, width, height, bytes, source_photo_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(a.id, body.id, attachmentKey(threadId, a.id), a.width, a.height, head?.size ?? 0, source, now)
      );
    }
    await c.env.DB.batch(stmts);
  }
  return answer(c.env, threadId);
});

coachRoutes.post("/threads/:id/retry", async (c) => {
  const threadId = c.req.param("id");
  if (!ID_RE.test(threadId)) return fail(c, 400, "invalid_input", "The id is not valid.");
  const rows = await readThreadRows(c.env, threadId);
  const last = rows.filter((r) => !r.error).at(-1);
  if (!last || last.role !== "user") return fail(c, 409, "answered", "This question already has an answer.");
  return answer(c.env, threadId);
});

for (const [path, value] of [["archive", 1], ["unarchive", 0]] as const) {
  coachRoutes.post(`/threads/:id/${path}`, async (c) => {
    const threadId = c.req.param("id");
    if (!ID_RE.test(threadId)) return fail(c, 400, "invalid_input", "The id is not valid.");
    // updated_at is kept, so a chat returns to its place in the list.
    const r = await c.env.DB.prepare("UPDATE coach_threads SET archived = ? WHERE id = ?").bind(value, threadId).run();
    if (!r.meta.changes) return fail(c, 404, "not_found", "Chat not found.");
    return c.json({ ok: true });
  });
}

/** Deletes an archived chat for good (SPEC-v9 §8.1, the approved SQL): R2 first, then one D1 batch. */
coachRoutes.delete("/threads/:id", async (c) => {
  const threadId = c.req.param("id");
  if (!ID_RE.test(threadId)) return fail(c, 400, "invalid_input", "The id is not valid.");
  const t = await c.env.DB.prepare("SELECT archived FROM coach_threads WHERE id = ?").bind(threadId).first<{ archived: number }>();
  if (!t) return fail(c, 404, "not_found", "Chat not found.");
  if (t.archived !== 1) return fail(c, 409, "not_archived", "Archive this chat first.");
  const prefix = `coach/${threadId}/`;
  const rows = await c.env.DB.prepare("SELECT a.r2_key FROM coach_attachments a JOIN coach_messages m ON m.id = a.message_id WHERE m.thread_id = ?").bind(threadId).all<{ r2_key: string }>();
  const keys = new Set(rows.results.map((r) => r.r2_key));
  let cursor: string | undefined;
  do {
    const page = await c.env.PHOTOS.list({ prefix, cursor });
    for (const o of page.objects) keys.add(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Never anything outside this chat's prefix: progress photos (photos/…) and library media stay.
  const mine = [...keys].filter((k) => k.startsWith(prefix));
  for (let i = 0; i < mine.length; i += 1000) await c.env.PHOTOS.delete(mine.slice(i, i + 1000));
  const archivedCheck = "EXISTS (SELECT 1 FROM coach_threads WHERE id = ?1 AND archived = 1)";
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM coach_attachments WHERE message_id IN (SELECT id FROM coach_messages WHERE thread_id = ?1) AND ${archivedCheck}`).bind(threadId),
    c.env.DB.prepare(`DELETE FROM coach_messages WHERE thread_id = ?1 AND ${archivedCheck}`).bind(threadId),
    c.env.DB.prepare("DELETE FROM coach_threads WHERE id = ?1 AND archived = 1").bind(threadId),
  ]);
  return c.json({ ok: true, deleted_objects: mine.length });
});

coachRoutes.put("/attachments/:id", async (c) => {
  const attId = c.req.param("id");
  const threadId = c.req.query("thread") ?? "";
  if (!ID_RE.test(attId) || !ID_RE.test(threadId)) return fail(c, 400, "invalid_input", "The upload request is not valid.");
  const key = attachmentKey(threadId, attId);
  if (await c.env.PHOTOS.head(key)) return c.json({ ok: true, existed: true });
  if (Number(c.req.header("Content-Length") ?? "0") > MAX_ATTACHMENT_BYTES) return fail(c, 413, "too_large", "The photo is too large.");
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.length > MAX_ATTACHMENT_BYTES) return fail(c, 413, "too_large", "The photo is too large.");
  if (!isJpeg(raw)) return fail(c, 415, "not_jpeg", "Only JPEG photos are accepted.");
  const clean = stripJpegMetadata(raw);
  await c.env.PHOTOS.put(key, clean, { httpMetadata: { contentType: "image/jpeg" } });
  return c.json({ ok: true, existed: false, bytes: clean.length });
});

/** A progress photo picked for a message is copied into the chat, so deleting the chat never touches the original. */
coachRoutes.post("/attachments/from-photo", async (c) => {
  const body = await readJson(c, z.object({ id, thread_id: id, photo_id: id }));
  const p = await c.env.DB.prepare("SELECT r2_key, width, height FROM photos WHERE id = ?").bind(body.photo_id).first<{ r2_key: string; width: number; height: number }>();
  if (!p) return fail(c, 404, "not_found", "Photo not found.");
  const key = attachmentKey(body.thread_id, body.id);
  const existing = await c.env.PHOTOS.head(key);
  if (!existing) {
    const obj = await c.env.PHOTOS.get(p.r2_key);
    if (!obj) return fail(c, 404, "not_uploaded", "The photo has not been uploaded yet.");
    await c.env.PHOTOS.put(key, await obj.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { source_photo_id: body.photo_id } });
  }
  return c.json({ ok: true, id: body.id, width: p.width, height: p.height });
});

coachRoutes.get("/attachments/:id", async (c) => {
  const attId = c.req.param("id");
  if (!ID_RE.test(attId)) return fail(c, 400, "invalid_input", "The id is not valid.");
  const row = await c.env.DB.prepare("SELECT r2_key FROM coach_attachments WHERE id = ?").bind(attId).first<{ r2_key: string }>();
  if (!row) return fail(c, 404, "not_found", "Photo not found.");
  const obj = await c.env.PHOTOS.get(row.r2_key);
  if (!obj) return fail(c, 404, "not_uploaded", "The photo is no longer stored.");
  return new Response(obj.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", ETag: obj.httpEtag } });
});

/**
 * Add to Planner: the draft card's draft, cleaned again against today's library, saved as an inactive program with the
 * draft id from the tool result (so a second tap returns the same draft). The active program is never touched.
 */
coachRoutes.post("/drafts", async (c) => {
  const body = await readJson(c, z.object({ message_id: id, tool_use_id: z.string().min(1).max(100) }));
  const row = await c.env.DB.prepare("SELECT thread_id, content_json FROM coach_messages WHERE id = ? AND role = 'assistant'").bind(body.message_id).first<{ thread_id: string; content_json: string }>();
  const call = row ? (JSON.parse(row.content_json) as StoredBlock[]).find((b) => b.type === "tool_use" && b.id === body.tool_use_id && b.name === "propose_program") : null;
  if (!row || !call || call.type !== "tool_use") return fail(c, 404, "not_found", "Draft not found.");
  const rows = await readThreadRows(c.env, row.thread_id);
  const result = rows.flatMap((r) => r.content).find((b) => b.type === "tool_result" && b.tool_use_id === body.tool_use_id);
  const draftId = result && result.type === "tool_result" && !result.is_error ? (JSON.parse(result.content) as { draft_id?: string }).draft_id : undefined;
  if (!draftId || !ID_RE.test(draftId)) return fail(c, 409, "invalid_draft", "This draft was not valid.");
  const known = (await readProgramVersions(c.env, [draftId]))[0];
  if (known) return c.json({ ok: true, program_id: draftId, existed: true });
  const d = await loadCoachData(c.env);
  const out = proposeProgram(d, call.input, draftId);
  if (!out.ok) return fail(c, 409, "invalid_draft", "This draft is no longer valid.");
  await saveDraft(c.env, draftId, out.draft);
  return c.json({ ok: true, program_id: draftId, existed: false });
});

async function saveDraft(env: Env, programId: string, draft: CleanDraft) {
  const now = nowISO();
  const days = draftDayRows(draft);
  const stmts = [
    env.DB.prepare("INSERT INTO programs (id, name, active, created_at, style, days_per_week, params, generated_by) VALUES (?, ?, 0, ?, 'coach', ?, NULL, 'coach')").bind(programId, draft.name, now, days.length),
  ];
  days.forEach((day, i) => {
    const dayId = `${programId}-d${i + 1}`;
    stmts.push(env.DB.prepare("INSERT INTO program_days (id, program_id, position, name_fa, name_en, focus_fa, est_minutes) VALUES (?, ?, ?, '', ?, '', ?)").bind(dayId, programId, i + 1, day.name, day.est_minutes));
    for (const x of day.exercises)
      stmts.push(
        env.DB.prepare(
          `INSERT INTO day_exercises (id, day_id, exercise_id, position, sets, reps_min, reps_max, per_leg, is_time, rest_sec, superset_tag, is_main, target_rir_min, target_rir_max, slot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        ).bind(`${dayId}-${x.position}`, dayId, x.exercise_id, x.position, x.sets, x.reps_min, x.reps_max, x.per_leg ? 1 : 0, x.is_time ? 1 : 0, x.rest_sec, x.superset_tag, x.is_main ? 1 : 0, x.target_rir_min, x.target_rir_max)
      );
  });
  await env.DB.batch(stmts);
}

/** Me → AI reports: this month's coach questions and the cost of every coach call (SPEC-v9 §7, the approved SQL). */
export async function coachMonth(env: Env, from: string, to: string): Promise<{ messages: number; cost_usd: number }> {
  const r = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM coach_messages
         WHERE role = 'user' AND created_at >= ?1 AND created_at < ?2
           AND EXISTS (SELECT 1 FROM json_each(content_json) WHERE json_extract(value, '$.type') IN ('text', 'image'))) AS questions,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM coach_messages
         WHERE role = 'assistant' AND created_at >= ?1 AND created_at < ?2) AS cost_usd`
  )
    .bind(from, to)
    .first<{ questions: number; cost_usd: number }>();
  return { messages: r?.questions ?? 0, cost_usd: Math.round((r?.cost_usd ?? 0) * 100) / 100 };
}


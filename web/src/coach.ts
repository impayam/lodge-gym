// Coach chat client (SPEC-v9 M12): the API, the streamed answer (server-sent events), photo attachments and the
// offline copy of past chats (IndexedDB key-value store). Sending needs a connection; reading saved chats does not.

import { api, apiUpload, ApiError, NetworkError } from "./api";
import { kvGet, kvSet } from "./localdb";
import { processPhoto } from "./photos";
import { ulid } from "../../worker/lib/ulid";
import type { StoredBlock } from "../../worker/lib/coach/context";
import type { CoachEvent } from "../../worker/lib/coach/events";

export type { CoachEvent, StoredBlock };

export interface CoachThread {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export interface CoachMessage {
  id: string;
  role: "user" | "assistant";
  content: StoredBlock[];
  created_at: string;
  error: string | null;
  cost_usd: number | null;
  model: string | null;
}

export interface CoachThreadData {
  thread: CoachThread;
  messages: CoachMessage[];
  /** Older messages that are no longer sent to the coach (token budget). */
  omitted: number;
}

/** Photos per message (SPEC-v9 §5). */
export const MAX_PHOTOS = 4;

const listKey = (archived: boolean) => `coach:threads:${archived ? "archived" : "open"}`;
const threadKey = (id: string) => `coach:thread:${id}`;

/** The chat list (or the Archived list); offline, the copy saved on the phone. */
export async function loadThreads(archived: boolean): Promise<{ threads: CoachThread[]; offline: boolean }> {
  try {
    const r = await api<{ threads: CoachThread[] }>("GET", `/coach/threads?archived=${archived ? 1 : 0}`);
    await kvSet(listKey(archived), r.threads);
    return { threads: r.threads, offline: false };
  } catch (e) {
    const saved = await kvGet<CoachThread[]>(listKey(archived));
    if (e instanceof NetworkError && saved) return { threads: saved, offline: true };
    throw e;
  }
}

/** One chat; offline, the copy saved on the phone. */
export async function loadThread(id: string): Promise<{ data: CoachThreadData; offline: boolean }> {
  try {
    const data = await api<CoachThreadData>("GET", `/coach/threads/${encodeURIComponent(id)}`);
    await kvSet(threadKey(id), data);
    return { data, offline: false };
  } catch (e) {
    const saved = await kvGet<CoachThreadData>(threadKey(id));
    if (e instanceof NetworkError && saved) return { data: saved, offline: true };
    throw e;
  }
}

/** Reads a server-sent event stream and hands each event over. */
async function readEvents(res: Response, on: (e: CoachEvent) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (data) on(JSON.parse(data) as CoachEvent);
    }
    if (done) return;
  }
}

/** POSTs and streams the answer's events; HTTP errors become ApiError, a lost connection NetworkError. */
async function post(path: string, body: unknown, on: (e: CoachEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), cache: "no-store" });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    const err = ((await res.json().catch(() => null)) as { error?: { code?: string; message_fa?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message_fa ?? "Could not reach the server.");
  }
  try {
    await readEvents(res, on);
  } catch {
    throw new NetworkError();
  }
}

export interface Attachment {
  id: string;
  width: number;
  height: number;
  /** A local preview until the chat reloads from the server. */
  url: string;
}

/** A photo from the camera or the library: EXIF orientation applied, 1600 px, JPEG 0.85, metadata stripped, uploaded. */
export async function attachFile(threadId: string, file: Blob): Promise<Attachment> {
  const p = await processPhoto(file);
  const id = ulid();
  await apiUpload(`/coach/attachments/${id}?thread=${encodeURIComponent(threadId)}`, p.full);
  return { id, width: p.width, height: p.height, url: URL.createObjectURL(p.full) };
}

/** One of his progress photos, copied into the chat on the server (the original is never touched). */
export async function attachProgressPhoto(threadId: string, photoId: string): Promise<Attachment> {
  const id = ulid();
  const r = await api<{ id: string; width: number; height: number }>("POST", "/coach/attachments/from-photo", { id, thread_id: threadId, photo_id: photoId });
  return { id, width: r.width, height: r.height, url: `/api/photos/${encodeURIComponent(photoId)}?size=thumb` };
}

export const attachmentSrc = (id: string) => `/api/coach/attachments/${encodeURIComponent(id)}`;

/** Sends a question (the chat is created with the first one) and streams the answer. */
export function sendMessage(threadId: string, message: { id: string; text: string; attachments: Pick<Attachment, "id" | "width" | "height">[] }, on: (e: CoachEvent) => void) {
  return post(`/coach/threads/${encodeURIComponent(threadId)}/messages`, message, on);
}

/** Answers the last question again after "Answer failed". */
export const retryAnswer = (threadId: string, on: (e: CoachEvent) => void) => post(`/coach/threads/${encodeURIComponent(threadId)}/retry`, {}, on);

export const archiveThread = (id: string, archived: boolean) => api<{ ok: true }>("POST", `/coach/threads/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`);

export const deleteThread = (id: string) => api<{ ok: true }>("DELETE", `/coach/threads/${encodeURIComponent(id)}`);

/** Add to Planner: the draft becomes an inactive program under Me → Program → Drafts. */
export const addDraft = (messageId: string, toolUseId: string) => api<{ ok: true; program_id: string }>("POST", "/coach/drafts", { message_id: messageId, tool_use_id: toolUseId });

/** A message's text blocks without the app's CONTEXT block. */
export function questionText(content: StoredBlock[]): string {
  return content
    .filter((b): b is Extract<StoredBlock, { type: "text" }> => b.type === "text" && !b.text.startsWith("CONTEXT (written by the app"))
    .map((b) => b.text)
    .join("\n");
}

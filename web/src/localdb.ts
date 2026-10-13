// IndexedDB: offline copy of bootstrap data, sessions and session plans, plus the outbox of pending writes.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SessionPlan } from "../../worker/lib/plan";
import type { Bootstrap, Photo, Settings, Unit, WorkoutSession } from "../../worker/lib/types";

/** The cached bootstrap; plans live in their own store (a bootstrap cached before M9c has none). */
export type BootData = Omit<Bootstrap, "sessions" | "server_time" | "plans">;

export type OutboxEntry =
  | { key: string; op: "put_session"; id: string; rev: number; queued_at: string }
  | { key: string; op: "delete_session"; id: string; rev: number; queued_at: string }
  | { key: string; op: "settings"; patch: Partial<Settings>; rev: number; queued_at: string }
  | { key: string; op: "body_mass"; date: string; value: number | null; unit: Unit; rev: number; queued_at: string }
  | { key: string; op: "photo"; photo: Photo; full: Blob; thumb: Blob; rev: number; queued_at: string }
  | { key: string; op: "delete_photo"; id: string; rev: number; queued_at: string }
  | { key: string; op: "put_plan"; id: string; rev: number; queued_at: string };

interface Schema extends DBSchema {
  kv: { key: string; value: unknown };
  sessions: { key: string; value: WorkoutSession };
  outbox: { key: string; value: OutboxEntry };
  plans: { key: string; value: SessionPlan };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db() {
  if (!dbp) {
    dbp = openDB<Schema>("lodge-gym", 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore("kv");
          d.createObjectStore("sessions", { keyPath: "id" });
          d.createObjectStore("outbox", { keyPath: "key" });
        }
        // Version 2 (SPEC-v3 M9c): session plans.
        if (oldVersion < 2) d.createObjectStore("plans", { keyPath: "id" });
      },
    });
  }
  return dbp;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get("kv", key)) as T | undefined;
}
export async function kvSet(key: string, value: unknown) {
  await (await db()).put("kv", value, key);
}
export async function kvDel(key: string) {
  await (await db()).delete("kv", key);
}

export async function allSessions(): Promise<WorkoutSession[]> {
  return (await db()).getAll("sessions");
}
export async function putSession(s: WorkoutSession) {
  await (await db()).put("sessions", s);
}
export async function putSessions(list: WorkoutSession[], remove: string[]) {
  const tx = (await db()).transaction("sessions", "readwrite");
  await Promise.all([...list.map((s) => tx.store.put(s)), ...remove.map((id) => tx.store.delete(id)), tx.done]);
}
export async function deleteSession(id: string) {
  await (await db()).delete("sessions", id);
}

export async function allPlans(): Promise<SessionPlan[]> {
  return (await db()).getAll("plans");
}
export async function putPlan(p: SessionPlan) {
  await (await db()).put("plans", p);
}
export async function putPlans(list: SessionPlan[], remove: string[]) {
  const tx = (await db()).transaction("plans", "readwrite");
  await Promise.all([...list.map((p) => tx.store.put(p)), ...remove.map((id) => tx.store.delete(id)), tx.done]);
}

export async function outboxAll(): Promise<OutboxEntry[]> {
  return (await db()).getAll("outbox");
}
export async function outboxGet(key: string) {
  return (await db()).get("outbox", key);
}
export async function outboxPut(e: OutboxEntry) {
  await (await db()).put("outbox", e);
}
/** Removes the entry only if nothing newer was queued while it was in flight. */
export async function outboxAck(key: string, rev: number) {
  const tx = (await db()).transaction("outbox", "readwrite");
  const cur = await tx.store.get(key);
  if (cur && cur.rev === rev) await tx.store.delete(key);
  await tx.done;
}

export async function outboxDelete(key: string) {
  await (await db()).delete("outbox", key);
}

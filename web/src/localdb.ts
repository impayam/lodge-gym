// IndexedDB: offline copy of bootstrap data and sessions, plus the outbox of pending writes.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Bootstrap, Settings, WorkoutSession } from "../../worker/lib/types";

export type BootData = Omit<Bootstrap, "sessions" | "server_time">;

export type OutboxEntry =
  | { key: string; op: "put_session"; id: string; rev: number; queued_at: string }
  | { key: string; op: "delete_session"; id: string; rev: number; queued_at: string }
  | { key: string; op: "settings"; patch: Partial<Settings>; rev: number; queued_at: string };

interface Schema extends DBSchema {
  kv: { key: string; value: unknown };
  sessions: { key: string; value: WorkoutSession };
  outbox: { key: string; value: OutboxEntry };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db() {
  if (!dbp) {
    dbp = openDB<Schema>("lodge-gym", 1, {
      upgrade(d) {
        d.createObjectStore("kv");
        d.createObjectStore("sessions", { keyPath: "id" });
        d.createObjectStore("outbox", { keyPath: "key" });
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

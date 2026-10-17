// IndexedDB: offline copy of bootstrap data, sessions, session plans and the training calendar, plus the outbox of
// pending writes.

import type { Goals } from "../../worker/lib/goals";
import type { BodyMeasurement } from "../../worker/lib/measurements";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { CalendarSettings, GymPlan, WorkShift } from "../../worker/lib/calendar";
import type { SessionPlan } from "../../worker/lib/plan";
import type { Bootstrap, Photo, Settings, Unit, WorkoutSession } from "../../worker/lib/types";

/**
 * The cached bootstrap; plans, shifts and gym plans live in their own stores. The calendar settings (SPEC-v10 M13) ride
 * along; a bootstrap cached before M13 has none (the approved defaults apply).
 */
export type BootData = Omit<Bootstrap, "sessions" | "server_time" | "plans" | "calendar"> & { calendar_settings?: CalendarSettings };

export type OutboxEntry =
  | { key: string; op: "put_session"; id: string; rev: number; queued_at: string }
  | { key: string; op: "delete_session"; id: string; rev: number; queued_at: string }
  | { key: string; op: "settings"; patch: Partial<Settings>; rev: number; queued_at: string }
  | { key: string; op: "body_mass"; date: string; value: number | null; unit: Unit; rev: number; queued_at: string }
  | { key: string; op: "photo"; photo: Photo; full: Blob; thumb: Blob; rev: number; queued_at: string }
  | { key: string; op: "delete_photo"; id: string; rev: number; queued_at: string }
  | { key: string; op: "put_plan"; id: string; rev: number; queued_at: string }
  | { key: string; op: "put_shift"; id: string; rev: number; queued_at: string }
  | { key: string; op: "delete_shift"; id: string; rev: number; queued_at: string }
  | { key: string; op: "put_gymplan"; id: string; rev: number; queued_at: string }
  | { key: string; op: "delete_gymplan"; id: string; rev: number; queued_at: string }
  | { key: string; op: "calendar_settings"; patch: Partial<CalendarSettings>; rev: number; queued_at: string }
  | { key: string; op: "goals"; goals: Goals; rev: number; queued_at: string }
  | { key: string; op: "put_measurement"; doc: BodyMeasurement; rev: number; queued_at: string }
  | { key: string; op: "delete_measurement"; id: string; rev: number; queued_at: string };

interface Schema extends DBSchema {
  kv: { key: string; value: unknown };
  sessions: { key: string; value: WorkoutSession };
  outbox: { key: string; value: OutboxEntry };
  plans: { key: string; value: SessionPlan };
  shifts: { key: string; value: WorkShift };
  gym_plans: { key: string; value: GymPlan };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db() {
  if (!dbp) {
    dbp = openDB<Schema>("lodge-gym", 3, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore("kv");
          d.createObjectStore("sessions", { keyPath: "id" });
          d.createObjectStore("outbox", { keyPath: "key" });
        }
        // Version 2 (SPEC-v3 M9c): session plans.
        if (oldVersion < 2) d.createObjectStore("plans", { keyPath: "id" });
        // Version 3 (SPEC-v10 M13): work shifts and planned gym sessions.
        if (oldVersion < 3) {
          d.createObjectStore("shifts", { keyPath: "id" });
          d.createObjectStore("gym_plans", { keyPath: "id" });
        }
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

export async function allShifts(): Promise<WorkShift[]> {
  return (await db()).getAll("shifts");
}
export async function allGymPlans(): Promise<GymPlan[]> {
  return (await db()).getAll("gym_plans");
}
/** Writes and removes shifts and gym plans in one transaction. */
export async function putCalendar(shifts: WorkShift[], removeShifts: string[], plans: GymPlan[], removePlans: string[]) {
  const tx = (await db()).transaction(["shifts", "gym_plans"], "readwrite");
  const sh = tx.objectStore("shifts");
  const gp = tx.objectStore("gym_plans");
  await Promise.all([
    ...shifts.map((x) => sh.put(x)),
    ...removeShifts.map((id) => sh.delete(id)),
    ...plans.map((x) => gp.put(x)),
    ...removePlans.map((id) => gp.delete(id)),
    tx.done,
  ]);
}

export async function outboxAll(): Promise<OutboxEntry[]> {
  return (await db()).getAll("outbox");
}
export async function outboxGet(key: string) {
  return (await db()).get("outbox", key);
}
/**
 * Queues an entry made from the one already queued under its key, read and written in one transaction: two changes
 * queued at the same moment (two settings in a row) both end up in it, neither overwrites the other.
 */
export async function outboxQueue(key: string, make: (prev: OutboxEntry | undefined) => OutboxEntry) {
  const tx = (await db()).transaction("outbox", "readwrite");
  await tx.store.put(make(await tx.store.get(key)));
  await tx.done;
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

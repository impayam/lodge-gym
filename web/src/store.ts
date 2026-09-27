// App state, offline-first persistence and the outbox sync loop.

import { useEffect, useState } from "preact/hooks";
import type { Bootstrap, HealthWorkout, Settings, WorkoutSession } from "../../worker/lib/types";
import { addDays, localDate } from "../../worker/lib/time";
import { api, ApiError, NetworkError } from "./api";
import * as ldb from "./localdb";
import type { BootData, OutboxEntry } from "./localdb";

export type AuthState = "loading" | "setup" | "login" | "recovery" | "locked" | "first-offline" | "ready";
export type ViewName = "home" | "history" | "program" | "settings" | "session" | "watch";

export interface SyncState {
  pending: number;
  online: boolean;
  syncing: boolean;
  error: string | null;
  lastSync: string | null;
}

export interface State {
  auth: AuthState;
  boot: BootData | null;
  sessions: Record<string, WorkoutSession>;
  view: { name: ViewName; sessionId?: string };
  sync: SyncState;
  rest: { endsAt: number; label: string } | null;
  flash: string | null;
}

let state: State = {
  auth: "loading",
  boot: null,
  sessions: {},
  view: { name: "home" },
  sync: { pending: 0, online: typeof navigator === "undefined" ? true : navigator.onLine, syncing: false, error: null, lastSync: null },
  rest: null,
  flash: null,
};

const listeners = new Set<() => void>();

export const getState = () => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function setSync(patch: Partial<SyncState>) {
  setState((s) => ({ sync: { ...s.sync, ...patch } }));
}

export function useStore<T>(select: (s: State) => T): T {
  const [value, setValue] = useState(() => select(state));
  useEffect(() => {
    const on = () => setValue(() => select(state));
    listeners.add(on);
    on();
    return () => {
      listeners.delete(on);
    };
  }, []);
  return value;
}

export const settings = (): Settings => state.boot!.settings;
export const today = () => localDate(state.boot?.settings.timezone ?? "America/Denver");

export function navigate(name: ViewName, sessionId?: string) {
  setState({ view: { name, sessionId } });
  window.scrollTo(0, 0);
}

export function flash(msg: string) {
  setState({ flash: msg });
  setTimeout(() => {
    if (state.flash === msg) setState({ flash: null });
  }, 3500);
}

/* ---------------- boot ---------------- */

export async function init() {
  window.addEventListener("online", () => {
    setSync({ online: true });
    void syncNow();
  });
  window.addEventListener("offline", () => setSync({ online: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncNow();
  });
  setInterval(() => {
    if (state.sync.pending > 0) void syncNow();
  }, 30_000);

  const [boot, loggedIn, sessions, outbox] = await Promise.all([
    ldb.kvGet<BootData>("boot"),
    ldb.kvGet<boolean>("logged_in"),
    ldb.allSessions(),
    ldb.outboxAll(),
  ]);
  setState({ boot: boot ?? null, sessions: Object.fromEntries(sessions.map((s) => [s.id, s])) });
  setSync({ pending: outbox.length });

  if (location.pathname === "/setup") {
    setState({ auth: "setup" });
    return;
  }
  if (loggedIn && boot) {
    setState({ auth: "ready" });
    void refresh();
    return;
  }
  await refresh();
}

/** Pulls /bootstrap and merges it with local data. Decides the auth state when we are not yet logged in. */
export async function refresh() {
  try {
    const b = await api<Bootstrap>("GET", "/bootstrap");
    const { sessions, server_time, ...boot } = b;
    await ldb.kvSet("boot", boot);
    await ldb.kvSet("logged_in", true);
    await mergeServerSessions(sessions, addDays(localDate(boot.settings.timezone), -60));
    setState((s) => ({ boot, auth: s.auth === "locked" ? "locked" : "ready" }));
    setSync({ online: true, lastSync: server_time });
    void syncNow();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await ldb.kvSet("logged_in", false);
      setState({ auth: "login" });
    } else if (e instanceof ApiError && e.status === 403) {
      setState({ auth: "recovery" });
    } else if (e instanceof NetworkError) {
      setSync({ online: false });
      // Only reached while loading when we were not logged in on this device.
      if (state.auth === "loading") setState({ auth: state.boot ? "login" : "first-offline" });
    } else {
      setSync({ error: e instanceof ApiError ? e.messageFa : "خطا در بارگذاری" });
      if (state.auth === "loading") setState({ auth: state.boot ? "ready" : "first-offline" });
    }
  }
}

/** Server wins unless we have a pending write or a newer local copy. Local sessions missing from the server window were deleted elsewhere. */
async function mergeServerSessions(server: WorkoutSession[], windowStart: string | null) {
  const outbox = new Set((await ldb.outboxAll()).map((e) => e.key));
  const next = { ...state.sessions };
  const put: WorkoutSession[] = [];
  const remove: string[] = [];
  const seen = new Set<string>();
  for (const s of server) {
    seen.add(s.id);
    if (outbox.has("session:" + s.id)) continue;
    const local = next[s.id];
    if (!local || Date.parse(s.updated_at) >= Date.parse(local.updated_at)) {
      next[s.id] = s;
      put.push(s);
    }
  }
  for (const s of Object.values(next)) {
    if (seen.has(s.id) || outbox.has("session:" + s.id)) continue;
    if (windowStart === null || (s.local_date >= windowStart && s.local_date <= addDays(today(), 1))) {
      delete next[s.id];
      remove.push(s.id);
    }
  }
  await ldb.putSessions(put, remove);
  setState({ sessions: next });
}

/** Loads the full history (all dates) when online. */
export async function loadAllHistory() {
  try {
    const r = await api<{ sessions: WorkoutSession[] }>("GET", "/sessions");
    await mergeServerSessions(r.sessions, null);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setState({ auth: "login" });
  }
}

/* ---------------- writes ---------------- */

type Draft<E = OutboxEntry> = E extends OutboxEntry ? Omit<E, "rev" | "queued_at"> : never;

async function enqueue(entry: Draft) {
  const prev = await ldb.outboxGet(entry.key);
  let e = { ...entry, rev: (prev?.rev ?? 0) + 1, queued_at: new Date().toISOString() } as OutboxEntry;
  if (e.op === "settings" && prev?.op === "settings") e = { ...e, patch: { ...prev.patch, ...e.patch } };
  await ldb.outboxPut(e);
  setSync({ pending: (await ldb.outboxAll()).length });
  scheduleSync();
}

export async function saveSession(doc: WorkoutSession) {
  const s = { ...doc, updated_at: new Date().toISOString() };
  setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
  await ldb.putSession(s);
  await enqueue({ key: "session:" + s.id, op: "put_session", id: s.id });
}

export async function removeSession(id: string) {
  setState((st) => {
    const next = { ...st.sessions };
    delete next[id];
    return { sessions: next };
  });
  await ldb.deleteSession(id);
  await enqueue({ key: "session:" + id, op: "delete_session", id });
}

export async function saveSettings(patch: Partial<Settings>) {
  if (!state.boot) return;
  const boot = { ...state.boot, settings: { ...state.boot.settings, ...patch } };
  setState({ boot });
  await ldb.kvSet("boot", boot);
  await enqueue({ key: "settings", op: "settings", patch });
}

/* ---------------- sync ---------------- */

let timer: ReturnType<typeof setTimeout> | null = null;
function scheduleSync() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), 800);
}

let running: Promise<void> | null = null;
let again = false;

export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncOnce();
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

async function syncOnce() {
  if (state.auth !== "ready" && state.auth !== "locked") return;
  const entries = (await ldb.outboxAll()).sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  if (!entries.length) {
    setSync({ pending: 0, error: null });
    return;
  }
  setSync({ syncing: true });
  try {
    for (const e of entries) {
      if (e.op === "put_session") {
        const doc = state.sessions[e.id] ?? (await ldb.allSessions()).find((s) => s.id === e.id);
        if (doc) {
          const r = await api<{ ok: boolean; applied: boolean; session?: WorkoutSession }>("PUT", `/sessions/${encodeURIComponent(e.id)}`, doc);
          if (!r.applied && r.session) {
            // The server has a newer version (edited on another device): take it.
            await ldb.putSession(r.session);
            setState((st) => ({ sessions: { ...st.sessions, [r.session!.id]: r.session! } }));
          }
        }
      } else if (e.op === "delete_session") {
        await api("DELETE", `/sessions/${encodeURIComponent(e.id)}`);
      } else {
        await api("PUT", "/settings", e.patch);
      }
      await ldb.outboxAck(e.key, e.rev);
    }
    setSync({ online: true, error: null, lastSync: new Date().toISOString() });
  } catch (err) {
    if (err instanceof NetworkError) setSync({ online: false });
    else if (err instanceof ApiError && err.status === 401) setState({ auth: "login" });
    else if (err instanceof ApiError) setSync({ error: err.messageFa });
  } finally {
    setSync({ syncing: false, pending: (await ldb.outboxAll()).length });
  }
}

/* ---------------- auth transitions ---------------- */

export async function onLoggedIn() {
  await ldb.kvSet("logged_in", true);
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* persistence is best-effort */
  }
  setState({ auth: "ready" });
  await refresh();
}

export async function logout() {
  try {
    await api("POST", "/auth/logout", {});
  } catch {
    /* offline logout still clears the local flag */
  }
  await ldb.kvSet("logged_in", false);
  setState({ auth: "login", view: { name: "home" }, rest: null });
}

/* ---------------- watch data ---------------- */

/** Stores watch workouts (e.g. after a manual attach) in the cached bootstrap so sessions show them offline. */
export async function upsertWatch(list: HealthWorkout[]) {
  if (!state.boot) return;
  const byId = new Map((state.boot.watch ?? []).map((w) => [w.id, w]));
  for (const w of list) byId.set(w.id, w);
  const boot = { ...state.boot, watch: [...byId.values()].filter((w) => w.matched_session_id) };
  setState({ boot });
  await ldb.kvSet("boot", boot);
}

/* ---------------- rest timer ---------------- */

export function startRest(seconds: number, label: string) {
  setState({ rest: { endsAt: Date.now() + seconds * 1000, label } });
}
export function extendRest(seconds: number) {
  if (state.rest) setState({ rest: { ...state.rest, endsAt: state.rest.endsAt + seconds * 1000 } });
}
export function stopRest() {
  setState({ rest: null });
}

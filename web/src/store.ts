// App state, offline-first persistence and the outbox sync loop.

import { useEffect, useState } from "preact/hooks";
import type { Category } from "../../worker/lib/category";
import type { BodyMetric, Bootstrap, Exercise, ExerciseMedia, HealthWorkout, Photo, Pose, ProgramInfo, ProgramVersion, Settings, Unit, WorkoutSession } from "../../worker/lib/types";
import type { CheckResult, EditedExercise, GeneratorInput, Proposal } from "../../worker/lib/generator";
import { ulid } from "../../worker/lib/ulid";
import { processPhoto } from "./photos";
import { cancelPush, schedulePush } from "./push";
import { addDays, localDate } from "../../worker/lib/time";
import { api, ApiError, apiUpload, NetworkError } from "./api";
import * as ldb from "./localdb";
import type { BootData, OutboxEntry } from "./localdb";

export type AuthState = "loading" | "setup" | "login" | "recovery" | "locked" | "first-offline" | "ready";
export type ViewName = "home" | "history" | "program" | "settings" | "session" | "watch" | "photos" | "reports" | "library" | "newprogram";

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
  /** sessionId: the session view; programId: a draft opened in the program editor. */
  view: { name: ViewName; sessionId?: string; programId?: string };
  sync: SyncState;
  rest: { id: string; endsAt: number; label: string } | null;
  flash: string | null;
  /** Synced photo metadata plus photos still waiting in the outbox. */
  photos: Photo[];
  /** Object URLs for photos not uploaded yet (id → { thumb, full }). */
  pendingPhotos: Record<string, { thumb: string; full: string }>;
  /** The exercise library (GET /api/exercises), cached for offline use; null until first loaded. */
  library: Exercise[] | null;
}

let state: State = {
  auth: "loading",
  boot: null,
  sessions: {},
  view: { name: "home" },
  sync: { pending: 0, online: typeof navigator === "undefined" ? true : navigator.onLine, syncing: false, error: null, lastSync: null },
  rest: null,
  flash: null,
  photos: [],
  pendingPhotos: {},
  library: null,
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

/** Opens the program editor: a new proposal, or a saved draft. */
export function openProgramEditor(programId?: string) {
  setState({ view: { name: "newprogram", programId } });
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

  const [boot, loggedIn, sessions, outbox, library] = await Promise.all([
    ldb.kvGet<BootData>("boot"),
    ldb.kvGet<boolean>("logged_in"),
    ldb.allSessions(),
    ldb.outboxAll(),
    ldb.kvGet<Exercise[]>("library"),
  ]);
  setState({ boot: boot ?? null, sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), library: library ?? null });
  await restorePendingPhotos();
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
      setSync({ error: e instanceof ApiError ? e.messageText : "Loading failed" });
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

/** Manual body weight for a day (source "manual"); null clears it. */
export async function saveBodyMass(date: string, value: number | null, unit: Unit) {
  if (!state.boot) return;
  const others = (state.boot.body ?? []).filter((m) => !(m.local_date === date && m.kind === "body_mass" && m.source === "manual"));
  const body: BodyMetric[] = value === null ? others : [...others, { local_date: date, kind: "body_mass", value, unit, source: "manual" }];
  body.sort((a, b) => a.local_date.localeCompare(b.local_date));
  const boot = { ...state.boot, body };
  setState({ boot });
  await ldb.kvSet("boot", boot);
  await enqueue({ key: "body:" + date, op: "body_mass", date, value, unit });
}

/* ---------------- photos (SPEC §8) ---------------- */

async function restorePendingPhotos() {
  const pending = (await ldb.outboxAll()).filter((e): e is Extract<OutboxEntry, { op: "photo" }> => e.op === "photo");
  const urls: State["pendingPhotos"] = {};
  for (const e of pending) urls[e.photo.id] = { thumb: URL.createObjectURL(e.thumb), full: URL.createObjectURL(e.full) };
  const cached = (await ldb.kvGet<Photo[]>("photos")) ?? [];
  const ids = new Set(cached.map((p) => p.id));
  setState({ pendingPhotos: urls, photos: [...pending.map((e) => e.photo).filter((p) => !ids.has(p.id)), ...cached] });
}

function sortPhotos(list: Photo[]) {
  return list.sort((a, b) => (b.local_date + b.created_at).localeCompare(a.local_date + a.created_at));
}

/** Loads the photo list from the server (keeps photos still waiting for upload). */
export async function loadPhotos() {
  try {
    const r = await api<{ photos: Photo[] }>("GET", "/photos");
    const deleting = new Set((await ldb.outboxAll()).filter((e) => e.op === "delete_photo").map((e) => (e as { id: string }).id));
    const server = r.photos.filter((p) => !deleting.has(p.id));
    await ldb.kvSet("photos", server);
    const ids = new Set(server.map((p) => p.id));
    const pending = state.photos.filter((p) => state.pendingPhotos[p.id] && !ids.has(p.id));
    setState({ photos: sortPhotos([...pending, ...server]) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setState({ auth: "login" });
  }
}

function photoUploaded(id: string) {
  const urls = state.pendingPhotos[id];
  if (!urls) return;
  const next = { ...state.pendingPhotos };
  delete next[id];
  setState({ pendingPhotos: next });
  void ldb.kvSet("photos", state.photos.filter((p) => !next[p.id]));
  // Keep the object URLs alive for images already on screen; the browser frees them on reload.
}

/** Resizes, strips metadata, stores locally and queues the upload. */
export async function addPhoto(file: Blob, pose: Pose, localDateStr: string, sessionId: string | null) {
  const processed = await processPhoto(file);
  const photo: Photo = {
    id: ulid(),
    session_id: sessionId,
    local_date: localDateStr,
    pose,
    width: processed.width,
    height: processed.height,
    bytes: processed.full.size,
    created_at: new Date().toISOString(),
  };
  setState((s) => ({
    photos: sortPhotos([photo, ...s.photos]),
    pendingPhotos: { ...s.pendingPhotos, [photo.id]: { thumb: URL.createObjectURL(processed.thumb), full: URL.createObjectURL(processed.full) } },
  }));
  await enqueue({ key: "photo:" + photo.id, op: "photo", photo, full: processed.full, thumb: processed.thumb });
  return photo;
}

export async function deletePhoto(id: string) {
  const wasPending = Boolean(state.pendingPhotos[id]) && (await ldb.outboxGet("photo:" + id));
  setState((s) => {
    const pendingPhotos = { ...s.pendingPhotos };
    delete pendingPhotos[id];
    return { photos: s.photos.filter((p) => p.id !== id), pendingPhotos };
  });
  if (wasPending) {
    // Never uploaded: just drop it from the queue.
    await ldb.outboxDelete("photo:" + id);
    setSync({ pending: (await ldb.outboxAll()).length });
  } else {
    await ldb.kvSet("photos", state.photos.filter((p) => !state.pendingPhotos[p.id]));
    await enqueue({ key: "photo-delete:" + id, op: "delete_photo", id });
  }
}

export const photoSrc = (p: Photo, size: "thumb" | "full") => state.pendingPhotos[p.id]?.[size] ?? `/api/photos/${encodeURIComponent(p.id)}?size=${size}`;

/* ---------------- exercise library (SPEC-v2 §7) ---------------- */

/** Loads the library list; the cached copy serves offline. */
export async function loadLibrary() {
  try {
    const r = await api<{ exercises: Exercise[] }>("GET", "/exercises");
    await ldb.kvSet("library", r.exercises);
    setState({ library: r.exercises });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setState({ auth: "login" });
  }
}

/** Every exercise the app knows: the cached library plus the bootstrap set (program, history, custom). */
export function allExercises(): Map<string, Exercise> {
  const map = new Map((state.library ?? []).map((e) => [e.id, e]));
  for (const e of state.boot?.exercises ?? []) if (!map.has(e.id)) map.set(e.id, e);
  return map;
}

/** Keeps an exercise in the cached bootstrap so a session that uses it renders offline. */
async function rememberExercise(ex: Exercise) {
  if (!state.boot) return;
  const exercises = [...state.boot.exercises.filter((e) => e.id !== ex.id), ex];
  const boot = { ...state.boot, exercises };
  setState({ boot });
  await ldb.kvSet("boot", boot);
}

function replaceInLibrary(ex: Exercise) {
  const library = state.library ? [...state.library.filter((e) => e.id !== ex.id), ex].sort((a, b) => a.name_en.localeCompare(b.name_en)) : [ex];
  setState({ library });
  void ldb.kvSet("library", library);
}

/**
 * Adds an exercise to this session only (SPEC-v2 §7.3): three empty sets flagged is_extra, placed after the other
 * extra exercises. The program is never changed. Works offline through the session outbox.
 */
export async function addExtraExercise(sessionId: string, ex: Exercise) {
  const s = state.sessions[sessionId];
  if (!s) return;
  await rememberExercise(ex);
  const position = Math.max(-1, ...s.sets.filter((x) => x.is_extra).map((x) => x.position ?? 0)) + 1;
  const existing = s.sets.filter((x) => x.exercise_id === ex.id).length;
  const now = new Date().toISOString();
  const sets = Array.from({ length: 3 }, (_, i) => ({
    id: ulid(),
    exercise_id: ex.id,
    set_index: existing + i,
    weight: null,
    reps: null,
    seconds: null,
    done: false,
    rir: null,
    is_extra: true,
    position,
    updated_at: now,
  }));
  await saveSession({ ...s, sets: [...s.sets, ...sets] });
}

/** Removes an extra exercise from the session; only allowed while none of its sets is done. */
export async function removeExtraExercise(sessionId: string, exerciseId: string) {
  const s = state.sessions[sessionId];
  if (!s) return;
  const mine = s.sets.filter((x) => x.exercise_id === exerciseId);
  if (!mine.length || mine.some((x) => x.done || !x.is_extra)) return;
  await saveSession({ ...s, sets: s.sets.filter((x) => x.exercise_id !== exerciseId) });
}

export interface CustomExerciseInput {
  name_en: string;
  muscle_primary: string;
  muscles_secondary: string[];
  equipment: Exercise["equipment"];
  pattern: Exercise["pattern"];
  /** Omitted: the server keeps the stored category (strength for a new exercise). */
  category?: Category;
  archived: boolean;
}

/** Creates or edits a custom exercise (online). Archiving hides it from the picker; it is never deleted. */
export async function saveCustomExercise(id: string, input: CustomExerciseInput): Promise<Exercise> {
  const r = await api<{ exercise: Exercise }>("PUT", `/exercises/${encodeURIComponent(id)}`, input);
  replaceInLibrary(r.exercise);
  if (state.boot) await rememberExercise(r.exercise);
  return r.exercise;
}

/** Photo of a custom exercise: resized and stripped of EXIF on the phone, then uploaded (online). */
export async function uploadCustomPhoto(ex: Exercise, file: Blob): Promise<Exercise> {
  const processed = await processPhoto(file);
  const r = await apiUpload<{ media: ExerciseMedia[] }>(`/exercises/${encodeURIComponent(ex.id)}/photo`, processed.full);
  const next = { ...ex, media: r.media };
  replaceInLibrary(next);
  if (state.boot) await rememberExercise(next);
  return next;
}

export const mediaSrc = (m: ExerciseMedia) => (m.r2_key ? `/api/library/media/${m.r2_key.split("/").map(encodeURIComponent).join("/")}` : (m.url ?? ""));

/* ---------------- programs (SPEC-v2 M8; online only) ---------------- */

export const generateProposal = (input: GeneratorInput) => api<{ proposal: Proposal }>("POST", "/programs/generate", input).then((r) => r.proposal);

export const loadProgramVersions = () => api<{ programs: ProgramVersion[] }>("GET", "/programs").then((r) => r.programs);

export const saveProgramDraft = (draft: { id: string; params: GeneratorInput; days: { exercises: EditedExercise[] }[] }) =>
  api<{ program: ProgramVersion; check: CheckResult }>("POST", "/programs", draft);

/** Approves a draft or re-activates an archived program, then reloads the bootstrap so the new program is offline too. */
export async function switchProgram(id: string, how: "approve" | "activate") {
  await api<{ ok: true; programs: ProgramInfo[] }>("POST", `/programs/${encodeURIComponent(id)}/${how}`);
  await refresh();
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
      } else if (e.op === "body_mass") {
        await api("PUT", `/body-mass/${e.date}`, { value: e.value, unit: e.unit });
      } else if (e.op === "photo") {
        const r = await api<{ upload: { full: string; thumb: string } }>("POST", "/photos", e.photo);
        await apiUpload(r.upload.full.replace(/^\/api/, ""), e.full);
        await apiUpload(r.upload.thumb.replace(/^\/api/, ""), e.thumb);
        photoUploaded(e.photo.id);
      } else if (e.op === "delete_photo") {
        await api("DELETE", `/photos/${encodeURIComponent(e.id)}`);
      } else {
        await api("PUT", "/settings", e.patch);
      }
      await ldb.outboxAck(e.key, e.rev);
    }
    setSync({ online: true, error: null, lastSync: new Date().toISOString() });
  } catch (err) {
    if (err instanceof NetworkError) setSync({ online: false });
    else if (err instanceof ApiError && err.status === 401) setState({ auth: "login" });
    else if (err instanceof ApiError) setSync({ error: err.messageText });
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
  if (state.rest) cancelPush(state.rest.id);
  const rest = { id: ulid(), endsAt: Date.now() + seconds * 1000, label };
  setState({ rest });
  schedulePush(rest.id, rest.endsAt, label);
}
export function extendRest(seconds: number) {
  if (!state.rest) return;
  const rest = { ...state.rest, endsAt: Math.max(Date.now(), state.rest.endsAt) + seconds * 1000 };
  setState({ rest });
  schedulePush(rest.id, rest.endsAt, rest.label);
}
export function stopRest() {
  if (state.rest) cancelPush(state.rest.id);
  setState({ rest: null });
}

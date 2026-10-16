// App state, offline-first persistence and the outbox sync loop.

import { useEffect, useState } from "preact/hooks";
import type { Category } from "../../worker/lib/category";
import type { BodyMetric, Bootstrap, Exercise, ExerciseMedia, HealthWorkout, Photo, Pose, ProgramInfo, ProgramVersion, Settings, Unit, WorkoutSession } from "../../worker/lib/types";
import type { CheckResult, EditedExercise, GeneratorInput, Proposal } from "../../worker/lib/generator";
import type { TimelineItem } from "../../worker/lib/ai/timeline";
import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings, type GymPlan, type WorkShift } from "../../worker/lib/calendar";
import { liveItems, removeItem, type SessionPlan } from "../../worker/lib/plan";
import { ulid } from "../../worker/lib/ulid";
import { processPhoto } from "./photos";
import { cancelPush, schedulePush } from "./push";
import { addDays, localDate } from "../../worker/lib/time";
import { api, ApiError, apiUpload, NetworkError } from "./api";
import * as ldb from "./localdb";
import { activeSession, homeModel, newSession, openPlanFor, planForSession, sessionFromPlan, sessionPlan } from "./model";
import type { BootData, OutboxEntry } from "./localdb";
import { backTarget, tabAfter, type TabName, type ViewName } from "./lib/nav";

export type AuthState = "loading" | "setup" | "login" | "recovery" | "locked" | "first-offline" | "ready";
export type { TabName, ViewName } from "./lib/nav";

export interface SyncState {
  pending: number;
  online: boolean;
  syncing: boolean;
  error: string | null;
  lastSync: string | null;
}

/** A server load that screens wait on (SPEC-v8 §7 states): running, failed with its error, or done in this run. */
export type Load = { status: "loading" } | { status: "error"; error: unknown } | { status: "done" };
export type LoadName = "history" | "photos" | "library" | "calendar";

export interface State {
  auth: AuthState;
  boot: BootData | null;
  sessions: Record<string, WorkoutSession>;
  /**
   * sessionId: the session view or its AI report (fresh: just finished); programId: a draft opened in the program
   * editor; planId: the session planner.
   */
  view: {
    name: ViewName;
    sessionId?: string;
    programId?: string;
    planId?: string;
    fresh?: boolean;
    saved?: TimelineItem;
    /** Photos: start in compare mode, or with one photo open. */
    photos?: { compare?: boolean; open?: string };
    /** Calendar: the week shown (its first date), free times on, Find times open. */
    calendar?: { week?: string; free?: boolean; find?: boolean };
  };
  /** The selected tab (SPEC-v8 §5); pushed screens keep the tab they were opened from. */
  tab: TabName;
  sync: SyncState;
  /** The rest timer: when it ends, what it follows, and its length in seconds (the ring's full circle). */
  rest: { id: string; endsAt: number; label: string; total: number } | null;
  flash: string | null;
  /** Synced photo metadata plus photos still waiting in the outbox. */
  photos: Photo[];
  /** Object URLs for photos not uploaded yet (id → { thumb, full }). */
  pendingPhotos: Record<string, { thumb: string; full: string }>;
  /** The exercise library (GET /api/exercises), cached for offline use; null until first loaded. */
  library: Exercise[] | null;
  /** Session plans (SPEC-v3 M9c) by id: open plans and the plans of recent sessions. */
  plans: Record<string, SessionPlan>;
  /** Training calendar (SPEC-v10 M13) by id: work shifts and planned gym sessions. */
  shifts: Record<string, WorkShift>;
  gymPlans: Record<string, GymPlan>;
  /** The full history, the photo list and the library: absent until first asked for. */
  loads: Partial<Record<LoadName, Load>>;
}

let state: State = {
  auth: "loading",
  boot: null,
  sessions: {},
  view: { name: "home" },
  tab: "home",
  sync: { pending: 0, online: typeof navigator === "undefined" ? true : navigator.onLine, syncing: false, error: null, lastSync: null },
  rest: null,
  flash: null,
  photos: [],
  pendingPhotos: {},
  library: null,
  plans: {},
  shifts: {},
  gymPlans: {},
  loads: {},
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
/** The calendar settings (gym hours, buffers, preferred windows, reminder); the approved defaults until synced. */
export const calendarSettings = (boot: BootData | null = state.boot): CalendarSettings => boot?.calendar_settings ?? DEFAULT_CALENDAR_SETTINGS;
export const today = () => localDate(state.boot?.settings.timezone ?? "America/Denver");

export function navigate(name: ViewName, sessionId?: string) {
  setState((s) => ({ view: { name, sessionId }, tab: tabAfter(name, s.tab) }));
  window.scrollTo(0, 0);
}

/** Back from a pushed screen (its Back button or the edge swipe, SPEC-v8 §5). */
export function goBack() {
  const to = backTarget(state.view.name, state.tab);
  if (to) navigate(to);
}

/** Progress photos, optionally in compare mode or with one photo open (Me → Progress photos). */
export function openPhotos(opts: { compare?: boolean; open?: string } = {}) {
  setState({ view: { name: "photos", photos: opts } });
  window.scrollTo(0, 0);
}

/** A session's AI report (SPEC-v3 M9a); `fresh` right after Finish session (with the progress-photo prompt). */
export function openReport(sessionId: string, fresh = false) {
  setState({ view: { name: "report", sessionId, fresh } });
  window.scrollTo(0, 0);
}

/** The training calendar (SPEC-v10 M13), on a week (its first date), with free times on or Find times open. */
export function openCalendar(opts: { week?: string; free?: boolean; find?: boolean } = {}) {
  setState({ view: { name: "calendar", calendar: opts } });
  window.scrollTo(0, 0);
}

/** A saved report from History → Reports timeline, read-only (SPEC-v7 M9d). */
export function openSaved(item: TimelineItem) {
  setState({ view: { name: "saved", saved: item } });
  window.scrollTo(0, 0);
}

/** The session planner (SPEC-v3 M9c) for a saved plan or a draft. */
export function openPlan(planId: string) {
  setState({ view: { name: "plan", planId } });
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

  const [boot, loggedIn, sessions, outbox, library, plans, shifts, gymPlans] = await Promise.all([
    ldb.kvGet<BootData>("boot"),
    ldb.kvGet<boolean>("logged_in"),
    ldb.allSessions(),
    ldb.outboxAll(),
    ldb.kvGet<Exercise[]>("library"),
    ldb.allPlans(),
    ldb.allShifts(),
    ldb.allGymPlans(),
  ]);
  setState({
    boot: boot ?? null,
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    library: library ?? null,
    plans: Object.fromEntries(plans.map((p) => [p.id, p])),
    shifts: Object.fromEntries(shifts.map((x) => [x.id, x])),
    gymPlans: Object.fromEntries(gymPlans.map((x) => [x.id, x])),
  });
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
    const { sessions, server_time, plans, calendar, ...rest } = b;
    const boot: BootData = { ...rest, calendar_settings: calendar?.settings ?? state.boot?.calendar_settings };
    await ldb.kvSet("boot", boot);
    await ldb.kvSet("logged_in", true);
    const windowStart = addDays(localDate(boot.settings.timezone), -60);
    await mergeServerSessions(sessions, windowStart);
    await mergeServerPlans(plans ?? []);
    // A Worker from before M13 sends no calendar: keep what this device has.
    if (calendar) await mergeServerCalendar(calendar.shifts, calendar.plans, windowStart, null);
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

/**
 * Server plans win unless a local write is pending or the local copy is newer. A local open plan the server no longer
 * lists (discarded or started on another device) goes, unless it is still waiting to sync.
 */
async function mergeServerPlans(server: SessionPlan[]) {
  const outbox = new Set((await ldb.outboxAll()).map((e) => e.key));
  const next = { ...state.plans };
  const put: SessionPlan[] = [];
  const remove: string[] = [];
  const seen = new Set<string>();
  for (const p of server) {
    seen.add(p.id);
    if (outbox.has("plan:" + p.id)) continue;
    const local = next[p.id];
    if (!local || Date.parse(p.updated_at) >= Date.parse(local.updated_at)) {
      next[p.id] = p;
      put.push(p);
    }
  }
  for (const p of Object.values(next))
    if (!seen.has(p.id) && !outbox.has("plan:" + p.id) && p.status === "planned") {
      delete next[p.id];
      remove.push(p.id);
    }
  await ldb.putPlans(put, remove);
  setState({ plans: next });
}

/**
 * Shifts and gym plans of [from, to] (to null: no end) from the server. The server wins unless a write is pending or
 * the local copy is newer; a local one in the range the server no longer has was deleted on another device.
 */
async function mergeServerCalendar(shifts: WorkShift[], plans: GymPlan[], from: string, to: string | null) {
  const outbox = new Set((await ldb.outboxAll()).map((e) => e.key));
  const inRange = (date: string) => date >= from && (to === null || date <= to);
  const merge = <T extends { id: string; date: string; updated_at: string }>(local: Record<string, T>, server: T[], prefix: string) => {
    const next = { ...local };
    const put: T[] = [];
    const remove: string[] = [];
    const seen = new Set<string>();
    for (const x of server) {
      seen.add(x.id);
      if (outbox.has(prefix + x.id)) continue;
      const mine = next[x.id];
      if (!mine || Date.parse(x.updated_at) >= Date.parse(mine.updated_at)) {
        next[x.id] = x;
        put.push(x);
      }
    }
    for (const x of Object.values(next))
      if (!seen.has(x.id) && !outbox.has(prefix + x.id) && inRange(x.date)) {
        delete next[x.id];
        remove.push(x.id);
      }
    return { next, put, remove };
  };
  const sh = merge(state.shifts, shifts, "shift:");
  const gp = merge(state.gymPlans, plans, "gymplan:");
  await ldb.putCalendar(sh.put, sh.remove, gp.put, gp.remove);
  setState({ shifts: sh.next, gymPlans: gp.next });
}

/**
 * The calendar of a week older than the bootstrap's 60 days: its shifts and plans, and the full session history for
 * its sessions (loaded once).
 */
export function loadCalendarRange(from: string, to: string) {
  return tracked("calendar", async () => {
    const [r] = await Promise.all([
      api<{ shifts: WorkShift[]; plans: GymPlan[] }>("GET", `/calendar?from=${from}&to=${to}`),
      state.loads.history?.status === "done" ? Promise.resolve() : api<{ sessions: WorkoutSession[] }>("GET", "/sessions").then((h) => mergeServerSessions(h.sessions, null)),
    ]);
    await mergeServerCalendar(r.shifts, r.plans, from, to);
  });
}

/**
 * Runs a server load and records its state for the screens; a 401 goes to sign-in. Once a load has worked in this run,
 * later ones refresh quietly: the screens keep what they have.
 */
async function tracked(name: LoadName, run: () => Promise<void>) {
  const refresh = state.loads[name]?.status === "done";
  if (!refresh) setState((s) => ({ loads: { ...s.loads, [name]: { status: "loading" } } }));
  let next: Load = { status: "done" };
  try {
    await run();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setState({ auth: "login" });
    if (!refresh) next = { status: "error", error: e };
  }
  setState((s) => ({ loads: { ...s.loads, [name]: next } }));
}

/** Loads the full history (all dates); the last 60 days come with /bootstrap. */
export function loadAllHistory() {
  return tracked("history", async () => {
    const r = await api<{ sessions: WorkoutSession[] }>("GET", "/sessions");
    await mergeServerSessions(r.sessions, null);
  });
}

/* ---------------- writes ---------------- */

type Draft<E = OutboxEntry> = E extends OutboxEntry ? Omit<E, "rev" | "queued_at"> : never;

async function enqueue(entry: Draft) {
  const prev = await ldb.outboxGet(entry.key);
  let e = { ...entry, rev: (prev?.rev ?? 0) + 1, queued_at: new Date().toISOString() } as OutboxEntry;
  if (e.op === "settings" && prev?.op === "settings") e = { ...e, patch: { ...prev.patch, ...e.patch } };
  if (e.op === "calendar_settings" && prev?.op === "calendar_settings") e = { ...e, patch: { ...prev.patch, ...e.patch } };
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

/** Stores a plan locally and queues it (SPEC-v3 M9c: planning works offline through the outbox). */
export async function savePlan(plan: SessionPlan) {
  setState((st) => ({ plans: { ...st.plans, [plan.id]: plan } }));
  await ldb.putPlan(plan);
  await enqueue({ key: "plan:" + plan.id, op: "put_plan", id: plan.id });
}

/* ---------------- training calendar (SPEC-v10 M13): written offline, sent through the outbox ---------------- */

/** Stores a work shift locally and queues it. */
export async function saveShift(x: WorkShift) {
  setState((st) => ({ shifts: { ...st.shifts, [x.id]: x } }));
  await ldb.putCalendar([x], [], [], []);
  await enqueue({ key: "shift:" + x.id, op: "put_shift", id: x.id });
}

/** Deletes a work shift (a real delete: shifts are plans, not history). */
export async function removeShift(id: string) {
  setState((st) => {
    const shifts = { ...st.shifts };
    delete shifts[id];
    return { shifts };
  });
  await ldb.putCalendar([], [id], [], []);
  await enqueue({ key: "shift:" + id, op: "delete_shift", id });
}

/** Stores a planned gym session locally and queues it; the server sets its link, status and reminder. */
export async function saveGymPlan(p: GymPlan) {
  setState((st) => ({ gymPlans: { ...st.gymPlans, [p.id]: p } }));
  await ldb.putCalendar([], [], [p], []);
  await enqueue({ key: "gymplan:" + p.id, op: "put_gymplan", id: p.id });
}

/** Deletes a planned gym session and, on the server, its reminder. */
export async function removeGymPlan(id: string) {
  setState((st) => {
    const gymPlans = { ...st.gymPlans };
    delete gymPlans[id];
    return { gymPlans };
  });
  await ldb.putCalendar([], [], [], [id]);
  await enqueue({ key: "gymplan:" + id, op: "delete_gymplan", id });
}

/** Changes calendar settings: at once on this device (the cached bootstrap), then on the server. */
export async function saveCalendarSettings(patch: Partial<CalendarSettings>) {
  if (!state.boot) return;
  const boot: BootData = { ...state.boot, calendar_settings: { ...calendarSettings(), ...patch } };
  setState({ boot });
  await ldb.kvSet("boot", boot);
  await enqueue({ key: "calendar_settings", op: "calendar_settings", patch });
}

/** Takes the server's copy after a write, unless this device changed the item again while it was being sent. */
async function tookShift(sent: WorkShift, server: WorkShift | null | undefined) {
  if (!server || state.shifts[sent.id] !== sent) return;
  setState((st) => ({ shifts: { ...st.shifts, [server.id]: server } }));
  await ldb.putCalendar([server], [], [], []);
}
async function tookGymPlan(sent: GymPlan, server: GymPlan | null | undefined) {
  if (!server || state.gymPlans[sent.id] !== sent) return;
  setState((st) => ({ gymPlans: { ...st.gymPlans, [server.id]: server } }));
  await ldb.putCalendar([], [], [server], []);
}

/** Start session: the plan becomes the workout session with the same id; the timer starts now, not at planning time. */
export async function startPlan(plan: SessionPlan) {
  const now = new Date().toISOString();
  const started: SessionPlan = { ...plan, status: "started", started_at: now, updated_at: now };
  // The session first: the planner leaves for it as soon as it sees the plan started.
  await saveSession(sessionFromPlan(state.boot!, started, today(), now));
  await savePlan(started);
  navigate("session", plan.id);
}

/** Discard plan: kept with status "discarded" (never deleted); the day goes back to the program default. */
export async function discardPlan(plan: SessionPlan) {
  await savePlan({ ...plan, status: "discarded", updated_at: new Date().toISOString() });
}

/**
 * Sends a saved plan now (NetworkError when it could not be sent) and returns its id on the server: when the day
 * already had an open plan from another device, this plan continued under that plan's id.
 */
export async function sendPlan(plan: SessionPlan): Promise<string> {
  await syncNow();
  if ((await ldb.outboxAll()).some((e) => e.key === "plan:" + plan.id)) throw new NetworkError();
  return state.plans[plan.id] ? plan.id : (openPlanFor(state.plans, plan.program_day_id)?.id ?? plan.id);
}

/**
 * Apply to program: saves the plan, sends it, then asks the server for a new program version with this day as planned
 * (M8 versioning: the new version is active, the old one archived). Needs a connection.
 */
export async function applyPlanToProgram(plan: SessionPlan): Promise<string> {
  await savePlan(plan);
  const id = await sendPlan(plan);
  const r = await api<{ ok: true; program_id: string }>("POST", `/sessions/${encodeURIComponent(id)}/apply-to-program`, {});
  await refresh();
  return r.program_id;
}

/**
 * Removes an exercise from a session (SPEC-v3 M9c): only while none of its sets is done, so history is never removed
 * silently. Its undone sets go, and the session's plan drops the exercise (soft delete); a session without a plan
 * gets one (approved default 7). Returns false when it is blocked.
 */
export async function removeSessionExercise(sessionId: string, exerciseId: string): Promise<boolean> {
  const s = state.sessions[sessionId];
  if (!s) return false;
  const mine = s.sets.filter((x) => x.exercise_id === exerciseId);
  if (mine.some((x) => x.done)) return false;
  const now = new Date().toISOString();
  const extraOnly = mine.length > 0 && mine.every((x) => x.is_extra);
  const current = sessionPlan(state.plans, sessionId);
  // An extra exercise in a session without a plan is simply its sets (as before M9c).
  if (!(extraOnly && !current)) {
    const plan = planForSession(state.boot!, s, current, allExercises(), now);
    const item = liveItems(plan).find((it) => it.exercise_id === exerciseId);
    await savePlan(item ? removeItem(plan, item.id, now) : plan);
  }
  if (mine.length) await saveSession({ ...s, sets: s.sets.filter((x) => x.exercise_id !== exerciseId) });
  return true;
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
export function loadPhotos() {
  return tracked("photos", async () => {
    const r = await api<{ photos: Photo[] }>("GET", "/photos");
    const deleting = new Set((await ldb.outboxAll()).filter((e) => e.op === "delete_photo").map((e) => (e as { id: string }).id));
    const server = r.photos.filter((p) => !deleting.has(p.id));
    await ldb.kvSet("photos", server);
    const ids = new Set(server.map((p) => p.id));
    const pending = state.photos.filter((p) => state.pendingPhotos[p.id] && !ids.has(p.id));
    setState({ photos: sortPhotos([...pending, ...server]) });
  });
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
export function loadLibrary() {
  return tracked("library", async () => {
    const r = await api<{ exercises: Exercise[] }>("GET", "/exercises");
    await ldb.kvSet("library", r.exercises);
    setState({ library: r.exercises });
  });
}

/** Every exercise the app knows: the cached library plus the bootstrap set (program, history, custom). */
export function allExercises(): Map<string, Exercise> {
  const map = new Map((state.library ?? []).map((e) => [e.id, e]));
  for (const e of state.boot?.exercises ?? []) if (!map.has(e.id)) map.set(e.id, e);
  return map;
}

/** Keeps an exercise in the cached bootstrap so a session or plan that uses it renders offline. */
export async function rememberExercise(ex: Exercise) {
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

/** One exercise of the coach's "Add to today's session" card (worker/lib/coach/sessionTools.ts Addition). */
export interface CoachExtra {
  exercise_id: string;
  sets: number;
  reps_max: number;
  is_time: boolean;
  weight: number | null;
  weight_unit: Unit | null;
}

/**
 * The coach's additions for today (Payam, 2026-10-16): into the open session as extras, as the 3D picker adds them
 * (is_extra, after the other extras), or, with no open session, into the day it names (or Home's next day) started
 * now, its open plan first if it has one. Each set is prefilled with the card's reps and its weight when the units
 * match, not checked (as "Copy last" fills a set). The program never changes. Returns the session.
 */
export async function addCoachExtras(items: CoachExtra[], dayId: string | null): Promise<WorkoutSession> {
  const boot = state.boot!;
  let s = activeSession(state.sessions);
  if (!s) {
    const days = boot.program.days;
    const day = days.find((d) => d.id === dayId) ?? days.find((d) => d.id === homeModel(boot, state.sessions, today()).next.dayId) ?? days[0];
    const plan = openPlanFor(state.plans, day.id);
    const now = new Date().toISOString();
    if (plan) {
      const started: SessionPlan = { ...plan, status: "started", started_at: now, updated_at: now };
      s = sessionFromPlan(boot, started, today(), now);
      await saveSession(s);
      await savePlan(started);
    } else s = newSession(boot, day, today());
  }
  const lib = allExercises();
  let position = Math.max(-1, ...s.sets.filter((x) => x.is_extra).map((x) => x.position ?? 0));
  const now = new Date().toISOString();
  const added = [];
  for (const it of items) {
    const ex = lib.get(it.exercise_id);
    if (!ex || s.sets.some((x) => x.exercise_id === ex.id)) continue;
    await rememberExercise(ex);
    position += 1;
    const weight = it.weight != null && it.weight_unit === s.unit ? it.weight : null;
    for (let i = 0; i < it.sets; i++)
      added.push({
        id: ulid(),
        exercise_id: ex.id,
        set_index: i,
        weight,
        reps: it.is_time ? null : it.reps_max || null,
        seconds: it.is_time ? it.reps_max : null,
        done: false,
        rir: null,
        is_extra: true,
        position,
        updated_at: now,
      });
  }
  const next = { ...s, sets: [...s.sets, ...added] };
  await saveSession(next);
  return next;
}

/** Removes an extra exercise from the session; only allowed while none of its sets is done. */
export async function removeExtraExercise(sessionId: string, exerciseId: string) {
  const s = state.sessions[sessionId];
  if (!s) return;
  const mine = s.sets.filter((x) => x.exercise_id === exerciseId);
  if (!mine.length || mine.some((x) => x.done || !x.is_extra)) return;
  await removeSessionExercise(sessionId, exerciseId);
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
      } else if (e.op === "put_plan") {
        await syncPlan(e.id);
      } else if (e.op === "put_shift") {
        const doc = state.shifts[e.id];
        if (doc) await tookShift(doc, (await api<{ shift?: WorkShift }>("PUT", `/calendar/shifts/${encodeURIComponent(e.id)}`, doc)).shift);
      } else if (e.op === "delete_shift") {
        await api("DELETE", `/calendar/shifts/${encodeURIComponent(e.id)}`);
      } else if (e.op === "put_gymplan") {
        const doc = state.gymPlans[e.id];
        if (doc) await tookGymPlan(doc, (await api<{ plan?: GymPlan }>("PUT", `/calendar/plans/${encodeURIComponent(e.id)}`, doc)).plan);
      } else if (e.op === "delete_gymplan") {
        await api("DELETE", `/calendar/plans/${encodeURIComponent(e.id)}`);
      } else if (e.op === "calendar_settings") {
        const r = await api<{ settings: CalendarSettings }>("PUT", "/calendar/settings", e.patch);
        // A change made while this one was being sent is queued and wins.
        if (state.boot && (await ldb.outboxGet(e.key))?.rev === e.rev) {
          const boot: BootData = { ...state.boot, calendar_settings: r.settings };
          setState({ boot });
          await ldb.kvSet("boot", boot);
        }
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

/**
 * One plan to the server: create-or-get it, mark it started if it is, then send its full item list. When the day
 * already had an open plan from another device, the local plan continues under that plan's id.
 */
async function syncPlan(localId: string) {
  let plan = state.plans[localId] ?? (await ldb.allPlans()).find((p) => p.id === localId);
  if (!plan) return;
  let created: { plan: SessionPlan };
  try {
    created = await api<{ plan: SessionPlan }>("POST", "/sessions/plan", {
      id: plan.id,
      program_day_id: plan.program_day_id,
      status: plan.status === "started" ? "started" : "planned",
      started_at: plan.started_at,
    });
  } catch (e) {
    // The program changed on another device before this plan reached the server: its day can't be planned any more.
    if (e instanceof ApiError && e.code === "not_active_day") {
      await forgetPlan(plan.id);
      if (plan.status === "planned") flash("A saved plan was dropped: its day is no longer in the active program.");
      return;
    }
    throw e;
  }
  if (created.plan.id !== plan.id) {
    // Nothing to discard on the server: drop the local copy.
    if (plan.status === "discarded") return forgetPlan(plan.id);
    plan = { ...plan, id: created.plan.id };
    await forgetPlan(localId);
    setState((st) => ({ plans: { ...st.plans, [plan!.id]: plan! } }));
    await ldb.putPlan(plan);
  }
  if (plan.status === "started" && plan.started_at) {
    try {
      await api("POST", `/sessions/${encodeURIComponent(plan.id)}/start`, { started_at: plan.started_at });
    } catch (e) {
      // Discarded on another device while this phone started it offline: the session itself still syncs.
      if (!(e instanceof ApiError && e.code === "plan_discarded")) throw e;
    }
  }
  let r: { applied: boolean; plan?: SessionPlan };
  try {
    r = await api<{ applied: boolean; plan?: SessionPlan }>("PUT", `/sessions/${encodeURIComponent(plan.id)}/plan-items`, {
      status: plan.status,
      updated_at: plan.updated_at,
      items: plan.items,
    });
  } catch (e) {
    // Discarded on another device: the day is back to the program default here too.
    if (e instanceof ApiError && e.code === "plan_discarded") return forgetPlan(plan.id);
    throw e;
  }
  if (r.plan?.status === "discarded") return forgetPlan(plan.id);
  // The server has a newer version (edited on another device): take it, unless this phone changed the plan again while
  // it was being sent (that change is queued and goes next).
  if (!r.applied && r.plan && (state.plans[plan.id] ?? plan) === plan) {
    await ldb.putPlan(r.plan);
    setState((st) => ({ plans: { ...st.plans, [r.plan!.id]: r.plan! } }));
  }
}

async function forgetPlan(id: string) {
  setState((st) => {
    const plans = { ...st.plans };
    delete plans[id];
    return { plans };
  });
  await ldb.putPlans([], [id]);
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
  setState({ auth: "login", view: { name: "home" }, tab: "home", rest: null });
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
  const rest = { id: ulid(), endsAt: Date.now() + seconds * 1000, label, total: seconds };
  setState({ rest });
  schedulePush(rest.id, rest.endsAt, label);
}
export function extendRest(seconds: number) {
  if (!state.rest) return;
  const endsAt = Math.max(Date.now(), state.rest.endsAt) + seconds * 1000;
  // The ring grows with the extension: it never shows more than a full circle.
  const rest = { ...state.rest, endsAt, total: Math.max(state.rest.total, (endsAt - Date.now()) / 1000) };
  setState({ rest });
  schedulePush(rest.id, rest.endsAt, rest.label);
}
export function stopRest() {
  if (state.rest) cancelPush(state.rest.id);
  setState({ rest: null });
}

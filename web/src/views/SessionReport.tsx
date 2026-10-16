// After-session report (SPEC-v3 M9a; Step 3, Payam 2026-10-16): one report per session, written once on the server
// when that day's body weight and the Apple Health workout are both in, or 2 hours after the session ends, whichever
// comes first; "Write report now" writes it at once. On top, today (summary, records, volume against the week's target);
// at the bottom, "Where you are" in 2–4 lines. Persian, right-to-left, inside the English app (like the weekly review).
// Right after Finish the screen shows only the report's status; the report itself opens on the Reports tab.
// "Report unavailable" comes with Retry; Regenerate writes a new report and the older ones are kept.

import { useEffect, useRef, useState } from "preact/hooks";
import type { NextTimeRow, ReportView } from "../../../worker/lib/ai/report";
import type { BalanceStatus } from "../../../worker/lib/reports";
import { localDate } from "../../../worker/lib/time";
import { fetchReport, lastReport, requestReport, sessionUnsynced, unavailableReason, type ReportResponse } from "../ai";
import { ApiError, errorText, NetworkError } from "../api";
import { STATUS_ICON, STATUS_NAME } from "../components/MuscleMap";
import { IconBack } from "../components/PulseIcons";
import { LoadError } from "../components/States";
import { SyncStatus } from "../components/SyncStatus";
import { costText, dateLong, dayMonth, fmtNum, hm, instantShort } from "../format";
import { dayTitle } from "../lib/lifts";
import { dayInfo } from "../model";
import { goBack, navigate, openReport, photoSrc, useStore } from "../store";
import { BodyWeight } from "../components/BodyWeight";
import { PhotoPicker, poseLabel } from "./Photos";

/** A session that ended this recently may not be queued on the server yet: keep asking for a little while. */
const FRESH_MS = 10 * 60_000;
const POLL_MS = 3000;
/** While the report waits for its timing rule: a body weight or a watch workout may make it due sooner. */
const WAIT_POLL_MS = 15_000;
const GRACE_POLLS = 5;

type Phase = "checking" | "unsynced" | "waiting" | "writing" | "ready" | "none" | "offline";

/** Queued with a time still ahead: waiting for its timing rule; queued and due: being written. */
const phaseOf = (r: ReportResponse | null): Phase =>
  !r ? "checking" : r.pending ? (r.due_at && Date.parse(r.due_at) > Date.now() ? "waiting" : "writing") : r.report ? "ready" : "none";

interface ReportState {
  phase: Phase;
  res: ReportResponse | null;
  busy: boolean;
  note: string | null;
  failure: unknown;
  /** "Write report now", Retry and Regenerate: the server writes it at once. */
  write: () => Promise<void>;
  retry: () => void;
}

/** The session's latest report and whether one is waiting or being written, kept fresh while it is. */
function useReportState(sessionId: string): ReportState {
  const syncPending = useStore((s) => s.sync.pending);
  const online = useStore((s) => s.sync.online);
  const session = useStore((s) => s.sessions[sessionId]);
  const [res, setRes] = useState<ReportResponse | null>(() => lastReport(sessionId));
  const [phase, setPhase] = useState<Phase>(() => phaseOf(lastReport(sessionId)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [failure, setFailure] = useState<unknown>(null);
  const grace = useRef(0);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (ms: number) => {
      timer = setTimeout(() => void run(), ms);
    };
    const run = async () => {
      if (await sessionUnsynced(sessionId)) {
        if (!stop) setPhase("unsynced");
        return;
      }
      try {
        const r = await fetchReport(sessionId);
        if (stop) return;
        setRes(r);
        const p = phaseOf(r);
        if (p === "waiting") {
          setPhase(p);
          return again(Math.min(WAIT_POLL_MS, Math.max(POLL_MS, Date.parse(r.due_at!) - Date.now() + 500)));
        }
        if (p === "writing") {
          setPhase(p);
          return again(POLL_MS);
        }
        if (p === "ready") return setPhase(p);
        // Just synced: its report may not be queued yet.
        const ended = session?.ended_at ? Date.parse(session.ended_at) : 0;
        if (Date.now() - ended < FRESH_MS && grace.current++ < GRACE_POLLS) {
          setPhase("checking");
          return again(POLL_MS);
        }
        setPhase("none");
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.status === 404) setPhase("unsynced");
        else {
          setFailure(e);
          setPhase((p) => (p === "ready" ? p : "offline"));
        }
      }
    };
    void run();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [sessionId, syncPending, online, round]);

  const write = async () => {
    setBusy(true);
    setNote(null);
    try {
      await requestReport(sessionId);
      grace.current = GRACE_POLLS;
      setPhase("writing");
      setRound((n) => n + 1);
    } catch (e) {
      setNote(e instanceof NetworkError ? "Writing a report needs a connection." : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return { phase, res, busy, note, failure, write, retry: () => setRound((n) => n + 1) };
}

/** When a report was written, by which model, and what it cost. */
export function Written({ view, tz }: { view: ReportView; tz: string }) {
  const cost = view.status === "ok" ? costText(view.cost_usd) : null;
  return (
    <span class="caption num" data-testid="report-written">
      Written {instantShort(view.created_at, tz)} · {hm(view.created_at, tz)}
      {view.status === "ok" ? ` · ${view.model}` : ""}
      {cost ? <span data-testid="report-cost"> · {cost}</span> : null}
    </span>
  );
}

/** "today's body weight" or "the body weight for Oct 14"; a due time on another day carries its date. */
function waitingText(r: ReportResponse, date: string, tz: string): string {
  const today = localDate(tz);
  const weight = date === today ? "today's body weight" : `the body weight for ${dayMonth(date)}`;
  const due = r.due_at!;
  const at = localDate(tz, due) === today ? hm(due, tz) : `${instantShort(due, tz)} ${hm(due, tz)}`;
  return `It is written once ${weight} and the Apple Health workout are both in, or at ${at} at the latest.`;
}

/** Every state but a written report: loading, not synced yet, waiting for its timing rule, writing, failed, none. */
function StateLines({ st, date, tz }: { st: ReportState; date: string; tz: string }) {
  const { phase, res, busy } = st;
  const view = res?.report ?? null;
  const writeNow = (
    <button type="button" class="clay press btn t-pink" data-testid="report-write" disabled={busy} onClick={() => void st.write()}>
      Write report now
    </button>
  );
  return (
    <>
      {phase === "checking" ? (
        <div class="l-col l-gap-8" aria-label="Loading the report">
          <span class="skeleton skeleton--line" />
          <span class="skeleton skeleton--line" />
        </div>
      ) : null}
      {phase === "unsynced" ? (
        <p class="state l-m0" data-testid="report-pending">
          Report pending: it is written when this session reaches the server.
        </p>
      ) : null}
      {phase === "waiting" && res ? (
        <>
          <p class="state l-m0" data-testid="report-waiting">
            {waitingText(res, date, tz)}
          </p>
          {writeNow}
        </>
      ) : null}
      {phase === "writing" ? (
        <div class="l-col l-gap-8" data-testid="report-loading">
          <span class="caption">Writing your report…</span>
          <span class="skeleton skeleton--line" />
          <span class="skeleton skeleton--line" />
        </div>
      ) : null}
      {phase === "offline" ? <LoadError what="Couldn't load the report." error={st.failure} onRetry={st.retry} /> : null}
      {phase === "none" ? (
        <>
          <p class="state l-m0">No report for this session yet.</p>
          {writeNow}
        </>
      ) : null}
      {phase === "ready" && view?.status === "error" ? (
        <div class="l-col l-gap-8" data-testid="report-unavailable">
          <span class="ex-card__meta">
            <b class="t-orange">Report unavailable</b> — {unavailableReason(view.error_code)}
          </span>
          <div class="l-row">
            <button type="button" class="clay press btn-sm btn--fit t-pink" data-testid="report-retry" disabled={busy} onClick={() => void st.write()}>
              Retry
            </button>
          </div>
        </div>
      ) : null}
      {st.note ? (
        <p class="caption t-orange l-m0" role="status">
          {st.note}
        </p>
      ) : null}
    </>
  );
}

/** The whole report (the report screen, opened from Reports or a finished session). */
export function ReportPanel({ sessionId }: { sessionId: string }) {
  const tz = useStore((s) => s.boot!.settings.timezone);
  const date = useStore((s) => s.sessions[sessionId]?.local_date ?? "");
  const st = useReportState(sessionId);
  const view = st.res?.report ?? null;
  const shown = st.phase === "ready" && view?.status === "ok" && view.report ? view : null;
  return (
    <section class="card l-col l-gap-12" data-testid="session-report" data-phase={st.phase} aria-busy={st.phase === "checking" || st.phase === "writing"} aria-labelledby="report-title">
      <div class="l-col l-gap-2">
        <h2 class="card__title l-m0" id="report-title">
          After-session report
        </h2>
        {view && st.phase === "ready" ? <Written view={view} tz={tz} /> : null}
      </div>
      <StateLines st={st} date={date} tz={tz} />
      {shown ? (
        <>
          <ReportBody view={shown} />
          <div class="l-row">
            <button type="button" class="clay press btn-sm btn--fit t-muted" data-testid="report-regenerate" disabled={st.busy} onClick={() => void st.write()}>
              Regenerate
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Right after Finish: the report's status only; a written report opens on the Reports tab. */
export function ReportStatus({ sessionId }: { sessionId: string }) {
  const tz = useStore((s) => s.boot!.settings.timezone);
  const date = useStore((s) => s.sessions[sessionId]?.local_date ?? "");
  const st = useReportState(sessionId);
  const view = st.res?.report ?? null;
  return (
    <section class="card l-col l-gap-10" data-testid="report-status" data-phase={st.phase} aria-busy={st.phase === "checking" || st.phase === "writing"} aria-labelledby="report-status-title">
      <h2 class="card__title l-m0" id="report-status-title">
        After-session report
      </h2>
      <StateLines st={st} date={date} tz={tz} />
      {st.phase === "ready" && view?.status === "ok" ? (
        <>
          <p class="state l-m0" data-testid="report-ready">
            Your report is ready.
          </p>
          <button type="button" class="clay press btn t-pink" data-testid="report-open" onClick={() => openReport(sessionId, false, true)}>
            Open in Reports
          </button>
        </>
      ) : null}
    </section>
  );
}

/** The app's target for next time ("145 lb × 5", "Bodyweight × 6–8", "60 s"). */
function nextTarget(n: NextTimeRow): string {
  if (n.kind === "time") return `${fmtNum(n.seconds)} s`;
  const reps = n.reps ? ` × ${n.reps}` : "";
  if (n.kind === "bodyweight") return `Bodyweight${n.weight ? ` +${fmtNum(n.weight)} ${n.unit}` : ""}${reps}`;
  return `${fmtNum(n.weight)} ${n.unit}${reps}`;
}

/** What the app's progression rule did. */
function nextChange(n: NextTimeRow): string {
  if (n.change === "same") return n.kind === "weight" ? "same weight" : "same";
  if (n.kind === "weight") return `+${fmtNum(n.step)} ${n.unit}${n.change === "up2" ? " (RIR 3+)" : ""}`;
  if (n.kind === "time") return "longer";
  return "add reps or load";
}

/**
 * The report: today on top (summary, records and highlights, volume today and this week against the target, extras,
 * skipped, next time, warnings), then "Where you are" in 2–4 lines (reports written before Step 3 have none).
 */
export function ReportBody({ view }: { view: ReportView }) {
  const r = view.report!;
  const where = r.where_fa ?? [];
  const list = (title: string, items: string[], mark: string, testid: string, warn = false) =>
    items.length ? (
      <div class="l-col l-gap-4" data-testid={testid}>
        <h4 class={`card__title l-m0${warn ? " t-orange" : ""}`}>{title}</h4>
        <ul class="fa prose-fa" dir="rtl" lang="fa">
          {items.map((h) => (
            <li>
              <span aria-hidden="true">{mark}</span> {h}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  const para = (title: string, text: string | null, testid: string) =>
    text ? (
      <div class="l-col l-gap-4" data-testid={testid}>
        <h4 class="card__title l-m0">{title}</h4>
        <p class="fa prose-fa" dir="rtl" lang="fa">
          {text}
        </p>
      </div>
    ) : null;
  return (
    <>
      <div class="l-col l-gap-12" data-testid="report-today">
        <h3 class="section-label">Today</h3>
        <p class="fa prose-fa" dir="rtl" lang="fa" data-testid="report-summary">
          {r.summary_fa}
        </p>
        {list("Highlights", r.highlights, "✓", "report-highlights")}
        {r.volume.length ? (
          <div class="l-col l-gap-4">
            <h4 class="card__title l-m0">Volume today and this week (fractional sets)</h4>
            <table class="data-table num" data-testid="report-volume">
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Today</th>
                  <th scope="col">Week</th>
                  <th scope="col">Target</th>
                  <th scope="col">
                    <span class="l-sr">Status</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.volume.map((v) => (
                  <tr data-status={v.status}>
                    <td>{v.group}</td>
                    <td>{fmtNum(v.today, 1)}</td>
                    <td>{fmtNum(v.week, 1)}</td>
                    <td>{v.target == null ? "–" : fmtNum(v.target, 1)}</td>
                    <td class={v.status === "under" || v.status === "over" ? "t-orange" : v.status === "on" ? "t-violet" : "t-muted"} title={STATUS_NAME[v.status as BalanceStatus]}>
                      <span aria-hidden="true">{STATUS_ICON[v.status as BalanceStatus]}</span> <span class="l-sr">{STATUS_NAME[v.status as BalanceStatus]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {para("Extra exercises", r.extras_note_fa, "report-extras")}
        {para("Skipped", r.missed_note_fa, "report-missed")}
        {r.next_time.length ? (
          <div class="l-col" data-testid="report-next">
            <h4 class="card__title l-m0">Next time</h4>
            <ul class="l-col list-plain">
              {r.next_time.map((n) => (
                <li class="list-row l-col l-top l-gap-4" data-testid={`next-${n.exercise_id}`} data-change={n.change}>
                  <span class="l-row l-between l-gap-8 l-full">
                    <span class="t-title">{n.name}</span>
                    <span class="list-row__value">
                      <b>{nextTarget(n)}</b> <span class="caption">{nextChange(n)}</span>
                    </span>
                  </span>
                  {n.note_fa ? (
                    <p class="fa prose-fa ex-card__meta l-m0 l-full" dir="rtl" lang="fa">
                      {n.note_fa}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {list("Watch out", r.warnings, "!", "report-warnings", true)}
      </div>
      {where.length ? (
        <div class="callout" data-testid="report-where">
          <h3 class="card__title l-m0">Where you are</h3>
          <ul class="fa prose-fa" dir="rtl" lang="fa">
            {where.map((t) => (
              <li>
                <span aria-hidden="true">•</span> {t}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/** The screen: after Finish (with the progress-photo prompt) or from a done session. */
export function SessionReportScreen({ id, fresh }: { id: string; fresh: boolean }) {
  const boot = useStore((s) => s.boot)!;
  const s = useStore((st) => st.sessions[id]);
  const photos = useStore((st) => st.photos);
  const [prompt, setPrompt] = useState(fresh);
  useEffect(() => {
    if (!s) navigate("home");
  }, [s]);
  if (!s) return null;
  const tz = boot.settings.timezone;
  const day = dayInfo(boot, s.program_day_id);
  const sessionPhotos = photos.filter((p) => p.session_id === s.id);
  return (
    <main class="page" data-testid="report-screen">
      <header class="screen-head">
        <button type="button" class="clay press btn-icon t-muted" aria-label="Back" data-testid="back" onClick={goBack}>
          <IconBack size={20} />
        </button>
        <div class="l-col l-grow">
          <span class="screen-head__sub">{fresh ? "Session saved" : "Finished session"}</span>
          <h1 class="screen-head__title l-m0">{dayTitle(day.name_en)}</h1>
        </div>
        {/* The report waits for this session to reach the server. */}
        <SyncStatus />
      </header>
      <span class="ex-card__meta num">
        {dateLong(s.local_date)} · {hm(s.started_at, tz)}
        {s.ended_at ? `–${hm(s.ended_at, tz)}` : ""}
      </span>

      {fresh ? (
        // Payam, 2026-10-16: the day's body weight right after Finish (optional; the same value as in the More sheet).
        <section class="card l-col l-gap-8" aria-label="Body weight" data-testid="finish-weight">
          <BodyWeight date={s.local_date} unit={s.unit} label={`Body weight today (${s.unit})`} testId="finish-body-weight" />
          <span class="caption">Optional.</span>
        </section>
      ) : null}

      {fresh ? <ReportStatus sessionId={s.id} /> : <ReportPanel sessionId={s.id} />}

      {prompt ? (
        <section class="card l-col l-gap-10" data-testid="photo-prompt" aria-labelledby="photo-prompt-title">
          <div class="l-col l-gap-2">
            <h2 class="card__title l-m0" id="photo-prompt-title">
              Progress photos today?
            </h2>
            <span class="caption">Front, side and back; optional.</span>
          </div>
          {(["front", "side", "back"] as const).map((pose) => (
            <PhotoPicker pose={pose} date={s.local_date} sessionId={s.id} compact />
          ))}
          <button type="button" class="clay press btn t-muted" onClick={() => setPrompt(false)}>
            Later
          </button>
        </section>
      ) : null}
      {sessionPhotos.length ? (
        <div class="l-grid-4 l-gap-8" data-testid="session-photos">
          {sessionPhotos.map((p) => (
            <button type="button" class="photo-thumb press" onClick={() => navigate("photos")}>
              <span class="photo-thumb__frame well">
                <img src={photoSrc(p, "thumb")} alt={`${poseLabel(p.pose)} photo`} loading="lazy" />
              </span>
              <span aria-hidden="true">{poseLabel(p.pose)}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div class="l-row l-gap-8">
        <button type="button" class="clay press btn t-muted l-grow" data-testid="report-session" onClick={() => navigate("session", s.id)}>
          Session details
        </button>
        <button type="button" class="clay press btn t-muted l-grow" onClick={() => navigate("home")}>
          Home
        </button>
      </div>
    </main>
  );
}

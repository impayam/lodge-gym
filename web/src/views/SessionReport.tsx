// AI session report (SPEC-v3 M9a): opens after Finish session and from History → session → Report. The report is
// written on the server after the session syncs, so the screen shows "Report pending" until then, a loading state
// while it is written, then the report: Persian, right-to-left, inside the English app (like the weekly review).
// "Report unavailable" comes with Retry; Regenerate writes a new report and the older ones are kept.

import { useEffect, useRef, useState } from "preact/hooks";
import type { ReportView } from "../../../worker/lib/ai/report";
import type { BalanceStatus } from "../../../worker/lib/reports";
import { fetchReport, lastReport, requestReport, sessionUnsynced, unavailableReason, type ReportResponse } from "../ai";
import { ApiError, errorText, NetworkError } from "../api";
import { STATUS_ICON, STATUS_NAME } from "../components/MuscleMap";
import { dateLong, fmtNum, hm, instantShort } from "../format";
import { dayInfo } from "../model";
import { navigate, photoSrc, useStore } from "../store";
import { PhotoPicker, poseLabel } from "./Photos";

/** A session that ended this recently may not be queued on the server yet: keep asking for a little while. */
const FRESH_MS = 10 * 60_000;
const POLL_MS = 3000;
const GRACE_POLLS = 5;

type Phase = "checking" | "unsynced" | "writing" | "ready" | "none" | "offline";

const phaseOf = (r: ReportResponse | null): Phase => (!r ? "checking" : r.pending ? "writing" : r.report ? "ready" : "none");

export function ReportPanel({ sessionId }: { sessionId: string }) {
  const syncPending = useStore((s) => s.sync.pending);
  const online = useStore((s) => s.sync.online);
  const session = useStore((s) => s.sessions[sessionId]);
  const tz = useStore((s) => s.boot!.settings.timezone);
  const [res, setRes] = useState<ReportResponse | null>(() => lastReport(sessionId));
  const [phase, setPhase] = useState<Phase>(() => phaseOf(lastReport(sessionId)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const grace = useRef(0);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      timer = setTimeout(() => void run(), POLL_MS);
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
        if (r.pending) {
          setPhase("writing");
          return again();
        }
        if (r.report) return setPhase("ready");
        const ended = session?.ended_at ? Date.parse(session.ended_at) : 0;
        if (Date.now() - ended < FRESH_MS && grace.current++ < GRACE_POLLS) {
          setPhase("writing");
          return again();
        }
        setPhase("none");
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.status === 404) setPhase("unsynced");
        else setPhase((p) => (p === "ready" ? p : "offline"));
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

  const view = res?.report ?? null;
  return (
    <section class="card review report stack" data-testid="session-report" data-phase={phase} aria-busy={phase === "checking" || phase === "writing"}>
      <div class="kv">
        <span class="eyebrow">Session report</span>
        {view && phase === "ready" ? (
          <span class="muted num" style={{ fontSize: "12px" }}>
            {instantShort(view.created_at, tz)} · {hm(view.created_at, tz)}
          </span>
        ) : null}
      </div>
      {phase === "checking" ? <div class="why">Loading the report…</div> : null}
      {phase === "unsynced" ? (
        <div class="why" data-testid="report-pending">
          Report pending: it is written when this session reaches the server.
        </div>
      ) : null}
      {phase === "writing" ? (
        <div class="rp-wait" data-testid="report-loading">
          <span class="spin" aria-hidden="true" /> Writing your report…
        </div>
      ) : null}
      {phase === "offline" ? <div class="why">The report needs a connection.</div> : null}
      {phase === "none" ? (
        <>
          <div class="why">No report for this session yet.</div>
          <button type="button" class="btn btn-primary btn-block" data-testid="report-write" disabled={busy} onClick={() => void write()}>
            Write report
          </button>
        </>
      ) : null}
      {phase === "ready" && view?.status === "error" ? (
        <div class="stack" data-testid="report-unavailable">
          <b>Report unavailable</b>
          <span class="why">{unavailableReason(view.error_code)}</span>
          <button type="button" class="btn btn-primary btn-block" data-testid="report-retry" disabled={busy} onClick={() => void write()}>
            Retry
          </button>
        </div>
      ) : null}
      {phase === "ready" && view?.status === "ok" && view.report ? (
        <>
          <ReportBody view={view} />
          <div class="kv rp-foot">
            <small class="muted">{view.model}</small>
            <button type="button" class="linkbtn" data-testid="report-regenerate" disabled={busy} onClick={() => void write()}>
              Regenerate
            </button>
          </div>
        </>
      ) : null}
      {note ? (
        <div class="banner warn" role="status">
          {note}
        </div>
      ) : null}
    </section>
  );
}

function ReportBody({ view }: { view: ReportView }) {
  const r = view.report!;
  const list = (title: string, items: string[], mark: string, cls = "") =>
    items.length ? (
      <div>
        <b class="rv-title">{title}</b>
        <ul class={`rv-list ${cls}`} dir="rtl" lang="fa">
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
      <div data-testid={testid}>
        <b class="rv-title">{title}</b>
        <p class="rp-note" dir="rtl" lang="fa">
          {text}
        </p>
      </div>
    ) : null;
  return (
    <>
      <p class="summary" dir="rtl" lang="fa" data-testid="report-summary">
        {r.summary_fa}
      </p>
      {list("Highlights", r.highlights, "✓")}
      {r.volume.length ? (
        <div>
          <b class="rv-title">Volume (fractional sets)</b>
          <table class="rp-vol num" data-testid="report-volume">
            <thead>
              <tr>
                <th>Group</th>
                <th>Today</th>
                <th>Week</th>
                <th>Target</th>
                <th>
                  <span class="sr-only">Status</span>
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
                  <td class={`st-${v.status}`} title={STATUS_NAME[v.status as BalanceStatus]}>
                    {STATUS_ICON[v.status as BalanceStatus]} <span class="sr-only">{STATUS_NAME[v.status as BalanceStatus]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {para("Extra exercises", r.extras_note_fa, "report-extras")}
      {para("Skipped", r.missed_note_fa, "report-missed")}
      {list("Next time", r.next_time, "←")}
      {list("Watch out", r.warnings, "!", "warn")}
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
    <>
      <section class="sess-head" data-testid="report-screen">
        <div class="sess-title">
          <div>
            <div class="eyebrow">{fresh ? "Session saved" : "Session report"}</div>
            <b>{day.name_en}</b>
          </div>
          <span class="pill done">Done</span>
        </div>
        <div class="why num">
          {dateLong(s.local_date)} · {hm(s.started_at, tz)}
          {s.ended_at ? `–${hm(s.ended_at, tz)}` : ""}
        </div>
      </section>

      <div style={{ marginTop: "14px" }}>
        <ReportPanel sessionId={s.id} />
      </div>

      {prompt ? (
        <section class="card photo-prompt stack" style={{ marginTop: "14px" }} data-testid="photo-prompt">
          <b>Progress photos today?</b>
          <span class="why">Front, side and back; optional.</span>
          {(["front", "side", "back"] as const).map((pose) => (
            <PhotoPicker pose={pose} date={s.local_date} sessionId={s.id} compact />
          ))}
          <button type="button" class="btn btn-ghost btn-block" onClick={() => setPrompt(false)}>
            Later
          </button>
        </section>
      ) : null}
      {sessionPhotos.length ? (
        <div class="photos" style={{ marginTop: "10px" }} data-testid="session-photos">
          {sessionPhotos.map((p) => (
            <button type="button" class="ph" onClick={() => navigate("photos")}>
              <img src={photoSrc(p, "thumb")} alt={`${poseLabel(p.pose)} photo`} loading="lazy" />
              <span class="d">{poseLabel(p.pose)}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div class="row" style={{ marginTop: "14px" }}>
        <button type="button" class="btn btn-ghost" data-testid="report-session" onClick={() => navigate("session", s.id)}>
          Session details
        </button>
        <button type="button" class="btn btn-ghost" onClick={() => navigate("home")}>
          Home
        </button>
      </div>
    </>
  );
}

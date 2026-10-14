// Reports → Training overview and Session reports (SPEC-v7 M9d). The overview is rewritten on the server after every
// finished session, right after that session's report, from raw training data only; its prose is Persian and renders
// right-to-left inside the English app. A failed update never hides the previous overview: it shows "Update failed"
// with Retry. Both are cached on the device, so Reports shows the last copy offline.

import { useEffect, useRef, useState } from "preact/hooks";
import type { OverviewView, StoredMotivation } from "../../../worker/lib/ai/overview";
import { cachedOverview, cachedSessionReports, fetchOverview, fetchSessionReports, requestOverview, unavailableReason, type OverviewResponse, type SessionReportItem } from "../ai";
import { errorText, NetworkError } from "../api";
import { dateLong, dayMonth, fmtNum, hm, instantShort } from "../format";
import { dayInfo, sortedSessions } from "../model";
import { getState, loadAllHistory, openReport, useStore } from "../store";

const POLL_MS = 3000;
/** A session that ended this recently may not have queued its overview yet: keep asking for a little while. */
const FRESH_MS = 10 * 60_000;
const GRACE_POLLS = 5;
/** Session reports shown before "Show all". */
const LIST_FIRST = 5;

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(n), 1)}%`;

export function TrainingOverviewCard() {
  const syncPending = useStore((s) => s.sync.pending);
  const online = useStore((s) => s.sync.online);
  const tz = useStore((s) => s.boot!.settings.timezone);
  const lastDone = useStore((s) => sortedSessions(s.sessions).find((x) => x.status === "done" && x.ended_at) ?? null);
  const [res, setRes] = useState<OverviewResponse | null>(null);
  const [offline, setOffline] = useState(false);
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
      try {
        const r = await fetchOverview();
        if (stop) return;
        setRes(r);
        setOffline(false);
        if (r.pending) return again();
        // The last finished session is newer than anything written since: its update may not be queued yet.
        const ended = lastDone?.ended_at ?? "";
        const newest = [r.overview?.created_at ?? "", r.failed?.created_at ?? ""].sort().at(-1)!;
        if (ended && ended > newest && Date.now() - Date.parse(ended) < FRESH_MS && syncPending === 0 && grace.current++ < GRACE_POLLS) again();
      } catch {
        if (stop) return;
        const cached = await cachedOverview();
        if (stop) return;
        if (cached) setRes((cur) => cur ?? cached);
        setOffline(true);
      }
    };
    void run();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [syncPending, online, round]);

  const write = async () => {
    setBusy(true);
    setNote(null);
    try {
      await requestOverview();
      grace.current = GRACE_POLLS;
      setRes((r) => (r ? { ...r, pending: true } : { overview: null, failed: null, pending: true }));
      setRound((n) => n + 1);
    } catch (e) {
      setNote(e instanceof NetworkError ? "Updating the overview needs a connection." : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const view = res?.overview ?? null;
  const failed = res && !res.pending ? res.failed : null;
  const state = !res ? "loading" : res.pending ? "writing" : view ? (failed ? "failed" : "ready") : failed ? "unavailable" : "none";
  return (
    <section class="card review report overview stack" data-testid="training-overview" data-state={state} data-overview={view?.id ?? ""} aria-busy={state === "loading" || state === "writing"}>
      <div class="kv">
        <span class="eyebrow">Training overview</span>
        {view ? <UpdatedAfter view={view} tz={tz} /> : null}
      </div>
      {offline && res ? <div class="why">Offline: showing the last saved copy.</div> : null}
      {!res ? <div class="why">{offline ? "The training overview needs a connection." : "Loading the training overview…"}</div> : null}
      {res?.pending ? (
        <div class="rp-wait" data-testid="overview-loading">
          <span class="spin" aria-hidden="true" /> {view ? "Updating the overview…" : "Writing your training overview…"}
        </div>
      ) : null}
      {failed ? (
        <div class={view ? "ov-failed" : "stack"} data-testid="overview-failed">
          <span>
            <b>{view ? "Update failed" : "Overview unavailable"}</b>
            <span class="why"> — {unavailableReason(failed.error_code, "overview")}</span>
          </span>
          <button type="button" class={view ? "linkbtn" : "btn btn-primary btn-block"} data-testid="overview-retry" disabled={busy || offline} onClick={() => void write()}>
            Retry
          </button>
        </div>
      ) : null}
      {state === "none" ? (
        <>
          <div class="why">No overview yet. It is written after each finished session, right after the session report.</div>
          <button type="button" class="btn btn-primary btn-block" data-testid="overview-write" disabled={busy || offline} onClick={() => void write()}>
            Write overview
          </button>
        </>
      ) : null}
      {view ? (
        <>
          <OverviewBody view={view} />
          <div class="kv rp-foot">
            <small class="muted">{view.model}</small>
            <button type="button" class="linkbtn" data-testid="overview-regenerate" disabled={busy || offline || !!res?.pending} onClick={() => void write()}>
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

/** "Updated after: Day 1 · Chest · Oct 12" (the finished session that triggered it), or the time of a manual update. */
function UpdatedAfter({ view, tz }: { view: OverviewView; tz: string }) {
  const boot = useStore((s) => s.boot)!;
  return (
    <span class="muted num ov-when" data-testid="overview-updated">
      {view.trigger ? `Updated after: ${dayInfo(boot, view.trigger.program_day_id).name_en} · ${dayMonth(view.trigger.local_date)}` : `Updated ${instantShort(view.created_at, tz)} · ${hm(view.created_at, tz)}`}
    </span>
  );
}

/** The motivational line's label from the app's facts: which week it reports, and "under half of plan" in words. */
export function motivationLabel(m: StoredMotivation): string {
  const base = m.phase === "start" ? "New week" : m.phase === "mid" ? "This week so far" : "This week's result";
  const label = m.announce_last_week && m.phase !== "start" ? `Last week's result · ${base}` : m.announce_last_week ? "Last week's result · New week" : base;
  return m.bad ? `${label} · under half of plan` : label;
}

export function OverviewBody({ view }: { view: OverviewView }) {
  const o = view.overview;
  const lifts = o.lifts.filter((l) => l.sessions > 0);
  const list = (title: string, items: string[], mark: string, testid: string, cls = "") =>
    items.length ? (
      <div data-testid={testid}>
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
      <div class="muted ov-window num">
        This week and the previous 4 · {dayMonth(view.window_start)} – {dayMonth(view.window_end)}
      </div>
      <p class="summary" dir="rtl" lang="fa" data-testid="overview-summary">
        {o.summary_fa}
      </p>
      {o.motivation ? (
        <div class={`ov-motivation${o.motivation.bad ? " bad" : ""}`} data-testid="overview-motivation" data-phase={o.motivation.phase} data-bad={String(o.motivation.bad)}>
          <b class="rv-title">{motivationLabel(o.motivation)}</b>
          <p dir="rtl" lang="fa">
            {o.motivation.text_fa}
          </p>
        </div>
      ) : null}
      {lifts.length ? (
        <div>
          <b class="rv-title">Main lifts (estimated 1RM)</b>
          <table class="rp-vol num" data-testid="overview-lifts">
            <thead>
              <tr>
                <th>Lift</th>
                <th>1RM ({o.unit})</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {lifts.map((l) => (
                <tr data-lift={l.exercise_id}>
                  <td>{l.name}</td>
                  <td>{l.latest_e1rm == null ? "–" : fmtNum(l.latest_e1rm, 1)}</td>
                  <td class={l.change_pct == null ? "" : l.change_pct > 0 ? "st-on" : l.change_pct < 0 ? "st-under" : ""}>{l.change_pct == null ? "–" : signed(l.change_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list("Trends", o.trends, "•", "overview-trends")}
      {para("Volume", o.volume_fa, "overview-volume")}
      {para("Consistency", o.consistency_fa, "overview-consistency")}
      {list("Focus next", o.focus_next, "←", "overview-focus")}
      {list("Watch out", o.warnings, "!", "overview-warnings", "warn")}
    </>
  );
}

/** Every session's latest report, newest session first; a row opens the full report. */
export function SessionReportsList() {
  const boot = useStore((s) => s.boot)!;
  const syncPending = useStore((s) => s.sync.pending);
  const online = useStore((s) => s.sync.online);
  const [list, setList] = useState<SessionReportItem[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [all, setAll] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const r = await fetchSessionReports();
        if (stop) return;
        setList(r);
        setOffline(false);
      } catch {
        const cached = await cachedSessionReports();
        if (stop) return;
        if (cached) setList((cur) => cur ?? cached);
        setOffline(true);
      }
    })();
    return () => {
      stop = true;
    };
  }, [syncPending, online]);

  const open = async (id: string) => {
    setOpening(id);
    // The phone keeps recent sessions only; older ones are loaded first (the report screen needs the session).
    if (!getState().sessions[id]) await loadAllHistory();
    setOpening(null);
    openReport(id);
  };

  const shown = list ? (all ? list : list.slice(0, LIST_FIRST)) : [];
  return (
    <section data-testid="session-reports">
      <h2>Session reports</h2>
      {offline && list ? <p class="why" style={{ marginTop: 0 }}>Offline: showing the last saved copy.</p> : null}
      {!list ? (
        <div class="empty">{offline ? "Session reports need a connection." : "Loading…"}</div>
      ) : !list.length ? (
        <div class="empty">No session reports yet. A report is written after each finished session.</div>
      ) : (
        <div class="stack">
          {shown.map((r) => (
            <button type="button" class="hist sr-row" data-testid="session-report-row" data-session={r.session_id} disabled={opening === r.session_id} onClick={() => void open(r.session_id)}>
              <span class="meta">
                <b>{dayInfo(boot, r.program_day_id).name_en}</b>
                <small>{dateLong(r.local_date)}</small>
                {r.status === "ok" && r.summary_fa ? (
                  <span class="sr-line" dir="rtl" lang="fa">
                    {r.summary_fa}
                  </span>
                ) : (
                  <span class="sr-line bad">Report unavailable</span>
                )}
              </span>
              <span class="side" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
          {list.length > LIST_FIRST ? (
            <button type="button" class="linkbtn" data-testid="session-reports-all" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${fmtNum(list.length)}`}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

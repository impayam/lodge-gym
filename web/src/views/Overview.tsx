// Reports → Training overview and Session reports (SPEC-v7 M9d). The overview is rewritten on the server after every
// finished session, right after that session's report, from raw training data only; its prose is Persian and renders
// right-to-left inside the English app. A failed update never hides the previous overview: it shows "Update failed"
// with Retry. Both are cached on the device, so Reports shows the last copy offline.

import { useEffect, useRef, useState } from "preact/hooks";
import type { OverviewView, StoredMotivation } from "../../../worker/lib/ai/overview";
import { cachedOverview, cachedSessionReports, fetchOverview, fetchSessionReports, requestOverview, unavailableReason, type OverviewResponse, type SessionReportItem } from "../ai";
import { errorText, NetworkError } from "../api";
import { IconChevron } from "../components/PulseIcons";
import { Empty, isOffline, LoadError } from "../components/States";
import { dateShort, dayMonth, fmtNum, hm, instantShort } from "../format";
import { dayTitle } from "../lib/lifts";
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
  // The last fetch failed (offline, or the server answered with an error): the error, shown with Retry.
  const [failure, setFailure] = useState<unknown>(null);
  const offline = failure !== null;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // "Read full overview" expands the rest of the overview in the card (Payam, 2026-10-14).
  const [open, setOpen] = useState(false);
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
        setFailure(null);
        if (r.pending) return again();
        // The last finished session is newer than anything written since: its update may not be queued yet.
        const ended = lastDone?.ended_at ?? "";
        const newest = [r.overview?.created_at ?? "", r.failed?.created_at ?? ""].sort().at(-1)!;
        if (ended && ended > newest && Date.now() - Date.parse(ended) < FRESH_MS && syncPending === 0 && grace.current++ < GRACE_POLLS) again();
      } catch (e) {
        if (stop) return;
        const cached = await cachedOverview();
        if (stop) return;
        if (cached) setRes((cur) => cur ?? cached);
        setFailure(e);
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
    <section class="card l-col l-gap-10" data-testid="training-overview" data-state={state} data-overview={view?.id ?? ""} aria-busy={state === "loading" || state === "writing"} aria-labelledby="overview-title">
      <div class="l-col l-gap-2">
        <h2 class="card__title l-m0" id="overview-title">
          Training overview
        </h2>
        {/* SPEC-v7 §M9d: when it was updated, and by which model. */}
        {view ? (
          <span class="caption num">
            <UpdatedAfter view={view} tz={tz} /> · {view.model}
          </span>
        ) : null}
      </div>
      {offline && res ? <p class="caption l-m0">{isOffline(failure) ? "Offline" : "Couldn't refresh"}: showing the last saved copy.</p> : null}
      {!res ? (
        offline ? (
          <LoadError what="Couldn't load the training overview." error={failure} onRetry={() => setRound((n) => n + 1)} />
        ) : (
          <div class="l-col l-gap-8" aria-label="Loading the training overview">
            <span class="skeleton skeleton--line" />
            <span class="skeleton skeleton--line" />
          </div>
        )
      ) : null}
      {res?.pending ? (
        <div class="l-col l-gap-8" data-testid="overview-loading">
          <span class="caption">{view ? "Updating the overview…" : "Writing your training overview…"}</span>
          {view ? null : <span class="skeleton skeleton--line" />}
        </div>
      ) : null}
      {failed ? (
        <div class="l-col l-gap-8" data-testid="overview-failed">
          <span class="ex-card__meta">
            <b class="t-orange">{view ? "Update failed" : "Overview unavailable"}</b> — {unavailableReason(failed.error_code, "overview")}
          </span>
          <button type="button" class="clay press btn-sm btn--fit t-pink" data-testid="overview-retry" disabled={busy || offline} onClick={() => void write()}>
            Retry
          </button>
        </div>
      ) : null}
      {state === "none" ? (
        <>
          <p class="state l-m0">No overview yet. It is written after each finished session, right after the session report.</p>
          <button type="button" class="clay press btn t-pink" data-testid="overview-write" disabled={busy || offline} onClick={() => void write()}>
            Write overview
          </button>
        </>
      ) : null}
      {view ? (
        <>
          <p class="fa prose-fa" dir="rtl" lang="fa" data-testid="overview-summary">
            {view.overview.summary_fa}
          </p>
          {open ? (
            <div id="overview-full" class="l-col l-gap-12">
              <OverviewBody view={view} summary={false} />
            </div>
          ) : null}
          <div class="l-row l-gap-8">
            <button type="button" class="clay press btn-sm btn--fit t-pink" aria-expanded={open} aria-controls="overview-full" data-testid="overview-more" onClick={() => setOpen(!open)}>
              {open ? "Show less" : "Read full overview"}
            </button>
            <button type="button" class="clay press btn-sm btn--fit t-muted" data-testid="overview-regenerate" disabled={busy || offline || !!res?.pending} onClick={() => void write()}>
              Regenerate
            </button>
          </div>
        </>
      ) : null}
      {note ? (
        <p class="caption t-orange l-m0" role="status">
          {note}
        </p>
      ) : null}
    </section>
  );
}

/** "Updated after: Day 1 · Chest · Oct 12" (the finished session that triggered it), or the time of a manual update. */
function UpdatedAfter({ view, tz }: { view: OverviewView; tz: string }) {
  const boot = useStore((s) => s.boot)!;
  return (
    <span data-testid="overview-updated">
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

export function OverviewBody({ view, summary = true }: { view: OverviewView; summary?: boolean }) {
  const o = view.overview;
  const lifts = o.lifts.filter((l) => l.sessions > 0);
  const list = (title: string, items: string[], mark: string, testid: string, warn = false) =>
    items.length ? (
      <div class="l-col l-gap-4" data-testid={testid}>
        <h3 class={`card__title l-m0${warn ? " t-orange" : ""}`}>{title}</h3>
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
        <h3 class="card__title l-m0">{title}</h3>
        <p class="fa prose-fa" dir="rtl" lang="fa">
          {text}
        </p>
      </div>
    ) : null;
  return (
    <>
      <span class="caption num">
        This week and the previous 4 · {dayMonth(view.window_start)} – {dayMonth(view.window_end)}
      </span>
      {summary ? (
        <p class="fa prose-fa" dir="rtl" lang="fa" data-testid="overview-summary">
          {o.summary_fa}
        </p>
      ) : null}
      {o.motivation ? (
        <div class="callout" data-testid="overview-motivation" data-phase={o.motivation.phase} data-bad={String(o.motivation.bad)}>
          <h3 class="card__title l-m0">{motivationLabel(o.motivation)}</h3>
          <p class="fa prose-fa" dir="rtl" lang="fa">
            {o.motivation.text_fa}
          </p>
        </div>
      ) : null}
      {lifts.length ? (
        <div class="l-col l-gap-4">
          <h3 class="card__title l-m0">Main lifts (estimated 1RM)</h3>
          <table class="data-table num" data-testid="overview-lifts">
            <thead>
              <tr>
                <th scope="col">Lift</th>
                <th scope="col">1RM ({o.unit})</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {lifts.map((l) => (
                <tr data-lift={l.exercise_id}>
                  <td>{l.name}</td>
                  <td>{l.latest_e1rm == null ? "–" : fmtNum(l.latest_e1rm, 1)}</td>
                  <td class={l.change_pct == null ? "" : l.change_pct > 0 ? "t-violet" : l.change_pct < 0 ? "t-orange" : ""}>{l.change_pct == null ? "–" : signed(l.change_pct)}</td>
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
      {list("Watch out", o.warnings, "!", "overview-warnings", true)}
    </>
  );
}

/** Every session's latest report, newest session first; a row opens the full report. */
export function SessionReportsList() {
  const boot = useStore((s) => s.boot)!;
  const syncPending = useStore((s) => s.sync.pending);
  const online = useStore((s) => s.sync.online);
  const [list, setList] = useState<SessionReportItem[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  const [all, setAll] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const r = await fetchSessionReports();
        if (stop) return;
        setList(r);
        setFailure(null);
      } catch (e) {
        const cached = await cachedSessionReports();
        if (stop) return;
        if (cached) setList((cur) => cur ?? cached);
        setFailure(e);
      }
    })();
    return () => {
      stop = true;
    };
  }, [syncPending, online, round]);

  const open = async (id: string) => {
    setOpening(id);
    // The phone keeps recent sessions only; older ones are loaded first (the report screen needs the session).
    if (!getState().sessions[id]) await loadAllHistory();
    setOpening(null);
    openReport(id);
  };

  const shown = list ? (all ? list : list.slice(0, LIST_FIRST)) : [];
  return (
    <section class="card card--list" data-testid="session-reports" aria-labelledby="session-reports-title">
      <h2 class="l-sr" id="session-reports-title">
        Session reports
      </h2>
      {failure !== null && list ? <p class="caption">{isOffline(failure) ? "Offline" : "Couldn't refresh"}: showing the last saved copy.</p> : null}
      {!list ? (
        failure !== null ? (
          <LoadError what="Couldn't load the session reports." error={failure} onRetry={() => setRound((n) => n + 1)} />
        ) : (
          <div class="l-col l-gap-8" aria-label="Loading the session reports">
            <span class="skeleton skeleton--line" />
            <span class="skeleton skeleton--line" />
          </div>
        )
      ) : !list.length ? (
        <Empty>No session reports yet. A report is written after each finished session.</Empty>
      ) : (
        <>
          {shown.map((r) => {
            const day = dayInfo(boot, r.program_day_id);
            return (
              <button type="button" class="list-row press" data-testid="session-report-row" data-session={r.session_id} disabled={opening === r.session_id} onClick={() => void open(r.session_id)}>
                <span class="well icon-well icon-well--40 big-num big-num--18 t-orange num" aria-hidden="true">
                  {fmtNum(day.position)}
                </span>
                <span class="list-row__text">
                  <span class="t-title">
                    <span class="l-sr">Day {fmtNum(day.position)} · </span>
                    {dayTitle(day.name_en)}
                  </span>
                  <span class="caption">{dateShort(r.local_date)}</span>
                  {r.status === "ok" && r.summary_fa ? (
                    <span class="list-row__note fa" dir="rtl" lang="fa">
                      {r.summary_fa}
                    </span>
                  ) : (
                    <span class="list-row__note t-orange">Report unavailable</span>
                  )}
                </span>
                <span class="list-row__chevron">
                  <IconChevron size={16} />
                </span>
              </button>
            );
          })}
          {list.length > LIST_FIRST ? (
            <button type="button" class="list-row press t-muted" data-testid="session-reports-all" onClick={() => setAll(!all)}>
              <span class="list-row__text">{all ? "Show fewer" : `Show all ${fmtNum(list.length)}`}</span>
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

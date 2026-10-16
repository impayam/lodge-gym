// Reports → AI reports (the latest after-session reports and a row to All reports), and the saved training overviews
// (SPEC-v7 M9d). Since Step 3 (Payam, 2026-10-16) the overview is no longer written: one after-session report per
// session carries "Where you are", and the older overviews stay readable from All reports. Persian prose renders
// right-to-left inside the English app. The list is cached on the device, so Reports shows the last copy offline.

import { useEffect, useState } from "preact/hooks";
import type { OverviewView, StoredMotivation } from "../../../worker/lib/ai/overview";
import { cachedSessionReports, fetchSessionReports, type SessionReportItem } from "../ai";
import { IconChevron } from "../components/PulseIcons";
import { Empty, isOffline, LoadError } from "../components/States";
import { dateShort, dayMonth, fmtNum } from "../format";
import { dayTitle } from "../lib/lifts";
import { dayInfo } from "../model";
import { getState, loadAllHistory, navigate, openReport, useStore } from "../store";

/** After-session reports shown on Reports; the rest are under All reports (Reports, approved 2026-10-16). */
const LIST_FIRST = 3;

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(n), 1)}%`;

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

/**
 * Reports → AI reports: the latest three sessions' reports (newest first; a row opens the full report), then a row to
 * All reports, the timeline of every saved report and weekly review.
 */
export function SessionReportsList() {
  const boot = useStore((s) => s.boot)!;
  const syncPending = useStore((s) => s.sync.pending);
  const online = useStore((s) => s.sync.online);
  const [list, setList] = useState<SessionReportItem[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);
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

  const shown = list ? list.slice(0, LIST_FIRST) : [];
  return (
    <section class="card card--list" data-testid="session-reports" aria-labelledby="session-reports-title">
      <h2 class="card__title l-m0" id="session-reports-title">
        AI reports
      </h2>
      {failure !== null && list ? <p class="caption">{isOffline(failure) ? "Offline" : "Couldn't refresh"}: showing the last saved copy.</p> : null}
      {!list ? (
        failure !== null ? (
          <LoadError what="Couldn't load the after-session reports." error={failure} onRetry={() => setRound((n) => n + 1)} />
        ) : (
          <div class="l-col l-gap-8" aria-label="Loading the after-session reports">
            <span class="skeleton skeleton--line" />
            <span class="skeleton skeleton--line" />
          </div>
        )
      ) : !list.length ? (
        <Empty>No after-session reports yet. One is written after each finished session.</Empty>
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
        </>
      )}
      <button type="button" class="list-row press" data-testid="all-reports" onClick={() => navigate("allreports")}>
        <span class="list-row__text">
          <span class="t-title">All reports and weekly reviews</span>
          <span class="caption">Timeline and list of every saved report</span>
        </span>
        <span class="list-row__chevron">
          <IconChevron size={16} />
        </span>
      </button>
    </section>
  );
}

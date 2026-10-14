// History → Reports timeline (SPEC-v7 M9d, design approved 2026-10-13). Every saved report on its date: two labeled
// rows, Session report (●) and Weekly review (□), one column per date with a report, newest on the right. Overviews
// open from the date's chooser (a session date lists its report and the overview written after it); an overview on a
// day without a session marks that date with ◆. Shape plus label, never color alone. The List view is the accessible
// alternative and shows all three types. Every report opens read-only (no Regenerate or Retry).

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { timelineDates, type TimelineItem, type TimelineKind } from "../../../worker/lib/ai/timeline";
import type { ReportView } from "../../../worker/lib/ai/report";
import type { OverviewView } from "../../../worker/lib/ai/overview";
import type { WeeklyReview } from "../../../worker/lib/types";
import { addDays } from "../../../worker/lib/time";
import { cachedReviews, cachedSavedOverview, cachedTimeline, fetchReport, fetchReviews, fetchSavedOverview, fetchTimeline, lastReport } from "../ai";
import { ApiError, NetworkError } from "../api";
import { dateLong, dateShort, dayMonth, hm, instantShort, monthLabel, plural } from "../format";
import * as ldb from "../localdb";
import type { BootData } from "../localdb";
import { dayInfo } from "../model";
import { navigate, openSaved, setState, useStore } from "../store";
import { OverviewBody } from "./Overview";
import { WeeklyReviewCard } from "./Review";
import { ReportBody } from "./SessionReport";

const KIND_LABEL: Record<TimelineKind, string> = { session: "Session report", overview: "Training overview", review: "Weekly review" };
const VIEW_KEY = "history:reports-view";

/** The second line of an item: the session's day, what the overview was written after, or the week reviewed. */
function detail(it: TimelineItem, boot: BootData): string {
  if (it.kind === "session") return dayInfo(boot, it.program_day_id ?? "").name_en;
  if (it.kind === "overview") return it.program_day_id ? `After ${dayInfo(boot, it.program_day_id).name_en}` : `Regenerated · ${hm(it.created_at, boot.settings.timezone)}`;
  return `Week of ${dayMonth(it.week_start!)} – ${dayMonth(addDays(it.week_start!, 6))}`;
}

const Marker = ({ kind }: { kind: TimelineKind }) => <i class={`mk mk-${kind}`} aria-hidden="true" />;

function ItemButton({ it, boot }: { it: TimelineItem; boot: BootData }) {
  return (
    <button type="button" class="rt-item" data-testid="rt-item" data-kind={it.kind} data-date={it.date} onClick={() => openSaved(it)}>
      <Marker kind={it.kind} />
      <span class="t">
        <b>{KIND_LABEL[it.kind]}</b>
        <small>{detail(it, boot)}</small>
      </span>
      <span class="go" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

export function ReportsTimeline() {
  const boot = useStore((s) => s.boot)!;
  const online = useStore((s) => s.sync.online);
  const syncPending = useStore((s) => s.sync.pending);
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [mode, setMode] = useState<"timeline" | "list">("timeline");
  const [sel, setSel] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ldb
      .kvGet<"timeline" | "list">(VIEW_KEY)
      .then((m) => m && setMode(m))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const r = await fetchTimeline();
        if (stop) return;
        setItems(r);
        setOffline(false);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return setState({ auth: "login" });
        const cached = await cachedTimeline();
        if (stop) return;
        setItems((cur) => cur ?? cached ?? null);
        setOffline(true);
      }
    })();
    return () => {
      stop = true;
    };
  }, [online, syncPending]);

  const dates = items ? timelineDates(items) : [];
  const columns = [...dates].reverse();
  // The newest date is on the right: start there.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [mode, items?.length]);

  const pick = (d: { date: string; items: TimelineItem[] }) => {
    if (d.items.length === 1) return openSaved(d.items[0]);
    setSel(sel === d.date ? null : d.date);
  };
  const choose = (m: "timeline" | "list") => {
    setMode(m);
    void ldb.kvSet(VIEW_KEY, m).catch(() => undefined);
  };
  const chosen = dates.find((d) => d.date === sel) ?? null;

  const months = new Map<string, typeof dates>();
  for (const d of dates) months.set(monthLabel(d.date), [...(months.get(monthLabel(d.date)) ?? []), d]);

  return (
    <section data-testid="reports-timeline" data-mode={mode}>
      <div class="kv rt-head">
        <h2>Reports timeline</h2>
        {items?.length ? (
          <div class="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === "timeline"} data-testid="rt-mode-timeline" onClick={() => choose("timeline")}>
              Timeline
            </button>
            <button type="button" aria-pressed={mode === "list"} data-testid="rt-mode-list" onClick={() => choose("list")}>
              List
            </button>
          </div>
        ) : null}
      </div>
      {offline && items ? <p class="why" style={{ marginTop: 0 }}>Offline: showing the last saved copy.</p> : null}
      {!items ? (
        <div class="empty">{offline ? "The reports timeline needs a connection." : "Loading…"}</div>
      ) : !items.length ? (
        <div class="empty">No saved reports yet. Session reports, training overviews and weekly reviews show up here.</div>
      ) : mode === "timeline" ? (
        <div class="card rt-card">
          <div class="rt-grid" role="group" aria-label="Reports by date, newest on the right">
            <div class="rt-lanes" aria-hidden="true">
              <span />
              <span class="rt-lane">
                <Marker kind="session" />
                Session report
              </span>
              <span class="rt-lane">
                <Marker kind="review" />
                Weekly review
              </span>
              <span />
            </div>
            <div class="rt-scroll" ref={scroller}>
              <div class="rt-cols">
                {columns.map((d, i) => {
                  const has = (k: TimelineKind) => d.items.some((x) => x.kind === k);
                  const month = i === 0 || d.date.slice(0, 7) !== columns[i - 1].date.slice(0, 7);
                  const [wd, rest] = dateShort(d.date).split(", ");
                  return (
                    <button
                      type="button"
                      class={`rt-col${sel === d.date ? " sel" : ""}${month && i ? " month-start" : ""}`}
                      data-testid="rt-col"
                      data-date={d.date}
                      aria-pressed={d.items.length > 1 ? sel === d.date : undefined}
                      aria-label={`${dateShort(d.date)}: ${d.items.map((x) => KIND_LABEL[x.kind].toLowerCase()).join(", ")}`}
                      onClick={() => pick(d)}
                    >
                      <span class="m">{month ? rest.split(" ")[0] : ""}</span>
                      <span class="c">{has("session") ? <Marker kind="session" /> : null}</span>
                      <span class="c">{has("review") ? <Marker kind="review" /> : null}</span>
                      <span class="d">
                        <span class="o">{has("overview") && !has("session") ? <Marker kind="overview" /> : null}</span>
                        <b>{rest.split(" ")[1]}</b>
                        <small>{wd}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div class="rt-hint">
            <Marker kind="overview" />
            <span>Overview on a day without a session. Tap a date to open its report.</span>
          </div>
          {chosen ? (
            <div class="rt-pick" role="group" aria-label={`Reports on ${dateLong(chosen.date)}`} data-testid="rt-chooser">
              <b>
                {dateLong(chosen.date)} · {plural(chosen.items.length, "report")}
              </b>
              {chosen.items.map((it) => (
                <ItemButton it={it} boot={boot} />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div data-testid="rt-list">
          {[...months].map(([month, days]) => (
            <>
              <h3 class="subhead">{month}</h3>
              <ul class="card rt-days">
                {days.map((d) => (
                  <li class="rt-day">
                    <div class="rt-date">{dateShort(d.date)}</div>
                    <ul class="rt-items">
                      {d.items.map((it) => (
                        <li>
                          <ItemButton it={it} boot={boot} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          ))}
        </div>
      )}
    </section>
  );
}

type Load<T> = { state: "loading" } | { state: "ok"; data: T; offline: boolean } | { state: "gone" } | { state: "offline" };

/** Loads a saved report: the device's copy first, then the server's. */
function useSaved<T>(cached: () => Promise<T | null | undefined> | T | null | undefined, fresh: () => Promise<T | null>): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let stop = false;
    void (async () => {
      const c = (await cached()) ?? null;
      if (c && !stop) setLoad({ state: "ok", data: c, offline: false });
      try {
        const f = await fresh();
        if (!stop) setLoad(f ? { state: "ok", data: f, offline: false } : { state: "gone" });
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.status === 404) setLoad({ state: "gone" });
        else if (e instanceof NetworkError || !(e instanceof ApiError)) setLoad(c ? { state: "ok", data: c, offline: true } : { state: "offline" });
        else setLoad({ state: "gone" });
      }
    })();
    return () => {
      stop = true;
    };
  }, []);
  return load;
}

function Status({ load }: { load: Load<unknown> }) {
  if (load.state === "loading") return <div class="why">Loading the saved report…</div>;
  if (load.state === "offline") return <div class="why">Opening a saved report needs a connection.</div>;
  if (load.state === "gone") return <div class="why">This report is no longer available.</div>;
  return load.offline ? <div class="why">Offline: showing the last saved copy.</div> : null;
}

/** The screen: one saved report, read-only, opened from the History timeline. */
export function SavedReport({ item }: { item: TimelineItem }) {
  const boot = useStore((s) => s.boot)!;
  return (
    <>
      <button type="button" class="linkbtn" onClick={() => navigate("history")}>
        ← History
      </button>
      <section class="sess-head" data-testid="saved-report" data-kind={item.kind}>
        <div class="sess-title">
          <div>
            <div class="eyebrow">{KIND_LABEL[item.kind]} · read-only</div>
            <b>{detail(item, boot)}</b>
          </div>
        </div>
        <div class="why num">{dateLong(item.date)}</div>
      </section>
      <div style={{ marginTop: "14px" }}>
        {item.kind === "session" ? <SavedSession id={item.id} tz={boot.settings.timezone} /> : item.kind === "overview" ? <SavedOverview id={item.id} tz={boot.settings.timezone} /> : <SavedReview id={item.id} />}
      </div>
    </>
  );
}

function SavedSession({ id, tz }: { id: string; tz: string }) {
  const load = useSaved<ReportView>(
    () => (lastReport(id)?.report?.status === "ok" ? lastReport(id)!.report : null),
    async () => {
      const r = await fetchReport(id);
      return r.report?.status === "ok" ? r.report : null;
    }
  );
  return (
    <>
      <Status load={load} />
      {load.state === "ok" ? (
        <section class="card review report stack" data-testid="saved-body">
          <div class="kv">
            <span class="eyebrow">Session report</span>
            <span class="muted num" style={{ fontSize: "12px" }}>
              {instantShort(load.data.created_at, tz)} · {hm(load.data.created_at, tz)}
            </span>
          </div>
          <ReportBody view={load.data} />
          <div class="kv rp-foot">
            <small class="muted">{load.data.model}</small>
          </div>
        </section>
      ) : null}
    </>
  );
}

function SavedOverview({ id, tz }: { id: string; tz: string }) {
  const load = useSaved<OverviewView>(() => cachedSavedOverview(id), () => fetchSavedOverview(id));
  return (
    <>
      <Status load={load} />
      {load.state === "ok" ? (
        <section class="card review report overview stack" data-testid="saved-body">
          <div class="kv">
            <span class="eyebrow">Training overview</span>
            <span class="muted num" style={{ fontSize: "12px" }}>
              {instantShort(load.data.created_at, tz)} · {hm(load.data.created_at, tz)}
            </span>
          </div>
          <OverviewBody view={load.data} />
          <div class="kv rp-foot">
            <small class="muted">{load.data.model}</small>
          </div>
        </section>
      ) : null}
    </>
  );
}

function SavedReview({ id }: { id: string }) {
  const load = useSaved<WeeklyReview>(
    async () => (await cachedReviews())?.find((r) => r.id === id) ?? null,
    async () => (await fetchReviews()).find((r) => r.id === id) ?? null
  );
  return (
    <>
      <Status load={load} />
      {load.state === "ok" ? (
        <div data-testid="saved-body">
          <WeeklyReviewCard review={load.data} />
        </div>
      ) : null}
    </>
  );
}

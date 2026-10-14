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
import { IconBack, IconChevron } from "../components/PulseIcons";
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

const Marker = ({ kind }: { kind: TimelineKind }) => <i class={`marker marker--${kind}`} aria-hidden="true" />;

/** One saved report: a raised row in a date's chooser (mockup 04), a list row in the List view. */
function ItemButton({ it, boot, row }: { it: TimelineItem; boot: BootData; row?: boolean }) {
  return (
    <button type="button" class={row ? "list-row press" : "clay press timeline-item"} data-testid="rt-item" data-kind={it.kind} data-date={it.date} onClick={() => openSaved(it)}>
      <Marker kind={it.kind} />
      <span class="list-row__text">
        <span class="t-title">{KIND_LABEL[it.kind]}</span>
        <span class="caption">{detail(it, boot)}</span>
      </span>
      <span class="list-row__chevron">
        <IconChevron size={16} />
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
    <section class="card l-col l-gap-12" data-testid="reports-timeline" data-mode={mode} aria-labelledby="rt-title">
      <div class="card__head l-gap-8">
        <h2 class="card__title l-m0" id="rt-title">
          Reports timeline
        </h2>
        {items?.length ? (
          <span class="segmented" role="group" aria-label="View">
            <button type="button" class="press" aria-pressed={mode === "timeline"} data-testid="rt-mode-timeline" onClick={() => choose("timeline")}>
              Timeline
            </button>
            <button type="button" class="press" aria-pressed={mode === "list"} data-testid="rt-mode-list" onClick={() => choose("list")}>
              List
            </button>
          </span>
        ) : null}
      </div>
      {offline && items ? <p class="caption l-m0">Offline: showing the last saved copy.</p> : null}
      {!items ? (
        offline ? (
          <p class="state l-m0">The reports timeline needs a connection.</p>
        ) : (
          <span class="skeleton" style={{ height: "120px" }} aria-label="Loading the reports timeline" />
        )
      ) : !items.length ? (
        <p class="state l-m0">No saved reports yet. Session reports, training overviews and weekly reviews show up here.</p>
      ) : mode === "timeline" ? (
        <>
          <div class="timeline">
            <div class="timeline__lanes" aria-hidden="true">
              <span />
              <span>Sessions</span>
              <span>Weekly</span>
              <span />
            </div>
            <div class="timeline__scroll" ref={scroller}>
              <div class="timeline__cols" role="group" aria-label="Reports by date, newest on the right">
                {columns.map((d, i) => {
                  const has = (k: TimelineKind) => d.items.some((x) => x.kind === k);
                  const month = i === 0 || d.date.slice(0, 7) !== columns[i - 1].date.slice(0, 7);
                  const [wd, rest] = dateShort(d.date).split(", ");
                  return (
                    <button
                      type="button"
                      class="timeline__col press"
                      data-testid="rt-col"
                      data-date={d.date}
                      aria-pressed={d.items.length > 1 ? sel === d.date : undefined}
                      aria-label={`${dateShort(d.date)}: ${d.items.map((x) => KIND_LABEL[x.kind].toLowerCase()).join(", ")}`}
                      onClick={() => pick(d)}
                    >
                      <span class="timeline__month">{month ? rest.split(" ")[0] : ""}</span>
                      {/* An overview on a day without a session sits in the Sessions lane as ◆. */}
                      <span>{has("session") ? <Marker kind="session" /> : has("overview") ? <Marker kind="overview" /> : null}</span>
                      <span>{has("review") ? <Marker kind="review" /> : null}</span>
                      <span class="timeline__date">
                        <b class="num">{rest.split(" ")[1]}</b>
                        <span>{wd}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <span class="caption l-row l-gap-8">
            <Marker kind="overview" />
            <span>Overview on a day without a session. Tap a date to open its report.</span>
          </span>
          {chosen ? (
            <div class="timeline__chooser" role="group" aria-label={`Reports on ${dateLong(chosen.date)}`} data-testid="rt-chooser">
              <span class="caption num">
                {dateLong(chosen.date)} · {plural(chosen.items.length, "report")}
              </span>
              {chosen.items.map((it) => (
                <ItemButton it={it} boot={boot} />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div class="l-col l-gap-12" data-testid="rt-list">
          {[...months].map(([month, days]) => (
            <>
              <h3 class="section-label">{month}</h3>
              {days.map((d) => (
                <div class="l-col l-gap-2">
                  <span class="caption num">{dateShort(d.date)}</span>
                  <div class="card--list">
                    {d.items.map((it) => (
                      <ItemButton it={it} boot={boot} row />
                    ))}
                  </div>
                </div>
              ))}
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
  if (load.state === "loading")
    return (
      <div class="card l-col l-gap-8" aria-label="Loading the saved report">
        <span class="skeleton skeleton--line" />
        <span class="skeleton skeleton--line" />
      </div>
    );
  if (load.state === "offline") return <p class="state l-m0">Opening a saved report needs a connection.</p>;
  if (load.state === "gone") return <p class="state l-m0">This report is no longer available.</p>;
  return load.offline ? <p class="caption l-m0">Offline: showing the last saved copy.</p> : null;
}

/** The screen: one saved report, read-only, opened from the History timeline. */
export function SavedReport({ item }: { item: TimelineItem }) {
  const boot = useStore((s) => s.boot)!;
  const tz = boot.settings.timezone;
  return (
    <main class="page" data-testid="saved-report" data-kind={item.kind}>
      <header class="screen-head">
        <button type="button" class="clay press btn-icon t-muted" aria-label="Back to History" data-testid="back" onClick={() => navigate("history")}>
          <IconBack size={20} />
        </button>
        <div class="l-col l-grow">
          <span class="screen-head__sub">{KIND_LABEL[item.kind]} · read-only</span>
          <h1 class="screen-head__title l-m0">{detail(item, boot)}</h1>
        </div>
      </header>
      <span class="ex-card__meta num">{dateLong(item.date)}</span>
      {item.kind === "session" ? <SavedSession id={item.id} tz={tz} /> : item.kind === "overview" ? <SavedOverview id={item.id} tz={tz} /> : <SavedReview id={item.id} />}
    </main>
  );
}

/** When a saved report was written, and by which model. */
const Written = ({ at, model, tz }: { at: string; model: string; tz: string }) => (
  <span class="caption num">
    Written {instantShort(at, tz)} · {hm(at, tz)} · {model}
  </span>
);

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
        <section class="card l-col l-gap-12" data-testid="saved-body" aria-label="Session report">
          <Written at={load.data.created_at} model={load.data.model} tz={tz} />
          <ReportBody view={load.data} />
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
        <section class="card l-col l-gap-12" data-testid="saved-body" aria-label="Training overview">
          <Written at={load.data.created_at} model={load.data.model} tz={tz} />
          <OverviewBody view={load.data} />
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
        <div class="l-col" data-testid="saved-body">
          <WeeklyReviewCard review={load.data} />
        </div>
      ) : null}
    </>
  );
}

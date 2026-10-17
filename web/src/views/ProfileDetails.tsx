// Profile → Details (SPEC-v12 M15 §3.2: everything the Reports tab held, folded on Profile, closed by default).
// Week / Month / All: three tiles (sessions, new records, groups on target; the current week's are Profile's This week,
// so they show here for a past week, a month and All), Main lifts (the estimated 1RM chart of the big three; each main
// lift's 1RM and change is in the Strength corner of My goal), sets vs target (Month: volume vs last month; All: the
// muscle balance list), the consistency calendar, the period's details folded, then share and export. Report numbers
// are computed on the server; the last loaded copy is cached on the device for offline viewing. The chart and the
// calendar read the sessions on the phone, the same way as the Train tab.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { monthKeyOf, monthRange, shiftMonth, type MuscleRow, type monthlyReport, type progressReport, type weeklyReport } from "../../../worker/lib/reports";
import { weekRange } from "../../../worker/lib/cycle";
import { addDays } from "../../../worker/lib/time";
import type { Photo } from "../../../worker/lib/types";
import { api, errorText } from "../api";
import { Bars } from "../components/Bars";
import { Columns } from "../components/Columns";
import { Empty, LoadError, Loading } from "../components/States";
import { BalanceList, MUSCLE_NAME } from "../components/BalanceList";
import { IconBack, IconChevron } from "../components/PulseIcons";
import { TimeChart, type ChartSeries } from "../components/TimeChart";
import { dateLong, dayMonth, fmtNum, monthLabel } from "../format";
import { BIG_THREE } from "../lib/lifts";
import { e1rmPoints } from "../lib/records";
import { calendarStarts, calendarWeeks, chartFrom, chartWindow, type Period } from "../lib/reportsView";
import * as ldb from "../localdb";
import { daysPerWeek } from "../model";
import { fetchFile, reportCard, shareOrDownload } from "../share";
import { getState, loadAllHistory, photoSrc, today, useStore } from "../store";
import { poseLabel } from "./Photos";

type Week = ReturnType<typeof weeklyReport>;
type Month = ReturnType<typeof monthlyReport>;
type Progress = ReturnType<typeof progressReport>;

/** Loads a report, caching it for offline use; `retry` loads it again after a failure; a new `refresh` loads it again. */
export function useReport<T>(
  path: string,
  refresh = ""
): {
  data: T | null;
  error: unknown;
  offline: boolean;
  retry: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    void (async () => {
      const cached = await ldb.kvGet<T>(`report:${path}`).catch(() => undefined);
      if (cached && alive) setData(cached);
      try {
        const fresh = await api<T>("GET", path);
        await ldb.kvSet(`report:${path}`, fresh);
        if (alive) {
          setData(fresh);
          setOffline(false);
        }
      } catch (e) {
        if (!alive) return;
        if (cached) setOffline(true);
        else setError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [path, attempt, refresh]);
  return { data, error, offline, retry: () => setAttempt((n) => n + 1) };
}

/** The phone keeps 60 days of sessions; longer charts load the rest once (after a failure, Retry loads it). */
const ensureHistory = () => {
  if (!getState().loads.history) void loadAllHistory();
};

const signed = (n: number | null, suffix = "") => (n == null ? "–" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(n), 1)}${suffix}`);
const setText = (s: { weight: number; reps: number } | null) => (s ? `${fmtNum(s.weight, 1)}×${fmtNum(s.reps)}` : "–");
const kilo = (n: number) => (n >= 1000 ? `${fmtNum(Math.round(n / 100) / 10)}k` : fmtNum(Math.round(n)));

/** The big three in the chart's fixed series order: orange, violet, pink (SPEC-v8 §3). */
const CHART_LIFTS = [
  { id: "deadlift", color: "--series-1" },
  { id: "squat", color: "--series-2" },
  { id: "bench", color: "--series-3" },
] as const;
const liftName = (id: string) => BIG_THREE.find((l) => l.id === id)!.label;

/* ---------------- shared cards ---------------- */

function Card({ title, sub, testid, children }: { title: string; sub?: ComponentChildren; testid?: string; children: ComponentChildren }) {
  return (
    <section class="card l-col l-gap-12" data-testid={testid}>
      <div class="card__head l-gap-8">
        <h2 class="card__title l-m0">{title}</h2>
        {sub ? <span class="caption num l-right">{sub}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** Three tiles (SPEC-v8 §6.03): the line under each number is short, as in the mockup, and screen readers hear what
 *  the number counts. */
function Tiles({ tiles, testid }: { tiles: { value: string; label: string; context?: string }[]; testid: string }) {
  return (
    <section class="l-grid-3 l-gap-10" data-testid={testid} aria-label="Summary">
      {tiles.map((t) => (
        <div class="card card--tile">
          <span class="big-num big-num--30 num">{t.value}</span>
          <span class="caption">
            {t.label}
            {t.context ? <span class="l-sr">, {t.context}</span> : null}
          </span>
        </div>
      ))}
    </section>
  );
}

function PeriodNav({ label, prev, next, unit, canNext }: { label: string; prev: () => void; next: () => void; unit: "week" | "month"; canNext: boolean }) {
  return (
    <div class="l-row l-between l-gap-8" data-testid="period-nav">
      <button type="button" class="clay press btn-icon t-muted" aria-label={`Previous ${unit}`} onClick={prev}>
        <IconBack size={20} />
      </button>
      <span class="t-title num" data-testid="period-label" aria-live="polite">
        {label}
      </span>
      <button type="button" class="clay press btn-icon t-muted" aria-label={`Next ${unit}`} disabled={!canNext} onClick={next}>
        <IconChevron size={20} />
      </button>
    </div>
  );
}

/** Loading (skeleton in card shape), or what failed with Retry. */
function Pending({ error, what, onRetry }: { error: unknown; what: string; onRetry: () => void }) {
  return error ? (
    <section class="card">
      <LoadError what={`Couldn't load ${what}.`} error={error} onRetry={onRetry} />
    </section>
  ) : (
    <Loading label="Loading the report" heights={[84, 220]} />
  );
}

/**
 * Main lifts: the chart of the big three's estimated 1RM over the period's window (three series in a fixed order).
 * Every main lift's 1RM and its change is in the Strength corner of My goal (SPEC-v12 M15 §3.2).
 */
export function MainLifts({ period, end }: { period: Period; end: string }) {
  const sessions = useStore((s) => s.sessions);
  const unit = useStore((s) => s.boot!.settings.unit);
  const older = useStore((s) => s.loads.history);
  const all = Object.values(sessions);
  const first = all.filter((s) => s.status === "done").reduce<string | null>((m, s) => (m === null || s.local_date < m ? s.local_date : m), null);
  const from = chartFrom(period, end, first);
  const needsOlder = from < addDays(today(), -59) || period === "all";
  useEffect(() => {
    if (needsOlder) ensureHistory();
  }, [from, period]);
  const series: ChartSeries[] = CHART_LIFTS.map((l) => ({
    label: liftName(l.id),
    color: l.color,
    points: e1rmPoints(all, l.id, unit, from)
      .filter((p) => p.date <= end)
      .map(({ date, value }) => ({ date, value })),
  })).filter((s) => s.points.length);
  const latest = series.map((s) => `${s.label} ${fmtNum(s.points[s.points.length - 1].value, 1)}`).join(", ");
  // The x-axis starts at the first date drawn; the label says the same.
  const drawn = series.reduce<string | null>((m, s) => (m === null || s.points[0].date < m ? s.points[0].date : m), null);
  const window = chartWindow(period, from, first, dayMonth(drawn ?? first ?? end));
  return (
    <Card title="Main lifts (estimated 1RM)" sub={`${unit}, ${window}`} testid="main-lifts">
      {series.length ? (
        <TimeChart series={series} height={170} yAxis label={`Estimated 1RM in ${unit}, ${window}; latest ${latest}`} unit={unit} />
      ) : needsOlder && older?.status !== "done" && older?.status !== "error" ? (
        <Loading label="Loading older sessions" heights={[170]} />
      ) : older?.status === "error" && needsOlder ? null : (
        <Empty>No bench press, squat or deadlift logged in this period.</Empty>
      )}
      {needsOlder && older?.status === "error" ? <LoadError what="Couldn't load sessions older than 60 days." error={older.error} onRetry={() => void loadAllHistory()} /> : null}
    </Card>
  );
}

/**
 * The three tiles of every period: sessions, new records, groups on target (no lift numbers: they are in Main lifts).
 * A group is on target at 80–120% of its weekly target, as in Sets vs target.
 */
export function PeriodTiles({ testid, sessions, records, muscles, context }: { testid: string; sessions: { value: string; context?: string }; records: number; muscles: MuscleRow[]; context: { records: string; target: string } }) {
  const targeted = muscles.filter((m) => m.target !== null);
  const on = targeted.filter((m) => m.status === "on").length;
  return (
    <Tiles
      testid={testid}
      tiles={[
        { value: sessions.value, label: "Sessions", context: sessions.context },
        { value: fmtNum(records), label: "New records", context: context.records },
        { value: `${fmtNum(on)}/${fmtNum(targeted.length)}`, label: "Groups on target", context: context.target },
      ]}
    />
  );
}

/** The period's details, folded by default (Reports, approved 2026-10-16); the row says what is inside. */
function Details({ sub, children }: { sub: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section class="card card--list" aria-label="Details">
        <button type="button" class="list-row press" data-testid="report-details" aria-expanded={open} aria-controls="report-details-body" onClick={() => setOpen(!open)}>
          <span class="list-row__text">
            <span class="t-title">{open ? "Hide details" : "Details"}</span>
            <span class="caption">{sub}</span>
          </span>
          <span class="list-row__chevron">
            <IconChevron size={16} />
          </span>
        </button>
      </section>
      {open ? (
        <div id="report-details-body" class="l-col l-gap-12" data-testid="report-details-body">
          {children}
        </div>
      ) : null}
    </>
  );
}

const weekdayNarrow = new Intl.DateTimeFormat("en-US", {
  weekday: "narrow",
  timeZone: "UTC",
});
const weekdayShort = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: "UTC",
});
const at = (d: string) => new Date(`${d}T12:00:00Z`);

/** Trained days per week and each week's done / target; the program has no fixed weekdays, so no missed days are drawn. */
function Consistency({ starts, sub }: { starts: string[]; sub: string }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const t = today();
  const target = daysPerWeek(boot);
  const done = Object.values(sessions)
    .filter((s) => s.status === "done")
    .map((s) => s.local_date);
  const weeks = calendarWeeks(done, starts, t);
  return (
    <Card title="Consistency" sub={sub} testid="consistency">
      <div class="calendar" aria-hidden="true">
        <span />
        {weeks[0]?.days.map((d) => (
          <span class="calendar__head">{weekdayNarrow.format(at(d.date))}</span>
        ))}
        <span />
        {weeks.map((w) => (
          <>
            <span class="calendar__week num">{dayMonth(w.start)}</span>
            {w.days.map((d) => (
              <span class="calendar__cell" data-trained={d.trained ? "true" : "false"} data-date={d.date} />
            ))}
            <span class="calendar__count num">
              {fmtNum(w.done)}/{fmtNum(target)}
            </span>
          </>
        ))}
      </div>
      <ul class="l-sr">
        {weeks.map((w) => {
          const days = w.days.filter((d) => d.trained).map((d) => weekdayShort.format(at(d.date)));
          return (
            <li>
              Week of {dateLong(w.start)}: {fmtNum(w.done)} of {fmtNum(target)} sessions{days.length ? `, trained ${days.join(", ")}` : ""}.
            </li>
          );
        })}
      </ul>
      <div class="chart-legend" aria-hidden="true">
        <span>
          <span class="chart-legend__swatch" style={{ background: "var(--pink)" }} />
          Trained
        </span>
        <span class="num">{fmtNum(target)} per week: sessions done / target</span>
      </div>
    </Card>
  );
}

function Actions({ card, csvPath, title }: { card: () => Promise<Blob>; csvPath?: string; title: string }) {
  const [msg, setMsg] = useState("");
  const run = async (f: () => Promise<{ blob: Blob; filename: string }>) => {
    setMsg("");
    try {
      const { blob, filename } = await f();
      const r = await shareOrDownload(blob, filename, title);
      setMsg(r === "downloaded" ? "File downloaded." : "");
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <div class="l-col l-gap-8">
      <div class="l-row l-gap-8">
        <button
          type="button"
          class="clay press btn btn--fit t-muted l-grow"
          data-testid="share-png"
          onClick={() =>
            void run(async () => ({
              blob: await card(),
              filename: "gym-time-report.png",
            }))
          }
        >
          Share image
        </button>
        {csvPath ? (
          <button type="button" class="clay press btn btn--fit t-muted l-grow" data-testid="export-csv" onClick={() => void run(() => fetchFile(csvPath))}>
            Export CSV
          </button>
        ) : null}
      </div>
      {msg ? (
        <span class="caption" role="status">
          {msg}
        </span>
      ) : null}
    </div>
  );
}

/** A row of a details card: a name (and a line under it) on the left, the numbers on the right. */
function Row({ name, sub, value, testid }: { name: ComponentChildren; sub?: ComponentChildren; value: ComponentChildren; testid?: string }) {
  return (
    <div class="list-row" data-testid={testid}>
      <span class="list-row__text">
        <span class="t-title">{name}</span>
        {sub ? <span class="caption num">{sub}</span> : null}
      </span>
      <span class="list-row__value num">{value}</span>
    </div>
  );
}

function ListCard({ title, testid, children }: { title: string; testid?: string; children: ComponentChildren }) {
  return (
    <section class="card card--list" data-testid={testid} aria-label={title}>
      <h2 class="card__title l-m0">{title}</h2>
      {children}
    </section>
  );
}

const Offline = ({ on }: { on: boolean }) => (on ? <p class="caption l-m0">Offline: showing the last saved copy.</p> : null);

/* ---------------- Week ---------------- */

function WeekView() {
  const [anchor, setAnchor] = useState(today());
  const ws = useStore((s) => s.boot!.settings.week_start);
  const range = weekRange(anchor, ws);
  const { data: r, error, offline, retry } = useReport<Week>(`/reports/week?start=${range.start}`);
  const nav = (
    <PeriodNav
      unit="week"
      label={`${dayMonth(range.start)} – ${dayMonth(range.end)}`}
      prev={() => setAnchor(addDays(range.start, -7))}
      next={() => setAnchor(addDays(range.start, 7))}
      canNext={range.end < today()}
    />
  );
  if (!r || r.range.start !== range.start)
    return (
      <>
        {nav}
        <Pending error={error} what="this week's report" onRetry={retry} />
      </>
    );
  const card = () =>
    reportCard("Weekly report", `${dateLong(r.range.start)} – ${dateLong(r.range.end)}`, [
      {
        label: "Sessions",
        value: `${r.sessions.done} of ${r.sessions.target}`,
      },
      { label: "Training time", value: `${r.sessions.total_minutes} min` },
      ...r.lifts
        .filter((l) => l.best)
        .map((l) => ({
          label: l.name_en,
          value: `${l.best!.weight}×${l.best!.reps} · 1RM ${l.best!.e1rm}`,
        })),
      ...(r.watch.active_kcal != null
        ? [
            {
              label: "Active kcal",
              value: `${Math.round(r.watch.active_kcal)}`,
            },
          ]
        : []),
      ...(r.body.avg != null
        ? [
            {
              label: `Body weight (${r.unit})`,
              value: `${r.body.avg}${r.body.change != null ? ` (${r.body.change > 0 ? "+" : ""}${r.body.change})` : ""}`,
            },
          ]
        : []),
    ]);
  // Chest first (the priority), then the program's order.
  const muscles = r.muscles.filter((m) => m.target !== null).sort((a, b) => (a.muscle === "chest" ? -1 : b.muscle === "chest" ? 1 : 0));
  return (
    <>
      {nav}
      <Offline on={offline} />
      {/* The current week's tiles are Profile's This week. */}
      {range.start !== weekRange(today(), ws).start ? <WeekTiles r={r} /> : null}
      <MainLifts period="week" end={range.end} />
      <Card title="Sets this week vs target" sub="Chest first" testid="week-sets">
        <Bars
          testid="sets-bars"
          markWord="Target"
          fmt={(n) => fmtNum(n, 1)}
          rows={muscles.map((m) => ({
            key: m.muscle,
            label: m.basis === "direct" ? `${MUSCLE_NAME[m.muscle]} (direct)` : MUSCLE_NAME[m.muscle],
            value: m.basis === "direct" ? m.sets : m.fractional,
            mark: m.target,
            direct: m.sets,
            status: m.status,
          }))}
        />
        <span class="caption">
          Fractional sets: the primary muscle counts 1 set, each secondary muscle 0.5. Forearms and neck count direct sets against the program's direct sets (rows and curls count only half a forearm set).
        </span>
      </Card>
      <Consistency starts={calendarStarts("week", range.start, range, null)} sub="Last 5 weeks" />
      <Details sub="New records, sessions, Apple Watch, body weight, notes">
        {r.prs.length ? (
          <ListCard title="New records" testid="week-prs">
            {r.prs.map((p) => (
              <Row
                name={
                  <>
                    <span class="badge">PR</span> {p.name_en}
                  </>
                }
                sub={`was ${fmtNum(p.previous_e1rm, 1)}`}
                value={`${setText(p)} · 1RM ${fmtNum(p.e1rm, 1)}`}
              />
            ))}
          </ListCard>
        ) : null}
        <ListCard title="Sessions, Apple Watch and body" testid="week-body">
          {r.sessions.days.length ? <Row name="Sessions" sub={r.sessions.days.map((d) => `${d.name_en} · ${dayMonth(d.date)}`).join(", ")} value={`${fmtNum(r.sessions.done)}`} /> : null}
          <Row name="Training time" value={`${fmtNum(r.sessions.total_minutes)} min`} />
          <Row name="Active kcal" value={r.watch.active_kcal != null ? fmtNum(Math.round(r.watch.active_kcal)) : "–"} />
          <Row name="Average heart rate in sessions" value={r.watch.hr_avg != null ? fmtNum(Math.round(r.watch.hr_avg)) : "–"} />
          <Row name="Sessions with / without watch data" value={`${fmtNum(r.watch.matched)} / ${fmtNum(r.watch.unmatched)}`} />
          <Row name={`Average body weight (${r.unit})`} sub={r.body.change != null ? `${signed(r.body.change)} vs last week` : undefined} value={r.body.avg != null ? fmtNum(r.body.avg, 1) : "–"} />
        </ListCard>
        {r.notes.length ? (
          <ListCard title="Notes">
            {r.notes.map((n) => (
              <div class="list-row">
                <span class="list-row__text">
                  <span class="caption num">
                    {n.name_en} · {dayMonth(n.date)}
                  </span>
                  <span dir="auto">{n.note}</span>
                </span>
              </div>
            ))}
          </ListCard>
        ) : null}
      </Details>
      <Actions card={card} csvPath={`/reports/week?start=${r.range.start}&format=csv`} title="GYM time weekly report" />
    </>
  );
}

/* ---------------- Month ---------------- */

function MonthView() {
  const [key, setKey] = useState(monthKeyOf(today()));
  const ws = useStore((s) => s.boot!.settings.week_start);
  const target = useStore((s) => daysPerWeek(s.boot!));
  const { data: r, error, offline, retry } = useReport<Month>(`/reports/month?month=${key}`);
  const current = monthKeyOf(today());
  const range = monthRange(key);
  const nav = <PeriodNav unit="month" label={monthLabel(`${key}-01`)} prev={() => setKey(shiftMonth(key, -1))} next={() => setKey(shiftMonth(key, 1))} canNext={key < current} />;
  if (!r || r.range.key !== key)
    return (
      <>
        {nav}
        <Pending error={error} what="this month's report" onRetry={retry} />
      </>
    );
  const card = () =>
    reportCard("Monthly report", monthLabel(r.range.start), [
      { label: "Sessions", value: `${r.sessions}` },
      { label: "Adherence", value: `${r.adherence_pct}%` },
      ...(r.avg_minutes != null ? [{ label: "Average session", value: `${r.avg_minutes} min` }] : []),
      ...r.e1rm
        .filter((l) => l.points.length)
        .map((l) => ({
          label: `1RM ${l.name_en}`,
          value: `${l.points[l.points.length - 1].e1rm}`,
        })),
      ...(r.body.length
        ? [
            {
              label: `Body weight (${r.unit})`,
              value: `${r.body[r.body.length - 1].ma7}`,
            },
          ]
        : []),
    ]);
  const volume = r.volume.filter((v) => v.current > 0 || v.previous > 0).sort((a, b) => (a.muscle === "chest" ? -1 : b.muscle === "chest" ? 1 : 0));
  return (
    <>
      {nav}
      <Offline on={offline} />
      <PeriodTiles
        testid="month-stats"
        sessions={{ value: `${fmtNum(r.sessions)}/${fmtNum(Math.round(r.target))}` }}
        records={r.prs.length}
        muscles={r.muscles}
        context={{ records: "new records this month", target: "muscle groups whose average week this month is on their weekly target" }}
      />
      <MainLifts period="month" end={range.end} />
      <Card title="Volume vs last month" sub={`${r.unit} × reps, chest first`} testid="month-volume">
        {volume.length ? (
          <Bars
            testid="volume-bars"
            markWord="Last month"
            fill="var(--series-2)"
            fmt={kilo}
            rows={volume.map((v) => ({
              key: v.muscle,
              label: MUSCLE_NAME[v.muscle],
              value: v.current,
              mark: v.previous,
            }))}
          />
        ) : (
          <p class="state l-m0">No sets this month or last month.</p>
        )}
      </Card>
      <Consistency starts={calendarStarts("month", weekRange(range.start, ws).start, range, null)} sub={monthLabel(range.start)} />
      <Details sub="Month in numbers, sessions per week, body weight, photos">
        <ListCard title="Month in numbers" testid="month-numbers">
          <Row name="Sessions" sub={`target ${fmtNum(r.target, 1)}`} value={fmtNum(r.sessions)} />
          <Row name="Adherence" value={`${fmtNum(r.adherence_pct)}%`} />
          <Row name="Average session" value={r.avg_minutes != null ? `${fmtNum(r.avg_minutes)} min` : "–"} />
          <Row name="Average active kcal" value={r.avg_active_kcal != null ? fmtNum(r.avg_active_kcal) : "–"} />
        </ListCard>
        <Card title="Sessions per week" testid="month-weeks">
          <Columns cols={r.weeks.map((w) => ({ date: w.start, value: w.sessions }))} unit="sessions" fmt={(n) => fmtNum(n)} target={target} label={`Sessions per week in ${monthLabel(r.range.start)}`} />
        </Card>
        <Card title="Body weight" sub={r.unit} testid="month-body">
          {r.body.length ? (
            <TimeChart
              series={[
                {
                  label: "7-day average",
                  color: "--series-2",
                  points: r.body.map((b) => ({ date: b.date, value: b.ma7 })),
                },
                {
                  label: "Daily",
                  color: "--series-1",
                  dots: true,
                  points: r.body.map((b) => ({ date: b.date, value: b.value })),
                },
              ]}
              height={150}
              yAxis
              label={`Body weight in ${r.unit}, ${monthLabel(r.range.start)}: 7-day average and daily values`}
              unit={r.unit}
            />
          ) : (
            <p class="state l-m0">No body weight logged this month.</p>
          )}
        </Card>
        {r.photos.length
          ? r.photos.map((p) => (
              <Card title={`${poseLabel(p!.pose)}: first and last photo`}>
                <div class="l-grid-2 l-gap-8">
                  {[p!.first, p!.last].map((ph: Photo) => (
                    <figure class="photo-thumb l-m0">
                      <span class="photo-thumb__frame well">
                        <img src={photoSrc(ph, "full")} alt={`${poseLabel(ph.pose)}, ${dateLong(ph.local_date)}`} loading="lazy" />
                      </span>
                      <figcaption>{dateLong(ph.local_date)}</figcaption>
                    </figure>
                  ))}
                </div>
              </Card>
            ))
          : null}
      </Details>
      <Actions card={card} csvPath={`/reports/month?month=${key}&format=csv`} title="GYM time monthly report" />
    </>
  );
}

/* ---------------- All ---------------- */

function AllView() {
  const { data: r, error, offline, retry } = useReport<Progress>("/reports/progress");
  const ws = useStore((s) => s.boot!.settings.week_start);
  const [scope, setScope] = useState<"since" | "last4">("since");
  if (!r)
    return (
      <>
        <Pending error={error} what="your progress report" onRetry={retry} />
      </>
    );
  const since = r.since;
  const p = r[scope];
  const t = today();
  const card = () =>
    reportCard("Progress", scope === "since" ? `Since ${dateLong(p.from)}` : "Last 4 weeks", [
      ...p.lifts
        .filter((l) => l.first)
        .map((l) => ({
          label: l.name_en,
          value: `${l.first!.e1rm} → ${l.current!.e1rm} (${l.change_pct! > 0 ? "+" : ""}${l.change_pct}%)`,
        })),
      { label: "Sessions", value: `${p.sessions} · ${p.adherence_pct}%` },
      ...(p.body.change != null
        ? [
            {
              label: `Body weight (${r.unit})`,
              value: `${p.body.first!.value} → ${p.body.current!.value}`,
            },
          ]
        : []),
    ]);
  return (
    <>
      <Offline on={offline} />
      <PeriodTiles
        testid="all-stats"
        sessions={{ value: fmtNum(since.sessions), context: `since ${dateLong(since.from)}, ${fmtNum(since.adherence_pct)}% of the plan` }}
        records={since.records}
        muscles={r.balance.muscles}
        context={{ records: "record moments since the first session", target: "muscle groups on their weekly target this week" }}
      />
      <MainLifts period="all" end={t} />
      <Card title="Muscle balance this week" sub={`${dayMonth(r.balance.week.start)} – ${dayMonth(r.balance.week.end)}`} testid="balance">
        <span class="caption">
          Done sets per group vs the program target. Direct counts the primary muscle only; fractional adds 0.5 for each secondary muscle. The target is the program's planned sets, counted the same
          fractional way. Below 80% of the target (fractional) counts as under, above 120% as over. Forearms and neck, when the program trains them directly, compare direct sets with the program's
          direct sets.
        </span>
        <BalanceList muscles={r.balance.muscles} />
      </Card>
      <Consistency starts={calendarStarts("all", weekRange(t, ws).start, { start: since.from, end: t }, weekRange(since.from, ws).start)} sub={`Since ${dayMonth(since.from)}`} />
      <Details sub="Sessions, adherence, body weight, volume per week">
        <div class="segmented l-full" role="group" aria-label="Details period" data-testid="all-scope">
          {(
            [
              ["since", "Since the first session"],
              ["last4", "Last 4 weeks"],
            ] as const
          ).map(([k, label]) => (
            <button type="button" class="press l-grow" aria-pressed={scope === k} onClick={() => setScope(k)}>
              {label}
            </button>
          ))}
        </div>
        <ListCard title="In numbers" testid="progress-stats">
          <Row name="Sessions" sub={`since ${dayMonth(p.from)}`} value={fmtNum(p.sessions)} />
          <Row name="Adherence" value={`${fmtNum(p.adherence_pct)}%`} />
          <Row
            name={`Body weight (${r.unit})`}
            sub={p.body.first && p.body.current ? `${fmtNum(p.body.first.value, 1)} → ${fmtNum(p.body.current.value, 1)}` : undefined}
            value={p.body.change != null ? signed(p.body.change) : "–"}
          />
        </ListCard>
        <Card title="Total volume per week" sub={`${r.unit} × reps`} testid="progress-volume">
          <Columns cols={p.volume_weeks.slice(-26).map((w) => ({ date: w.start, value: w.volume }))} unit={`${r.unit} × reps`} fmt={kilo} label={`Total volume per week in ${r.unit} × reps`} />
        </Card>
      </Details>
      <Actions card={card} title="GYM time progress" />
    </>
  );
}

/* ---------------- screen ---------------- */

const PERIODS: [Period, string][] = [
  ["week", "Week"],
  ["month", "Month"],
  ["all", "All"],
];

/** The three tiles of a week (Profile → This week for the current one, Details for a past one). */
export function WeekTiles({ r }: { r: Week }) {
  return (
    <PeriodTiles
      testid="week-stats"
      sessions={{ value: `${fmtNum(r.sessions.done)}/${fmtNum(r.sessions.target)}` }}
      records={r.prs.length}
      muscles={r.muscles}
      context={{ records: "new records this week", target: "muscle groups on their weekly target this week" }}
    />
  );
}

/** Profile → This week: the current week's three tiles. */
export function ThisWeek() {
  const ws = useStore((s) => s.boot!.settings.week_start);
  const start = weekRange(today(), ws).start;
  const { data: r, error, retry } = useReport<Week>(`/reports/week?start=${start}`);
  if (!r || r.range.start !== start) return <Pending error={error} what="this week's numbers" onRetry={retry} />;
  return <WeekTiles r={r} />;
}

/** Profile → Details: closed by default; open, the period's report. */
export function ProfileDetails() {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<Period>("week");
  return (
    <>
      <section class="card card--list" aria-label="Details">
        <button type="button" class="list-row press" data-testid="profile-details" aria-expanded={open} aria-controls="profile-details-body" onClick={() => setOpen(!open)}>
          <span class="list-row__text">
            <span class="t-title">{open ? "Hide details" : "Details"}</span>
            <span class="caption">Week · Month · All: main lifts chart, sets vs target, consistency, records, body weight, volume, share and CSV</span>
          </span>
          <span class="list-row__chevron">
            <IconChevron size={16} />
          </span>
        </button>
      </section>
      {open ? (
        <div id="profile-details-body" class="l-col l-gap-12" data-testid="reports">
          <div
            class="segmented l-full"
            role="tablist"
            aria-label="Period"
            onKeyDown={(e) => {
              // Tabs pattern: the arrow keys move between periods; only the selected one is in the Tab order.
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const i = PERIODS.findIndex(([k]) => k === period);
              const next = PERIODS[(i + (e.key === "ArrowRight" ? 1 : PERIODS.length - 1)) % PERIODS.length][0];
              setPeriod(next);
              document.getElementById(`period-${next}`)?.focus();
            }}
          >
            {PERIODS.map(([k, label]) => (
              <button
                type="button"
                role="tab"
                id={`period-${k}`}
                aria-selected={period === k}
                aria-controls="period-panel"
                tabIndex={period === k ? 0 : -1}
                class="press l-grow"
                onClick={() => setPeriod(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <div id="period-panel" role="tabpanel" aria-labelledby={`period-${period}`} class="l-col l-gap-12">
            {period === "week" ? <WeekView /> : period === "month" ? <MonthView /> : <AllView />}
          </div>
        </div>
      ) : null}
    </>
  );
}

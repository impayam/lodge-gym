// Reports (SPEC §10, SPEC-v8 §6.03). On top, the main lifts' estimated 1RM over this week and the previous 4, computed
// by the app (Step 3: it was the training overview's table). Week / Month / All: the rest of the page follows the period
// (Payam, 2026-10-14) — the tiles, the estimated 1RM of the big three, sets vs target (Month: volume vs last month; All:
// muscle balance), the consistency calendar, then the after-session reports and the period's details. Last, the reports
// timeline: every AI report lives in this tab (Step 3). Report numbers are computed on the server; the last loaded copy
// is cached on the device for offline viewing. The 1RM table, the chart and the calendar read the sessions on the phone,
// the same way as the Train tab.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { liftTrends, mainLifts, monthKeyOf, monthRange, shiftMonth, trendWindow, type monthlyReport, type progressReport, type weeklyReport } from "../../../worker/lib/reports";
import { weekRange } from "../../../worker/lib/cycle";
import { addDays } from "../../../worker/lib/time";
import type { Photo } from "../../../worker/lib/types";
import { api, errorText } from "../api";
import { Bars } from "../components/Bars";
import { Columns } from "../components/Columns";
import { Empty, LoadError, Loading } from "../components/States";
import { MUSCLE_NAME, MuscleMap } from "../components/MuscleMap";
import { IconBack, IconChevron } from "../components/PulseIcons";
import { TimeChart, type ChartSeries, type Pick as ChartPick } from "../components/TimeChart";
import { dateLong, dayMonth, fmtNum, monthLabel } from "../format";
import { BIG_THREE } from "../lib/lifts";
import { e1rmPoints } from "../lib/records";
import { barScale, calendarStarts, calendarWeeks, changePct, chartFrom, chartWindow, signedPct, type Period } from "../lib/reportsView";
import * as ldb from "../localdb";
import { daysPerWeek } from "../model";
import { fetchFile, reportCard, shareOrDownload } from "../share";
import { getState, loadAllHistory, photoSrc, today, useStore } from "../store";
import { SessionReportsList } from "./Overview";
import { ReportsTimeline } from "./ReportsTimeline";
import { poseLabel } from "./Photos";

type Week = ReturnType<typeof weeklyReport>;
type Month = ReturnType<typeof monthlyReport>;
type Progress = ReturnType<typeof progressReport>;

/** Loads a report, caching it for offline use; `retry` loads it again after a failure. */
function useReport<T>(path: string): {
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
  }, [path, attempt]);
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

/** Three tiles (SPEC-v8 §6.03): sessions, bench and squat; the line under each number is short, as in the mockup, and
 *  screen readers hear what the change is measured against. */
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

/** The estimated 1RM of the big three over the period's window, three series in a fixed order. */
function E1rmCard({ period, end }: { period: Period; end: string }) {
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
  const window = chartWindow(period, first ? dayMonth(first) : dayMonth(end));
  return (
    <Card title="Estimated 1RM" sub={`${unit}, ${window}`} testid="e1rm-trend">
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
 * The main lifts' estimated 1RM over this week and the previous 4, computed by the app (no AI; Step 3): the best set
 * (Epley) of the latest session with each lift, and the change from the first session with it in these weeks.
 */
function MainLiftsCard() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const unit = boot.settings.unit;
  const w = trendWindow(today(), boot.settings.week_start);
  const names = new Map(boot.exercises.map((e) => [e.id, e.name_en]));
  const done = Object.values(sessions)
    .filter((s) => s.status === "done" && s.local_date >= w.start && s.local_date <= w.end)
    .sort((a, b) => (a.local_date + a.started_at).localeCompare(b.local_date + b.started_at));
  const lifts = liftTrends(done, mainLifts({ program: boot.program }), (id) => names.get(id) ?? id, unit);
  return (
    <Card title="Main lifts (estimated 1RM)" sub={`${dayMonth(w.start)} – ${dayMonth(w.end)}`} testid="main-lifts">
      {lifts.length ? (
        <>
          <table class="data-table num" data-testid="main-lifts-table">
            <thead>
              <tr>
                <th scope="col">Lift</th>
                <th scope="col">1RM ({unit})</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {lifts.map((l) => (
                <tr data-lift={l.exercise_id}>
                  <td>{l.name}</td>
                  <td>{l.latest_e1rm == null ? "–" : fmtNum(l.latest_e1rm, 1)}</td>
                  <td class={l.change_pct == null ? "" : l.change_pct > 0 ? "t-violet" : l.change_pct < 0 ? "t-orange" : ""}>{signed(l.change_pct, "%")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span class="caption">This week and the previous 4. Change: from the first session with the lift in these weeks to the latest.</span>
        </>
      ) : (
        <Empty>No main lift logged this week or in the previous 4.</Empty>
      )}
    </Card>
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

function WeekView({ reports }: { reports: ComponentChildren }) {
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
        {reports}
      </>
    );
  const lift = (id: string) => r.lifts.find((l) => l.exercise_id === id);
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
      <Tiles
        testid="week-stats"
        tiles={[
          {
            value: `${fmtNum(r.sessions.done)}/${fmtNum(r.sessions.target)}`,
            label: "Sessions",
          },
          {
            value: signedPct(lift("bench")?.change_pct ?? null),
            label: "Bench",
            context: "estimated 1RM vs last week",
          },
          {
            value: signedPct(lift("squat")?.change_pct ?? null),
            label: "Squat",
            context: "estimated 1RM vs last week",
          },
        ]}
      />
      <E1rmCard period="week" end={range.end} />
      <Card title="Sets this week vs target" sub="Chest first" testid="week-sets">
        <Bars
          testid="sets-bars"
          markWord="Target"
          fmt={(n) => fmtNum(n, 1)}
          rows={muscles.map((m) => ({
            key: m.muscle,
            label: MUSCLE_NAME[m.muscle],
            value: m.fractional,
            mark: m.target,
            direct: m.sets,
            status: m.status,
          }))}
        />
        <span class="caption">Fractional sets: the primary muscle counts 1 set, each secondary muscle 0.5.</span>
      </Card>
      <Consistency starts={calendarStarts("week", range.start, range, null)} sub="Last 5 weeks" />
      {reports}

      <ListCard title="Main lifts" testid="week-lifts">
        {r.lifts.map((l) =>
          l.best ? (
            <Row name={l.name_en} sub={`vs last week: ${signed(l.change_pct, "%")}`} value={`${setText(l.best)} · 1RM ${fmtNum(l.best.e1rm, 1)}`} />
          ) : (
            <Row name={l.name_en} sub="Not logged this week" value="–" />
          )
        )}
      </ListCard>
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
      <Actions card={card} csvPath={`/reports/week?start=${r.range.start}&format=csv`} title="GYM time weekly report" />
    </>
  );
}

/* ---------------- Month ---------------- */

function LiftMultiple({ name, unit, points }: { name: string; unit: string; points: { date: string; value: number }[] }) {
  const [pick, setPick] = useState<ChartPick | null>(null);
  const shown =
    pick?.values[0] != null
      ? pick
      : points.length
        ? {
            date: points[points.length - 1].date,
            values: [points[points.length - 1].value],
          }
        : null;
  return (
    <section class="card l-col l-gap-8">
      <div class="card__head l-gap-8">
        <h3 class="card__title l-m0">{name}</h3>
        {shown ? (
          <span class="caption num" aria-live="polite">
            {fmtNum(shown.values[0]!, 1)} {unit} · {dayMonth(shown.date)}
          </span>
        ) : null}
      </div>
      {points.length ? (
        <TimeChart series={[{ label: name, color: "--series-2", points }]} height={110} label={`${name}, estimated 1RM this month`} unit={unit} pickLast onPick={setPick} />
      ) : (
        <p class="state l-m0">Not logged this month.</p>
      )}
    </section>
  );
}

function MonthView({ reports }: { reports: ComponentChildren }) {
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
        {reports}
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
  const monthChange = (id: string) => {
    const pts = r.e1rm.find((l) => l.exercise_id === id)?.points ?? [];
    return pts.length >= 2 ? changePct(pts[0].e1rm, pts[pts.length - 1].e1rm) : null;
  };
  const volume = r.volume.filter((v) => v.current > 0 || v.previous > 0).sort((a, b) => (a.muscle === "chest" ? -1 : b.muscle === "chest" ? 1 : 0));
  return (
    <>
      {nav}
      <Offline on={offline} />
      <Tiles
        testid="month-stats"
        tiles={[
          {
            value: `${fmtNum(r.sessions)}/${fmtNum(Math.round(r.target))}`,
            label: "Sessions",
          },
          {
            value: signedPct(monthChange("bench")),
            label: "Bench",
            context: "estimated 1RM, first to last session this month",
          },
          {
            value: signedPct(monthChange("squat")),
            label: "Squat",
            context: "estimated 1RM, first to last session this month",
          },
        ]}
      />
      <E1rmCard period="month" end={range.end} />
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
      {reports}

      <ListCard title="Month in numbers" testid="month-numbers">
        <Row name="Sessions" sub={`target ${fmtNum(r.target, 1)}`} value={fmtNum(r.sessions)} />
        <Row name="Adherence" value={`${fmtNum(r.adherence_pct)}%`} />
        <Row name="Average session" value={r.avg_minutes != null ? `${fmtNum(r.avg_minutes)} min` : "–"} />
        <Row name="Average active kcal" value={r.avg_active_kcal != null ? fmtNum(r.avg_active_kcal) : "–"} />
      </ListCard>
      <Card title="Sessions per week" testid="month-weeks">
        <Columns cols={r.weeks.map((w) => ({ date: w.start, value: w.sessions }))} unit="sessions" fmt={(n) => fmtNum(n)} target={target} label={`Sessions per week in ${monthLabel(r.range.start)}`} />
      </Card>
      <h2 class="card__title l-m0">Estimated 1RM this month</h2>
      {r.e1rm.map((l) => (
        <LiftMultiple name={l.name_en} unit={r.unit} points={l.points.map((p) => ({ date: p.date, value: p.e1rm }))} />
      ))}
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
      <Actions card={card} csvPath={`/reports/month?month=${key}&format=csv`} title="GYM time monthly report" />
    </>
  );
}

/* ---------------- All ---------------- */

function AllView({ reports }: { reports: ComponentChildren }) {
  const { data: r, error, offline, retry } = useReport<Progress>("/reports/progress");
  const ws = useStore((s) => s.boot!.settings.week_start);
  const [scope, setScope] = useState<"since" | "last4">("since");
  if (!r)
    return (
      <>
        <Pending error={error} what="your progress report" onRetry={retry} />
        {reports}
      </>
    );
  const since = r.since;
  const p = r[scope];
  const t = today();
  const lift = (id: string) => since.lifts.find((l) => l.exercise_id === id);
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
      <Tiles
        testid="all-stats"
        tiles={[
          {
            value: fmtNum(since.sessions),
            label: "Sessions",
            context: `since ${dateLong(since.from)}, ${fmtNum(since.adherence_pct)}% of the plan`,
          },
          {
            value: signedPct(lift("bench")?.change_pct ?? null),
            label: "Bench",
            context: "estimated 1RM since the first session",
          },
          {
            value: signedPct(lift("squat")?.change_pct ?? null),
            label: "Squat",
            context: "estimated 1RM since the first session",
          },
        ]}
      />
      <E1rmCard period="all" end={t} />
      <Card title="Muscle balance this week" sub={`${dayMonth(r.balance.week.start)} – ${dayMonth(r.balance.week.end)}`} testid="balance">
        <span class="caption">
          Done sets per group vs the program target. Direct counts the primary muscle only; fractional adds 0.5 for each secondary muscle. The target is the program's planned sets, counted the same
          fractional way. Below 80% of the target (fractional) counts as under, above 120% as over.
        </span>
        <MuscleMap muscles={r.balance.muscles} />
      </Card>
      <Consistency starts={calendarStarts("all", weekRange(t, ws).start, { start: since.from, end: t }, weekRange(since.from, ws).start)} sub={`Since ${dayMonth(since.from)}`} />
      {reports}

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
      <ListCard title="Main lifts: first vs now" testid="progress-lifts">
        {p.lifts.map((l) =>
          !l.first ? (
            <Row name={l.name_en} sub="Not logged" value="–" />
          ) : (
            <Row
              name={l.name_en}
              sub={`${l.first ? `${setText(l.first)} (${dayMonth(l.first.date)})` : "–"} → ${l.current ? `${setText(l.current)} (${dayMonth(l.current.date)})` : "–"}`}
              value={
                <>
                  1RM {l.first ? fmtNum(l.first.e1rm, 1) : "–"} → {l.current ? fmtNum(l.current.e1rm, 1) : "–"}
                  <br />
                  <b>{signed(l.change_pct, "%")}</b>
                </>
              }
            />
          )
        )}
      </ListCard>
      <Card title="Total volume per week" sub={`${r.unit} × reps`} testid="progress-volume">
        <Columns cols={p.volume_weeks.slice(-26).map((w) => ({ date: w.start, value: w.volume }))} unit={`${r.unit} × reps`} fmt={kilo} label={`Total volume per week in ${r.unit} × reps`} />
      </Card>
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

export function Reports() {
  const [period, setPeriod] = useState<Period>("week");
  const reports = <SessionReportsList />;
  return (
    <main class="page" data-testid="reports">
      <header class="page-head">
        <h1 class="h-page">Reports</h1>
        <div
          class="segmented"
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
              class="press"
              onClick={() => setPeriod(k)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <MainLiftsCard />
      <div id="period-panel" role="tabpanel" aria-labelledby={`period-${period}`} class="l-col l-gap-12">
        {period === "week" ? <WeekView reports={reports} /> : period === "month" ? <MonthView reports={reports} /> : <AllView reports={reports} />}
      </div>
      <ReportsTimeline />
    </main>
  );
}

// Reports (SPEC §10) and the Progress page. Computed on the server; the last loaded report is cached
// on the device for offline viewing.

import { useEffect, useState } from "preact/hooks";
import { monthKeyOf, shiftMonth, type monthlyReport, type progressReport, type weeklyReport } from "../../../worker/lib/reports";
import { addDays } from "../../../worker/lib/time";
import { weekRange } from "../../../worker/lib/cycle";
import type { Photo } from "../../../worker/lib/types";
import { api, errorText } from "../api";
import { Columns, LineChart, Stat, TargetBars } from "../components/Charts";
import { MUSCLE_NAME, MuscleMap } from "../components/MuscleMap";
import { dateLong, dayMonth, fmtNum, monthLabel } from "../format";
import * as ldb from "../localdb";
import { fetchFile, reportCard, shareOrDownload } from "../share";
import { photoSrc, today, useStore } from "../store";
import { poseLabel } from "./Photos";
import { WeeklyReviewCard } from "./Review";

type Week = ReturnType<typeof weeklyReport>;
type Month = ReturnType<typeof monthlyReport>;
type Progress = ReturnType<typeof progressReport>;

/** Loads a report, caching it for offline use. */
function useReport<T>(path: string): { data: T | null; err: string; offline: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let alive = true;
    setErr("");
    void (async () => {
      const cached = await ldb.kvGet<T>(`report:${path}`);
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
        else setErr(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [path]);
  return { data, err, offline };
}

const signed = (n: number | null, suffix = "") => (n == null ? "–" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(n), 1)}${suffix}`);
const setText = (s: { weight: number; reps: number } | null) => (s ? `${fmtNum(s.weight, 1)}×${fmtNum(s.reps)}` : "–");

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
    <div class="stack" style={{ marginTop: "14px" }}>
      <div class="row">
        <button type="button" class="btn btn-ghost" data-testid="share-png" onClick={() => void run(async () => ({ blob: await card(), filename: "lodge-gym-report.png" }))}>
          Share image
        </button>
        {csvPath ? (
          <button type="button" class="btn btn-ghost" data-testid="export-csv" onClick={() => void run(() => fetchFile(csvPath))}>
            Export CSV
          </button>
        ) : null}
      </div>
      {msg ? <div class="why">{msg}</div> : null}
    </div>
  );
}

function WeekView() {
  const [anchor, setAnchor] = useState(today());
  const ws = useStore((s) => s.boot!.settings.week_start);
  const range = weekRange(anchor, ws);
  const { data: r, err, offline } = useReport<Week>(`/reports/week?start=${range.start}`);
  const nav = (
    <div class="kv navrow">
      <button type="button" class="linkbtn" onClick={() => setAnchor(addDays(range.start, -7))}>
        ← Previous week
      </button>
      <b>
        {dayMonth(range.start)} – {dayMonth(range.end)}
      </b>
      <button type="button" class="linkbtn" disabled={range.end >= today()} onClick={() => setAnchor(addDays(range.start, 7))}>
        Next week →
      </button>
    </div>
  );
  if (!r || r.range.start !== range.start) return <>{nav}{err ? <div class="banner">{err}</div> : <div class="empty">Loading…</div>}</>;
  const card = () =>
    reportCard("Weekly report", `${dateLong(r.range.start)} – ${dateLong(r.range.end)}`, [
      { label: "Sessions", value: `${r.sessions.done} of ${r.sessions.target}` },
      { label: "Training time", value: `${r.sessions.total_minutes} min` },
      ...r.lifts.filter((l) => l.best).map((l) => ({ label: l.name_en, value: `${l.best!.weight}×${l.best!.reps} · 1RM ${l.best!.e1rm}` })),
      ...(r.watch.active_kcal != null ? [{ label: "Active kcal", value: `${Math.round(r.watch.active_kcal)}` }] : []),
      ...(r.body.avg != null ? [{ label: `Body weight (${r.unit})`, value: `${r.body.avg}${r.body.change != null ? ` (${r.body.change > 0 ? "+" : ""}${r.body.change})` : ""}` }] : []),
    ]);
  return (
    <>
      {nav}
      {offline ? <div class="banner">Offline: showing the last saved copy.</div> : null}
      <div class="stats" data-testid="week-stats">
        <Stat value={`${fmtNum(r.sessions.done)} of ${fmtNum(r.sessions.target)}`} label="sessions" />
        <Stat value={fmtNum(r.sessions.total_minutes)} label="min trained" />
        <Stat value={r.watch.active_kcal != null ? fmtNum(Math.round(r.watch.active_kcal)) : "–"} label="active kcal" />
      </div>
      {r.sessions.days.length ? (
        <div class="chips">
          {r.sessions.days.map((d) => (
            <span class="chip">
              {d.name_en} · {dayMonth(d.date)}
            </span>
          ))}
        </div>
      ) : null}

      <h2>Sets vs program target</h2>
      <p class="why" style={{ marginTop: 0 }}>Fractional sets: the primary muscle counts 1 set, each secondary muscle 0.5.</p>
      <div class="card">
        <TargetBars
          rows={r.muscles.filter((m) => m.target !== null).map((m) => ({ label: MUSCLE_NAME[m.muscle], value: m.fractional, direct: m.sets, target: m.target! }))}
          unitLabel="fractional sets"
          fmt={(n) => fmtNum(n, 1)}
        />
      </div>

      <h2>Main lifts</h2>
      <div class="card stack" data-testid="week-lifts">
        {r.lifts.map((l) => (
          <div class="kv">
            <span>{l.name_en}</span>
            <span class="num" style={{ textAlign: "right" }}>
              {setText(l.best)} · 1RM {l.best ? fmtNum(l.best.e1rm, 1) : "–"}
              <br />
              <small class="muted">vs last week: {signed(l.change_pct, "%")}</small>
            </span>
          </div>
        ))}
      </div>

      {r.prs.length ? (
        <>
          <h2>New records</h2>
          <div class="card stack" data-testid="week-prs">
            {r.prs.map((p) => (
              <div class="kv">
                <span>🏆 {p.name_en}</span>
                <span class="num">
                  {setText(p)} · 1RM {fmtNum(p.e1rm, 1)} (was {fmtNum(p.previous_e1rm, 1)})
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <h2>Apple Watch and body</h2>
      <div class="card stack">
        <div class="kv">
          <span>Average heart rate in sessions</span>
          <span class="num">{r.watch.hr_avg != null ? fmtNum(Math.round(r.watch.hr_avg)) : "–"}</span>
        </div>
        <div class="kv">
          <span>Sessions with / without watch data</span>
          <span class="num">
            {fmtNum(r.watch.matched)} / {fmtNum(r.watch.unmatched)}
          </span>
        </div>
        <div class="kv">
          <span>Average body weight ({r.unit})</span>
          <span class="num">
            {r.body.avg != null ? fmtNum(r.body.avg, 1) : "–"} {r.body.change != null ? `(${signed(r.body.change)} vs last week)` : ""}
          </span>
        </div>
      </div>

      {r.notes.length ? (
        <>
          <h2>Notes</h2>
          <div class="card stack">
            {r.notes.map((n) => (
              <div>
                <small class="muted">
                  {n.name_en} · {dayMonth(n.date)}
                </small>
                <div>{n.note}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <Actions card={card} csvPath={`/reports/week?start=${r.range.start}&format=csv`} title="Lodge Gym weekly report" />
    </>
  );
}

function MonthView() {
  const [key, setKey] = useState(monthKeyOf(today()));
  const { data: r, err, offline } = useReport<Month>(`/reports/month?month=${key}`);
  const current = monthKeyOf(today());
  const nav = (
    <div class="kv navrow">
      <button type="button" class="linkbtn" onClick={() => setKey(shiftMonth(key, -1))}>
        ← Previous month
      </button>
      <b>{monthLabel(`${key}-01`)}</b>
      <button type="button" class="linkbtn" disabled={key >= current} onClick={() => setKey(shiftMonth(key, 1))}>
        Next month →
      </button>
    </div>
  );
  if (!r || r.range.key !== key) return <>{nav}{err ? <div class="banner">{err}</div> : <div class="empty">Loading…</div>}</>;
  const card = () =>
    reportCard("Monthly report", monthLabel(r.range.start), [
      { label: "Sessions", value: `${r.sessions}` },
      { label: "Adherence", value: `${r.adherence_pct}%` },
      ...(r.avg_minutes != null ? [{ label: "Average session", value: `${r.avg_minutes} min` }] : []),
      ...r.e1rm.filter((l) => l.points.length).map((l) => ({ label: `1RM ${l.name_en}`, value: `${l.points[l.points.length - 1].e1rm}` })),
      ...(r.body.length ? [{ label: `Body weight (${r.unit})`, value: `${r.body[r.body.length - 1].ma7}` }] : []),
    ]);
  return (
    <>
      {nav}
      {offline ? <div class="banner">Offline: showing the last saved copy.</div> : null}
      <div class="stats" data-testid="month-stats">
        <Stat value={fmtNum(r.sessions)} label="sessions" sub={`target ${fmtNum(r.target, 1)}`} />
        <Stat value={`${fmtNum(r.adherence_pct)}%`} label="adherence" />
        <Stat value={r.avg_minutes != null ? fmtNum(r.avg_minutes) : "–"} label="avg minutes" sub={r.avg_active_kcal != null ? `${fmtNum(r.avg_active_kcal)} kcal` : undefined} />
      </div>

      <h2>Sessions per week</h2>
      <div class="card">
        <Columns cols={r.weeks.map((w) => ({ label: dayMonth(w.start), value: w.sessions }))} target={4} valueLabel="sessions" />
      </div>

      <h2>Estimated 1RM trend</h2>
      <div class="multiples">
        {r.e1rm.map((l) => (
          <div class="card">
            <b class="mtitle">{l.name_en}</b>
            <LineChart points={l.points.map((p) => ({ x: p.date, y: p.e1rm, label: dayMonth(p.date) }))} valueLabel={r.unit} height={110} />
          </div>
        ))}
      </div>

      <h2>Volume per muscle group ({r.unit} × reps)</h2>
      <div class="card">
        <TargetBars
          rows={r.volume.map((v) => ({ label: MUSCLE_NAME[v.muscle], value: v.current, compare: v.previous }))}
          unitLabel={r.unit}
          legend={["This month", "Last month"]}
          fmt={(n) => fmtNum(Math.round(n))}
        />
      </div>

      <h2>Body weight</h2>
      <div class="card">
        <LineChart
          points={r.body.map((b) => ({ x: b.date, y: b.ma7, label: dayMonth(b.date) }))}
          dots={r.body.map((b) => ({ x: b.date, y: b.value, label: dayMonth(b.date) }))}
          valueLabel={r.unit}
          legend={["7-day average", "Daily"]}
        />
      </div>

      {r.photos.length ? (
        <>
          <h2>First and last photo of the month</h2>
          {r.photos.map((p) => (
            <div class="card stack">
              <b>{poseLabel(p!.pose)}</b>
              <div class="cmp">
                {[p!.first, p!.last].map((ph: Photo) => (
                  <figure>
                    <img src={photoSrc(ph, "full")} alt={`${poseLabel(ph.pose)}, ${dateLong(ph.local_date)}`} loading="lazy" />
                    <figcaption>{dateLong(ph.local_date)}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ))}
        </>
      ) : null}
      <Actions card={card} csvPath={`/reports/month?month=${key}&format=csv`} title="Lodge Gym monthly report" />
    </>
  );
}

function ProgressView() {
  const { data: r, err, offline } = useReport<Progress>("/reports/progress");
  const [scope, setScope] = useState<"since" | "last4">("since");
  if (!r) return err ? <div class="banner">{err}</div> : <div class="empty">Loading…</div>;
  const p = r[scope];
  const card = () =>
    reportCard("Progress", scope === "since" ? `Since ${dateLong(p.from)}` : "Last 4 weeks", [
      ...p.lifts.filter((l) => l.first).map((l) => ({ label: l.name_en, value: `${l.first!.e1rm} → ${l.current!.e1rm} (${l.change_pct! > 0 ? "+" : ""}${l.change_pct}%)` })),
      { label: "Sessions", value: `${p.sessions} · ${p.adherence_pct}%` },
      ...(p.body.change != null ? [{ label: `Body weight (${r.unit})`, value: `${p.body.first!.value} → ${p.body.current!.value}` }] : []),
    ]);
  return (
    <>
      {offline ? <div class="banner">Offline: showing the last saved copy.</div> : null}
      <div class="seg" role="group" aria-label="Period" style={{ marginBottom: "10px" }}>
        <button type="button" aria-pressed={scope === "since"} onClick={() => setScope("since")}>
          Since the first session
        </button>
        <button type="button" aria-pressed={scope === "last4"} onClick={() => setScope("last4")}>
          Last 4 weeks
        </button>
      </div>
      <div class="stats" data-testid="progress-stats">
        <Stat value={fmtNum(p.sessions)} label="sessions" sub={`since ${dayMonth(p.from)}`} />
        <Stat value={`${fmtNum(p.adherence_pct)}%`} label="adherence" />
        <Stat
          value={p.body.change != null ? signed(p.body.change) : "–"}
          label={`body weight (${r.unit})`}
          sub={p.body.first && p.body.current ? `${fmtNum(p.body.first.value, 1)} → ${fmtNum(p.body.current.value, 1)}` : undefined}
        />
      </div>

      <h2>Main lifts: first vs now</h2>
      <div class="card stack" data-testid="progress-lifts">
        {p.lifts.map((l) => (
          <div class="kv">
            <span>
              {l.name_en}
              <br />
              <small class="muted">
                {l.first ? `${setText(l.first)} (${dayMonth(l.first.date)})` : "–"} → {l.current ? `${setText(l.current)} (${dayMonth(l.current.date)})` : "–"}
              </small>
            </span>
            <span class="num" style={{ textAlign: "right" }}>
              1RM {l.first ? fmtNum(l.first.e1rm, 1) : "–"} → {l.current ? fmtNum(l.current.e1rm, 1) : "–"}
              <br />
              <b>{signed(l.change_pct, "%")}</b>
            </span>
          </div>
        ))}
      </div>

      <h2>Total volume per week</h2>
      <div class="card">
        <Columns cols={p.volume_weeks.slice(-26).map((w) => ({ label: dayMonth(w.start), value: w.volume }))} valueLabel={`${r.unit} × reps`} fmt={(n) => fmtNum(Math.round(n))} />
      </div>

      <h2>Muscle balance this week</h2>
      <div class="card">
        <p class="why" style={{ marginTop: 0 }}>
          Done sets per group vs the program target, {dayMonth(r.balance.week.start)} – {dayMonth(r.balance.week.end)}. Direct counts the primary muscle only; fractional adds 0.5 for each secondary muscle. The target is the program's planned sets, counted the same fractional way. Below 80% of the target (fractional) counts as under, above 120% as over.
        </p>
        <MuscleMap muscles={r.balance.muscles} />
      </div>
      <Actions card={card} title="Lodge Gym progress" />
    </>
  );
}

export function Reports() {
  const [tab, setTab] = useState<"week" | "month" | "progress">("week");
  return (
    <>
      <WeeklyReviewCard />
      <div class="seg wide" role="tablist" aria-label="Reports" style={{ margin: "14px 0 6px" }}>
        {(
          [
            ["week", "Weekly"],
            ["month", "Monthly"],
            ["progress", "Progress"],
          ] as const
        ).map(([k, label]) => (
          <button type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "week" ? <WeekView /> : tab === "month" ? <MonthView /> : <ProgressView />}
    </>
  );
}

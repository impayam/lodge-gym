// Reports (SPEC §10) and the «پیشرفت» page. Computed on the server; the last loaded report is cached
// on the device for offline viewing.

import { useEffect, useState } from "preact/hooks";
import { faNum } from "../../../worker/lib/digits";
import { monthKeyOf, shiftMonth, type monthlyReport, type progressReport, type weeklyReport } from "../../../worker/lib/reports";
import { addDays } from "../../../worker/lib/time";
import { weekRange } from "../../../worker/lib/cycle";
import type { Photo } from "../../../worker/lib/types";
import { api, errorText } from "../api";
import { Columns, LineChart, Stat, TargetBars } from "../components/Charts";
import { MUSCLE_FA, MuscleMap } from "../components/MuscleMap";
import { greg, jalali, jalaliShort, monthLabel } from "../format";
import * as ldb from "../localdb";
import { fetchFile, reportCard, shareOrDownload } from "../share";
import { photoSrc, today, useStore } from "../store";
import { poseFa } from "./Photos";
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

const signed = (n: number | null, suffix = "") => (n == null ? "–" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${faNum(Math.abs(n), 1)}${suffix}`);
const setText = (s: { weight: number; reps: number } | null) => (s ? `${faNum(s.weight, 1)}×${faNum(s.reps)}` : "–");

function Actions({ card, csvPath, title }: { card: () => Promise<Blob>; csvPath?: string; title: string }) {
  const [msg, setMsg] = useState("");
  const run = async (f: () => Promise<{ blob: Blob; filename: string }>) => {
    setMsg("");
    try {
      const { blob, filename } = await f();
      const r = await shareOrDownload(blob, filename, title);
      setMsg(r === "downloaded" ? "فایل دانلود شد." : "");
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <div class="stack" style={{ marginTop: "14px" }}>
      <div class="row">
        <button type="button" class="btn btn-ghost" data-testid="share-png" onClick={() => void run(async () => ({ blob: await card(), filename: "lodge-gym-report.png" }))}>
          اشتراک تصویر
        </button>
        {csvPath ? (
          <button type="button" class="btn btn-ghost" data-testid="export-csv" onClick={() => void run(() => fetchFile(csvPath))}>
            خروجی CSV
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
        → هفته‌ی قبل
      </button>
      <b>
        {jalaliShort(range.start)} تا {jalaliShort(range.end)}
      </b>
      <button type="button" class="linkbtn" disabled={range.end >= today()} onClick={() => setAnchor(addDays(range.start, 7))}>
        هفته‌ی بعد ←
      </button>
    </div>
  );
  if (!r || r.range.start !== range.start) return <>{nav}{err ? <div class="banner">{err}</div> : <div class="empty">در حال بارگذاری…</div>}</>;
  const card = () =>
    reportCard("گزارش هفتگی", `${jalali(r.range.start)} تا ${jalali(r.range.end)}`, [
      { label: "جلسه‌ها", value: `${r.sessions.done} از ${r.sessions.target}` },
      { label: "زمان تمرین", value: `${r.sessions.total_minutes} دقیقه` },
      ...r.lifts.filter((l) => l.best).map((l) => ({ label: l.name_fa, value: `${l.best!.weight}×${l.best!.reps} · 1RM ${l.best!.e1rm}` })),
      ...(r.watch.active_kcal != null ? [{ label: "کالری فعال", value: `${Math.round(r.watch.active_kcal)}` }] : []),
      ...(r.body.avg != null ? [{ label: `وزن بدن (${r.unit})`, value: `${r.body.avg}${r.body.change != null ? ` (${r.body.change > 0 ? "+" : ""}${r.body.change})` : ""}` }] : []),
    ]);
  return (
    <>
      {nav}
      {offline ? <div class="banner">آفلاین؛ آخرین نسخه‌ی ذخیره‌شده نمایش داده می‌شود.</div> : null}
      <div class="stats" data-testid="week-stats">
        <Stat value={`${faNum(r.sessions.done)} از ${faNum(r.sessions.target)}`} label="جلسه" />
        <Stat value={faNum(r.sessions.total_minutes)} label="دقیقه تمرین" />
        <Stat value={r.watch.active_kcal != null ? faNum(Math.round(r.watch.active_kcal)) : "–"} label="کالری فعال" />
      </div>
      {r.sessions.days.length ? (
        <div class="chips">
          {r.sessions.days.map((d) => (
            <span class="chip">
              {d.name_fa} · {jalaliShort(d.date)}
            </span>
          ))}
        </div>
      ) : null}

      <h2>ست‌ها در برابر هدف برنامه</h2>
      <div class="card">
        <TargetBars rows={r.muscles.map((m) => ({ label: MUSCLE_FA[m.muscle], value: m.sets, target: m.target }))} unitLabel="ست" />
      </div>

      <h2>حرکت‌های اصلی</h2>
      <div class="card stack" data-testid="week-lifts">
        {r.lifts.map((l) => (
          <div class="kv">
            <span>
              {l.name_fa}
              <br />
              <small class="muted ltr">{l.name_en}</small>
            </span>
            <span class="num" style={{ textAlign: "left" }}>
              {setText(l.best)} · 1RM {l.best ? faNum(l.best.e1rm, 1) : "–"}
              <br />
              <small class="muted">نسبت به هفته‌ی قبل: {signed(l.change_pct, "٪")}</small>
            </span>
          </div>
        ))}
      </div>

      {r.prs.length ? (
        <>
          <h2>رکوردهای تازه</h2>
          <div class="card stack" data-testid="week-prs">
            {r.prs.map((p) => (
              <div class="kv">
                <span>🏆 {p.name_fa}</span>
                <span class="num">
                  {setText(p)} · 1RM {faNum(p.e1rm, 1)} (قبلی {faNum(p.previous_e1rm, 1)})
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <h2>Apple Watch و بدن</h2>
      <div class="card stack">
        <div class="kv">
          <span>میانگین ضربان در جلسه‌ها</span>
          <span class="num">{r.watch.hr_avg != null ? faNum(Math.round(r.watch.hr_avg)) : "–"}</span>
        </div>
        <div class="kv">
          <span>جلسه با داده‌ی ساعت / بدون داده</span>
          <span class="num">
            {faNum(r.watch.matched)} / {faNum(r.watch.unmatched)}
          </span>
        </div>
        <div class="kv">
          <span>میانگین وزن بدن ({r.unit})</span>
          <span class="num">
            {r.body.avg != null ? faNum(r.body.avg, 1) : "–"} {r.body.change != null ? `(${signed(r.body.change)} نسبت به هفته‌ی قبل)` : ""}
          </span>
        </div>
      </div>

      {r.notes.length ? (
        <>
          <h2>یادداشت‌ها</h2>
          <div class="card stack">
            {r.notes.map((n) => (
              <div>
                <small class="muted">
                  {n.name_fa} · {jalaliShort(n.date)}
                </small>
                <div>{n.note}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <Actions card={card} csvPath={`/reports/week?start=${r.range.start}&format=csv`} title="گزارش هفتگی Lodge Gym" />
    </>
  );
}

function MonthView() {
  const cal = useStore((s) => s.boot!.settings.month_calendar);
  const [key, setKey] = useState(monthKeyOf(today(), cal));
  useEffect(() => setKey(monthKeyOf(today(), cal)), [cal]);
  const { data: r, err, offline } = useReport<Month>(`/reports/month?month=${key}`);
  const current = monthKeyOf(today(), cal);
  const nav = (
    <div class="kv navrow">
      <button type="button" class="linkbtn" onClick={() => setKey(shiftMonth(key, -1))}>
        → ماه قبل
      </button>
      <b>{r && r.range.key === key ? monthLabel(r.range.start, cal) : key}</b>
      <button type="button" class="linkbtn" disabled={key >= current} onClick={() => setKey(shiftMonth(key, 1))}>
        ماه بعد ←
      </button>
    </div>
  );
  if (!r || r.range.key !== key) return <>{nav}{err ? <div class="banner">{err}</div> : <div class="empty">در حال بارگذاری…</div>}</>;
  const card = () =>
    reportCard("گزارش ماهانه", monthLabel(r.range.start, cal), [
      { label: "جلسه‌ها", value: `${r.sessions}` },
      { label: "پایبندی", value: `${r.adherence_pct}٪` },
      ...(r.avg_minutes != null ? [{ label: "میانگین مدت جلسه", value: `${r.avg_minutes} دقیقه` }] : []),
      ...r.e1rm.filter((l) => l.points.length).map((l) => ({ label: `1RM ${l.name_fa}`, value: `${l.points[l.points.length - 1].e1rm}` })),
      ...(r.body.length ? [{ label: `وزن بدن (${r.unit})`, value: `${r.body[r.body.length - 1].ma7}` }] : []),
    ]);
  return (
    <>
      {nav}
      {offline ? <div class="banner">آفلاین؛ آخرین نسخه‌ی ذخیره‌شده نمایش داده می‌شود.</div> : null}
      <div class="stats" data-testid="month-stats">
        <Stat value={faNum(r.sessions)} label="جلسه" sub={`هدف ${faNum(r.target, 1)}`} />
        <Stat value={`${faNum(r.adherence_pct)}٪`} label="پایبندی" />
        <Stat value={r.avg_minutes != null ? faNum(r.avg_minutes) : "–"} label="میانگین دقیقه" sub={r.avg_active_kcal != null ? `${faNum(r.avg_active_kcal)} کالری` : undefined} />
      </div>

      <h2>جلسه در هر هفته</h2>
      <div class="card">
        <Columns cols={r.weeks.map((w) => ({ label: jalaliShort(w.start), value: w.sessions }))} target={4} valueLabel="جلسه" />
      </div>

      <h2>روند 1RM تخمینی</h2>
      <div class="multiples">
        {r.e1rm.map((l) => (
          <div class="card">
            <b class="mtitle">{l.name_fa}</b>
            <LineChart points={l.points.map((p) => ({ x: p.date, y: p.e1rm, label: jalaliShort(p.date) }))} valueLabel={r.unit} height={110} />
          </div>
        ))}
      </div>

      <h2>حجم تمرین هر گروه ({r.unit} × تکرار)</h2>
      <div class="card">
        <TargetBars
          rows={r.volume.map((v) => ({ label: MUSCLE_FA[v.muscle], value: v.current, compare: v.previous }))}
          unitLabel={r.unit}
          legend={["این ماه", "ماه قبل"]}
          fmt={(n) => faNum(Math.round(n))}
        />
      </div>

      <h2>وزن بدن</h2>
      <div class="card">
        <LineChart
          points={r.body.map((b) => ({ x: b.date, y: b.ma7, label: jalaliShort(b.date) }))}
          dots={r.body.map((b) => ({ x: b.date, y: b.value, label: jalaliShort(b.date) }))}
          valueLabel={r.unit}
          legend={["میانگین ۷ روزه", "روزانه"]}
        />
      </div>

      {r.photos.length ? (
        <>
          <h2>اولین و آخرین عکس ماه</h2>
          {r.photos.map((p) => (
            <div class="card stack">
              <b>{poseFa(p!.pose)}</b>
              <div class="cmp">
                {[p!.first, p!.last].map((ph: Photo) => (
                  <figure>
                    <img src={photoSrc(ph, "full")} alt={`${poseFa(ph.pose)} ${jalali(ph.local_date)}`} loading="lazy" />
                    <figcaption>
                      {jalali(ph.local_date)} · <span class="ltr">{greg(ph.local_date)}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ))}
        </>
      ) : null}
      <Actions card={card} csvPath={`/reports/month?month=${key}&format=csv`} title="گزارش ماهانه Lodge Gym" />
    </>
  );
}

function ProgressView() {
  const { data: r, err, offline } = useReport<Progress>("/reports/progress");
  const [scope, setScope] = useState<"since" | "last4">("since");
  if (!r) return err ? <div class="banner">{err}</div> : <div class="empty">در حال بارگذاری…</div>;
  const p = r[scope];
  const card = () =>
    reportCard("پیشرفت", scope === "since" ? `از ${jalali(p.from)}` : "۴ هفته‌ی اخیر", [
      ...p.lifts.filter((l) => l.first).map((l) => ({ label: l.name_fa, value: `${l.first!.e1rm} → ${l.current!.e1rm} (${l.change_pct! > 0 ? "+" : ""}${l.change_pct}%)` })),
      { label: "جلسه‌ها", value: `${p.sessions} · ${p.adherence_pct}%` },
      ...(p.body.change != null ? [{ label: `وزن بدن (${r.unit})`, value: `${p.body.first!.value} → ${p.body.current!.value}` }] : []),
    ]);
  return (
    <>
      {offline ? <div class="banner">آفلاین؛ آخرین نسخه‌ی ذخیره‌شده نمایش داده می‌شود.</div> : null}
      <div class="seg" role="group" aria-label="بازه" style={{ marginBottom: "10px" }}>
        <button type="button" aria-pressed={scope === "since"} onClick={() => setScope("since")}>
          از اولین جلسه
        </button>
        <button type="button" aria-pressed={scope === "last4"} onClick={() => setScope("last4")}>
          ۴ هفته‌ی اخیر
        </button>
      </div>
      <div class="stats" data-testid="progress-stats">
        <Stat value={faNum(p.sessions)} label="جلسه" sub={`از ${jalaliShort(p.from)}`} />
        <Stat value={`${faNum(p.adherence_pct)}٪`} label="پایبندی" />
        <Stat
          value={p.body.change != null ? signed(p.body.change) : "–"}
          label={`وزن بدن (${r.unit})`}
          sub={p.body.first && p.body.current ? `${faNum(p.body.first.value, 1)} ← ${faNum(p.body.current.value, 1)}` : undefined}
        />
      </div>

      <h2>حرکت‌های اصلی: اول در برابر حالا</h2>
      <div class="card stack" data-testid="progress-lifts">
        {p.lifts.map((l) => (
          <div class="kv">
            <span>
              {l.name_fa}
              <br />
              <small class="muted">
                {l.first ? `${setText(l.first)} (${jalaliShort(l.first.date)})` : "–"} ← {l.current ? `${setText(l.current)} (${jalaliShort(l.current.date)})` : "–"}
              </small>
            </span>
            <span class="num" style={{ textAlign: "left" }}>
              1RM {l.first ? faNum(l.first.e1rm, 1) : "–"} ← {l.current ? faNum(l.current.e1rm, 1) : "–"}
              <br />
              <b>{signed(l.change_pct, "٪")}</b>
            </span>
          </div>
        ))}
      </div>

      <h2>حجم کل تمرین در هر هفته</h2>
      <div class="card">
        <Columns cols={p.volume_weeks.slice(-26).map((w) => ({ label: jalaliShort(w.start), value: w.volume }))} valueLabel={`${r.unit} × تکرار`} fmt={(n) => faNum(Math.round(n))} />
      </div>

      <h2>تعادل عضلات این هفته</h2>
      <div class="card">
        <p class="why" style={{ marginTop: 0 }}>
          ست‌های انجام‌شده‌ی هر گروه (فقط عضله‌ی اصلی) در برابر هدف برنامه، از {jalaliShort(r.balance.week.start)} تا {jalaliShort(r.balance.week.end)}. کمتر از ۸۰٪ هدف «کم» و بیشتر از ۱۲۰٪ «زیاد» حساب می‌شود.
        </p>
        <MuscleMap muscles={r.balance.muscles} />
      </div>
      <Actions card={card} title="پیشرفت Lodge Gym" />
    </>
  );
}

export function Reports() {
  const [tab, setTab] = useState<"week" | "month" | "progress">("week");
  return (
    <>
      <WeeklyReviewCard />
      <div class="seg wide" role="tablist" aria-label="گزارش‌ها" style={{ margin: "14px 0 6px" }}>
        {(
          [
            ["week", "هفتگی"],
            ["month", "ماهانه"],
            ["progress", "پیشرفت"],
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

// Settings → «Apple Watch»: shortcut token, step-by-step Shortcuts instructions, last received data, manual attach.

import { useEffect, useState } from "preact/hooks";
import { faNum, toPersianDigits } from "../../../worker/lib/digits";
import { addDays, localDate } from "../../../worker/lib/time";
import type { HealthWorkout, WorkoutSession } from "../../../worker/lib/types";
import { api, errorText } from "../api";
import { faHM, greg, jalali } from "../format";
import { dayInfo, sortedSessions } from "../model";
import { navigate, upsertWatch, useStore } from "../store";

interface TokenRow {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}
interface Status {
  last_received_at: string | null;
  last_result: { sessions?: number; stored: number; matched: number; hr_samples: number; energy_samples?: number; warnings: string[] } | null;
  workouts: HealthWorkout[];
}

const TYPE_FA: Record<string, string> = {
  "Traditional Strength Training": "تمرین قدرتی",
  "Functional Strength Training": "تمرین قدرتی عملکردی",
  "High Intensity Interval Training": "HIIT",
  "Core Training": "تمرین مرکز بدن",
  Walking: "پیاده‌روی",
  Running: "دویدن",
  Cycling: "دوچرخه‌سواری",
  Hiking: "کوه‌پیمایی",
  Cooldown: "سردکردن",
  Yoga: "یوگا",
};
export const workoutTypeFa = (t: string | null) => (t ? (TYPE_FA[t] ?? t) : "تمرین");

const WARNING_FA: Record<string, string> = {
  hr_time_count_mismatch: "تعداد مقدارهای ضربان با تعداد زمان‌هایشان یکی نبود.",
  hr_without_time_assigned_to_single_workout: "زمان نمونه‌های ضربان نرسید؛ همه به تنها تمرین نسبت داده شد.",
  hr_without_time_ignored: "زمان نمونه‌های ضربان نرسید، پس ضربان حساب نشد. فیلد hr_time را بررسی کن.",
  energy_time_count_mismatch: "تعداد مقدارهای انرژی با تعداد زمان‌هایشان یکی نبود.",
  energy_without_time_ignored: "زمان نمونه‌های انرژی نرسید، پس کالری حساب نشد. فیلد energy_time را بررسی کن.",
};
const warningFa = (w: string) => WARNING_FA[w] ?? (/^workout_\d+_no_start$/.test(w) ? "تاریخ شروع یکی از تمرین‌ها خوانده نشد." : w);

/** Duration (from the session when the data belongs to one), active kcal and HR. */
export function WatchStats({ w, session }: { w: HealthWorkout; session?: WorkoutSession | null }) {
  const parts: string[] = [];
  let dur = w.duration_sec;
  if (w.kind === "session" && session) dur = session.ended_at ? Math.round((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 1000) : null;
  if (dur != null) parts.push(`${faNum(Math.round(dur / 60))} دقیقه`);
  if (w.active_kcal != null) parts.push(`${faNum(Math.round(w.active_kcal))} کیلوکالری فعال`);
  if (w.hr_avg != null) parts.push(`ضربان میانگین ${faNum(Math.round(w.hr_avg))}${w.hr_max != null ? ` · بیشینه ${faNum(Math.round(w.hr_max))}` : ""}`);
  return <span class="num">{parts.length ? parts.join(" · ") : "بدون داده"}</span>;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [done, setDone] = useState<string>("");
  return (
    <div class="field">
      <span class="lbl">{label}</span>
      <div class="copyrow">
        <input class="ltr" readOnly value={value} data-testid={testId} onFocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
        <button
          type="button"
          class="btn btn-ghost btn-small"
          onClick={async () => setDone((await copy(value)) ? "کپی شد" : "انتخاب کن و کپی کن")}
        >
          {done || "کپی"}
        </button>
      </div>
    </div>
  );
}

export function Watch() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const tz = boot.settings.timezone;
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const url = `${location.origin}/api/health/raw`;

  const load = async () => {
    setErr("");
    try {
      const [t, s] = await Promise.all([api<{ tokens: TokenRow[] }>("GET", "/tokens"), api<Status>("GET", "/health/status")]);
      setTokens(t.tokens);
      setStatus(s);
      await upsertWatch(s.workouts.filter((w) => w.matched_session_id));
    } catch (e) {
      setErr(errorText(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ token: string }>("POST", "/tokens", { label: "iPhone Shortcuts" });
      setFresh(r.token);
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    if (armed !== id) return setArmed(id);
    setArmed(null);
    try {
      await api("DELETE", `/tokens/${id}`);
      await load();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const attach = async (w: HealthWorkout) => {
    const sid = pick[w.id];
    if (!sid) return;
    try {
      const r = await api<{ workout: HealthWorkout }>("PUT", `/health/workouts/${w.id}/match`, { session_id: sid });
      await upsertWatch([r.workout]);
      await load();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  const all = sortedSessions(sessions);
  const candidates = (w: HealthWorkout) => {
    const d = localDate(tz, w.started_at);
    // Sessions within a day of the watch workout first, then other recent sessions.
    const near = all.filter((s) => s.local_date >= addDays(d, -1) && s.local_date <= addDays(d, 1));
    const rest = all.filter((s) => !near.includes(s)).slice(0, Math.max(0, 20 - near.length));
    return [...near, ...rest];
  };

  return (
    <>
      <button type="button" class="linkbtn" onClick={() => navigate("settings")}>
        → بازگشت به تنظیمات
      </button>
      <h2>Apple Watch</h2>
      <p class="why" style={{ marginTop: 0 }}>
        برنامه‌ی وب نمی‌تواند مستقیم از Apple Health بخواند. یک میان‌بر (Shortcut) با سه کار، بعد از هر تمرین ساعت، نمونه‌های ضربان و کالری فعال را برای این برنامه می‌فرستد و محاسبه‌ها روی سرور انجام می‌شود.
      </p>
      {err ? (
        <div class="banner" role="alert">
          {err}
        </div>
      ) : null}

      <h2>۱. توکن میان‌بر</h2>
      <div class="card stack">
        {fresh ? (
          <>
            <CopyField value={fresh} label="توکن تازه (فقط همین یک بار نمایش داده می‌شود)" testId="fresh-token" />
            <CopyField value={`Bearer ${fresh}`} label="مقدار کامل هدر Authorization" />
          </>
        ) : null}
        {tokens?.length ? (
          tokens.map((t) => (
            <div class="kv" data-testid="token-row">
              <span>
                {t.label}
                <br />
                <small class="muted">
                  ساخته‌شده {jalali(localDate(tz, t.created_at))} · آخرین استفاده {t.last_used_at ? `${jalali(localDate(tz, t.last_used_at))} ${faHM(t.last_used_at, tz)}` : "هنوز نه"}
                </small>
              </span>
              <button type="button" class="btn btn-danger btn-small" onClick={() => void revoke(t.id)}>
                {armed === t.id ? "مطمئنی؟ باطل کن" : "باطل کردن"}
              </button>
            </div>
          ))
        ) : tokens ? (
          <div class="why">هنوز توکنی نساخته‌ای.</div>
        ) : null}
        <button type="button" class="btn btn-primary btn-block" disabled={busy} onClick={() => void create()}>
          ساختن توکن تازه
        </button>
        <CopyField value={url} label="آدرس (URL) برای Get Contents of URL" testId="health-url" />
      </div>

      <h2>۲. ساختن میان‌بر «ثبت تمرین ساعت»</h2>
      <div class="card">
        <ol class="rules steps">
          <li>
            اپ <b class="ltr">Shortcuts</b> را باز کن، در زبانه‌ی <b class="ltr">Shortcuts</b> دکمه‌ی <b>+</b> را بزن و نام میان‌بر را «ثبت تمرین ساعت» بگذار.
          </li>
          <li>
            <b class="ltr">Add Action</b> را بزن، <b class="ltr">Find Health Samples</b> را جستجو و اضافه کن. روی <b class="ltr">Type</b> بزن و <b class="ltr">Heart Rate</b> را انتخاب کن. بعد <b class="ltr">Add Filter</b>: <b class="ltr">Start Date</b>، <b class="ltr">is in the last</b>، <b class="ltr">6</b>، <b class="ltr">hours</b>.
          </li>
          <li>
            دوباره <b class="ltr">Find Health Samples</b> اضافه کن: <b class="ltr">Type</b> = <b class="ltr">Active Energy</b> و همان فیلتر <b class="ltr">Start Date is in the last 6 hours</b>.
          </li>
          <li>
            <b class="ltr">Get Contents of URL</b> را اضافه کن و آدرس بالا را در آن بگذار. روی فلش کنارش (<b class="ltr">Show More</b>) بزن:
            <ul>
              <li>
                <b class="ltr">Method</b>: <b class="ltr">POST</b>
              </li>
              <li>
                <b class="ltr">Headers</b>، <b class="ltr">Add new header</b>: کلید <b class="ltr">Authorization</b>، مقدار «مقدار کامل هدر Authorization» که بالا کپی کردی (<span class="ltr">Bearer lgt_…</span>).
              </li>
              <li>
                <b class="ltr">Request Body</b>: <b class="ltr">JSON</b>. با <b class="ltr">Add new field</b> و نوع <b class="ltr">Text</b> این چهار فیلد را بساز. کلیدها دقیقاً همین‌ها باشند؛ برای مقدار، <b class="ltr">Select Variable</b> را بزن:
                <table class="fields">
                  <tbody>
                    <tr>
                      <td class="ltr">hr</td>
                      <td>
                        خروجی کار اول (ضربان). روی متغیر بزن و <b class="ltr">Value</b> را انتخاب کن.
                      </td>
                    </tr>
                    <tr>
                      <td class="ltr">hr_time</td>
                      <td>
                        خروجی کار اول، این بار <b class="ltr">Start Date</b>.
                      </td>
                    </tr>
                    <tr>
                      <td class="ltr">energy</td>
                      <td>
                        خروجی کار دوم (<span class="ltr">Active Energy</span>)، <b class="ltr">Value</b>.
                      </td>
                    </tr>
                    <tr>
                      <td class="ltr">energy_time</td>
                      <td>
                        خروجی کار دوم، <b class="ltr">Start Date</b>.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </li>
              <li>
                برای دو فیلد تاریخ (<span class="ltr">hr_time</span> و <span class="ltr">energy_time</span>) روی متغیر بزن، <b class="ltr">Date Format</b> را <b class="ltr">ISO 8601</b> بگذار و <b class="ltr">Include ISO 8601 Time</b> را روشن کن. اگر این گزینه نبود، مشکلی نیست؛ سرور قالب‌های دیگر (حتی تاریخ شمسی) را هم می‌خواند.
              </li>
            </ul>
          </li>
          <li>
            در انتخاب متغیر، هر دو خروجی ممکن است با نام <span class="ltr">Health Samples</span> دیده شوند؛ اولی ضربان است و دومی انرژی. اگر نام یک گزینه با این‌جا کمی فرق دارد، نزدیک‌ترین را انتخاب کن.
          </li>
          <li>
            <b class="ltr">Done</b> را بزن و یک بار میان‌بر را با ▶︎ اجرا کن. دسترسی به <b class="ltr">Health</b> را <b class="ltr">Allow</b> کن. بعد پایین همین صفحه «بررسی دوباره» را بزن؛ «آخرین دریافت» باید به‌روز شده باشد.
          </li>
        </ol>
        <p class="why">
          سرور برای هر جلسه‌ای که در این برنامه ثبت کرده‌ای، نمونه‌های بین شروع و پایان جلسه را جدا می‌کند و میانگین و بیشینه‌ی ضربان و جمع کالری فعال را حساب می‌کند. مدت تمرین همان مدت جلسه است. پس جلسه را در برنامه شروع و تمام کن.
        </p>
      </div>

      <h2>۳. اجرای خودکار بعد از هر تمرین ساعت</h2>
      <div class="card">
        <ol class="rules steps">
          <li>
            در اپ <b class="ltr">Shortcuts</b> به زبانه‌ی <b class="ltr">Automation</b> برو و <b>+</b> (یا <b class="ltr">New Automation</b>) را بزن. در iOS قدیمی‌تر: <b class="ltr">Create Personal Automation</b>.
          </li>
          <li>
            <b class="ltr">Apple Watch Workout</b> را انتخاب کن، <b class="ltr">Ends</b> را تیک بزن و در <b class="ltr">Workout</b> گزینه‌های <b class="ltr">Traditional Strength Training</b> و <b class="ltr">Functional Strength Training</b> (یا <b class="ltr">Any</b>) را انتخاب کن.
          </li>
          <li>
            <b class="ltr">Run Immediately</b> را انتخاب کن (در iOS ۱۶ و قدیمی‌تر: <b class="ltr">Ask Before Running</b> را خاموش کن). <b class="ltr">Notify When Run</b> اختیاری است.
          </li>
          <li>
            <b class="ltr">Next</b> را بزن و میان‌بر «ثبت تمرین ساعت» را انتخاب کن، بعد <b class="ltr">Done</b>.
          </li>
        </ol>
        <p class="why">
          محدودیت iOS: داده‌ی Health فقط وقتی آیفون قفل نیست خوانده می‌شود، پس ممکن است اجرا تا باز کردن قفل گوشی عقب بیفتد. اگر اجرا نشد، بعداً میان‌بر را دستی اجرا کن؛ تا ۶ ساعت عقب را می‌فرستد و تکراری ذخیره نمی‌شود. اگر جلسه را دیرتر از اجرای میان‌بر در برنامه ثبت کردی، میان‌بر را یک بار دیگر اجرا کن.
        </p>
      </div>

      <h2>۴. همگام‌سازی ۷ روز اخیر (دستی)</h2>
      <div class="card">
        <ol class="rules steps">
          <li>
            در زبانه‌ی <b class="ltr">Shortcuts</b> روی «ثبت تمرین ساعت» نگه دار و <b class="ltr">Duplicate</b> را بزن. نام نسخه‌ی تازه را «همگام‌سازی ۷ روز اخیر» بگذار.
          </li>
          <li>
            در هر دو <b class="ltr">Find Health Samples</b>، <b class="ltr">6 hours</b> را به <b class="ltr">7 days</b> تغییر بده.
          </li>
          <li>هر وقت لازم شد دستی اجرایش کن. داده‌ی تکراری دوباره ذخیره نمی‌شود.</li>
        </ol>
      </div>

      <h2>۵. وضعیت</h2>
      <div class="card stack" data-testid="watch-status">
        <div class="kv">
          <span>آخرین دریافت</span>
          <span data-testid="last-received">
            {status?.last_received_at ? (
              <>
                {jalali(localDate(tz, status.last_received_at))} · <span class="ltr">{greg(localDate(tz, status.last_received_at))}</span> · {faHM(status.last_received_at, tz)}
              </>
            ) : (
              "هنوز چیزی نرسیده"
            )}
          </span>
        </div>
        {status?.last_result ? (
          <div class="why">
            آخرین ارسال: {faNum(status.last_result.hr_samples)} نمونه‌ی ضربان، {faNum(status.last_result.energy_samples ?? 0)} نمونه‌ی انرژی، داده برای {faNum(status.last_result.sessions ?? 0)} جلسه.
            {status.last_result.stored ? ` ${faNum(status.last_result.stored)} تمرین ساعت (قالب قدیمی)، ${faNum(status.last_result.matched)} وصل به جلسه.` : ""}
            {status.last_result.warnings.map((w) => (
              <div class="ss-note" style={{ marginTop: "6px" }}>
                {warningFa(w)}
              </div>
            ))}
          </div>
        ) : null}
        <button type="button" class="btn btn-ghost btn-block" onClick={() => void load()}>
          بررسی دوباره
        </button>
      </div>

      <h2>۱۰ داده‌ی آخر ساعت</h2>
      <div class="stack" data-testid="watch-list">
        {status && !status.workouts.length ? <div class="empty">هنوز داده‌ای از ساعت برای جلسه‌ها نرسیده.</div> : null}
        {status?.workouts.map((w) => {
          const s = w.matched_session_id ? sessions[w.matched_session_id] : null;
          const d = localDate(tz, w.started_at);
          return (
            <div class="card stack" data-testid="watch-row">
              <div class="kv">
                <b>{w.kind === "session" ? (s ? dayInfo(boot, s.program_day_id).name_fa : "جلسه") : workoutTypeFa(w.activity_type)}</b>
                <span>
                  {jalali(d)} · {faHM(w.started_at, tz)}
                  {w.ended_at ? `–${faHM(w.ended_at, tz)}` : ""}
                </span>
              </div>
              <div class="why">
                <WatchStats w={w} session={s} />
              </div>
              {w.matched_session_id ? (
                <div class="kv">
                  <span class="pill done">وصل به جلسه</span>
                  {s ? (
                    <button type="button" class="linkbtn" onClick={() => navigate("session", s.id)}>
                      {dayInfo(boot, s.program_day_id).name_fa} · {jalali(s.local_date)}
                    </button>
                  ) : (
                    <span class="muted">جلسه در این دستگاه نیست</span>
                  )}
                </div>
              ) : (
                <>
                  <span class="pill">تمرین ساعت بدون جلسه</span>
                  <div class="copyrow">
                    <select aria-label="جلسه برای وصل کردن" value={pick[w.id] ?? ""} onChange={(e) => setPick({ ...pick, [w.id]: (e.currentTarget as HTMLSelectElement).value })}>
                      <option value="">انتخاب جلسه…</option>
                      {candidates(w).map((c) => (
                        <option value={c.id}>
                          {dayInfo(boot, c.program_day_id).name_fa} · {jalali(c.local_date)} · {toPersianDigits(faHM(c.started_at, tz))}
                        </option>
                      ))}
                    </select>
                    <button type="button" class="btn btn-primary btn-small" disabled={!pick[w.id]} onClick={() => void attach(w)}>
                      وصل کن
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

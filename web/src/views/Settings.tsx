import { useEffect, useState } from "preact/hooks";
import { faNum } from "../../../worker/lib/digits";
import { isValidTimeZone } from "../../../worker/lib/time";
import type { Settings as SettingsT, WeekStart } from "../../../worker/lib/types";
import { api, errorText } from "../api";
import { jalali } from "../format";
import { fetchFile, shareOrDownload } from "../share";
import { disablePush, enablePush, isStandalone, pushEnabled, pushSupported, testPush } from "../push";
import { deviceLabel, registerPasskey } from "../passkey";
import { logout, navigate, saveSettings, syncNow, useStore } from "../store";

const ZONES = ["America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Chicago", "America/New_York", "Asia/Tehran", "Europe/London", "UTC"];

export function Settings() {
  const boot = useStore((s) => s.boot)!;
  const sync = useStore((s) => s.sync);
  const st = boot.settings;
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...new Set([st.timezone, ...ZONES, ...(deviceTz && isValidTimeZone(deviceTz) ? [deviceTz] : [])])];

  const set = (patch: Partial<SettingsT>) => void saveSettings(patch);

  const addDevice = async () => {
    setBusy(true);
    setMsg("");
    try {
      await registerPasskey({ label: deviceLabel() });
      setMsg("دستگاه تازه ثبت شد.");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>تنظیمات</h2>
      <div class="card settings-list">
        <div class="field">
          <span class="lbl">واحد وزن پیش‌فرض (برای جلسه‌های تازه)</span>
          <span class="seg" role="group" aria-label="واحد وزن">
            {(["lb", "kg"] as const).map((u) => (
              <button type="button" aria-pressed={st.unit === u} onClick={() => set({ unit: u })}>
                {u}
              </button>
            ))}
          </span>
        </div>
        <div class="field">
          <label for="s-week">شروع هفته</label>
          <select id="s-week" value={st.week_start} onChange={(e) => set({ week_start: (e.currentTarget as HTMLSelectElement).value as WeekStart })}>
            <option value="sat">شنبه</option>
            <option value="sun">یکشنبه</option>
            <option value="mon">دوشنبه</option>
          </select>
        </div>
        <div class="field">
          <label for="s-month">ماه در گزارش ماهانه</label>
          <select id="s-month" value={st.month_calendar} onChange={(e) => set({ month_calendar: (e.currentTarget as HTMLSelectElement).value as SettingsT["month_calendar"] })}>
            <option value="gregorian">میلادی</option>
            <option value="jalali">شمسی</option>
          </select>
        </div>
        <div class="field">
          <label for="s-relock">قفل دوباره با Face ID بعد از رفتن به پس‌زمینه</label>
          <select id="s-relock" value={String(st.relock_minutes)} onChange={(e) => set({ relock_minutes: Number((e.currentTarget as HTMLSelectElement).value) })}>
            <option value="0">خاموش</option>
            {[1, 5, 15, 30, 60].map((m) => (
              <option value={String(m)}>{faNum(m)} دقیقه</option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="s-tz">منطقه‌ی زمانی</label>
          <select id="s-tz" class="ltr" value={st.timezone} onChange={(e) => set({ timezone: (e.currentTarget as HTMLSelectElement).value })}>
            {zones.map((z) => (
              <option value={z}>{z}</option>
            ))}
          </select>
        </div>
      </div>

      <h2>اتصال‌ها</h2>
      <button type="button" class="setlink" onClick={() => navigate("watch")} data-testid="open-watch">
        <span>
          Apple Watch
          <br />
          <small>توکن، ساختن میان‌بر، آخرین داده‌های ساعت</small>
        </span>
        <span aria-hidden="true">←</span>
      </button>

      <h2>دستگاه‌ها</h2>
      <div class="card stack">
        <p class="why" style={{ margin: 0 }}>
          passkey معمولاً از طریق iCloud Keychain روی دستگاه‌های Apple تو همگام می‌شود. برای دستگاهی که همگام نمی‌شود، از همان دستگاه اینجا را باز کن و «افزودن دستگاه» را بزن.
        </p>
        <button class="btn btn-ghost btn-block" type="button" disabled={busy} onClick={addDevice}>
          افزودن دستگاه
        </button>
        <div class="why">{msg}</div>
      </div>

      <h2>اعلان پایان استراحت</h2>
      <PushSettings />

      <h2>پشتیبان</h2>
      <Backups />

      <h2>همگام‌سازی</h2>
      <div class="card stack">
        <div class="kv">
          <span>در صف ارسال</span>
          <span class="num">{faNum(sync.pending)}</span>
        </div>
        <div class="kv">
          <span>وضعیت</span>
          <span>{sync.online ? (sync.error ? sync.error : "آنلاین") : "آفلاین"}</span>
        </div>
        <button class="btn btn-ghost btn-block" type="button" onClick={() => void syncNow()}>
          همگام‌سازی الان
        </button>
      </div>

      <div class="stack" style={{ marginTop: "22px" }}>
        <button class="btn btn-danger btn-block" type="button" onClick={() => void logout()}>
          خروج
        </button>
      </div>
    </>
  );
}

function Backups() {
  const [list, setList] = useState<{ name: string; bytes: number; uploaded: string }[] | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api<{ backups: { name: string; bytes: number; uploaded: string }[] }>("GET", "/backups")
      .then((r) => setList(r.backups))
      .catch(() => setList(null));
  }, []);
  const get = async (path: string) => {
    setMsg("");
    try {
      const { blob, filename } = await fetchFile(path);
      await shareOrDownload(blob, filename, "پشتیبان Lodge Gym");
    } catch (e) {
      setMsg(e instanceof Error && e.message === "http_404" ? "هنوز پشتیبان خودکاری ساخته نشده است." : errorText(e));
    }
  };
  const latest = list?.[0];
  return (
    <div class="card stack" data-testid="backups">
      <p class="why" style={{ margin: 0 }}>
        هر دوشنبه یک نسخه‌ی کامل (جلسه‌ها، ست‌ها، داده‌ی ساعت، وزن بدن و فهرست عکس‌ها) به‌صورت خودکار ذخیره می‌شود و ۱۲ نسخه‌ی آخر نگه داشته می‌شود.
      </p>
      <div class="kv">
        <span>آخرین پشتیبان خودکار</span>
        <span data-testid="last-backup">{latest ? `${jalali(latest.uploaded.slice(0, 10))} · ${faNum(Math.round(latest.bytes / 1024))} KB` : list ? "هنوز ساخته نشده" : "–"}</span>
      </div>
      <div class="row">
        <button type="button" class="btn btn-ghost" disabled={!latest} onClick={() => void get("/backups/latest")}>
          دانلود آخرین پشتیبان
        </button>
        <button type="button" class="btn btn-ghost" data-testid="export-now" onClick={() => void get("/export")}>
          خروجی کامل همین حالا
        </button>
      </div>
      {msg ? <div class="why">{msg}</div> : null}
    </div>
  );
}

function PushSettings() {
  const [on, setOn] = useState<boolean | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (pushSupported()) void pushEnabled().then(setOn);
    else setOn(false);
  }, []);
  const enable = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await enablePush();
      if (r === "enabled") {
        setOn(true);
        setMsg("فعال شد. وقتی استراحت تمام شود، حتی اگر برنامه در پس‌زمینه باشد، اعلان می‌آید.");
      } else if (r === "denied") setMsg("اجازه‌ی اعلان داده نشد. از Settings ← Notifications ← Lodge Gym آن را روشن کن.");
      else if (r === "not-standalone") setMsg("روی آیفون اعلان فقط در نسخه‌ی نصب‌شده روی Home Screen کار می‌کند. برنامه را از آیکون صفحه‌ی اصلی باز کن.");
      else setMsg("این مرورگر اعلان وب را پشتیبانی نمی‌کند (آیفون: iOS 16.4 یا جدیدتر لازم است).");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="card stack" data-testid="push-settings">
      <p class="why" style={{ margin: 0 }}>
        با شروع استراحت، سرور زمان پایانش را نگه می‌دارد و سر وقت یک اعلان می‌فرستد؛ پس گوشی می‌تواند قفل باشد یا برنامه بسته. {isStandalone() ? "" : "روی آیفون فقط از نسخه‌ی Home Screen کار می‌کند."}
      </p>
      <div class="kv">
        <span>وضعیت</span>
        <span data-testid="push-status">{on === null ? "–" : on ? "فعال" : "خاموش"}</span>
      </div>
      <div class="row">
        {on ? (
          <>
            <button
              type="button"
              class="btn btn-ghost"
              disabled={busy}
              onClick={async () => {
                setMsg("");
                try {
                  const r = await testPush();
                  setMsg(r.sent ? "اعلان آزمایشی فرستاده شد." : "ارسال نشد؛ یک بار اعلان را خاموش و دوباره روشن کن.");
                } catch (e) {
                  setMsg(errorText(e));
                }
              }}
            >
              اعلان آزمایشی
            </button>
            <button
              type="button"
              class="btn btn-ghost"
              disabled={busy}
              onClick={async () => {
                await disablePush();
                setOn(false);
                setMsg("");
              }}
            >
              خاموش کردن
            </button>
          </>
        ) : (
          <button type="button" class="btn btn-primary" disabled={busy} data-testid="enable-push" onClick={() => void enable()}>
            فعال کردن اعلان
          </button>
        )}
      </div>
      {msg ? (
        <div class="why" role="status">
          {msg}
        </div>
      ) : null}
    </div>
  );
}

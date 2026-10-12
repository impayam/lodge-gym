import { useEffect, useState } from "preact/hooks";
import { isValidTimeZone } from "../../../worker/lib/time";
import type { Settings as SettingsT, WeekStart } from "../../../worker/lib/types";
import { api, errorText } from "../api";
import { dateLong, fmtNum } from "../format";
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
      setMsg("New device registered.");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>Settings</h2>
      <div class="card settings-list">
        <div class="field">
          <span class="lbl">Default weight unit (for new sessions)</span>
          <span class="seg" role="group" aria-label="Weight unit">
            {(["lb", "kg"] as const).map((u) => (
              <button type="button" aria-pressed={st.unit === u} onClick={() => set({ unit: u })}>
                {u}
              </button>
            ))}
          </span>
        </div>
        <div class="field">
          <label for="s-week">Week starts on</label>
          <select id="s-week" value={st.week_start} onChange={(e) => set({ week_start: (e.currentTarget as HTMLSelectElement).value as WeekStart })}>
            <option value="sat">Saturday</option>
            <option value="sun">Sunday</option>
            <option value="mon">Monday</option>
          </select>
        </div>
        <div class="field">
          <label for="s-relock">Lock again with Face ID after the app is in the background for</label>
          <select id="s-relock" value={String(st.relock_minutes)} onChange={(e) => set({ relock_minutes: Number((e.currentTarget as HTMLSelectElement).value) })}>
            <option value="0">Off</option>
            {[1, 5, 15, 30, 60].map((m) => (
              <option value={String(m)}>{fmtNum(m)} min</option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="s-tz">Time zone</label>
          <select id="s-tz" value={st.timezone} onChange={(e) => set({ timezone: (e.currentTarget as HTMLSelectElement).value })}>
            {zones.map((z) => (
              <option value={z}>{z}</option>
            ))}
          </select>
        </div>
      </div>

      <h2>Connections</h2>
      <button type="button" class="setlink" onClick={() => navigate("watch")} data-testid="open-watch">
        <span>
          Apple Watch
          <br />
          <small>Token, shortcut setup, latest watch data</small>
        </span>
        <span aria-hidden="true">→</span>
      </button>

      <h2>Devices</h2>
      <div class="card stack">
        <p class="why" style={{ margin: 0 }}>
          Passkeys usually sync across your Apple devices through iCloud Keychain. For a device that doesn't sync, open this page on that device and tap “Add device”.
        </p>
        <button class="btn btn-ghost btn-block" type="button" disabled={busy} onClick={addDevice}>
          Add device
        </button>
        <div class="why">{msg}</div>
      </div>

      <h2>Rest-timer notification</h2>
      <PushSettings />

      <h2>Backup</h2>
      <Backups />

      <h2>Sync</h2>
      <div class="card stack">
        <div class="kv">
          <span>Waiting to send</span>
          <span class="num">{fmtNum(sync.pending)}</span>
        </div>
        <div class="kv">
          <span>Status</span>
          <span>{sync.online ? (sync.error ? sync.error : "Online") : "Offline"}</span>
        </div>
        <button class="btn btn-ghost btn-block" type="button" onClick={() => void syncNow()}>
          Sync now
        </button>
      </div>

      <div class="stack" style={{ marginTop: "22px" }}>
        <button class="btn btn-danger btn-block" type="button" onClick={() => void logout()}>
          Sign out
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
      await shareOrDownload(blob, filename, "Lodge Gym backup");
    } catch (e) {
      setMsg(e instanceof Error && e.message === "http_404" ? "No automatic backup has been made yet." : errorText(e));
    }
  };
  const latest = list?.[0];
  return (
    <div class="card stack" data-testid="backups">
      <p class="why" style={{ margin: 0 }}>
        Every Monday a full copy (sessions, sets, watch data, body weight and the photo list) is saved automatically, and the last 12 copies are kept.
      </p>
      <div class="kv">
        <span>Latest automatic backup</span>
        <span data-testid="last-backup">{latest ? `${dateLong(latest.uploaded.slice(0, 10))} · ${fmtNum(Math.round(latest.bytes / 1024))} KB` : list ? "None yet" : "–"}</span>
      </div>
      <div class="row">
        <button type="button" class="btn btn-ghost" disabled={!latest} onClick={() => void get("/backups/latest")}>
          Download latest backup
        </button>
        <button type="button" class="btn btn-ghost" data-testid="export-now" onClick={() => void get("/export")}>
          Full export now
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
        setMsg("Enabled. When a rest ends you get a notification, even with the app in the background.");
      } else if (r === "denied") setMsg("Notifications were not allowed. Turn them on in Settings → Notifications → Lodge Gym.");
      else if (r === "not-standalone") setMsg("On iPhone, notifications work only in the app installed on the Home Screen. Open the app from its Home Screen icon.");
      else setMsg("This browser doesn't support web notifications (iPhone needs iOS 16.4 or later).");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="card stack" data-testid="push-settings">
      <p class="why" style={{ margin: 0 }}>
        When a rest starts, the server keeps its end time and sends a notification right on time, so the phone can be locked or the app closed. {isStandalone() ? "" : "On iPhone this works only from the Home Screen app."}
      </p>
      <div class="kv">
        <span>Status</span>
        <span data-testid="push-status">{on === null ? "–" : on ? "On" : "Off"}</span>
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
                  setMsg(r.sent ? "Test notification sent." : "Not sent; turn notifications off and on again.");
                } catch (e) {
                  setMsg(errorText(e));
                }
              }}
            >
              Test notification
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
              Turn off
            </button>
          </>
        ) : (
          <button type="button" class="btn btn-primary" disabled={busy} data-testid="enable-push" onClick={() => void enable()}>
            Turn on notifications
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

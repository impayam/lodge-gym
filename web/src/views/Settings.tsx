import { useEffect, useState } from "preact/hooks";
import { isValidTimeZone } from "../../../worker/lib/time";
import type { ProgramInfo, Settings as SettingsT, WeekStart } from "../../../worker/lib/types";
import { api, errorText } from "../api";
import { dateLong, fmtNum, instantShort, plural } from "../format";
import { fetchUsage, type AiUsage } from "../ai";
import { activeProgramInfo, programName, styleLabel } from "../model";
import { fetchFile, shareOrDownload } from "../share";
import { disablePush, enablePush, isStandalone, pushEnabled, pushSupported, testPush } from "../push";
import { deviceLabel, registerPasskey } from "../passkey";
import { IconChevron, IconWatch } from "../components/PulseIcons";
import { ScreenHead } from "../components/ScreenHead";
import { Select } from "../components/Select";
import { LoadError, Loading } from "../components/States";
import { loadProgramVersions, logout, navigate, openProgramEditor, saveSettings, syncNow, useStore } from "../store";

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
    <main class="page" data-testid="settings">
      <ScreenHead title="Settings" sub="Me" />
      <section class="card l-col l-gap-14" aria-label="General">
        <div class="form-field">
          <span class="form-field__label" id="s-unit">
            Default weight unit (for new sessions)
          </span>
          <span class="segmented l-full" role="group" aria-labelledby="s-unit">
            {(["lb", "kg"] as const).map((u) => (
              <button type="button" class="press l-grow" aria-pressed={st.unit === u} onClick={() => set({ unit: u })}>
                {u}
              </button>
            ))}
          </span>
        </div>
        <div class="form-field">
          <label class="form-field__label" for="s-week">
            Week starts on
          </label>
          <Select id="s-week" value={st.week_start} onChange={(e) => set({ week_start: (e.currentTarget as HTMLSelectElement).value as WeekStart })}>
            <option value="sat">Saturday</option>
            <option value="sun">Sunday</option>
            <option value="mon">Monday</option>
          </Select>
        </div>
        <div class="form-field">
          <label class="form-field__label" for="s-relock">
            Lock again with Face ID after the app is in the background for
          </label>
          <Select id="s-relock" value={String(st.relock_minutes)} onChange={(e) => set({ relock_minutes: Number((e.currentTarget as HTMLSelectElement).value) })}>
            <option value="0">Off</option>
            {[1, 5, 15, 30, 60].map((m) => (
              <option value={String(m)}>{fmtNum(m)} min</option>
            ))}
          </Select>
        </div>
        <div class="form-field">
          <label class="form-field__label" for="s-tz">
            Time zone
          </label>
          <Select id="s-tz" value={st.timezone} onChange={(e) => set({ timezone: (e.currentTarget as HTMLSelectElement).value })}>
            {zones.map((z) => (
              <option value={z}>{z}</option>
            ))}
          </Select>
        </div>
      </section>

      <h2 class="section-label">Program</h2>
      <ProgramSettings />

      <h2 class="section-label">Connections</h2>
      <section class="card card--list" aria-label="Connections">
        <button type="button" class="list-row press" data-testid="open-watch" onClick={() => navigate("watch")}>
          <span class="well icon-well t-orange">
            <IconWatch />
          </span>
          <span class="list-row__text">
            <span class="t-title">Apple Watch</span>
            <span class="caption">Token, shortcut setup, latest watch data</span>
          </span>
          <span class="list-row__chevron">
            <IconChevron size={16} />
          </span>
        </button>
      </section>

      <h2 class="section-label">Devices</h2>
      <section class="card l-col l-gap-10" aria-label="Devices">
        <p class="ex-card__meta l-m0">
          Passkeys usually sync across your Apple devices through iCloud Keychain. For a device that doesn't sync, open this page on that device and tap “Add device”.
        </p>
        <button class="clay press btn t-muted" type="button" disabled={busy} onClick={addDevice}>
          Add device
        </button>
        {msg ? (
          <p class="caption l-m0" role="status">
            {msg}
          </p>
        ) : null}
      </section>

      <h2 class="section-label">Rest-timer notification</h2>
      <PushSettings />

      <h2 class="section-label">Sync</h2>
      <section class="card l-col l-gap-10" aria-label="Sync">
        <div class="l-col">
          <Fact label="Waiting to send" value={fmtNum(sync.pending)} />
          <Fact label="Status" value={sync.online ? (sync.error ? sync.error : "Online") : "Offline"} />
        </div>
        <button class="clay press btn t-muted" type="button" onClick={() => void syncNow()}>
          Sync now
        </button>
      </section>

      <h2 class="section-label">About</h2>
      <section class="card" data-testid="about" aria-label="About">
        {/* CC BY-SA 4.0 attribution of the picker's 3D model (SPEC-v6 §1, web/public/models/ANATOMY-SOURCE.md). */}
        <p class="ex-card__meta l-m0">
          3D anatomy model:{" "}
          <a class="t-pink" href="https://github.com/hpfrei/body-anatomy-3d-viewer" target="_blank" rel="noopener noreferrer">
            Body Anatomy 3D Viewer
          </a>{" "}
          by hpfrei, based on{" "}
          <a class="t-pink" href="https://www.z-anatomy.com/" target="_blank" rel="noopener noreferrer">
            Z-Anatomy
          </a>
          ,{" "}
          <a class="t-pink" href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">
            CC BY-SA 4.0
          </a>
          .
        </p>
      </section>

      <button class="clay press btn t-danger" type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </main>
  );
}

/** A label and its value on one row (a divider between rows). */
function Fact({ label, value, testid }: { label: string; value: preact.ComponentChildren; testid?: string }) {
  return (
    <div class="list-row">
      <span class="list-row__text ex-card__meta">{label}</span>
      <span class="list-row__value" data-testid={testid}>
        {value}
      </span>
    </div>
  );
}

/** Settings → Program (SPEC-v2 §8.6): the active program, a new program, and saved drafts. */
function ProgramSettings() {
  const boot = useStore((s) => s.boot)!;
  const info = activeProgramInfo(boot);
  const since = info?.activations[info.activations.length - 1]?.started_at;
  const [drafts, setDrafts] = useState<ProgramInfo[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    setFailure(null);
    loadProgramVersions()
      .then((list) => setDrafts(list.filter((p) => p.status === "draft")))
      .catch((e) => setFailure(e));
  }, [round]);
  return (
    <section class="card l-col l-gap-10" data-testid="program-settings" aria-label="Program">
      <div class="l-col">
        <Fact label="Current program" value={`${programName(info, boot.program.name)}${since ? ` · since ${instantShort(since, boot.settings.timezone)}` : ""}`} />
        <Fact label="Style" value={styleLabel(info?.style ?? null)} />
      </div>
      <button type="button" class="clay press btn t-pink" data-testid="new-program" onClick={() => openProgramEditor()}>
        New program
      </button>
      {/* Saved drafts, when there are any. */}
      {drafts === null && failure !== null ? (
        <LoadError what="Couldn't load your saved drafts." error={failure} onRetry={() => setRound((n) => n + 1)} />
      ) : drafts === null ? (
        <Loading label="Loading your saved drafts" heights={[56]} />
      ) : null}
      {drafts?.length ? (
        <div class="l-col">
          <h3 class="form-field__label l-m0">Drafts</h3>
          {drafts.map((d) => (
            <button type="button" class="list-row press" data-testid="open-draft" onClick={() => openProgramEditor(d.id)}>
              <span class="list-row__text">
                <span class="t-title">{d.name}</span>
                <span class="caption num">Saved {instantShort(d.created_at, boot.settings.timezone)}</span>
              </span>
              <span class="list-row__chevron">
                <IconChevron size={16} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <p class="caption l-m0">Past programs are in History, where you can switch back to one.</p>
    </section>
  );
}

/**
 * SPEC-v3 M9a: this month's AI reports and plan advice with their estimated cost, and the API key's state as the last
 * call saw it (the key itself never reaches the phone).
 */
export function AiSettings() {
  const online = useStore((s) => s.sync.online);
  const [u, setU] = useState<AiUsage | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    setFailure(null);
    fetchUsage()
      .then((r) => setU(r))
      .catch((e) => setFailure(e));
  }, [online, round]);
  const keyProblem = u ? (u.key === "missing" ? "Report unavailable — API key not set" : u.key_status === "invalid" ? "Report unavailable — API key expired or invalid" : null) : null;
  return (
    <section class="card l-col l-gap-10" data-testid="ai-settings" aria-label="AI reports">
      {keyProblem ? (
        <p class="callout l-m0" data-bad="true" role="alert" data-testid="ai-key-problem">
          <b class="t-orange">{keyProblem}</b>
        </p>
      ) : null}
      {u ? (
        <div class="l-col">
          <Fact
            label="This month"
            testid="ai-cost"
            value={`${plural(u.month.reports, "report")}, ${plural(u.month.overviews, "overview")}${u.month.advice ? `, ${fmtNum(u.month.advice)} plan advice` : ""}, ~$${u.month.cost_usd.toFixed(2)}`}
          />
          <Fact
            label="Today"
            value={`${fmtNum(u.today.reports)}/${fmtNum(u.limits.report)} reports · ${fmtNum(u.today.overviews)}/${fmtNum(u.limits.overview)} overviews · ${fmtNum(u.today.advice)}/${fmtNum(u.limits.advice)} advice`}
          />
          <Fact label="Model" value={u.model} />
        </div>
      ) : failure !== null ? (
        <LoadError what="Couldn't load this month's AI use." error={failure} onRetry={() => setRound((n) => n + 1)} />
      ) : (
        <Loading label="Loading this month's AI use" heights={[44, 44, 44]} />
      )}
      <p class="caption l-m0">
        A short Persian report is written after each session, then the training overview in Reports is updated. The planner's Get advice asks for advice on a plan. Costs are estimates from the token counts.
      </p>
    </section>
  );
}

export function Backups() {
  const [list, setList] = useState<{ name: string; bytes: number; uploaded: string }[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    setFailure(null);
    api<{ backups: { name: string; bytes: number; uploaded: string }[] }>("GET", "/backups")
      .then((r) => setList(r.backups))
      .catch((e) => setFailure(e));
  }, [round]);
  const get = async (path: string) => {
    setMsg("");
    try {
      const { blob, filename } = await fetchFile(path);
      await shareOrDownload(blob, filename, "GYM time backup");
    } catch (e) {
      setMsg(e instanceof Error && e.message === "http_404" ? "No automatic backup has been made yet." : errorText(e));
    }
  };
  const latest = list?.[0];
  return (
    <section class="card l-col l-gap-10" data-testid="backups" aria-label="Backup and export">
      <p class="ex-card__meta l-m0">Every Monday a full copy (sessions, sets, watch data, body weight and the photo list) is saved automatically, and the last 12 copies are kept.</p>
      {list ? (
        <Fact label="Latest automatic backup" testid="last-backup" value={latest ? `${dateLong(latest.uploaded.slice(0, 10))} · ${fmtNum(Math.round(latest.bytes / 1024))} KB` : "None yet"} />
      ) : failure !== null ? (
        <LoadError what="Couldn't load your backups." error={failure} onRetry={() => setRound((n) => n + 1)} />
      ) : (
        <Loading label="Loading your backups" heights={[44]} />
      )}
      <div class="l-row l-gap-8">
        <button type="button" class="clay press btn btn--fit t-muted l-grow" disabled={!latest} onClick={() => void get("/backups/latest")}>
          Download latest backup
        </button>
        <button type="button" class="clay press btn btn--fit t-pink l-grow" data-testid="export-now" onClick={() => void get("/export")}>
          Full export now
        </button>
      </div>
      {msg ? (
        <p class="caption t-orange l-m0" role="status">
          {msg}
        </p>
      ) : null}
    </section>
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
      } else if (r === "denied") setMsg("Notifications were not allowed. Turn them on in Settings → Notifications → GYM time.");
      else if (r === "not-standalone") setMsg("On iPhone, notifications work only in the app installed on the Home Screen. Open the app from its Home Screen icon.");
      else setMsg("This browser doesn't support web notifications (iPhone needs iOS 16.4 or later).");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card l-col l-gap-10" data-testid="push-settings" aria-label="Rest-timer notification">
      <p class="ex-card__meta l-m0">
        When a rest starts, the server keeps its end time and sends a notification right on time, so the phone can be locked or the app closed. {isStandalone() ? "" : "On iPhone this works only from the Home Screen app."}
      </p>
      <Fact label="Status" testid="push-status" value={on === null ? "–" : on ? "On" : "Off"} />
      <div class="l-row l-gap-8">
        {on ? (
          <>
            <button
              type="button"
              class="clay press btn btn--fit t-muted l-grow"
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
              class="clay press btn btn--fit t-muted l-grow"
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
          <button type="button" class="clay press btn t-muted l-grow" disabled={busy} data-testid="enable-push" onClick={() => void enable()}>
            Turn on notifications
          </button>
        )}
      </div>
      {msg ? (
        <p class="caption l-m0" role="status">
          {msg}
        </p>
      ) : null}
    </section>
  );
}

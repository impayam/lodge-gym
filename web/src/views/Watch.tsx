// Settings → Apple Watch: shortcut token, step-by-step Shortcuts instructions, last received data, manual attach.

import { useEffect, useState } from "preact/hooks";
import { fmtNum } from "../../../worker/lib/digits";
import { addDays, localDate } from "../../../worker/lib/time";
import type { HealthWorkout, WorkoutSession } from "../../../worker/lib/types";
import { api, errorText } from "../api";
import { dateLong, dateShort, hm } from "../format";
import { dayInfo, sortedSessions } from "../model";
import { ScreenHead } from "../components/ScreenHead";
import { Select } from "../components/Select";
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

export const workoutTypeName = (t: string | null) => t || "Workout";

const WARNING_TEXT: Record<string, string> = {
  hr_time_count_mismatch: "The number of heart-rate values did not match the number of their times.",
  hr_without_time_assigned_to_single_workout: "Heart-rate sample times were missing; all samples were assigned to the only workout.",
  hr_without_time_ignored: "Heart-rate sample times were missing, so heart rate was not counted. Check the hr_time field.",
  energy_time_count_mismatch: "The number of energy values did not match the number of their times.",
  energy_without_time_ignored: "Energy sample times were missing, so calories were not counted. Check the energy_time field.",
};
const warningText = (w: string) => WARNING_TEXT[w] ?? (/^workout_\d+_no_start$/.test(w) ? "The start date of one of the workouts could not be read." : w);

/** Duration (from the session when the data belongs to one), active kcal and HR. */
export function WatchStats({ w, session }: { w: HealthWorkout; session?: WorkoutSession | null }) {
  const parts: string[] = [];
  let dur = w.duration_sec;
  if (w.kind === "session" && session) dur = session.ended_at ? Math.round((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 1000) : null;
  if (dur != null) parts.push(`${fmtNum(Math.round(dur / 60))} min`);
  if (w.active_kcal != null) parts.push(`${fmtNum(Math.round(w.active_kcal))} active kcal`);
  if (w.hr_avg != null) parts.push(`avg HR ${fmtNum(Math.round(w.hr_avg))}${w.hr_max != null ? ` · max ${fmtNum(Math.round(w.hr_max))}` : ""}`);
  return <span class="num">{parts.length ? parts.join(" · ") : "No data"}</span>;
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
    <div class="form-field">
      <span class="form-field__label">{label}</span>
      <div class="l-row l-gap-8">
        <input class="input num" readOnly value={value} aria-label={label} data-testid={testId} onFocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
        <button type="button" class="clay press btn btn--fit t-muted" onClick={async () => setDone((await copy(value)) ? "Copied" : "Select and copy")}>
          {done || "Copy"}
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

  const step = (n: number, title: string) => (
    <h2 class="section-label">
      {n}. {title}
    </h2>
  );
  return (
    <main class="page" data-testid="watch">
      <ScreenHead title="Apple Watch" sub="Settings" onBack={() => navigate("settings")} />
      <p class="ex-card__meta l-m0">
        A web app can't read Apple Health directly. A shortcut with three actions sends the heart-rate and active-energy samples to this app after each watch workout, and the server does the math.
      </p>
      {err ? (
        <p class="callout l-m0 ex-card__meta" data-bad="true" role="alert">
          <b class="t-orange">{err}</b>
        </p>
      ) : null}

      {step(1, "Shortcut token")}
      <section class="card l-col l-gap-12" aria-label="Shortcut token">
        {fresh ? (
          <>
            <CopyField value={fresh} label="New token (shown only this once)" testId="fresh-token" />
            <CopyField value={`Bearer ${fresh}`} label="Full Authorization header value" />
          </>
        ) : null}
        {tokens?.length ? (
          <div class="l-col">
            {tokens.map((t) => (
              <div class="list-row" data-testid="token-row">
                <span class="list-row__text">
                  <span class="t-title">{t.label}</span>
                  <span class="caption num">
                    Created {dateShort(localDate(tz, t.created_at))} · last used {t.last_used_at ? `${dateShort(localDate(tz, t.last_used_at))} ${hm(t.last_used_at, tz)}` : "never"}
                  </span>
                </span>
                <button type="button" class="clay press btn-sm btn--fit t-danger" onClick={() => void revoke(t.id)}>
                  {armed === t.id ? "Sure? Revoke" : "Revoke"}
                </button>
              </div>
            ))}
          </div>
        ) : tokens ? (
          <p class="state l-m0">You haven't created a token yet.</p>
        ) : null}
        <button type="button" class="clay press btn t-pink" disabled={busy} onClick={() => void create()}>
          Create new token
        </button>
        <CopyField value={url} label="URL for Get Contents of URL" testId="health-url" />
      </section>

      {step(2, "Build the “Log Watch Workout” shortcut")}
      <section class="card l-col l-gap-12" aria-label="Build the shortcut">
        <ol class="prose-list">
          <li>
            Open the <b>Shortcuts</b> app, tap <b>+</b> in the <b>Shortcuts</b> tab and name the shortcut “Log Watch Workout”.
          </li>
          <li>
            Tap <b>Add Action</b>, search for <b>Find Health Samples</b> and add it. Tap <b>Type</b> and pick <b>Heart Rate</b>. Then <b>Add Filter</b>: <b>Start Date</b>, <b>is in the last</b>, <b>6</b>, <b>hours</b>.
          </li>
          <li>
            Add <b>Find Health Samples</b> again: <b>Type</b> = <b>Active Energy</b> and the same filter, <b>Start Date is in the last 6 hours</b>.
          </li>
          <li>
            Add <b>Get Contents of URL</b> and put the URL above in it. Tap the arrow next to it (<b>Show More</b>):
            <ul class="prose-list">
              <li>
                <b>Method</b>: <b>POST</b>
              </li>
              <li>
                <b>Headers</b>, <b>Add new header</b>: key <b>Authorization</b>, value the “Full Authorization header value” you copied above (Bearer lgt_…).
              </li>
              <li>
                <b>Request Body</b>: <b>JSON</b>. With <b>Add new field</b> and type <b>Text</b>, create these four fields. The keys must be exactly these; for each value tap <b>Select Variable</b>:
                <table class="data-table data-table--text">
                  <thead>
                    <tr>
                      <th scope="col">Key</th>
                      <th scope="col">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>hr</td>
                      <td>
                        Output of the first action (heart rate). Tap the variable and pick <b>Value</b>.
                      </td>
                    </tr>
                    <tr>
                      <td>hr_time</td>
                      <td>
                        Output of the first action, this time <b>Start Date</b>.
                      </td>
                    </tr>
                    <tr>
                      <td>energy</td>
                      <td>
                        Output of the second action (Active Energy), <b>Value</b>.
                      </td>
                    </tr>
                    <tr>
                      <td>energy_time</td>
                      <td>
                        Output of the second action, <b>Start Date</b>.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </li>
              <li>
                For the two date fields (hr_time and energy_time) tap the variable, set <b>Date Format</b> to <b>ISO 8601</b> and turn on <b>Include ISO 8601 Time</b>. If that option is missing, that's fine: the server reads other formats too.
              </li>
            </ul>
          </li>
          <li>
            When picking variables, both outputs may show up as “Health Samples”: the first is heart rate, the second is energy. If an option's name differs a little from this page, pick the closest one.
          </li>
          <li>
            Tap <b>Done</b> and run the shortcut once with ▶︎. <b>Allow</b> access to <b>Health</b>. Then tap “Check again” at the bottom of this page; “Last received” should be updated.
          </li>
        </ol>
        <p class="caption l-m0">
          For each session you logged in this app, the server takes the samples between its start and end and computes the average and maximum heart rate and the total active energy. The workout duration is the session's duration, so start and finish the session in the app.
        </p>
      </section>

      {step(3, "Run it automatically after each watch workout")}
      <section class="card l-col l-gap-12" aria-label="Run it automatically">
        <ol class="prose-list">
          <li>
            In the <b>Shortcuts</b> app go to the <b>Automation</b> tab and tap <b>+</b> (or <b>New Automation</b>). On older iOS: <b>Create Personal Automation</b>.
          </li>
          <li>
            Pick <b>Apple Watch Workout</b>, check <b>Ends</b>, and under <b>Workout</b> pick <b>Traditional Strength Training</b> and <b>Functional Strength Training</b> (or <b>Any</b>).
          </li>
          <li>
            Pick <b>Run Immediately</b> (on iOS 16 and older: turn off <b>Ask Before Running</b>). <b>Notify When Run</b> is optional.
          </li>
          <li>
            Tap <b>Next</b>, pick the “Log Watch Workout” shortcut, then <b>Done</b>.
          </li>
        </ol>
        <p class="caption l-m0">
          iOS limit: Health data can only be read while the iPhone is unlocked, so the run may wait until you unlock the phone. If it didn't run, run the shortcut by hand later: it sends the last 6 hours and nothing is stored twice. If you logged the session in the app after the shortcut ran, run the shortcut once more.
        </p>
      </section>

      {step(4, "Sync the last 7 days (manual)")}
      <section class="card" aria-label="Sync the last 7 days">
        <ol class="prose-list">
          <li>
            In the <b>Shortcuts</b> tab, press and hold “Log Watch Workout” and tap <b>Duplicate</b>. Name the copy “Sync Last 7 Days”.
          </li>
          <li>
            In both <b>Find Health Samples</b> actions, change <b>6 hours</b> to <b>7 days</b>.
          </li>
          <li>Run it by hand whenever you need to. Duplicate data is not stored again.</li>
        </ol>
      </section>

      {step(5, "Status")}
      <section class="card l-col l-gap-10" data-testid="watch-status" aria-label="Status">
        <div class="list-row">
          <span class="list-row__text ex-card__meta">Last received</span>
          <span class="list-row__value" data-testid="last-received">
            {status?.last_received_at ? `${dateLong(localDate(tz, status.last_received_at))} · ${hm(status.last_received_at, tz)}` : "Nothing yet"}
          </span>
        </div>
        {status?.last_result ? (
          <div class="l-col l-gap-6 ex-card__meta num">
            <span>
              Last send: {fmtNum(status.last_result.hr_samples)} heart-rate samples, {fmtNum(status.last_result.energy_samples ?? 0)} energy samples, data for {fmtNum(status.last_result.sessions ?? 0)}{" "}
              {status.last_result.sessions === 1 ? "session" : "sessions"}.
              {status.last_result.stored ? ` ${fmtNum(status.last_result.stored)} watch workouts (old format), ${fmtNum(status.last_result.matched)} matched to a session.` : ""}
            </span>
            {status.last_result.warnings.map((w) => (
              <span class="t-orange">{warningText(w)}</span>
            ))}
          </div>
        ) : null}
        <button type="button" class="clay press btn t-muted" onClick={() => void load()}>
          Check again
        </button>
      </section>

      <h2 class="section-label">Last 10 watch records</h2>
      <div class="l-col l-gap-8" data-testid="watch-list">
        {status && !status.workouts.length ? <p class="state l-m0">No watch data has arrived for your sessions yet.</p> : null}
        {status?.workouts.map((w) => {
          const s = w.matched_session_id ? sessions[w.matched_session_id] : null;
          const d = localDate(tz, w.started_at);
          return (
            <section class="card l-col l-gap-8" data-testid="watch-row">
              <div class="l-row l-between l-gap-8">
                <span class="t-title">{w.kind === "session" ? (s ? dayInfo(boot, s.program_day_id).name_en : "Session") : workoutTypeName(w.activity_type)}</span>
                <span class="caption num">
                  {dateShort(d)} · {hm(w.started_at, tz)}
                  {w.ended_at ? `–${hm(w.ended_at, tz)}` : ""}
                </span>
              </div>
              <span class="ex-card__meta">
                <WatchStats w={w} session={s} />
              </span>
              {w.matched_session_id ? (
                <div class="l-row l-between l-gap-8">
                  <span class="badge">Matched to a session</span>
                  {s ? (
                    <button type="button" class="clay press btn-sm btn--fit t-muted" onClick={() => navigate("session", s.id)}>
                      {dayInfo(boot, s.program_day_id).name_en} · {dateShort(s.local_date)}
                    </button>
                  ) : (
                    <span class="caption">Session not on this device</span>
                  )}
                </div>
              ) : (
                <>
                  <span class="caption t-orange">Watch workout without a session</span>
                  <div class="l-row l-gap-8">
                    <span class="l-grow">
                      <Select aria-label="Session to attach to" value={pick[w.id] ?? ""} onChange={(e) => setPick({ ...pick, [w.id]: (e.currentTarget as HTMLSelectElement).value })}>
                        <option value="">Pick a session…</option>
                        {candidates(w).map((c) => (
                          <option value={c.id}>
                            {dayInfo(boot, c.program_day_id).name_en} · {dateShort(c.local_date)} · {hm(c.started_at, tz)}
                          </option>
                        ))}
                      </Select>
                    </span>
                    <button type="button" class="clay press btn btn--fit t-pink" disabled={!pick[w.id]} onClick={() => void attach(w)}>
                      Attach
                    </button>
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}

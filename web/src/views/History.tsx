// History (SPEC-v8 §6.04, SPEC-v2 §8.6): sessions only (Step 3: the AI reports live in Reports; a link goes there),
// as cards by month (grouped by program when there is more than one), then the program timeline with Switch back.

import { useEffect, useState } from "preact/hooks";
import { localDate } from "../../../worker/lib/time";
import type { ProgramInfo, WorkoutSession } from "../../../worker/lib/types";
import { errorText } from "../api";
import { SessionCard } from "../components/SessionCard";
import { Empty, LoadError, Loading } from "../components/States";
import { dayMonth, instantShort, monthLabel, plural } from "../format";
import { activeSession, programName, recentSwitch, sortedSessions, styleLabel } from "../model";
import { flash, loadAllHistory, navigate, switchProgram, useStore } from "../store";
import { IconChevron, IconSpark } from "../components/PulseIcons";

const lastStart = (p: ProgramInfo) => p.activations[p.activations.length - 1]?.started_at ?? "";

export function History() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  // The last 60 days are on the device; older sessions come from the server.
  const older = useStore((s) => s.loads.history);
  useEffect(() => {
    void loadAllHistory();
  }, []);
  const programs = (boot.programs ?? []).filter((p) => p.status !== "draft");
  const all = sortedSessions(sessions);
  const programOfDay = new Map([...boot.program.days, ...boot.other_days].map((d) => [d.id, d.program_id]));
  const bySession = new Map<string, WorkoutSession[]>();
  for (const s of all) {
    const k = programOfDay.get(s.program_day_id) ?? "";
    bySession.set(k, [...(bySession.get(k) ?? []), s]);
  }
  // Newest activation first; the active program on top.
  const ordered = [...programs].sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || lastStart(b).localeCompare(lastStart(a)));
  const groups: { key: string; title: string; list: WorkoutSession[] }[] = ordered
    .filter((p) => bySession.has(p.id))
    .map((p) => ({ key: p.id, title: programName(p), list: bySession.get(p.id)! }));
  if (!programs.length && bySession.has(boot.program.id)) groups.push({ key: boot.program.id, title: programName({ name: boot.program.name, style: "seed_full_body" }), list: bySession.get(boot.program.id)! });
  for (const [k, list] of bySession) if (!groups.some((g) => g.key === k)) groups.push({ key: k, title: "Other sessions", list });

  const active = programs.find((p) => p.status === "active") ?? null;
  const since = active ? lastStart(active) : "";

  return (
    <main class="page" data-testid="history">
      <header class="page-head">
        <div class="l-col l-gap-2">
          {active && since ? (
            <span class="page-head__sub num">
              {programName(active)}, since {dayMonth(localDate(boot.settings.timezone, since))}
            </span>
          ) : null}
          <h1 class="h-page">History</h1>
        </div>
      </header>
      <section class="card card--list" aria-label="AI reports">
        <button type="button" class="list-row press" data-testid="history-reports-link" onClick={() => navigate("reports")}>
          <span class="well icon-well t-violet">
            <IconSpark />
          </span>
          <span class="list-row__text">
            <span class="t-title">AI reports</span>
            <span class="caption">After-session reports and weekly reviews are in Reports.</span>
          </span>
          <span class="list-row__chevron">
            <IconChevron size={16} />
          </span>
        </button>
      </section>
      {all.length ? null : older?.status === "error" ? (
        <LoadError what="Couldn't load your sessions." error={older.error} onRetry={() => void loadAllHistory()} />
      ) : older?.status !== "done" ? (
        <Loading label="Loading your sessions" heights={[132, 132]} />
      ) : (
        <Empty action={{ label: "Go to Train", onClick: () => navigate("home"), testId: "history-empty-train" }}>No sessions yet. Finished sessions show up here.</Empty>
      )}
      {all.length ? (
        groups.map((g) => (
          <section class="l-col l-gap-12" data-testid="history-group" data-program={g.key} aria-label={`${g.title}, ${plural(g.list.length, "session")}`}>
            {/* The program is named when there are several, or when these sessions belong to an earlier one. */}
            {groups.length > 1 || g.key !== active?.id ? (
              <h2 class="t-title l-m0">
                {g.title} <span class="caption">· {plural(g.list.length, "session")}</span>
              </h2>
            ) : null}
            {[...months(g.list)].map(([month, list]) => (
              <>
                <h3 class="section-label">{month}</h3>
                {list.map((s) => (
                  <SessionCard s={s} boot={boot} all={all} />
                ))}
              </>
            ))}
          </section>
        ))
      ) : null}
      {all.length && older?.status === "loading" ? <Loading label="Loading older sessions" heights={[132]} /> : null}
      {all.length && older?.status === "error" ? <LoadError what="Couldn't load sessions older than 60 days." error={older.error} onRetry={() => void loadAllHistory()} /> : null}
      {programs.length ? <Timeline programs={ordered} /> : null}
    </main>
  );
}

function months(list: WorkoutSession[]) {
  const out = new Map<string, WorkoutSession[]>();
  for (const s of list) {
    const k = monthLabel(s.local_date);
    out.set(k, [...(out.get(k) ?? []), s]);
  }
  return out;
}

/** Every program used, with its dates; an archived one can be used again after a confirm (SPEC-v2 §8.6). */
function Timeline({ programs }: { programs: ProgramInfo[] }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const switchedAt = recentSwitch(boot);
  const open = activeSession(sessions);
  const tz = boot.settings.timezone;
  const day = (iso: string) => instantShort(iso, tz);

  const activate = async (p: ProgramInfo) => {
    setBusy(true);
    setMsg("");
    try {
      await switchProgram(p.id, "activate");
      setArmed(null);
      flash(`Switched back to ${programName(p)}. It applies from the next session.`);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card card--list" data-testid="program-timeline" aria-labelledby="programs-title">
      <h2 class="card__title l-m0" id="programs-title">
        Programs
      </h2>
      {programs.map((p) => (
        <div class="list-row l-col l-top" data-program={p.id} data-testid="program-item">
          <div class="l-row l-gap-12 l-full">
            <span class="list-row__text">
              <span class="t-title">
                {programName(p)} {p.status === "active" ? <span class="badge">active</span> : null}
              </span>
              <span class="caption num">
                {styleLabel(p.style)} ·{" "}
                {p.activations.length ? p.activations.map((a) => `${day(a.started_at)} – ${a.ended_at ? day(a.ended_at) : "now"}`).join(", ") : "never used"}
              </span>
            </span>
            {p.status === "archived" && armed !== p.id ? (
              <button type="button" class="clay press btn-sm btn--fit t-pink" data-testid="reactivate" onClick={() => setArmed(p.id)}>
                {p.activations.length ? "Switch back" : "Use this program"}
              </button>
            ) : null}
          </div>
          {armed === p.id ? (
            <div class="callout l-full" data-testid="reactivate-confirm">
              <span class="ex-card__meta">
                “{programName(p)}” becomes your program{p.activations.length ? " again" : ""} from the next session. Your history stays as it is.
              </span>
              {switchedAt ? (
                <span class="ex-card__meta t-orange" data-testid="switch-notice">
                  You last switched programs on {day(switchedAt)}. Switching more than once in 3 weeks makes progress hard to judge.
                </span>
              ) : null}
              {open ? <span class="ex-card__meta t-orange">Finish or delete the open session first.</span> : null}
              <div class="l-row l-gap-8">
                <button type="button" class="clay press btn btn--fit t-pink" data-testid="reactivate-yes" disabled={busy || !!open} onClick={() => void activate(p)}>
                  {busy ? "Working…" : p.activations.length ? "Yes, switch back" : "Yes, use it"}
                </button>
                <button type="button" class="clay press btn btn--fit t-muted" onClick={() => setArmed(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {msg ? (
        <p class="caption t-orange" role="alert">
          {msg}
        </p>
      ) : null}
    </section>
  );
}

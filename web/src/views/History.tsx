import { useEffect, useState } from "preact/hooks";
import type { ProgramInfo, WorkoutSession } from "../../../worker/lib/types";
import { errorText } from "../api";
import { dateShort, monthLabel, plural } from "../format";
import { activeSession, programName, recentSwitch, sortedSessions, styleLabel } from "../model";
import { flash, loadAllHistory, switchProgram, useStore } from "../store";
import { HistoryItem } from "./HistoryItem";

const lastStart = (p: ProgramInfo) => p.activations[p.activations.length - 1]?.started_at ?? "";

/** History (SPEC-v2 §8.6): the program timeline, and sessions grouped by the program they belong to. */
export function History() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
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

  return (
    <>
      {programs.length ? <Timeline programs={ordered} /> : null}
      {!all.length ? (
        <>
          <h2>History</h2>
          <div class="empty">No sessions yet.</div>
        </>
      ) : (
        groups.map((g) => (
          <section data-testid="history-group" data-program={g.key}>
            <h2>
              {g.title} <small>· {plural(g.list.length, "session")}</small>
            </h2>
            {[...months(g.list)].map(([month, list]) => (
              <>
                <h3 class="subhead">{month}</h3>
                <div class="stack">
                  {list.map((s) => (
                    <HistoryItem s={s} boot={boot} />
                  ))}
                </div>
              </>
            ))}
          </section>
        ))
      )}
    </>
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

function Timeline({ programs }: { programs: ProgramInfo[] }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const switchedAt = recentSwitch(boot);
  const open = activeSession(sessions);
  const tz = boot.settings.timezone;
  const day = (iso: string) => dateShort(new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }));

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
    <>
      <h2>Programs</h2>
      <div class="card stack" data-testid="program-timeline">
        {programs.map((p) => (
          <div class="tl-item" data-program={p.id}>
            <div class="tl-row">
              <span class="meta">
                <b>
                  {programName(p)} {p.status === "active" ? <span class="pill done">active</span> : null}
                </b>
                <small>
                  {styleLabel(p.style)} ·{" "}
                  {p.activations.length ? p.activations.map((a) => `${day(a.started_at)} – ${a.ended_at ? day(a.ended_at) : "now"}`).join(", ") : "never used"}
                </small>
              </span>
              {p.status === "archived" && armed !== p.id ? (
                <button type="button" class="btn btn-ghost btn-small" data-testid="reactivate" onClick={() => setArmed(p.id)}>
                  Switch back
                </button>
              ) : null}
            </div>
            {armed === p.id ? (
              <div class="stack tl-confirm" data-testid="reactivate-confirm">
                <div class="why">“{programName(p)}” becomes your program again from the next session. Your history stays as it is.</div>
                {switchedAt ? (
                  <div class="ss-note" data-testid="switch-notice">
                    You last switched programs on {day(switchedAt)}. Switching more than once in 3 weeks makes progress hard to judge.
                  </div>
                ) : null}
                {open ? <div class="ss-note">Finish or delete the open session first.</div> : null}
                <div class="row">
                  <button type="button" class="btn btn-primary" data-testid="reactivate-yes" disabled={busy || !!open} onClick={() => void activate(p)}>
                    {busy ? "Working…" : "Yes, switch back"}
                  </button>
                  <button type="button" class="btn btn-ghost" onClick={() => setArmed(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
        {msg ? (
          <div class="why" role="alert">
            {msg}
          </div>
        ) : null}
      </div>
    </>
  );
}

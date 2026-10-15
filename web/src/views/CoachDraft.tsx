// A program draft the coach proposed and Payam added with "Add to Planner" (SPEC-v9 M12, decision 8): read-only here,
// approved with the same tap and confirm as a New program draft. It becomes the active program only on that tap.

import { useState } from "preact/hooks";
import type { ProgramVersion } from "../../../worker/lib/types";
import { errorText } from "../api";
import { ScreenHead } from "../components/ScreenHead";
import { fmtNum, instantShort } from "../format";
import { activeProgramInfo, exerciseMap, programName } from "../model";
import { flash, navigate, switchProgram, useStore } from "../store";
import { rirText, targetText } from "./Program";

export function CoachDraftView({ program }: { program: ProgramVersion }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const exMap = exerciseMap(boot);
  const active = activeProgramInfo(boot);
  const openSession = Object.values(sessions).find((s) => s.status === "active");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const approve = async () => {
    setBusy(true);
    setMsg("");
    try {
      await switchProgram(program.id, "approve");
      flash("Your new program is active from the next session.");
      navigate("program");
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="page" data-testid="coach-draft-screen">
      <ScreenHead title={program.name} sub="Draft from the coach" onBack={() => navigate("program")} />
      <span class="ex-card__meta num">
        {fmtNum(program.days.length)} days · added {instantShort(program.created_at, boot.settings.timezone)}
      </span>
      {program.days.map((d) => (
        <section class="l-col l-gap-8" aria-label={d.name_en}>
          <h2 class="section-label num">
            {d.name_en} · about {fmtNum(d.est_minutes)} min
          </h2>
          <div class="card card--list">
            {d.exercises.map((p) => {
              const rir = rirText(p);
              return (
                <div class="list-row" data-testid="coach-draft-exercise">
                  <span class="list-row__text">
                    <span class="t-title">
                      {p.superset_tag ? <span class="t-violet">{p.superset_tag} </span> : null}
                      {exMap.get(p.exercise_id)?.name_en ?? p.exercise_id}
                      {p.is_main ? (
                        <>
                          {" "}
                          <span class="badge">Main</span>
                        </>
                      ) : null}
                    </span>
                    <span class="caption num">
                      {targetText(p)}
                      {rir ? ` · ${rir}` : ""} · rest {fmtNum(p.rest_sec)} s
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {msg ? (
        <p class="callout l-m0 ex-card__meta" data-bad="true" role="alert">
          <b class="t-orange">{msg}</b>
        </p>
      ) : null}
      {confirming ? (
        <section class="callout" data-testid="coach-draft-confirm" aria-label="Approve program">
          <p class="ex-card__meta l-m0">
            <b>{program.name}</b> becomes your program from the next session. {active ? <>“{programName(active)}” is archived; its sessions stay in History and you can switch back.</> : null}
          </p>
          {openSession ? <p class="ex-card__meta t-orange l-m0">Finish or delete the open session first.</p> : null}
          <div class="l-row l-gap-8">
            <button type="button" class="clay press btn btn--fit t-pink" data-testid="coach-draft-approve-yes" disabled={busy || !!openSession} onClick={() => void approve()}>
              {busy ? "Working…" : "Yes, start this program"}
            </button>
            <button type="button" class="clay press btn btn--fit t-muted" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </section>
      ) : (
        <button type="button" class="clay press btn-lg t-pink" data-testid="coach-draft-approve" disabled={busy} onClick={() => setConfirming(true)}>
          Approve program
        </button>
      )}
      <p class="caption l-m0">Needs an internet connection. Nothing changes until you approve the program.</p>
    </main>
  );
}

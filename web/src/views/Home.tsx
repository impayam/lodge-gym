import { daysBetween } from "../../../worker/lib/time";
import type { ProgramDay } from "../../../worker/lib/types";
import { dateShort, fmtNum, hm, plural } from "../format";
import { liveItems, planMinutes } from "../../../worker/lib/plan";
import { activeSession, dayInfo, daysPerWeek, exerciseMap, homeModel, newSession, openPlanFor, plannedLabel } from "../model";
import { navigate, openPlan, saveSession, today, useStore } from "../store";
import { planDay } from "./Planner";
import { HistoryItem } from "./HistoryItem";
import { WeeklyReviewCard } from "./Review";

export function Home() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const plans = useStore((s) => s.plans);
  const t = today();
  const m = homeModel(boot, sessions, t);
  const act = activeSession(sessions);
  const days = boot.program.days;
  const next = days.find((d) => d.id === m.next.dayId) ?? days[0];
  const exMap = exerciseMap(boot);
  const nextPlan = openPlanFor(plans, next.id);

  const start = async (day: ProgramDay) => {
    if (act) return navigate("session", act.id);
    const s = newSession(boot, day, t);
    await saveSession(s);
    navigate("session", s.id);
  };

  let why = "Your first session: start with Day 1.";
  if (m.next.programChanged) why = "The program changed: start with Day 1 of the new program.";
  else if (m.next.last) {
    const ago = daysBetween(m.next.last.local_date, t);
    const when = ago === 0 ? "today" : ago === 1 ? "yesterday" : `${fmtNum(ago)} days ago`;
    why = `Last session: ${dayInfo(boot, m.next.last.program_day_id).name_en}, ${when}.`;
  }

  const perWeek = daysPerWeek(boot);
  const dots = Math.max(perWeek, m.weekDone);
  return (
    <>
      {act ? (
        <section class="card next open" data-testid="next-card">
          <div class="eyebrow">Open session</div>
          <div class="big">{dayInfo(boot, act.program_day_id).name_en}</div>
          <div class="why">
            Started {dateShort(act.local_date)} at <span class="num">{hm(act.started_at, boot.settings.timezone)}</span>
          </div>
          <button class="btn btn-primary btn-block" type="button" onClick={() => navigate("session", act.id)}>
            Continue session
          </button>
        </section>
      ) : (
        <section class="card next" data-testid="next-card">
          <div class="why">{why}</div>
          {nextPlan ? (
            <div class="big" data-testid="planned-label">
              {plannedLabel(boot, nextPlan)}
            </div>
          ) : (
            <div class="big">Next session: {next.name_en}</div>
          )}
          <div class="why">
            {plural(nextPlan ? liveItems(nextPlan).length : next.exercises.length, "exercise")} · about {fmtNum(nextPlan ? planMinutes(nextPlan, next) : next.est_minutes)} min
          </div>
          {m.rest ? <div class="ss-note">Rest is better today. You trained yesterday and the day before; the program allows at most two training days in a row.</div> : null}
          {nextPlan ? (
            <button class="btn btn-primary btn-block" type="button" data-testid="open-plan" onClick={() => openPlan(nextPlan.id)}>
              Open plan
            </button>
          ) : (
            <>
              <button class="btn btn-primary btn-block" type="button" onClick={() => void start(next)}>
                Start
              </button>
              <button class="btn btn-ghost btn-block" type="button" data-testid="plan-session" onClick={() => planDay(next)}>
                Plan session
              </button>
            </>
          )}
        </section>
      )}

      <div style={{ marginTop: "12px" }}>
        <WeeklyReviewCard />
      </div>

      <h2>This week</h2>
      <div class="card weekcard" data-testid="week-strip">
        <div>
          <b class="num">
            {fmtNum(m.weekDone)}
            <small> of {fmtNum(perWeek)}</small>
          </b>
          <br />
          <small>sessions this week</small>
        </div>
        <div class="dots" aria-hidden="true">
          {Array.from({ length: dots }, (_, i) => (
            <i class={i < m.weekDone ? "on" : ""} />
          ))}
        </div>
      </div>

      {!act ? (
        <>
          <h2>Or pick another day</h2>
          <div class="daygrid">
            {days.map((d) => {
              // A planned day opens its plan (SPEC-v3 M9c); the others start as before.
              const p = openPlanFor(plans, d.id);
              return (
                <button type="button" class={`dayopt${d.id === next.id ? " is-next" : ""}`} onClick={() => (p ? openPlan(p.id) : void start(d))}>
                  <b>{d.name_en}</b>
                  <small>{p ? plannedLabel(boot, p, false) : exMap.get(d.exercises[0]?.exercise_id)?.name_en}</small>
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <h2>Recent sessions</h2>
      <div class="stack">
        {m.recent.length ? (
          m.recent.map((s) => <HistoryItem s={s} boot={boot} />)
        ) : (
          <div class="empty">No sessions yet. Your first workout will show up here.</div>
        )}
      </div>
    </>
  );
}

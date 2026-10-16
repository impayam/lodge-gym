// Train tab (SPEC-v8 §6.01): the calendar week strip (SPEC-v10 M13), the next session as the hero card (Exercise /
// Last / Today, the progression targets in orange, one main action), the estimated 1RM of the big three, then this
// week, the other days and recent sessions.

import { useEffect, useState } from "preact/hooks";
import { hm as hmMin, toMin } from "../../../worker/lib/calendar";
import { liveItems, planMinutes, itemAsDayExercise } from "../../../worker/lib/plan";
import { addDays, daysBetween, localHM } from "../../../worker/lib/time";
import type { DayExercise, ProgramDay } from "../../../worker/lib/types";
import { SessionCard } from "../components/SessionCard";
import { Empty } from "../components/States";
import { SyncStatus } from "../components/SyncStatus";
import { TimeChart, type Pick } from "../components/TimeChart";
import { dateShort, dayMonth, fmtNum, hm, plural } from "../format";
import { BIG_THREE, dayTitle } from "../lib/lifts";
import { todayPlan } from "../lib/calendarView";
import { nextRows } from "../lib/next";
import { e1rmPoints } from "../lib/records";
import { activeProgramInfo, activeSession, dayInfo, daysPerWeek, exerciseMap, homeModel, newSession, openPlanFor, plannedLabel, programName } from "../model";
import { autoClosedShown, calendarSettings, clearAutoClosed, navigate, openPlan, saveSession, today, useStore } from "../store";
import { CalendarStrip } from "./Calendar";
import { planDay } from "./Planner";

const longDate = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const dateHeading = (date: string) => longDate.format(new Date(`${date}T12:00:00Z`));

/** The Home main button glows once per app start (SPEC-v8 §7: the one attention moment). */
let glowed = false;

/** The first rows of the next session (the mockup shows three); the rest are counted under the table. */
const NEXT_ROWS = 3;

function NextTable({ exercises }: { exercises: DayExercise[] }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const all = nextRows(exercises, exerciseMap(boot), Object.values(sessions), boot.settings.unit);
  const rows = all.slice(0, NEXT_ROWS);
  return (
    <table class="next-table num" data-testid="next-table">
      <thead>
        <tr>
          <th scope="col">Exercise</th>
          <th scope="col">Last</th>
          <th scope="col">Today ({boot.settings.unit})</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr data-row={r.exercise_id}>
            <td>{r.name}</td>
            <td class="next-table__last">{r.last}</td>
            <td class="next-table__today">{r.today}</td>
          </tr>
        ))}
      </tbody>
      {all.length > rows.length ? (
        <tfoot>
          <tr>
            <td colSpan={3} class="caption">
              and {plural(all.length - rows.length, "more exercise")}
            </td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

/** Today's planned gym time (SPEC-v10 §2): the hero card shows it. */
function useTodayGym() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const shifts = useStore((s) => s.shifts);
  const gymPlans = useStore((s) => s.gymPlans);
  const tz = boot.settings.timezone;
  const now = new Date().toISOString();
  const src = { shifts: Object.values(shifts), plans: Object.values(gymPlans), sessions: Object.values(sessions), settings: calendarSettings(boot), tz, today: today(), now };
  return todayPlan(src, toMin(localHM(tz, now)));
}

function Hero() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const plans = useStore((s) => s.plans);
  const gym = useTodayGym();
  const [glow] = useState(() => {
    const first = !glowed;
    glowed = true;
    return first;
  });
  const t = today();
  const m = homeModel(boot, sessions, t);
  const act = activeSession(sessions);
  const days = boot.program.days;
  const next = days.find((d) => d.id === m.next.dayId) ?? days[0];
  const nextPlan = openPlanFor(plans, next.id);

  const start = async (day: ProgramDay) => {
    if (act) return navigate("session", act.id);
    const s = newSession(boot, day, t);
    await saveSession(s);
    navigate("session", s.id);
  };

  if (act) {
    const d = dayInfo(boot, act.program_day_id);
    return (
      <section class="card card--hero l-col l-gap-12" data-testid="next-card" data-day={d.name_en}>
        <div class="l-col l-gap-4">
          <span class="page-head__sub">Open session</span>
          <span class="big-num big-num--54">{dayTitle(d.name_en)}</span>
          <span class="caption num">
            Started {dateShort(act.local_date)} at {hm(act.started_at, boot.settings.timezone)}
          </span>
        </div>
        <button type="button" class={`clay press btn-lg t-pink l-full${glow ? " glow-once" : ""}`} data-testid="continue" onClick={() => navigate("session", act.id)}>
          Continue {dayTitle(d.name_en)}
        </button>
      </section>
    );
  }

  let why = "Your first session: start with Day 1.";
  if (m.next.programChanged) why = "The program changed: start with Day 1 of the new program.";
  else if (m.next.last) {
    const ago = daysBetween(m.next.last.local_date, t);
    const when = ago === 0 ? "today" : ago === 1 ? "yesterday" : `${fmtNum(ago)} days ago`;
    why = `Last session: ${dayInfo(boot, m.next.last.program_day_id).name_en}, ${when}.`;
  }
  const items: DayExercise[] = nextPlan ? liveItems(nextPlan).map((it) => itemAsDayExercise(it, null)) : next.exercises;
  const minutes = nextPlan ? planMinutes(nextPlan, next) : next.est_minutes;
  const program = programName(activeProgramInfo(boot)).split(" · ")[0];

  return (
    <section class="card card--hero l-col l-gap-12" data-testid="next-card" data-day={next.name_en}>
      <div class="l-row l-between l-top l-gap-12">
        <div class="l-col l-gap-4 l-grow">
          {nextPlan ? (
            <span class="page-head__sub" data-testid="planned-label">
              {plannedLabel(boot, nextPlan)}
            </span>
          ) : (
            <span class="page-head__sub">
              Day {fmtNum(next.position)} of {program}
            </span>
          )}
          <span class="big-num big-num--54">{dayTitle(next.name_en)}</span>
        </div>
        <div class="l-col l-gap-2" style={{ alignItems: "flex-end", paddingTop: "4px" }}>
          <span class="big-num big-num--26 num">
            {fmtNum(minutes)}
            <span class="big-num__unit"> min</span>
          </span>
          <span class="caption">{plural(items.length, "exercise")}</span>
        </div>
      </div>
      {gym ? (
        <p class="t-title l-m0 num" data-testid="hero-gym-time">
          Planned today at {hmMin(gym.start_min)}
          {gym.program_day_id !== next.id ? ` · ${dayInfo(boot, gym.program_day_id).name_en}` : ""}
        </p>
      ) : null}
      <p class="caption l-m0">{why}</p>
      {/* Advice only (Payam, 2026-10-15): nothing blocks training on any day. */}
      {m.rest ? (
        <p class="caption l-m0" data-testid="rest-advice">
          You trained yesterday and the day before: a rest day may help today.
        </p>
      ) : null}
      {/* A program day always has exercises; an open plan can have none yet ("Open plan" below adds them). */}
      {items.length ? <NextTable exercises={items} /> : <Empty>No exercises in this plan yet.</Empty>}
      {nextPlan ? (
        <button type="button" class={`clay press btn-lg t-pink l-full${glow ? " glow-once" : ""}`} data-testid="open-plan" onClick={() => openPlan(nextPlan.id)}>
          Open plan
        </button>
      ) : (
        <>
          <button type="button" class={`clay press btn-lg t-pink l-full${glow ? " glow-once" : ""}`} data-testid="start" onClick={() => void start(next)}>
            Start {dayTitle(next.name_en)}
          </button>
          <button type="button" class="clay press btn t-muted l-full" data-testid="plan-session" onClick={() => planDay(next)}>
            Plan session
          </button>
        </>
      )}
    </section>
  );
}

/**
 * The one-time note for sessions closed automatically (Payam, 2026-10-16): shown while Home is open, then gone; it is
 * not shown again on the next launch.
 */
function AutoClosedNote() {
  const dates = useStore((s) => s.autoClosed);
  useEffect(() => {
    if (dates.length) void autoClosedShown();
  }, [dates.length]);
  useEffect(() => () => clearAutoClosed(), []);
  if (!dates.length) return null;
  const list = dates.map((d) => dateShort(d));
  const text = list.length === 1 ? `Your session from ${list[0]} was closed automatically.` : `Your sessions from ${list.slice(0, -1).join(", ")} and ${list.at(-1)} were closed automatically.`;
  return (
    <p class="caption l-m0" role="status" data-testid="auto-closed">
      {text}
    </p>
  );
}

/** Estimated 1RM of the big three over the last 8 weeks (Payam, 2026-10-14: Bench / Squat / Deadlift). */
function OneRepMax() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const unit = boot.settings.unit;
  const [lift, setLift] = useState(BIG_THREE[0].id);
  const [picked, setPicked] = useState<Pick | null>(null);
  const t = today();
  const from = addDays(t, -55);
  const points = e1rmPoints(Object.values(sessions), lift, unit, from).map(({ date, value }) => ({ date, value }));
  const label = BIG_THREE.find((l) => l.id === lift)!.label;
  const first = points[0];
  const last = points[points.length - 1];
  const shown = picked && picked.values[0] != null ? { date: picked.date, value: picked.values[0] } : last;
  const change = first && shown && first.value ? Math.round(((shown.value - first.value) / first.value) * 1000) / 10 : null;
  const thisWeek = last && daysBetween(last.date, t) < 7;
  const trend = first && last ? (last.value > first.value ? "rose" : last.value < first.value ? "fell" : "stayed") : "";

  return (
    <section class="card l-col l-gap-8" data-testid="e1rm-card">
      <div class="l-row l-between l-gap-8">
        <h2 class="card__title l-m0">Estimated 1RM</h2>
        <div class="segmented" role="tablist" aria-label="Lift">
          {BIG_THREE.map((l) => (
            <button
              type="button"
              role="tab"
              class="press"
              aria-selected={l.id === lift}
              onClick={() => {
                setLift(l.id);
                setPicked(null);
              }}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      {shown ? (
        <>
          <div class="l-row l-baseline l-gap-8" aria-live="polite">
            <span class="big-num big-num--34 num" data-testid="e1rm-value">
              {fmtNum(shown.value)}
              <span class="big-num__unit"> {unit}</span>
            </span>
            {change != null && shown.date !== first.date ? (
              <span class="delta num">
                {change > 0 ? "+" : change < 0 ? "−" : ""}
                {fmtNum(Math.abs(change))}% since {dayMonth(first.date)}
              </span>
            ) : null}
            <span class="caption l-grow l-right">{dayMonth(shown.date)}</span>
          </div>
          {points.length > 1 ? (
            <TimeChart
              key={lift}
              series={[{ label, color: "--violet", points }]}
              height={120}
              unit={unit}
              area
              pickLast
              xLabels={thisWeek ? { last: "This week" } : {}}
              label={`${label} estimated 1RM ${trend} from ${fmtNum(first.value)} to ${fmtNum(last.value)} ${unit} since ${dayMonth(first.date)}`}
              onPick={setPicked}
              testid="e1rm-chart"
            />
          ) : null}
        </>
      ) : (
        <p class="state l-m0">No {label.toLowerCase()} sets in the last 8 weeks.</p>
      )}
    </section>
  );
}

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
  const perWeek = daysPerWeek(boot);
  const dots = Math.max(perWeek, m.weekDone);
  const all = Object.values(sessions);

  const start = async (day: ProgramDay) => {
    const s = newSession(boot, day, t);
    await saveSession(s);
    navigate("session", s.id);
  };

  return (
    <main class="page" data-testid="home">
      <header class="page-head">
        <div class="l-col l-gap-2">
          <span class="page-head__sub" data-testid="today-date">
            {dateHeading(t)}
          </span>
          <h1 class="h-page">Today</h1>
        </div>
        <SyncStatus />
      </header>

      <AutoClosedNote />
      <CalendarStrip />
      <Hero />
      <OneRepMax />

      <section class="card l-col l-gap-12" data-testid="week-strip">
        <div class="card__head">
          <h2 class="card__title l-m0">This week</h2>
          <span class="caption">sessions this week</span>
        </div>
        <div class="l-row l-gap-14">
          <span class="big-num big-num--34 num">
            {fmtNum(m.weekDone)}
            <span class="big-num__unit"> of {fmtNum(perWeek)}</span>
          </span>
          <span class="week-dots l-grow" aria-hidden="true">
            {Array.from({ length: dots }, (_, i) => (
              <span data-on={i < m.weekDone ? "true" : "false"} />
            ))}
          </span>
        </div>
      </section>

      {!act ? (
        <section class="l-col l-gap-8" aria-labelledby="other-days">
          <h2 id="other-days" class="card__title l-m0" style={{ padding: "0 4px" }}>
            Or pick another day
          </h2>
          <div class="l-grid-2 l-gap-10">
            {days.map((d) => {
              // A planned day opens its plan (SPEC-v3 M9c); the others start as before.
              const p = openPlanFor(plans, d.id);
              return (
                <button type="button" class="clay press tile-btn" data-testid="day-option" onClick={() => (p ? openPlan(p.id) : void start(d))}>
                  <span>{d.name_en}</span>
                  <span class="caption">{d.id === next.id ? "Next · " : ""}{p ? plannedLabel(boot, p, false) : exMap.get(d.exercises[0]?.exercise_id)?.name_en}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section class="l-col l-gap-12" aria-labelledby="recent">
        <h2 id="recent" class="card__title l-m0" style={{ padding: "0 4px" }}>
          Recent sessions
        </h2>
        {m.recent.length ? m.recent.map((s) => <SessionCard s={s} boot={boot} all={all} />) : <p class="state l-m0">No sessions yet. Your first workout will show up here.</p>}
      </section>
    </main>
  );
}

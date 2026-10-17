// Profile tab (SPEC-v12 M15 §3; Payam's decisions 2026-10-17): Reports and Me in one page, top to bottom: the line
// after the last session, My body (the shared 3D body tinted today / this week / rest, the latest sizes, Log sizes and
// the body goal's pace), My goal (the Living Diamond), This week's tiles, the AI reports, Before · After, and Details
// (everything else Reports held, closed). The gear at the top opens a short list: Program, Planner, My training, Photos, Settings.

import { useEffect, useState } from "preact/hooks";
import { BODY_GOAL_NAME, trainingLabel, type TrainingGoal } from "../../../worker/lib/goals";
import { FRAMING_LABEL, beforeAfter } from "../../../worker/lib/photoGroups";
import type { Muscle } from "../../../worker/lib/muscles";
import { groupOf } from "../../../worker/lib/muscles";
import type { Profile as ProfileData } from "../../../worker/lib/profile";
import { setsPerMuscle } from "../../../worker/lib/reports";
import { weekRange } from "../../../worker/lib/cycle";
import { daysBetween } from "../../../worker/lib/time";
import type { Photo, Pose, WorkoutSession } from "../../../worker/lib/types";
import { MUSCLE_NAME } from "../components/BalanceList";
import { Body3D } from "../components/Body3D";
import { BodyCard } from "../components/BodyCard";
import { CornerPanel, Diamond } from "../components/Diamond";
import { GuideCamera } from "../components/GuideCamera";
import { IconBarbell, IconChevron, IconPlanner, IconProgram, IconSettings } from "../components/PulseIcons";
import { IconCamera } from "../components/PulseIcons";
import { Sheet } from "../components/Sheet";
import { SizeTiles, SizesSheet } from "../components/Sizes";
import { LoadError } from "../components/States";
import { dayMonth, dateShort, fmtNum } from "../format";
import { BODY_TINT, profileTints } from "../lib/anatomy-status";
import { lastPose } from "../lib/camera";
import { activeProgramInfo, homeModel, programName, trainingSince } from "../model";
import { loadPhotos, navigate, openPhotos, photoSrc, today, useStore } from "../store";
import { SessionReportsList } from "./Overview";
import { poseLabel } from "./Photos";
import { planDay } from "./Planner";
import { ProfileDetails, ThisWeek, useReport } from "./ProfileDetails";

const signed = (n: number, digits = 1) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(n), digits)}`;

/** The gear's list: Program, Planner, My training, Photos, Settings (Payam, 2026-10-17). */
function GearSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const next = boot.program.days.find((d) => d.id === homeModel(boot, sessions, today()).next.dayId) ?? boot.program.days[0];
  const row = (testid: string, icon: preact.JSX.Element, tone: string, title: string, sub: string, go: () => void) => (
    <button
      type="button"
      class="list-row press"
      data-testid={testid}
      onClick={() => {
        onClose();
        go();
      }}
    >
      <span class={`well icon-well ${tone}`}>{icon}</span>
      <span class="list-row__text">
        <span class="t-title">{title}</span>
        <span class="caption">{sub}</span>
      </span>
      <span class="list-row__chevron">
        <IconChevron size={16} />
      </span>
    </button>
  );
  return (
    <Sheet open={open} onClose={onClose} title="More" testId="gear-sheet">
      <div class="card card--list">
        {row("gear-program", <IconProgram />, "t-pink", "Program", `${programName(activeProgramInfo(boot))}, active`, () => navigate("program"))}
        {next ? row("gear-planner", <IconPlanner />, "t-orange", "Planner", `Plan the next session: ${next.name_en}`, () => planDay(next)) : null}
        {row("gear-training", <IconBarbell />, "t-orange", "My training", "Rest timer, calendar, gym hours, reminders", () => navigate("training"))}
        {row("gear-photos", <IconCamera />, "t-violet", "Photos", "Progress photos, compare two dates", () => openPhotos())}
        {row("gear-settings", <IconSettings />, "t-muted", "Settings", "Units, Face ID, AI reports, backup, Apple Watch", () => navigate("settings"))}
      </div>
    </Sheet>
  );
}

/** Report groups with a done set: today, and this week up to today. */
function trainedGroups(sessions: Record<string, WorkoutSession>, ex: Parameters<typeof setsPerMuscle>[1], date: string, weekStart: string) {
  const all = Object.values(sessions);
  const groups = (list: WorkoutSession[]) => {
    const by = setsPerMuscle(list, ex);
    return { set: new Set(Object.keys(by).filter((g) => by[g].fractional > 0)), by };
  };
  const today = groups(all.filter((s) => s.local_date === date));
  const week = groups(all.filter((s) => s.local_date >= weekStart && s.local_date <= date));
  return { today, week };
}

function MyBody({ profile }: { profile: ProfileData | null }) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const library = useStore((s) => s.library);
  const [sizes, setSizes] = useState(false);
  const t = today();
  const ex = new Map([...boot.exercises, ...(library ?? [])].map((e) => [e.id, e]));
  const { today: day, week } = trainedGroups(sessions, ex, t, weekRange(t, boot.settings.week_start).start);
  const tints = profileTints(day.set, week.set);
  const body = profile?.body ?? null;
  const card = (m: Muscle) => {
    const g = groupOf(m) ?? m;
    const w = week.by[g]?.fractional ?? 0;
    const d = day.by[g]?.fractional ?? 0;
    return {
      body: (
        <span class="l-col">
          <b>{MUSCLE_NAME[g] ?? g}</b>
          <span class="num">
            {fmtNum(w, 1)} sets this week, {fmtNum(d, 1)} today
          </span>
        </span>
      ),
      data: { group: g, state: d > 0 ? "today" : w > 0 ? "week" : "rest" },
    };
  };
  const swatch = (k: keyof typeof BODY_TINT, label: string) => (
    <span>
      <span class="chart-legend__swatch" style={{ background: `var(${BODY_TINT[k]})` }} /> {label}
    </span>
  );
  return (
    <section class="card l-col l-gap-12" aria-labelledby="my-body-title" data-testid="my-body">
      <div class="card__head">
        <h2 class="card__title l-m0" id="my-body-title">
          My body
        </h2>
        <span class="caption">today · this week · rest</span>
      </div>
      <Body3D
        tints={tints}
        size="profile"
        hintKey="profile"
        card={card}
        label={`Your body: ${[...day.set].map((g) => MUSCLE_NAME[g] ?? g).join(", ") || "nothing"} trained today, ${[...week.set].filter((g) => !day.set.has(g)).map((g) => MUSCLE_NAME[g] ?? g).join(", ") || "nothing else"} earlier this week`}
        legend={
          <div class="chart-legend" data-testid="body-legend">
            {swatch("today", "Today")}
            {swatch("week", "This week")}
            {swatch("rest", "Not this week")}
            <span>
              <span class="chart-legend__swatch" style={{ background: "var(--model-context)" }} /> Not mapped
            </span>
          </div>
        }
      />
      <SizeTiles />
      <div class="l-row l-between l-gap-8">
        <button type="button" class="clay press btn-sm btn--fit t-muted" data-testid="sizes-all" onClick={() => navigate("sizes")}>
          All sizes
        </button>
        <button type="button" class="clay press btn-sm btn--fit t-pink" data-testid="sizes-log" onClick={() => setSizes(true)}>
          Log sizes
        </button>
      </div>
      {body ? (
        <div class="l-col l-gap-4" data-testid="body-goal" data-status={body.status}>
          <div class="l-row l-gap-10 l-baseline">
            <span class="badge">{body.badge}</span>
            {body.avg7 !== null ? (
              <span class="big-num big-num--26 num">
                {fmtNum(body.avg7, 1)}
                <span class="big-num__unit"> {body.unit}</span>
              </span>
            ) : null}
            {body.change !== null && body.since ? (
              <span class="delta num">
                {signed(body.change)} {body.unit} since {dayMonth(body.since)}
              </span>
            ) : null}
          </div>
          <p class="ex-card__meta l-m0">{body.sentence}</p>
        </div>
      ) : boot.goals ? null : (
        <p class="caption l-m0">Set a body goal to see your weight's pace against it.</p>
      )}
      <SizesSheet open={sizes} onClose={() => setSizes(false)} />
    </section>
  );
}

function Panel({ corner, profile }: { corner: TrainingGoal; profile: ProfileData }) {
  const unit = useStore((s) => s.boot!.settings.unit);
  const d = profile.diamond;
  if (corner === "strength")
    return (
      <CornerPanel title={`Strength: ${d.corners.strength.label} over the baseline`} testid="panel-strength">
        {d.strength.length ? (
          <table class="data-table num" data-testid="main-lifts-table">
            <thead>
              <tr>
                <th scope="col">Lift</th>
                <th scope="col">1RM ({unit})</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {d.strength.map((l) => (
                <tr data-lift={l.exercise_id}>
                  <td>{l.name}</td>
                  <td>{l.e1rm == null ? "–" : fmtNum(l.e1rm, 1)}</td>
                  <td class={l.change_pct == null ? "" : l.change_pct > 0 ? "t-violet" : l.change_pct < 0 ? "t-orange" : ""}>{l.change_pct == null ? "–" : `${signed(l.change_pct)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <span class="caption">
          Best estimated 1RM (Epley) of each main lift in the last 28 days against the baseline
          {d.baseline ? ` (${dayMonth(d.baseline.from)} – ${dayMonth(d.baseline.to)})` : ""}; a lift not done keeps its baseline. +10 % fills the corner. The chart is under Details → Main lifts.
        </span>
      </CornerPanel>
    );
  if (corner === "growth")
    return (
      <CornerPanel title={`Growth: ${d.corners.growth.label}`} testid="panel-growth">
        <span class="ex-card__meta num">
          {fmtNum(d.growth.regions_done)} of {fmtNum(d.growth.regions_total)} regions trained this week.
          {d.growth.missing.length ? ` Not yet: ${d.growth.missing.join(", ")}.` : ""}
        </span>
        {d.growth.uses_sizes ? (
          <span class="ex-card__meta num">Sizes over 8 weeks: {d.growth.sizes.map((s) => `${s.name} ${signed(s.change)} cm`).join(", ")}. +1 cm on average fills the size half.</span>
        ) : (
          <span class="caption">Log your sizes twice or more and the size growth counts too (half of the corner).</span>
        )}
      </CornerPanel>
    );
  if (corner === "endurance")
    return (
      <CornerPanel title={`Endurance: ${d.corners.endurance.label} reps at the same weight`} testid="panel-endurance">
        {d.endurance.length ? (
          <ul class="prose-list ex-card__meta num">
            {d.endurance.map((r) => (
              <li>
                {r.name} at {fmtNum(r.weight, 1)} {unit}: {fmtNum(r.first_reps)} → {fmtNum(r.best_reps)} reps ({signed(r.gain_pct)}%)
              </li>
            ))}
          </ul>
        ) : (
          <span class="ex-card__meta">No data yet: sets of 12 or more reps on accessory work, at a weight you used before, count here.</span>
        )}
        <span class="caption">The median gain in reps at the same weight; +25 % fills the corner.</span>
      </CornerPanel>
    );
  return (
    <CornerPanel title="Power: 0, no data" testid="panel-power">
      <span class="ex-card__meta">Sets and weights cannot measure power. A jump log comes later; until then this corner stays at 0.</span>
    </CornerPanel>
  );
}

function MyGoal({ profile, error, retry }: { profile: ProfileData | null; error: unknown; retry: () => void }) {
  const goals = useStore((s) => s.boot!.goals ?? null);
  const [open, setOpen] = useState<TrainingGoal | null>(null);
  const d = profile?.diamond ?? null;
  const corners = goals && d ? d.corners : null;
  const pace = profile?.body?.status;
  const paceWord = pace === "on" ? "on pace" : pace === "slow" ? "slower than the pace" : pace === "fast" ? "faster than the pace" : pace === "holding" ? "holding" : pace === "drifting" ? "drifting" : null;
  return (
    <section class="card l-col l-gap-12" aria-labelledby="my-goal-title" data-testid="my-goal">
      <div class="card__head">
        <h2 class="card__title l-m0" id="my-goal-title">
          My goal
        </h2>
        <button type="button" class="clay press btn-sm btn--fit t-pink" data-testid="set-goal-open" onClick={() => navigate("goal")}>
          {goals ? "Change goal" : "Set goal"}
        </button>
      </div>
      <Diamond
        corners={corners}
        ghost={goals && d ? d.ghost : null}
        selected={goals?.training ?? []}
        body={goals?.body ?? null}
        open={open}
        onCorner={corners ? (g) => setOpen(open === g ? null : g) : undefined}
        label={
          corners
            ? `Living Diamond: ${(["growth", "strength", "endurance", "power"] as const).map((g) => `${g} ${corners[g].has_data ? corners[g].label : "no data"}`).join(", ")}; dashed: 4 weeks ago`
            : "Living Diamond: no goal set yet"
        }
      />
      {goals ? (
        <p class="caption l-m0" data-testid="goal-caption">
          {trainingLabel(goals.training)} · {BODY_GOAL_NAME[goals.body]}
          {paceWord ? `, ${paceWord}` : ""}. Each corner stretches with that goal's progress; dashed is 4 weeks ago. Tap a corner for details.
        </p>
      ) : (
        <p class="caption l-m0">Set a training goal and a body goal. The program and the Coach follow it; saving changes nothing in your current program.</p>
      )}
      {!profile && error ? <LoadError what="Couldn't load your progress numbers." error={error} onRetry={retry} /> : null}
      {open && profile ? <Panel corner={open} profile={profile} /> : null}
    </section>
  );
}

function BeforeAfter() {
  const photos = useStore((s) => s.photos);
  const [pos, setPos] = useState(50);
  const [camera, setCamera] = useState(false);
  useEffect(() => {
    void loadPhotos();
  }, []);
  const pair = beforeAfter(photos);
  return (
    <section class="card l-col l-gap-10" aria-labelledby="before-after-title" data-testid="before-after">
      <div class="card__head">
        <h2 class="card__title l-m0" id="before-after-title">
          Before · After
        </h2>
        {pair ? (
          <span class="caption num">
            {poseLabel(pair[0].pose)}
            {pair[0].framing ? ` · ${FRAMING_LABEL[pair[0].framing]}` : ""} · {fmtNum(daysBetween(pair[0].local_date, pair[1].local_date))} days apart
          </span>
        ) : null}
      </div>
      {pair ? (
        <>
          <div class="photo-overlay well">
            <img src={photoSrc(pair[0], "full")} alt={`Before: ${poseLabel(pair[0].pose)}, ${dateShort(pair[0].local_date)}`} />
            <img src={photoSrc(pair[1], "full")} alt={`After: ${poseLabel(pair[1].pose)}, ${dateShort(pair[1].local_date)}`} style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
          </div>
          <input class="range" type="range" min={0} max={100} value={pos} aria-label="Move the divider between the two photos" onInput={(e) => setPos(Number((e.currentTarget as HTMLInputElement).value))} />
          <div class="l-row l-between caption num">
            <span>Before: {dateShort(pair[0].local_date)}</span>
            <span>After: {dateShort(pair[1].local_date)}</span>
          </div>
        </>
      ) : (
        <p class="caption l-m0">Two photos of the same pose and framing show here side by side. Take them with the guide camera so they line up.</p>
      )}
      <div class="l-row l-gap-8">
        <button type="button" class="clay press btn btn--fit t-pink l-grow" data-testid="profile-take-photo" onClick={() => setCamera(true)}>
          Take photo
        </button>
        <button type="button" class="clay press btn btn--fit t-muted l-grow" data-testid="profile-all-photos" onClick={() => openPhotos()}>
          All photos
        </button>
      </div>
      <GuideCamera open={camera} onClose={() => setCamera(false)} date={today()} sessionId={null} pose={lastPose()} />
    </section>
  );
}

export function Profile() {
  const boot = useStore((s) => s.boot)!;
  const lastSync = useStore((s) => s.sync.lastSync);
  const pending = useStore((s) => s.sync.pending);
  const [gear, setGear] = useState(false);
  // The numbers come from the server (cached for offline); they reload after each sync.
  const { data: profile, error, retry } = useReport<ProfileData>("/profile", `${lastSync ?? ""}:${pending}`);
  const since = trainingSince(boot);
  return (
    <main class="page" data-testid="profile">
      <header class="page-head">
        <div class="l-col l-gap-2">
          <h1 class="h-page">Profile</h1>
          {since ? <span class="page-head__sub">Training since {dayMonth(since)}</span> : null}
        </div>
        <button type="button" class="clay press btn-icon t-muted" aria-label="More: Program, Planner, My training, Photos, Settings" data-testid="profile-gear" onClick={() => setGear(true)}>
          <IconSettings size={22} />
        </button>
      </header>
      <section class="callout" aria-label="Your last session" data-testid="after-session">
        <span class="ex-card__meta">{profile?.after_session ?? (error ? "Your last session shows here when the app is online." : "…")}</span>
      </section>
      <MyBody profile={profile} />
      <BodyCard />
      <MyGoal profile={profile} error={error} retry={retry} />
      <ThisWeek />
      <SessionReportsList />
      <BeforeAfter />
      <ProfileDetails />
      <GearSheet open={gear} onClose={() => setGear(false)} />
    </main>
  );
}

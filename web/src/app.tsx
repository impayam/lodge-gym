import { useEffect, useRef } from "preact/hooks";
import { Pushed } from "./components/Pushed";
import { IconCoach, TabIcon } from "./components/PulseIcons";
import { RestTimer } from "./components/RestTimer";
import { backTarget, showsCoachButton, showsTabBar, tabIndex, TABS, type TabName } from "./lib/nav";
import { getState, goBack, navigate, setState, useStore } from "./store";
import { FirstOffline, Locked, Login, Recovery, Setup } from "./views/Auth";
import { History } from "./views/History";
import { Library } from "./views/Library";
import { AiReports, Backup } from "./views/SettingsScreens";
import { Calendar } from "./views/Calendar";
import { Coach } from "./views/Coach";
import { NewProgram } from "./views/NewProgram";
import { Home } from "./views/Home";
import { Photos } from "./views/Photos";
import { Planner } from "./views/Planner";
import { Program } from "./views/Program";
import { Profile } from "./views/Profile";
import { SetGoal } from "./views/SetGoal";
import { AllSizes } from "./components/Sizes";
import { AllReports, SavedReport } from "./views/ReportsTimeline";
import { Session } from "./views/Session";
import { SessionReportScreen } from "./views/SessionReport";
import { Settings } from "./views/Settings";
import { MyTraining } from "./views/MyTraining";
import { Watch } from "./views/Watch";

/** Client-side re-lock after N minutes in the background (SPEC §4.4). */
function useRelock() {
  const hiddenAt = useRef<number | null>(null);
  useEffect(() => {
    const on = () => {
      const st = getState();
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      const mins = st.boot?.settings.relock_minutes ?? 0;
      if (st.auth === "ready" && mins > 0 && hiddenAt.current && Date.now() - hiddenAt.current >= mins * 60_000) setState({ auth: "locked" });
      hiddenAt.current = null;
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
}

/** The four icon tabs with the pressed-in well that slides to the current one (SPEC-v8 §5, SPEC-v12 M15 §3.0); `coach`
 *  leaves room at the right end for the Coach button. */
function TabBar({ tab, coach }: { tab: TabName; coach: boolean }) {
  return (
    <nav class={coach ? "tabbar tabbar--coach" : "tabbar"} data-tabs={String(TABS.length)} aria-label="Sections" style={{ "--i": String(tabIndex(tab)) }}>
      <span class="tabbar__indicator" aria-hidden="true" />
      {TABS.map(({ name, label }) => {
        const Icon = TabIcon[name];
        return (
          <a
            href={name === "home" ? "/" : `/${name}`}
            class="press"
            aria-label={label}
            aria-current={tab === name ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(name);
            }}
          >
            <Icon />
          </a>
        );
      })}
    </nav>
  );
}

export function App() {
  const auth = useStore((s) => s.auth);
  const view = useStore((s) => s.view);
  const tab = useStore((s) => s.tab);
  const flashMsg = useStore((s) => s.flash);
  const hasBoot = useStore((s) => s.boot !== null);
  useRelock();

  if (auth === "loading") return <main class="page gate" aria-busy="true" />;
  if (auth === "setup") return <Setup />;
  if (auth === "login") return <Login />;
  if (auth === "recovery") return <Recovery />;
  if (auth === "locked") return <Locked />;
  if (auth === "first-offline" || !hasBoot) return <FirstOffline />;

  const screen =
    view.name === "session" && view.sessionId ? (
      <Session key={view.sessionId} id={view.sessionId} />
    ) : view.name === "report" && view.sessionId ? (
      <SessionReportScreen key={`${view.sessionId}:${view.fresh ? "fresh" : ""}`} id={view.sessionId} fresh={!!view.fresh} />
    ) : view.name === "plan" && view.planId ? (
      <Planner key={view.planId} id={view.planId} />
    ) : view.name === "history" ? (
      <History />
    ) : view.name === "allreports" ? (
      <AllReports />
    ) : view.name === "saved" && view.saved ? (
      <SavedReport key={`${view.saved.kind}:${view.saved.id}`} item={view.saved} />
    ) : view.name === "library" ? (
      <Library />
    ) : view.name === "profile" ? (
      <Profile />
    ) : view.name === "goal" ? (
      <SetGoal />
    ) : view.name === "sizes" ? (
      <AllSizes />
    ) : view.name === "coach" ? (
      <Coach />
    ) : view.name === "calendar" ? (
      <Calendar />
    ) : view.name === "photos" ? (
      <Photos key={JSON.stringify(view.photos ?? {})} compare={view.photos?.compare} open={view.photos?.open} />
    ) : view.name === "program" ? (
      <Program />
    ) : view.name === "settings" ? (
      <Settings />
    ) : view.name === "training" ? (
      <MyTraining />
    ) : view.name === "ai" ? (
      <AiReports />
    ) : view.name === "backup" ? (
      <Backup />
    ) : view.name === "watch" ? (
      <Watch />
    ) : view.name === "newprogram" ? (
      <NewProgram key={view.programId ?? "new"} />
    ) : (
      <Home />
    );

  const pushed = backTarget(view.name, tab) !== null;
  return (
    <>
      {pushed ? (
        <Pushed key={`${view.name}:${view.sessionId ?? view.planId ?? view.programId ?? view.saved?.id ?? ""}`} onBack={goBack}>
          {screen}
        </Pushed>
      ) : (
        screen
      )}
      <RestTimer />
      {showsCoachButton(view.name) ? (
        <button type="button" class="clay press fab" aria-label="Ask the coach" data-testid="coach-button" onClick={() => navigate("coach")}>
          <IconCoach size={22} />
        </button>
      ) : null}
      {showsTabBar(view.name) ? <TabBar tab={tab} coach={showsCoachButton(view.name)} /> : null}
      {flashMsg ? (
        <div class="toast" role="status" data-testid="toast">
          {flashMsg}
        </div>
      ) : null}
    </>
  );
}

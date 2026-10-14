import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Pushed } from "./components/Pushed";
import { IconCoach, TabIcon } from "./components/PulseIcons";
import { RestTimer } from "./components/RestTimer";
import { StatusChip } from "./components/StatusChip";
import { dateLong } from "./format";
import { backTarget, showsCoachButton, showsTabBar, tabIndex, TABS, type TabName } from "./lib/nav";
import { getState, goBack, navigate, setState, today, useStore } from "./store";
import { FirstOffline, Locked, Login, Recovery, Setup } from "./views/Auth";
import { History } from "./views/History";
import { Library } from "./views/Library";
import { Me } from "./views/Me";
import { AiReports, Backup } from "./views/MeScreens";
import { Coach } from "./views/Coach";
import { NewProgram } from "./views/NewProgram";
import { Home } from "./views/Home";
import { Photos } from "./views/Photos";
import { Planner } from "./views/Planner";
import { Program } from "./views/Program";
import { Reports } from "./views/Reports";
import { SavedReport } from "./views/ReportsTimeline";
import { Session } from "./views/Session";
import { SessionReportScreen } from "./views/SessionReport";
import { Settings } from "./views/Settings";
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

/** The 5 icon tabs with the pressed-in well that slides to the current one (SPEC-v8 §5). */
function TabBar({ tab }: { tab: TabName }) {
  return (
    <nav class="tabbar" aria-label="Sections" style={{ "--i": String(tabIndex(tab)) }}>
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

/** A screen still on the pre-Pulse styles, with its old header (until it moves to the Pulse library). */
function Legacy({ children, back }: { children: ComponentChildren; back?: string }) {
  const t = today();
  return (
    <div class="legacy">
      <div class="wrap">
        <header class="top">
          <div class="brand">
            <b>GYM time</b>
            <small>{dateLong(t)}</small>
          </div>
          <StatusChip />
        </header>
        <main>
          {back ? (
            <button type="button" class="linkbtn" data-testid="back" onClick={goBack}>
              ← {back}
            </button>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const auth = useStore((s) => s.auth);
  const view = useStore((s) => s.view);
  const tab = useStore((s) => s.tab);
  const flashMsg = useStore((s) => s.flash);
  const hasBoot = useStore((s) => s.boot !== null);
  useRelock();

  const gate = (el: preact.JSX.Element) => <div class="legacy">{el}</div>;
  if (auth === "loading") return gate(<div class="gate wrap" aria-busy="true" />);
  if (auth === "setup") return gate(<Setup />);
  if (auth === "login") return gate(<Login />);
  if (auth === "recovery") return gate(<Recovery />);
  if (auth === "locked") return gate(<Locked />);
  if (auth === "first-offline" || !hasBoot) return gate(<FirstOffline />);

  const screen =
    view.name === "session" && view.sessionId ? (
      <Legacy>
        <Session key={view.sessionId} id={view.sessionId} />
      </Legacy>
    ) : view.name === "report" && view.sessionId ? (
      <Legacy>
        <SessionReportScreen key={view.sessionId} id={view.sessionId} fresh={!!view.fresh} />
      </Legacy>
    ) : view.name === "plan" && view.planId ? (
      <Legacy>
        <Planner key={view.planId} id={view.planId} />
      </Legacy>
    ) : view.name === "history" ? (
      <Legacy>
        <History />
      </Legacy>
    ) : view.name === "saved" && view.saved ? (
      <Legacy>
        <SavedReport key={`${view.saved.kind}:${view.saved.id}`} item={view.saved} />
      </Legacy>
    ) : view.name === "reports" ? (
      <Legacy>
        <Reports />
      </Legacy>
    ) : view.name === "library" ? (
      <Legacy>
        <Library />
      </Legacy>
    ) : view.name === "me" ? (
      <Me />
    ) : view.name === "coach" ? (
      <Coach />
    ) : view.name === "photos" ? (
      <Legacy back="Me">
        <Photos key={JSON.stringify(view.photos ?? {})} compare={view.photos?.compare} open={view.photos?.open} />
      </Legacy>
    ) : view.name === "program" ? (
      <Legacy back="Me">
        <Program />
      </Legacy>
    ) : view.name === "settings" ? (
      <Legacy back="Me">
        <Settings />
      </Legacy>
    ) : view.name === "ai" ? (
      <Legacy>
        <AiReports />
      </Legacy>
    ) : view.name === "backup" ? (
      <Legacy>
        <Backup />
      </Legacy>
    ) : view.name === "watch" ? (
      <Legacy>
        <Watch />
      </Legacy>
    ) : view.name === "newprogram" ? (
      <Legacy>
        <NewProgram key={view.programId ?? "new"} />
      </Legacy>
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
      <div class="legacy legacy--overlay">
        <RestTimer />
      </div>
      {showsCoachButton(view.name) ? (
        <button type="button" class="clay press fab" aria-label="Ask the coach" data-testid="coach-button" onClick={() => navigate("coach")}>
          <IconCoach size={22} />
        </button>
      ) : null}
      {showsTabBar(view.name) ? <TabBar tab={tab} /> : null}
      {flashMsg ? (
        <div class="toast" role="status" data-testid="toast">
          {flashMsg}
        </div>
      ) : null}
    </>
  );
}

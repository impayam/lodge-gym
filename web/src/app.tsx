import { useEffect, useRef } from "preact/hooks";
import { IconHistory, IconLibrary, IconPhotos, IconProgram, IconReports, IconSettings, IconTrain } from "./components/Icons";
import { RestTimer } from "./components/RestTimer";
import { StatusChip } from "./components/StatusChip";
import { dateLong } from "./format";
import { getState, navigate, setState, today, useStore, type ViewName } from "./store";
import { FirstOffline, Locked, Login, Recovery, Setup } from "./views/Auth";
import { History } from "./views/History";
import { Library } from "./views/Library";
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

const TABS: { name: ViewName; label: string; Icon: () => preact.JSX.Element }[] = [
  { name: "home", label: "Train", Icon: IconTrain },
  { name: "history", label: "History", Icon: IconHistory },
  { name: "library", label: "Library", Icon: IconLibrary },
  { name: "photos", label: "Photos", Icon: IconPhotos },
  { name: "reports", label: "Reports", Icon: IconReports },
  { name: "program", label: "Program", Icon: IconProgram },
  { name: "settings", label: "Settings", Icon: IconSettings },
];

export function App() {
  const auth = useStore((s) => s.auth);
  const view = useStore((s) => s.view);
  const flashMsg = useStore((s) => s.flash);
  const hasBoot = useStore((s) => s.boot !== null);
  useRelock();

  if (auth === "loading") return <div class="gate wrap" aria-busy="true" />;
  if (auth === "setup") return <Setup />;
  if (auth === "login") return <Login />;
  if (auth === "recovery") return <Recovery />;
  if (auth === "locked") return <Locked />;
  if (auth === "first-offline" || !hasBoot) return <FirstOffline />;

  const t = today();
  const current = view.name === "session" || view.name === "plan" || view.name === "report" ? "home" : view.name === "watch" || view.name === "newprogram" ? "settings" : view.name === "saved" ? "history" : view.name;
  return (
    <>
      <div class="wrap">
        <header class="top">
          <div class="brand">
            <b>GYM time</b>
            <small>{dateLong(t)}</small>
          </div>
          <StatusChip />
        </header>
        {flashMsg ? (
          <div class="banner good" role="status">
            {flashMsg}
          </div>
        ) : null}
        <main>
          {view.name === "session" && view.sessionId ? (
            <Session key={view.sessionId} id={view.sessionId} />
          ) : view.name === "report" && view.sessionId ? (
            <SessionReportScreen key={view.sessionId} id={view.sessionId} fresh={!!view.fresh} />
          ) : view.name === "plan" && view.planId ? (
            <Planner key={view.planId} id={view.planId} />
          ) : view.name === "history" ? (
            <History />
          ) : view.name === "saved" && view.saved ? (
            <SavedReport key={`${view.saved.kind}:${view.saved.id}`} item={view.saved} />
          ) : view.name === "reports" ? (
            <Reports />
          ) : view.name === "library" ? (
            <Library />
          ) : view.name === "photos" ? (
            <Photos />
          ) : view.name === "program" ? (
            <Program />
          ) : view.name === "settings" ? (
            <Settings />
          ) : view.name === "watch" ? (
            <Watch />
          ) : view.name === "newprogram" ? (
            <NewProgram key={view.programId ?? "new"} />
          ) : (
            <Home />
          )}
        </main>
      </div>
      <RestTimer />
      <nav class="tabbar" aria-label="Sections">
        <div class="in">
          {TABS.map(({ name, label, Icon }) => (
            <button type="button" aria-current={current === name ? "page" : "false"} onClick={() => navigate(name)}>
              <Icon />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}

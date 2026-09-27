import { useEffect, useRef } from "preact/hooks";
import { IconHistory, IconProgram, IconSettings, IconTrain } from "./components/Icons";
import { RestTimer } from "./components/RestTimer";
import { StatusChip } from "./components/StatusChip";
import { greg, jalali } from "./format";
import { getState, navigate, setState, today, useStore, type ViewName } from "./store";
import { FirstOffline, Locked, Login, Recovery, Setup } from "./views/Auth";
import { History } from "./views/History";
import { Home } from "./views/Home";
import { Program } from "./views/Program";
import { Session } from "./views/Session";
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
  { name: "home", label: "تمرین", Icon: IconTrain },
  { name: "history", label: "سابقه", Icon: IconHistory },
  { name: "program", label: "برنامه", Icon: IconProgram },
  { name: "settings", label: "تنظیمات", Icon: IconSettings },
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
  const current = view.name === "session" ? "home" : view.name === "watch" ? "settings" : view.name;
  return (
    <>
      <div class="wrap">
        <header class="top">
          <div class="brand">
            <b>Lodge Gym</b>
            <small>
              {jalali(t)} · <span class="ltr">{greg(t)}</span>
            </small>
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
          ) : view.name === "history" ? (
            <History />
          ) : view.name === "program" ? (
            <Program />
          ) : view.name === "settings" ? (
            <Settings />
          ) : view.name === "watch" ? (
            <Watch />
          ) : (
            <Home />
          )}
        </main>
      </div>
      <RestTimer />
      <nav class="tabbar" aria-label="بخش‌ها">
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

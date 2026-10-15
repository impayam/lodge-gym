// Rest timer pill (SPEC-v8 §6.02): slides up after a set with a ring countdown in the effort color, +30 s and Skip.
// When the rest is over the pill keeps a visual cue (iOS web apps cannot vibrate) and counts up; it vibrates where the
// browser allows. Screen readers hear the start and the end of a rest, not every second.

import { useEffect, useRef, useState } from "preact/hooks";
import { clock } from "../format";
import { effortColor } from "../lib/effort";
import { restShare, sessionEffort } from "../lib/session";
import { effortStops } from "../lib/tokens";
import { activeSession } from "../model";
import { extendRest, stopRest, useStore } from "../store";

const R = 18;
const CIRC = 2 * Math.PI * R;

export function RestTimer() {
  const rest = useStore((s) => s.rest);
  const sessions = useStore((s) => s.sessions);
  const [now, setNow] = useState(Date.now());
  const [said, setSaid] = useState("");
  const alerted = useRef<number | null>(null);
  // The last rest stays drawn while the pill slides away.
  const last = useRef(rest);
  if (rest) last.current = rest;

  useEffect(() => {
    if (!rest) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [rest]);

  useEffect(() => {
    if (rest) setSaid(`${rest.label}: ${clock(Math.ceil((rest.endsAt - Date.now()) / 1000))}`);
  }, [rest?.id]);

  useEffect(() => {
    if (!rest) return;
    if (now >= rest.endsAt && alerted.current !== rest.endsAt) {
      alerted.current = rest.endsAt;
      if (typeof navigator.vibrate === "function") navigator.vibrate([200, 100, 200]);
      setSaid("Rest is over");
    }
  }, [now, rest]);

  const shown = rest ?? last.current;
  const left = shown ? (shown.endsAt - now) / 1000 : 0;
  const over = !!rest && left <= 0;
  const act = activeSession(sessions);
  const color = effortColor(sessionEffort(act?.sets ?? []).e, effortStops());

  return (
    <div
      class="rest"
      data-active={rest ? "true" : "false"}
      data-over={over ? "true" : "false"}
      role="timer"
      aria-label="Rest timer"
      aria-hidden={rest ? undefined : "true"}
      inert={!rest}
      data-testid="rest-timer"
      style={{ "--effort": color }}
    >
      <svg class="rest__ring" viewBox="0 0 44 44" aria-hidden="true">
        <circle class="rest__track" cx="22" cy="22" r={R} />
        <circle class="rest__arc" cx="22" cy="22" r={R} stroke-dasharray={CIRC.toFixed(1)} stroke-dashoffset={(CIRC * (1 - (over ? 1 : restShare(left, shown?.total ?? 0)))).toFixed(1)} />
      </svg>
      <div class="rest__text">
        <span class="rest__label">{over ? "Rest is over" : (shown?.label ?? "Rest")}</span>
        <span class={`big-num big-num--30 num${over ? " t-effort" : ""}`}>{shown ? (over ? "+" + clock(-left) : clock(Math.ceil(left))) : ""}</span>
      </div>
      <button type="button" class="clay press btn t-effort" onClick={() => extendRest(30)}>
        +30 s
      </button>
      <button type="button" class="rest__skip press" onClick={stopRest}>
        Skip
      </button>
      <span class="l-sr" role="status">
        {rest ? said : ""}
      </span>
    </div>
  );
}

// Sticky rest timer: +30 s, dismiss; vibration where supported, visual flash otherwise (iOS).

import { useEffect, useRef, useState } from "preact/hooks";
import { clock } from "../format";
import { extendRest, stopRest, useStore } from "../store";

export function RestTimer() {
  const rest = useStore((s) => s.rest);
  const [now, setNow] = useState(Date.now());
  const [flashing, setFlashing] = useState(false);
  const alerted = useRef<number | null>(null);

  useEffect(() => {
    if (!rest) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [rest]);

  useEffect(() => {
    if (!rest) return;
    if (now >= rest.endsAt && alerted.current !== rest.endsAt) {
      alerted.current = rest.endsAt;
      if (typeof navigator.vibrate === "function") navigator.vibrate([200, 100, 200]);
      setFlashing(true);
      setTimeout(() => setFlashing(false), 3000);
    }
  }, [now, rest]);

  if (!rest) return null;
  const left = (rest.endsAt - now) / 1000;
  const over = left <= 0;
  return (
    <div class={`rest${over ? " over" : ""}${flashing ? " flash" : ""}`} role="timer" aria-live="polite" data-testid="rest-timer">
      <div>
        <small>{over ? "استراحت تمام شد" : rest.label}</small>
        <br />
        <b class="num">{over ? "+" + clock(-left) : clock(Math.ceil(left))}</b>
      </div>
      <div class="row" style={{ flex: "none", gap: "6px" }}>
        <button type="button" onClick={() => extendRest(30)}>
          +۳۰ ث
        </button>
        <button type="button" onClick={stopRest}>
          بستن
        </button>
      </div>
    </div>
  );
}

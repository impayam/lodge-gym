// A screen pushed on top of a tab (SPEC-v8 §5): swiping from the left edge goes back. The finger drags the screen;
// past 35% of the width or with a fast flick it slides out and goes back, otherwise it springs back. The screen keeps
// its visible Back button; reduced motion skips the slide.

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { EDGE_ZONE, edgeSwipeOutcome } from "../lib/nav";

export function Pushed({ onBack, children }: { onBack: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef(onBack);
  back.current = onBack;

  useEffect(() => {
    const el = ref.current!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let pointer: number | null = null;
    let mode: "pending" | "drag" | null = null;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let suppressClick = false;

    const down = (e: PointerEvent) => {
      if (!e.isPrimary || pointer !== null || e.clientX > EDGE_ZONE) return;
      pointer = e.pointerId;
      mode = "pending";
      x0 = lastX = e.clientX;
      y0 = e.clientY;
      lastT = e.timeStamp;
      dx = velocity = 0;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer || !mode) return;
      const mx = e.clientX - x0;
      const my = e.clientY - y0;
      if (mode === "pending") {
        if (Math.hypot(mx, my) < 8) return;
        // Only a rightward, mostly horizontal drag is a back swipe; anything else is left to the page.
        if (mx <= 0 || Math.abs(my) > Math.abs(mx)) {
          pointer = null;
          mode = null;
          return;
        }
        mode = "drag";
        el.dataset.dragging = "true";
        el.setPointerCapture(e.pointerId);
      }
      dx = Math.max(0, mx);
      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (e.clientX - lastX) / dt;
      lastX = e.clientX;
      lastT = e.timeStamp;
      el.style.transform = `translateX(${dx}px)`;
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const dragged = mode === "drag";
      pointer = null;
      mode = null;
      if (!dragged) return;
      suppressClick = true;
      el.dataset.dragging = "false";
      if (e.type === "pointercancel" || edgeSwipeOutcome(dx, el.clientWidth, velocity) === "cancel") {
        el.style.transform = "";
        return;
      }
      if (reduce.matches) return back.current();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        back.current();
      };
      el.addEventListener("transitionend", finish, { once: true });
      window.setTimeout(finish, 450);
      el.style.transform = "translateX(100%)";
    };
    // A drag never counts as a tap on whatever is under the finger.
    const click = (e: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", click, true);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("click", click, true);
    };
  }, []);

  return (
    <div ref={ref} class="pushed" data-testid="pushed">
      {children}
    </div>
  );
}

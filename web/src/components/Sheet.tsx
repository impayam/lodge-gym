// Bottom sheet (SPEC-v8 §5, §7): slides up in 300 ms over a scrim; closes with a tap on the scrim, a swipe down on its
// head (grabber and title), Escape, or its own button. While open the screen behind it is inert (the caller passes
// `inert` to its content); focus moves to the title and goes back to the element that opened the sheet.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** A line under the title. */
  sub?: string;
  /** "alertdialog" for a confirm. */
  role?: "dialog" | "alertdialog";
  testId?: string;
  /** CSS variables the sheet needs from its screen (e.g. the session's --effort). */
  vars?: Record<string, string>;
  children: ComponentChildren;
}

let seq = 0;

/**
 * The control last pressed: Safari does not focus a tapped button, so this is where focus goes back when a sheet that
 * control opened closes.
 */
let lastPressed: HTMLElement | null = null;
if (typeof document !== "undefined")
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastPressed = e.target instanceof Element ? e.target.closest<HTMLElement>("button, a[href], [tabindex]") : null;
    },
    true
  );

export function Sheet({ open, onClose, title, sub, role = "dialog", testId, vars, children }: Props) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [ids] = useState(() => {
    seq += 1;
    return { title: `sheet-title-${seq}`, sub: `sheet-sub-${seq}` };
  });

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (open) {
      const a = document.activeElement;
      opener.current = a instanceof HTMLElement && a !== document.body ? a : lastPressed;
      setMounted(true);
      // Two frames: the sheet is laid out closed first, so opening it slides.
      let f2 = 0;
      const f1 = requestAnimationFrame(() => {
        f2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(f1);
        cancelAnimationFrame(f2);
      };
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), reduce ? 0 : 300);
    const back = opener.current;
    opener.current = null;
    if (back && back.isConnected) back.focus({ preventScroll: true });
    return () => window.clearTimeout(t);
  }, [open]);

  // The library opens a sheet with the `open` attribute (.sheet[open]).
  useEffect(() => {
    sheetRef.current?.toggleAttribute("open", shown);
  }, [shown, mounted]);

  useEffect(() => {
    if (shown) titleRef.current?.focus({ preventScroll: true });
  }, [shown]);

  // Escape closes from the moment the sheet opens, before its slide ends.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);

  // Swipe down on the head: the sheet follows the finger; past 30% of its height or a flick it closes, else springs back.
  const drag = useRef<{ id: number; y0: number; dy: number; lastY: number; lastT: number; v: number } | null>(null);
  const down = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    const el = sheetRef.current;
    if (!d || e.pointerId !== d.id || !el) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    if (d.dy > 4) {
      el.dataset.dragging = "true";
      el.style.transform = `translateY(${d.dy}px)`;
    }
  };
  const up = (e: PointerEvent) => {
    const d = drag.current;
    const el = sheetRef.current;
    if (!d || e.pointerId !== d.id || !el) return;
    drag.current = null;
    el.dataset.dragging = "false";
    el.style.transform = "";
    const far = d.dy >= el.offsetHeight * 0.3;
    const flick = d.v >= 0.5 && d.dy >= 24;
    if (e.type !== "pointercancel" && (far || flick)) close.current();
  };

  if (!mounted) return null;
  return (
    <>
      <div class="scrim" data-open={shown ? "true" : "false"} aria-hidden="true" onClick={() => close.current()} />
      <div
        ref={sheetRef}
        class="sheet"
        role={role}
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={sub ? ids.sub : undefined}
        data-testid={testId}
        style={vars}
      >
        <div class="sheet__head" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <span class="sheet__grabber" aria-hidden="true" />
          <h2 ref={titleRef} id={ids.title} class="sheet__title" tabIndex={-1}>
            {title}
          </h2>
          {sub ? (
            <span id={ids.sub} class="caption">
              {sub}
            </span>
          ) : null}
        </div>
        {children}
      </div>
    </>
  );
}

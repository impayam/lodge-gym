// The one shared 3D body (SPEC-v12 M15 §3.3): every screen that shows the body renders this component, so a later
// redesign of the body (its look, levels, growth) lands here and in ../lib/anatomy3d.ts, and every screen follows.
// It owns the lazy load of the model, the 10 s timeout, dispose, Front / Back, the area zoom with "← Body", the
// "Drag to turn" hint and the fallback ("3D unavailable." and Retry; no drawn figure, a proper fallback is for the
// native app).
//
// Callers give the colour of each muscle as a token name (`tints`), what a tap in a close-up shows (`card`) and,
// for the exercise picker, a handle to zoom from its area chips. Unmapped tissue stays dark (the view draws it).

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { areaDef, areaOfMuscle, type BodyArea, type FigureView } from "../../../worker/lib/bodyAreas";
import type { Muscle } from "../../../worker/lib/muscles";
import type { AnatomyView } from "../lib/anatomy3d";
import type { TintToken } from "../lib/anatomy-status";
import { token } from "../lib/tokens";

/** SPEC-v6 §5: a model that has not loaded after 10 s gives way to the fallback (the note and Retry). */
const LOAD_TIMEOUT_MS = 10_000;

export type { TintToken };

export interface BodyPlace {
  /** Area the model is zoomed to (null: the whole body). */
  area: BodyArea | null;
  /** Side facing the viewer. */
  view: FigureView;
  /** Muscle selected in a close-up. */
  selected: Muscle | null;
}

export const WHOLE_BODY: BodyPlace = { area: null, view: "front", selected: null };

/** Zooms the body from outside (the picker's area chips). */
export interface Body3DHandle {
  zoom: (area: BodyArea | null, view?: FigureView) => void;
}

export interface Body3DIds {
  stage: string;
  front: string;
  back: string;
  body: string;
  hint: string;
  card: string;
}

const DEFAULT_IDS: Body3DIds = { stage: "body3d", front: "body3d-front", back: "body3d-back", body: "body3d-body", hint: "body3d-hint", card: "body3d-card" };

/** What a tap on a muscle shows: the card's content and data attributes (for tests and styles). */
export interface BodyCard {
  body: ComponentChildren;
  data?: Record<string, string>;
}

/** The "Drag to turn" hint shows until the first touch on a model, once per app run and caller. */
const hintDone = new Set<string>();

export function Body3D({
  tints,
  size = "default",
  place: initial = WHOLE_BODY,
  onPlace,
  card,
  legend,
  fallbackNote = "3D unavailable.",
  fallbackExtra,
  handle,
  ids: idsIn,
  hintKey = "body",
  label,
  onMode,
}: {
  /** The colour of each app muscle; without one, the model's own muscle colour and the picker's accent. */
  tints?: ReadonlyMap<Muscle, TintToken>;
  size?: "default" | "picker" | "profile";
  /** Where to start (the picker remembers its place per session). */
  place?: BodyPlace;
  onPlace?: (p: BodyPlace) => void;
  /** What a tap on a muscle in a close-up shows; null: nothing. */
  card?: (muscle: Muscle) => BodyCard | null;
  /** Shown under the 3D body (not with the fallback). */
  legend?: ComponentChildren;
  fallbackNote?: string;
  /** Shown under the fallback note (the picker's ← Body). */
  fallbackExtra?: ComponentChildren;
  handle?: { current: Body3DHandle | null };
  ids?: Partial<Body3DIds>;
  hintKey?: string;
  /** What the body shows, for screen readers (the list or card beside it carries the numbers). */
  label?: string;
  /** Loading, the 3D model, or the fallback. */
  onMode?: (mode: "loading" | "3d" | "fallback") => void;
}) {
  const ids = { ...DEFAULT_IDS, ...idsIn };
  const host = useRef<HTMLDivElement>(null);
  const view3d = useRef<AnatomyView | null>(null);
  const [mode, setModeState] = useState<"loading" | "3d" | "fallback">("loading");
  const setMode = (m: "loading" | "3d" | "fallback") => {
    setModeState(m);
    onMode?.(m);
  };
  const [place, setPlaceState] = useState<BodyPlace>(initial);
  const [hint, setHint] = useState(!hintDone.has(hintKey));
  // Retry after the fallback loads the model again (a new attempt runs the load effect again).
  const [attempt, setAttempt] = useState(0);
  const placeRef = useRef(place);
  placeRef.current = place;
  const tintsRef = useRef(tints);
  tintsRef.current = tints;
  const go = (patch: Partial<BodyPlace>) => {
    const next = { ...placeRef.current, ...patch };
    placeRef.current = next;
    setPlaceState(next);
    onPlace?.(next);
  };
  const colours = (t: ReadonlyMap<Muscle, TintToken> | undefined) => (t ? new Map([...t].map(([m, k]) => [m, token(k)])) : undefined);

  function zoom(area: BodyArea | null, view: FigureView) {
    go({ area, view, selected: null });
    view3d.current?.setArea(area, view);
    view3d.current?.select(null);
  }
  if (handle) handle.current = { zoom: (area, view) => zoom(area, view ?? (area ? areaDef(area).views[0] : placeRef.current.view)) };

  useEffect(() => {
    const openedAt = performance.now();
    let view: AnatomyView | null = null;
    let gone = false;
    const timer = window.setTimeout(() => {
      gone = true;
      setMode("fallback");
    }, LOAD_TIMEOUT_MS);
    import("../lib/anatomy3d")
      .then((m) =>
        m.AnatomyView.create(host.current!, {
          onSelect: (muscle) => {
            const p = placeRef.current;
            if (!p.area) {
              // Whole body: the tap picks the muscle's area and zooms in, on the side the body faces now.
              const area = muscle ? areaOfMuscle(muscle) : null;
              if (area) zoom(area, p.view);
              return;
            }
            go({ selected: muscle });
            view3d.current?.select(muscle);
          },
          onFacing: (v) => go({ view: v }),
          accent: token("--model-accent"),
          openedAt,
          tints: colours(tintsRef.current),
        })
      )
      .then((v) => {
        view = v;
        if (gone) return v.dispose();
        clearTimeout(timer);
        const p = placeRef.current;
        if (p.area) v.setArea(p.area, p.view, false);
        else if (p.view !== "front") v.setView(p.view);
        v.select(p.selected);
        view3d.current = v;
        setMode("3d");
      })
      .catch(() => {
        if (gone) return;
        gone = true;
        clearTimeout(timer);
        setMode("fallback");
      });
    return () => {
      gone = true;
      clearTimeout(timer);
      view?.dispose();
      view3d.current = null;
    };
  }, [attempt]);

  // New numbers (a set done, a sync): new colours, without reloading the model.
  const tintKey = tints ? [...tints].map(([m, k]) => `${m}:${k}`).join(",") : "";
  useEffect(() => {
    const c = colours(tints);
    if (c) view3d.current?.setTints(c);
  }, [tintKey]);

  const turn = (view: FigureView) => {
    go({ view });
    view3d.current?.setView(view);
  };
  const def = place.area ? areaDef(place.area) : null;
  const back = def ? (
    <button type="button" class="clay press btn-sm t-muted" data-testid={ids.body} onClick={() => zoom(null, placeRef.current.view)}>
      ← Body
    </button>
  ) : null;

  if (mode === "fallback")
    return (
      <>
        <div class="stage__off l-row l-between l-gap-10" data-testid="anatomy-fallback" role="status">
          <span>{fallbackNote}</span>
          <button
            type="button"
            class="clay press btn-sm btn--fit t-muted"
            data-testid="anatomy-retry"
            onClick={() => {
              setMode("loading");
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
        {fallbackExtra ?? (back ? <div class="l-row">{back}</div> : null)}
      </>
    );

  const shown = place.selected && card ? card(place.selected) : null;
  return (
    <>
      <div
        class={size === "picker" ? "stage stage--picker" : size === "profile" ? "stage stage--profile" : "stage"}
        data-testid={ids.stage}
        data-mode={mode}
        data-area={place.area ?? ""}
        data-view={place.view}
        role={label ? "img" : undefined}
        aria-label={label}
        onPointerDown={(e) => {
          // A touch on the model itself (not on Front / Back or ← Body) retires the hint.
          if ((e.target as Element).tagName !== "CANVAS") return;
          hintDone.add(hintKey);
          setHint(false);
        }}
      >
        <div class="stage__canvas" ref={host} />
        {mode === "loading" ? <div class="stage__msg">Loading the 3D body…</div> : null}
        <div class="stage__top">
          {back ?? <span />}
          {mode === "3d" ? (
            <span class="segmented" role="group" aria-label="Side">
              {(["front", "back"] as const).map((v) => (
                <button type="button" class="press" aria-pressed={place.view === v} data-testid={v === "front" ? ids.front : ids.back} onClick={() => turn(v)}>
                  {v === "front" ? "Front" : "Back"}
                </button>
              ))}
            </span>
          ) : null}
        </div>
        {mode === "3d" && !shown ? (
          <span class="stage__hint" data-gone={hint ? "false" : "true"} data-testid={ids.hint} aria-hidden="true">
            Drag to turn.
            <br />
            {def ? "Tap a muscle." : "Tap to zoom in."}
          </span>
        ) : null}
        {mode === "3d" && shown ? (
          <div class="stage__card" data-testid={ids.card} data-muscle={place.selected!} {...dataAttrs(shown.data)} aria-live="polite">
            {shown.body}
          </div>
        ) : null}
      </div>
      {legend}
    </>
  );
}

const dataAttrs = (d: Record<string, string> | undefined) => Object.fromEntries(Object.entries(d ?? {}).map(([k, v]) => [`data-${k}`, v]));

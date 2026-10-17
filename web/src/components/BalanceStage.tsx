// The 3D muscle map of Reports (SPEC-v6 §8): the picker's model, scene, mapping and lazy loading, with every mapped
// muscle in the colour of its weekly status (../lib/anatomy-status.ts) and unmapped muscles dark. Drag turns the body,
// Front / Back turn it round; on the whole body a tap zooms to the muscle's area (as in the picker); in a close-up a
// tap shows the muscle's card with its done / target sets this week; "← Body" goes back. The list under the map stays
// the accessible alternative; without WebGL 2, or when the model fails or takes over 10 s, the caller's fallback shows.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { areaDef, areaOfMuscle, type BodyArea, type FigureView } from "../../../worker/lib/bodyAreas";
import type { Muscle } from "../../../worker/lib/muscles";
import type { BalanceStatus, MuscleRow } from "../../../worker/lib/reports";
import { fmtNum } from "../format";
import type { AnatomyView } from "../lib/anatomy3d";
import { STAGE_STATUS_TOKEN, muscleState, stageTints } from "../lib/anatomy-status";
import { token } from "../lib/tokens";
import { muscleLabel } from "../views/Library";

/** SPEC-v6 §5: a model that has not loaded after 10 s gives way to the fallback. */
const LOAD_TIMEOUT_MS = 10_000;

const accentColor = () => token("--model-accent");
const stageStatusColor = (status: BalanceStatus) => token(STAGE_STATUS_TOKEN[status]);

export interface StatusText {
  name: Record<BalanceStatus, string>;
  icon: Record<BalanceStatus, string>;
  group: (g: string) => string;
}

interface Place {
  area: BodyArea | null;
  view: FigureView;
  selected: Muscle | null;
}

export function BalanceStage({ muscles, text, fallback }: { muscles: MuscleRow[]; text: StatusText; fallback: ComponentChildren }) {
  const host = useRef<HTMLDivElement>(null);
  const view3d = useRef<AnatomyView | null>(null);
  const [mode, setMode] = useState<"loading" | "3d" | "fallback">("loading");
  const [place, setPlace] = useState<Place>({ area: null, view: "front", selected: null });
  const [hint, setHint] = useState(true);
  const placeRef = useRef(place);
  placeRef.current = place;
  const rowsRef = useRef(muscles);
  rowsRef.current = muscles;
  const go = (patch: Partial<Place>) => setPlace((p) => ({ ...p, ...patch }));

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
          accent: accentColor(),
          openedAt,
          tints: stageTints(rowsRef.current, stageStatusColor),
        })
      )
      .then((v) => {
        view = v;
        if (gone) return v.dispose();
        clearTimeout(timer);
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
  }, []);

  // New numbers (another week, a sync): new colours.
  useEffect(() => {
    view3d.current?.setTints(stageTints(muscles, stageStatusColor));
  }, [muscles]);

  function zoom(area: BodyArea | null, view: FigureView) {
    go({ area, view, selected: null });
    view3d.current?.setArea(area, view);
    view3d.current?.select(null);
  }
  const turn = (view: FigureView) => {
    go({ view });
    view3d.current?.setView(view);
  };

  if (mode === "fallback")
    return (
      <>
        <div class="stage__off" data-testid="anatomy-fallback">
          3D unavailable.
        </div>
        {fallback}
      </>
    );

  const st = place.selected ? muscleState(muscles, place.selected) : null;
  const def = place.area ? areaDef(place.area) : null;
  return (
    <>
      <div
        class="stage"
        data-testid="balance-stage"
        data-mode={mode}
        data-area={place.area ?? ""}
        onPointerDown={(e) => {
          if ((e.target as Element).tagName === "CANVAS") setHint(false);
        }}
      >
        <div class="stage__canvas" ref={host} />
        {mode === "loading" ? <div class="stage__msg">Loading the 3D body…</div> : null}
        <div class="stage__top">
          {def ? (
            <button type="button" class="clay press btn-sm t-muted" data-testid="balance-body" onClick={() => zoom(null, placeRef.current.view)}>
              ← Body
            </button>
          ) : (
            <span />
          )}
          {mode === "3d" ? (
            <span class="segmented" role="group" aria-label="Side">
              {(["front", "back"] as const).map((v) => (
                <button type="button" class="press" aria-pressed={place.view === v} data-testid={`balance-${v}`} onClick={() => turn(v)}>
                  {v === "front" ? "Front" : "Back"}
                </button>
              ))}
            </span>
          ) : null}
        </div>
        {mode === "3d" && !st ? (
          <span class="stage__hint" data-gone={hint ? "false" : "true"} aria-hidden="true">
            Drag to turn.
            <br />
            {def ? "Tap a muscle." : "Tap to zoom in."}
          </span>
        ) : null}
        {st ? (
          <div class="stage__card" data-testid="balance-card" data-muscle={st.muscle} data-status={st.status} aria-live="polite">
            <span class="l-col">
              <span>
                <b>{muscleLabel(st.muscle)}</b>
                {text.group(st.group) !== muscleLabel(st.muscle) ? <span class="caption"> · {text.group(st.group)}</span> : null}
              </span>
              <span class="num">
                {st.row?.target != null
                  ? st.row.basis === "direct"
                    ? `${fmtNum(st.row.sets)} / ${fmtNum(st.row.target)} direct sets this week`
                    : `${fmtNum(st.row.fractional, 1)} / ${fmtNum(st.row.target)} sets this week`
                  : `${fmtNum(st.row?.fractional ?? 0, 1)} sets this week, no target`}
              </span>
            </span>
            {/* "No sets" is too dark to read in its own colour: it stays in the secondary ink. */}
            <span class="balance-list__status" style={st.status === "none" ? undefined : { color: stageStatusColor(st.status) }}>
              {text.icon[st.status]} {text.name[st.status]}
            </span>
          </div>
        ) : null}
      </div>
      <div class="chart-legend" data-testid="balance-legend">
        {(["under", "on", "over", "untracked", "none"] as BalanceStatus[]).map((s) => (
          <span>
            <span class="chart-legend__swatch" style={{ background: stageStatusColor(s) }} /> {text.icon[s]} {text.name[s]}
          </span>
        ))}
        <span>
          <span class="chart-legend__swatch" style={{ background: "var(--model-context)" }} /> Not mapped
        </span>
      </div>
    </>
  );
}

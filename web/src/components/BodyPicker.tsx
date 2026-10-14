// Body-map exercise picker (SPEC-v3 M9b with the SPEC-v6 3D model), the "Body" tab of "+ Add exercise":
//   1. the whole 3D body (lazily loaded, see ../lib/anatomy3d.ts): drag turns it, Front / Back turn it round; a tap on
//      a muscle, or an area chip, zooms to that area's close-up;
//   2. the close-up: a tap lights up a muscle group on both sides with "Show exercises"; the area's muscle chips
//      replace the area chips and open the list directly; "← Body" goes back (the chips do everything the model does,
//      and work without it);
//   3. the exercises for the chosen muscle: primary first, then "Also works this muscle", with filters;
//   4. tapping an exercise adds it to the session (the caller's onPick). Back goes list → body, and the place is
//      remembered while the app is open, per session.
// Without WebGL 2, or when the model fails or takes over 10 s, only the chips show, with a "3D unavailable" note.

import { useEffect, useRef, useState } from "preact/hooks";
import { BODY_AREAS, areaDef, areaOfMuscle, musclePicks, type BodyArea, type CategoryFilter, type FigureView } from "../../../worker/lib/bodyAreas";
import { CATEGORIES, countsVolume } from "../../../worker/lib/category";
import type { Muscle } from "../../../worker/lib/muscles";
import type { Equipment, Exercise, WorkoutSession } from "../../../worker/lib/types";
import { dayMonth, fmtNum, ytLink } from "../format";
import type { AnatomyView } from "../lib/anatomy3d";
import { loadLibrary, useStore } from "../store";
import { CATEGORY_LABEL, EquipmentIcon, equipmentLabel, muscleLabel } from "../views/Library";
import { IconPlay } from "./PulseIcons";
import { token } from "../lib/tokens";

interface Place {
  step: "body" | "list";
  /** Area the model is zoomed to (null: the whole body). */
  area: BodyArea | null;
  /** Side facing the viewer. */
  view: FigureView;
  /** Muscle lit up on the model. */
  selected: Muscle | null;
  /** Muscle whose exercises the list shows. */
  muscle: string | null;
  equipment: Equipment | "";
  category: CategoryFilter;
}

/** The "Drag to turn" hint shows until the first touch on the model, once per app run. */
let hintDone = false;

const START: Place = { step: "body", area: null, view: "front", selected: null, muscle: null, equipment: "", category: "counted" };
/** Where the picker was left, per session, while the app stays open. */
const memory = new Map<string, Place>();

const EQUIPMENT: Equipment[] = ["barbell", "dumbbell", "cable", "machine", "bodyweight"];
/** SPEC-v6 §5: a model that has not loaded after 10 s gives way to the chips. */
const LOAD_TIMEOUT_MS = 10_000;

type Go = (patch: Partial<Place>, scroll?: boolean) => void;

export function BodyPicker({ sessionId, onPick }: { sessionId: string; onPick: (ex: Exercise) => void }) {
  const [place, setPlace] = useState<Place>(() => memory.get(sessionId) ?? START);
  const go: Go = (patch, scroll = true) => {
    setPlace((prev) => {
      const next = { ...prev, ...patch };
      memory.set(sessionId, next);
      return next;
    });
    if (scroll) window.scrollTo(0, 0);
  };
  useEffect(() => {
    void loadLibrary();
  }, []);

  if (place.step === "list" && place.muscle) return <MuscleList place={place} go={go} onPick={onPick} />;
  return <BodyStep place={place} go={go} />;
}

const accentColor = () => token("--model-accent");

function BodyStep({ place, go }: { place: Place; go: Go }) {
  const host = useRef<HTMLDivElement>(null);
  const view3d = useRef<AnatomyView | null>(null);
  const [mode, setMode] = useState<"loading" | "3d" | "fallback">("loading");
  const [hint, setHint] = useState(!hintDone);
  const placeRef = useRef(place);
  placeRef.current = place;

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
            go({ selected: muscle }, false);
            view3d.current?.select(muscle);
          },
          onFacing: (v) => go({ view: v }, false),
          accent: accentColor(),
          openedAt,
        })
      )
      .then((v) => {
        view = v;
        if (gone) return v.dispose();
        clearTimeout(timer);
        const p = placeRef.current;
        v.setArea(p.area, p.view, false);
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
  }, []);

  /** Enters an area's close-up, or goes back to the whole body. The muscle is chosen in the close-up only. */
  function zoom(area: BodyArea | null, view: FigureView) {
    go({ area, view, selected: null }, false);
    view3d.current?.setArea(area, view);
    view3d.current?.select(null);
  }
  // A chip opens the close-up on the area's first side (the camera preset's side, ../lib/anatomy-camera.ts).
  const chooseArea = (area: BodyArea | null) => zoom(area, area ? areaDef(area).views[0] : placeRef.current.view);
  const turn = (view: FigureView) => {
    go({ view }, false);
    view3d.current?.setView(view);
  };
  const def = place.area ? areaDef(place.area) : null;

  const sides =
    mode === "3d" ? (
      <span class="segmented" role="group" aria-label="Side">
        {(["front", "back"] as const).map((v) => (
          <button type="button" class="press" aria-pressed={place.view === v} data-testid={`view-${v}`} onClick={() => turn(v)}>
            {v === "front" ? "Front" : "Back"}
          </button>
        ))}
      </span>
    ) : null;
  const back = def ? (
    <button type="button" class="clay press btn-sm t-muted" data-testid="pick-back" onClick={() => chooseArea(null)}>
      ← Body
    </button>
  ) : null;

  return (
    <div class="l-col l-gap-12" data-testid="body-step" data-area={place.area ?? ""} data-mode={mode}>
      {mode === "fallback" ? (
        <>
          <div class="stage__off" data-testid="anatomy-fallback">
            3D unavailable. Pick an area, then a muscle.
          </div>
          {back ? <div class="l-row">{back}</div> : null}
        </>
      ) : (
        <div
          class="stage stage--picker"
          data-testid="anatomy"
          onPointerDown={(e) => {
            // A touch on the model itself (not on Front / Back or ← Body) retires the hint.
            if ((e.target as Element).tagName !== "CANVAS") return;
            hintDone = true;
            setHint(false);
          }}
        >
          <div class="stage__canvas" ref={host} />
          {mode === "loading" ? <div class="stage__msg">Loading the 3D body…</div> : null}
          <div class="stage__top">
            {back ?? <span />}
            {sides}
          </div>
          {mode === "3d" && !place.selected ? (
            <span class="stage__hint" data-gone={hint ? "false" : "true"} data-testid="anatomy-hint" aria-hidden="true">
              Drag to turn.
              <br />
              {def ? "Tap a muscle." : "Tap to zoom in."}
            </span>
          ) : null}
          {mode === "3d" && place.selected ? (
            <div class="stage__card" data-testid="anatomy-selection" data-muscle={place.selected}>
              <b class="t-title">{muscleLabel(place.selected)}</b>
              <button type="button" class="clay press btn-sm t-pink" data-testid="show-exercises" onClick={() => go({ step: "list", muscle: place.selected })}>
                Show exercises
              </button>
            </div>
          ) : null}
        </div>
      )}
      {def ? (
        // In a close-up the area's muscle chips take the place of the area chips; "← Body" goes back.
        <div class="chip-wrap" role="group" aria-label={`${def.label} muscles`} data-testid="muscle-chips">
          {def.muscles.map((m) => (
            <button type="button" class="clay press chip chip--lg" data-testid={`muscle-${m}`} onClick={() => go({ step: "list", muscle: m, selected: m })}>
              {muscleLabel(m)}
            </button>
          ))}
        </div>
      ) : (
        <div class="chip-wrap" role="group" aria-label="Body areas" data-testid="area-chips">
          {BODY_AREAS.map((a) => (
            <button type="button" class="clay press chip chip--lg" data-testid={`area-${a.key}`} onClick={() => chooseArea(a.key)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Last time each exercise was done: when (for sorting) and the heaviest set (for the row). */
function lastDone(sessions: Record<string, WorkoutSession>) {
  const out = new Map<string, { when: string; text: string }>();
  const done = Object.values(sessions)
    .filter((s) => s.status === "done")
    .sort((a, b) => (b.local_date + b.started_at).localeCompare(a.local_date + a.started_at));
  for (const s of done) {
    const by = new Map<string, typeof s.sets>();
    for (const x of s.sets) if (x.done && (x.weight != null || x.reps != null || x.seconds != null)) by.set(x.exercise_id, [...(by.get(x.exercise_id) ?? []), x]);
    for (const [id, sets] of by) {
      if (out.has(id)) continue;
      const timed = sets.filter((x) => x.seconds != null);
      const top = timed.length
        ? `${fmtNum(Math.max(...timed.map((x) => x.seconds!)))} s`
        : (() => {
            const best = [...sets].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (b.reps ?? 0) - (a.reps ?? 0))[0];
            return best.weight != null ? `${fmtNum(best.weight)} ${s.unit} × ${fmtNum(best.reps)}` : `${fmtNum(best.reps)} reps`;
          })();
      out.set(id, { when: s.local_date + s.started_at, text: `${top} · ${dayMonth(s.local_date)}` });
    }
  }
  return out;
}

function MuscleList({ place, go, onPick }: { place: Place; go: Go; onPick: (ex: Exercise) => void }) {
  const boot = useStore((s) => s.boot)!;
  const library = useStore((s) => s.library);
  const sessions = useStore((s) => s.sessions);
  const muscle = place.muscle!;
  const last = lastDone(sessions);
  const programIds = new Set(boot.program.days.flatMap((d) => d.exercises.map((x) => x.exercise_id)));
  const all = library ?? boot.exercises;
  const { primary, secondary } = musclePicks(all, muscle, {
    equipment: place.equipment,
    category: place.category,
    lastDone: new Map([...last].map(([id, v]) => [id, v.when])),
    programIds,
  });
  const [more, setMore] = useState(false);
  const row = (e: Exercise) => {
    const l = last.get(e.id);
    return (
      <div class="card ex-row" data-testid="pick-row" data-id={e.id}>
        <button type="button" class="ex-row__main press" onClick={() => onPick(e)}>
          <span class="well icon-well icon-well--44 t-violet">
            <EquipmentIcon equipment={e.equipment} size={22} />
          </span>
          <span class="list-row__text">
            <b class="t-title">{e.name_en}</b>
            <span class="caption num">
              {equipmentLabel(e.equipment)}
              {countsVolume(e.category) ? "" : " · not counted"}
              {l ? ` · Last: ${l.text}` : programIds.has(e.id) ? " · in your program" : ""}
            </span>
          </span>
        </button>
        <a class="btn-icon btn-icon--soft press" href={ytLink(e.name_en)} target="_blank" rel="noopener noreferrer" aria-label={`Form video: ${e.name_en}`}>
          <IconPlay />
        </a>
      </div>
    );
  };
  return (
    <div class="l-col l-gap-12" data-testid="muscle-step" data-muscle={muscle}>
      <div class="l-row">
        <button type="button" class="clay press btn-sm t-muted" data-testid="pick-back" onClick={() => go({ step: "body" })}>
          ← {place.area ? areaDef(place.area).label : "Body"}
        </button>
      </div>
      <h2 class="screen-head__title l-m0">{muscleLabel(muscle)}</h2>
      <div class="l-grid-2 l-gap-8">
        <select class="input" aria-label="Equipment" value={place.equipment} onChange={(e) => go({ equipment: (e.currentTarget as HTMLSelectElement).value as Equipment | "" })}>
          <option value="">All equipment</option>
          {EQUIPMENT.map((k) => (
            <option value={k}>{equipmentLabel(k)}</option>
          ))}
        </select>
        <select class="input" aria-label="Category" value={place.category} onChange={(e) => go({ category: (e.currentTarget as HTMLSelectElement).value as CategoryFilter })}>
          <option value="counted">Strength (counted)</option>
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option value={c}>
              {CATEGORY_LABEL[c]}
              {countsVolume(c) ? "" : " (not counted)"}
            </option>
          ))}
        </select>
      </div>
      {library === null ? <span class="skeleton" style={{ height: "76px" }} aria-label="Loading the library" /> : null}
      <div class="l-col l-gap-8" data-testid="pick-primary">
        {primary.map(row)}
        {!primary.length ? <p class="state l-m0">No exercise has {muscleLabel(muscle).toLowerCase()} as its main muscle with these filters.</p> : null}
      </div>
      {secondary.length ? (
        <div class="l-col l-gap-8" data-testid="pick-secondary">
          <button type="button" class="clay press btn t-muted" aria-expanded={more} onClick={() => setMore(!more)}>
            Also works this muscle ({fmtNum(secondary.length)})
          </button>
          {more ? secondary.map(row) : null}
        </div>
      ) : null}
    </div>
  );
}

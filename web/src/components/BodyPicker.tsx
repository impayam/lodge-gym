// Body-map exercise picker (SPEC-v3 M9b), the "Body" tab of "+ Add exercise":
//   1. the front and back figures (the muscle map's drawing, no status colours): tap an area, or its chip;
//   2. the area enlarged, each muscle its own tap target, with large muscle chips and a front/back toggle;
//   3. the exercises for the chosen muscle: primary first, then "Also works this muscle", with filters;
//   4. tapping an exercise adds it to the session (the caller's onPick). Back goes list → area → body, and the place
//      is remembered while the app is open, per session.

import { useEffect, useState } from "preact/hooks";
import { BODY_AREAS, areaDef, areaOfMuscle, musclePicks, type BodyArea, type CategoryFilter, type FigureView } from "../../../worker/lib/bodyAreas";
import { CATEGORIES, countsVolume } from "../../../worker/lib/category";
import type { Equipment, Exercise, WorkoutSession } from "../../../worker/lib/types";
import { dayMonth, fmtNum, ytLink } from "../format";
import { loadLibrary, useStore } from "../store";
import { CATEGORY_LABEL, ExerciseThumb, equipmentLabel, muscleLabel } from "../views/Library";
import { BACK, FRONT, SILHOUETTE, VIEW_H, VIEW_W, mirrorPath, type HalfRegion } from "./bodyMap";

interface Place {
  step: "body" | "area" | "list";
  area: BodyArea | null;
  view: FigureView;
  muscle: string | null;
  equipment: Equipment | "";
  category: CategoryFilter;
}

const START: Place = { step: "body", area: null, view: "front", muscle: null, equipment: "", category: "counted" };
/** Where the picker was left, per session, while the app stays open. */
const memory = new Map<string, Place>();

const HALVES: Record<FigureView, HalfRegion[]> = { front: FRONT, back: BACK };
const EQUIPMENT: Equipment[] = ["barbell", "dumbbell", "cable", "machine", "bodyweight"];
/** Height of the enlarged area, in CSS pixels. */
const ZOOM_H = 340;

/** Bounding box of absolute path data (control points included, so it never cuts a curve). */
function bbox(ds: string[]) {
  const n = ds.flatMap((d) => d.match(/-?\d+(\.\d+)?/g)!.map(Number));
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** The area's muscles in one view: left-half paths, plus the mirror when the muscle reaches the body's midline. */
function areaShapes(area: BodyArea, view: FigureView) {
  const muscles = new Set<string>(areaDef(area).muscles);
  const half = HALVES[view].filter((r) => muscles.has(r.key));
  const central = half.length > 0 && bbox(half.map((r) => r.d)).x1 >= 95;
  return { shapes: central ? half.flatMap((r) => [r, { key: r.key, d: mirrorPath(r.d) }]) : half };
}

export function BodyPicker({ sessionId, onPick }: { sessionId: string; onPick: (ex: Exercise) => void }) {
  const [place, setPlace] = useState<Place>(() => memory.get(sessionId) ?? START);
  const go = (patch: Partial<Place>) => {
    const next = { ...place, ...patch };
    memory.set(sessionId, next);
    setPlace(next);
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    void loadLibrary();
  }, []);

  if (place.step === "list" && place.muscle && place.area)
    return <MuscleList place={place} go={go} onPick={onPick} />;
  if (place.step === "area" && place.area) return <AreaView place={place} go={go} />;
  return <BodyStep go={go} />;
}

function BodyStep({ go }: { go: (p: Partial<Place>) => void }) {
  const open = (area: BodyArea, view: FigureView) => go({ step: "area", area, view: areaDef(area).views.includes(view) ? view : areaDef(area).views[0] });
  const figure = (view: FigureView, title: string) => {
    const regions = HALVES[view].flatMap((r) => [r, { key: r.key, d: mirrorPath(r.d) }]);
    return (
      <figure class="figure">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={`${title}: tap a body area`}>
          <path d={SILHOUETTE} class="body" />
          {/* A wide invisible stroke under each muscle makes small areas easier to hit. */}
          {regions.map((r) => (
            <path d={r.d} class="pick-hit" onClick={() => open(areaOfMuscle(r.key)!, view)} />
          ))}
          {regions.map((r) => (
            <path d={r.d} class="pick-muscle" data-muscle={r.key} data-area={areaOfMuscle(r.key)!} onClick={() => open(areaOfMuscle(r.key)!, view)}>
              <title>{areaDef(areaOfMuscle(r.key)!).label}</title>
            </path>
          ))}
        </svg>
        <figcaption>{title}</figcaption>
      </figure>
    );
  };
  return (
    <div class="stack bodypick" data-testid="body-step">
      <div class="why">Tap a body area, or pick one below.</div>
      <div class="figures">
        {figure("front", "Front")}
        {figure("back", "Back")}
      </div>
      <div class="bigchips" role="group" aria-label="Body areas">
        {BODY_AREAS.map((a) => (
          <button type="button" class="bigchip" data-testid={`area-${a.key}`} onClick={() => go({ step: "area", area: a.key, view: a.views[0] })}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AreaView({ place, go }: { place: Place; go: (p: Partial<Place>) => void }) {
  const def = areaDef(place.area!);
  const view = place.view;
  const { shapes } = areaShapes(def.key, view);
  const box = bbox(shapes.map((r) => r.d));
  const pad = 8;
  const vb = { x: Math.max(0, box.x0 - pad), y: Math.max(0, box.y0 - pad), w: 0, h: 0 };
  vb.w = Math.min(VIEW_W, box.x1 + pad) - vb.x;
  vb.h = Math.min(VIEW_H, box.y1 + pad) - vb.y;
  // The rest of the figure stays as faint context.
  const context = HALVES[view].flatMap((r) => [r, { key: r.key, d: mirrorPath(r.d) }]).filter((r) => !def.muscles.includes(r.key));
  const pickMuscle = (m: string) => go({ step: "list", muscle: m });
  return (
    <div class="stack bodypick" data-testid="area-step" data-area={def.key}>
      <div class="kv navrow">
        <button type="button" class="btn btn-ghost btn-small" data-testid="pick-back" onClick={() => go({ step: "body" })}>
          ← Body
        </button>
        {def.views.length > 1 ? (
          <span class="seg" role="group" aria-label="Side">
            {def.views.map((v) => (
              <button type="button" aria-pressed={view === v} data-testid={`view-${v}`} onClick={() => go({ view: v })}>
                {v === "front" ? "Front" : "Back"}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      <h2 style={{ margin: 0 }}>{def.label}</h2>
      {/* The drawing box has the zoomed area's own proportions, at most 340 px tall, so nothing else shows beside it. */}
      <svg class="zoom" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} style={{ width: `min(100%, ${Math.round((ZOOM_H * vb.w) / vb.h)}px)`, aspectRatio: `${vb.w} / ${vb.h}` }} role="img" aria-label={`${def.label}, ${view === "front" ? "front" : "back"}: tap a muscle`}>
        <path d={SILHOUETTE} class="body" />
        {context.map((r) => (
          <path d={r.d} class="pick-context" />
        ))}
        {shapes.map((r) => (
          <path d={r.d} class="pick-muscle on" data-muscle={r.key} onClick={() => pickMuscle(r.key)}>
            <title>{muscleLabel(r.key)}</title>
          </path>
        ))}
      </svg>
      <div class="bigchips" role="group" aria-label={`${def.label} muscles`}>
        {def.muscles.map((m) => (
          <button type="button" class="bigchip" data-testid={`muscle-${m}`} onClick={() => pickMuscle(m)}>
            {muscleLabel(m)}
          </button>
        ))}
      </div>
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

function MuscleList({ place, go, onPick }: { place: Place; go: (p: Partial<Place>) => void; onPick: (ex: Exercise) => void }) {
  const boot = useStore((s) => s.boot)!;
  const library = useStore((s) => s.library);
  const sessions = useStore((s) => s.sessions);
  const muscle = place.muscle!;
  const def = areaDef(place.area!);
  const last = lastDone(sessions);
  const programIds = new Set(boot.program.days.flatMap((d) => d.exercises.map((x) => x.exercise_id)));
  const all = library ?? boot.exercises;
  const { primary, secondary } = musclePicks(all, muscle, {
    equipment: place.equipment,
    category: place.category,
    lastDone: new Map([...last].map(([id, v]) => [id, v.when])),
    programIds,
  });
  const row = (e: Exercise) => {
    const l = last.get(e.id);
    return (
      <div class="pickrow" data-testid="pick-row" data-id={e.id}>
        <button type="button" class="pickmain" onClick={() => onPick(e)}>
          <ExerciseThumb ex={e} />
          <span class="meta">
            <b>{e.name_en}</b>
            <small>
              {equipmentLabel(e.equipment)}
              {countsVolume(e.category) ? "" : " · not counted"}
              {l ? ` · Last: ${l.text}` : programIds.has(e.id) ? " · in your program" : ""}
            </small>
          </span>
        </button>
        <a class="formlink" href={ytLink(e.name_en)} target="_blank" rel="noopener noreferrer">
          Watch form video ↗
        </a>
      </div>
    );
  };
  return (
    <div class="stack bodypick" data-testid="muscle-step" data-muscle={muscle}>
      <div class="kv navrow">
        <button type="button" class="btn btn-ghost btn-small" data-testid="pick-back" onClick={() => go({ step: "area" })}>
          ← {def.label}
        </button>
      </div>
      <h2 style={{ margin: 0 }}>{muscleLabel(muscle)}</h2>
      <div class="filters two">
        <select aria-label="Equipment" value={place.equipment} onChange={(e) => go({ equipment: (e.currentTarget as HTMLSelectElement).value as Equipment | "" })}>
          <option value="">All equipment</option>
          {EQUIPMENT.map((k) => (
            <option value={k}>{equipmentLabel(k)}</option>
          ))}
        </select>
        <select aria-label="Category" value={place.category} onChange={(e) => go({ category: (e.currentTarget as HTMLSelectElement).value as CategoryFilter })}>
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
      {library === null ? <div class="empty">Loading the library…</div> : null}
      <div class="exlist" data-testid="pick-primary">
        {primary.map(row)}
        {!primary.length ? <div class="empty">No exercise has {muscleLabel(muscle).toLowerCase()} as its main muscle with these filters.</div> : null}
      </div>
      {secondary.length ? (
        <details class="tableview" data-testid="pick-secondary">
          <summary>Also works this muscle ({fmtNum(secondary.length)})</summary>
          <div class="exlist" style={{ marginTop: "6px" }}>
            {secondary.map(row)}
          </div>
        </details>
      ) : null}
    </div>
  );
}

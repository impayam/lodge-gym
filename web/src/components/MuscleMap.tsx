// Muscle balance map: front/back body, each muscle group colored by this week's fractional sets vs the program
// target (SPEC-v2 §7.4: primary muscle 1 set, secondary 0.5). Status is never color alone: under/over also carry a
// texture, and every muscle is listed with its direct and fractional numbers and a text status. Muscles without a
// program target are shown with their sets only.

import { useState } from "preact/hooks";
import { fmtNum } from "../../../worker/lib/digits";

export type Status = "none" | "under" | "on" | "over" | "untracked";
export interface MuscleRow {
  muscle: string;
  /** Direct sets (primary muscle). */
  sets: number;
  /** Fractional sets; the status compares this number with the target. */
  fractional: number;
  target: number | null;
  status: Status;
}

export const MUSCLE_NAME: Record<string, string> = {
  chest: "Chest",
  back: "Back",
  quads: "Quads",
  hamstrings_glutes: "Hamstrings & glutes",
  shoulders: "Shoulders",
  rear_delts: "Rear delts",
  calves: "Calves",
  core: "Core",
  biceps: "Biceps",
  triceps: "Triceps",
  traps: "Traps",
  forearms: "Forearms",
  lower_back: "Lower back",
  adductors: "Adductors",
  abductors: "Abductors",
  neck: "Neck",
};

export const STATUS_NAME: Record<Status, string> = { none: "No sets", under: "Under target", on: "On target", over: "Over target", untracked: "No target" };
const STATUS_ICON: Record<Status, string> = { none: "–", under: "▼", on: "✓", over: "▲", untracked: "·" };

const setsText = (r: MuscleRow) =>
  `${fmtNum(r.sets)} direct · ${fmtNum(r.fractional, 1)} fractional${r.target !== null ? ` of ${fmtNum(r.target)}` : ""} sets · ${STATUS_NAME[r.status]}`;

type Shape = { m: string; d: string };

// Front view (viewBox 0 0 120 250).
const FRONT: Shape[] = [
  { m: "neck", d: "M54,33 h12 v7 h-12 Z" },
  { m: "shoulders", d: "M23,50 a11,9 0 1,1 22,0 a11,9 0 1,1 -22,0 Z M75,50 a11,9 0 1,1 22,0 a11,9 0 1,1 -22,0 Z" },
  { m: "chest", d: "M40,44 h18 v22 a6,6 0 0 1 -6,6 h-8 a6,6 0 0 1 -4,-6 Z M62,44 h18 v22 a6,6 0 0 1 -4,6 h-8 a6,6 0 0 1 -6,-6 Z" },
  { m: "biceps", d: "M21,60 h11 v32 a5,5 0 0 1 -11,0 Z M88,60 h11 v32 a5,5 0 0 1 -11,0 Z" },
  { m: "forearms", d: "M18,100 h11 v24 a5,5 0 0 1 -11,0 Z M91,100 h11 v24 a5,5 0 0 1 -11,0 Z" },
  { m: "core", d: "M45,74 h30 v36 a6,6 0 0 1 -6,6 h-18 a6,6 0 0 1 -6,-6 Z" },
  { m: "quads", d: "M42,126 h15 v50 a8,8 0 0 1 -15,0 Z M63,126 h15 v50 a8,8 0 0 1 -15,0 Z" },
  { m: "adductors", d: "M57,126 h3 v32 h-3 Z M60,126 h3 v32 h-3 Z" },
  { m: "calves", d: "M44,190 h12 v38 a6,6 0 0 1 -12,0 Z M64,190 h12 v38 a6,6 0 0 1 -12,0 Z" },
];
// Back view.
const BACK: Shape[] = [
  { m: "traps", d: "M48,33 h24 l6,8 h-36 Z" },
  { m: "rear_delts", d: "M23,50 a11,9 0 1,1 22,0 a11,9 0 1,1 -22,0 Z M75,50 a11,9 0 1,1 22,0 a11,9 0 1,1 -22,0 Z" },
  { m: "back", d: "M42,43 h36 l-3,45 h-30 Z" },
  { m: "lower_back", d: "M45,90 h30 l-1,12 a6,6 0 0 1 -6,6 h-16 a6,6 0 0 1 -6,-6 Z" },
  { m: "triceps", d: "M21,60 h11 v32 a5,5 0 0 1 -11,0 Z M88,60 h11 v32 a5,5 0 0 1 -11,0 Z" },
  { m: "forearms", d: "M18,100 h11 v24 a5,5 0 0 1 -11,0 Z M91,100 h11 v24 a5,5 0 0 1 -11,0 Z" },
  { m: "abductors", d: "M35,112 h6 v18 h-6 Z M79,112 h6 v18 h-6 Z" },
  { m: "hamstrings_glutes", d: "M42,110 h36 v16 a8,8 0 0 1 -8,8 h-20 a8,8 0 0 1 -8,-8 Z M42,138 h16 v38 a8,8 0 0 1 -16,0 Z M62,138 h16 v38 a8,8 0 0 1 -16,0 Z" },
  { m: "calves", d: "M44,190 h12 v38 a6,6 0 0 1 -12,0 Z M64,190 h12 v38 a6,6 0 0 1 -12,0 Z" },
];
// Neutral silhouette under the muscles.
const BODY =
  "M60,4 a14,14 0 1,1 0,28 a14,14 0 1,1 0,-28 Z M52,32 h16 v8 h-16 Z M36,40 h48 a14,14 0 0 1 14,14 l4,44 l4,34 a5,5 0 0 1 -10,1 l-6,-32 l-4,-24 v62 l2,62 l-2,34 a5,5 0 0 1 -10,0 l-2,-36 l-4,-50 h-8 l-4,50 l-2,36 a5,5 0 0 1 -10,0 l-2,-34 l2,-62 v-62 l-4,24 l-6,32 a5,5 0 0 1 -10,-1 l4,-34 l4,-44 a14,14 0 0 1 14,-14 Z";

function Figure({ shapes, rows, title, active, onPick }: { shapes: Shape[]; rows: Map<string, MuscleRow>; title: string; active: string | null; onPick: (m: string) => void }) {
  return (
    <figure class="figure">
      <svg viewBox="0 0 120 250" role="img" aria-label={title}>
        <path d={BODY} class="body" />
        {shapes.map((s) => {
          const r = rows.get(s.m);
          const st = r?.status ?? "none";
          // Left and right sides are separate shapes so each is its own tap target.
          return s.d.split(/ (?=M)/).map((d) => (
            <path d={d} class={`muscle m-${st}${active === s.m ? " active" : ""}`} onClick={() => onPick(s.m)} data-muscle={s.m} data-status={st}>
              <title>{r ? `${MUSCLE_NAME[s.m]}: ${setsText(r)}` : MUSCLE_NAME[s.m]}</title>
            </path>
          ));
        })}
      </svg>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

export function MuscleMap({ muscles }: { muscles: MuscleRow[] }) {
  const [active, setActive] = useState<string | null>(null);
  const rows = new Map(muscles.map((m) => [m.muscle, m]));
  const a = active ? rows.get(active) : null;
  return (
    <div class="musclemap" data-testid="muscle-map">
      <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
        <defs>
          <pattern id="tex-under" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" class="tex-under-bg" />
            <line x1="0" y1="0" x2="0" y2="6" class="tex-line" />
          </pattern>
          <pattern id="tex-over" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
            <rect width="6" height="6" class="tex-over-bg" />
            <line x1="0" y1="0" x2="0" y2="6" class="tex-line" />
          </pattern>
        </defs>
      </svg>
      <div class="readout" aria-live="polite">
        {a ? `${MUSCLE_NAME[a.muscle]}: ${setsText(a)}` : "Tap a muscle."}
      </div>
      <div class="figures">
        <Figure shapes={FRONT} rows={rows} title="Front" active={active} onPick={setActive} />
        <Figure shapes={BACK} rows={rows} title="Back" active={active} onPick={setActive} />
      </div>
      <div class="legend">
        {(["under", "on", "over", "none", "untracked"] as Status[]).map((s) => (
          <span>
            <i class={`sw m-${s}`} /> {STATUS_ICON[s]} {STATUS_NAME[s]}
          </span>
        ))}
      </div>
      <ul class="musclelist">
        <li class="head" aria-hidden="true">
          <span>Muscle</span>
          <span>direct · fractional / target</span>
          <span>Status</span>
        </li>
        {muscles.map((m) => (
          <li data-testid={`muscle-${m.muscle}`}>
            <span>{MUSCLE_NAME[m.muscle]}</span>
            <span class="num" title="direct · fractional / target">
              {fmtNum(m.sets)} · {fmtNum(m.fractional, 1)} / {m.target === null ? "–" : fmtNum(m.target)}
            </span>
            <span class={`st st-${m.status}`}>
              {STATUS_ICON[m.status]} {STATUS_NAME[m.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

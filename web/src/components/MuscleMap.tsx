// Muscle balance map: front/back body, each primary muscle group colored by this week's sets vs the
// program target. Status is never color alone: under/over also carry a texture, and every muscle is
// listed with its numbers and a text status.

import { useState } from "preact/hooks";
import { faNum } from "../../../worker/lib/digits";

export type Status = "none" | "under" | "on" | "over";
export interface MuscleRow {
  muscle: string;
  sets: number;
  target: number;
  status: Status;
}

export const MUSCLE_FA: Record<string, string> = {
  chest: "سینه",
  back: "پشت",
  quads: "جلو ران",
  hamstrings_glutes: "پشت ران و باسن",
  shoulders: "سرشانه",
  rear_delts: "سرشانه‌ی پشتی",
  calves: "ساق",
  core: "شکم و مرکز بدن",
  biceps: "جلو بازو",
  triceps: "پشت بازو",
};

export const STATUS_FA: Record<Status, string> = { none: "بدون ست", under: "کمتر از هدف", on: "در هدف", over: "بیشتر از هدف" };
const STATUS_ICON: Record<Status, string> = { none: "–", under: "▼", on: "✓", over: "▲" };

type Shape = { m: string; d: string };

// Front view (viewBox 0 0 120 250).
const FRONT: Shape[] = [
  { m: "shoulders", d: "M23,50 a11,9 0 1,1 22,0 a11,9 0 1,1 -22,0 Z M75,50 a11,9 0 1,1 22,0 a11,9 0 1,1 -22,0 Z" },
  { m: "chest", d: "M40,44 h18 v22 a6,6 0 0 1 -6,6 h-8 a6,6 0 0 1 -4,-6 Z M62,44 h18 v22 a6,6 0 0 1 -4,6 h-8 a6,6 0 0 1 -6,-6 Z" },
  { m: "biceps", d: "M21,60 h11 v32 a5,5 0 0 1 -11,0 Z M88,60 h11 v32 a5,5 0 0 1 -11,0 Z" },
  { m: "core", d: "M45,74 h30 v36 a6,6 0 0 1 -6,6 h-18 a6,6 0 0 1 -6,-6 Z" },
  { m: "quads", d: "M42,126 h16 v50 a8,8 0 0 1 -16,0 Z M62,126 h16 v50 a8,8 0 0 1 -16,0 Z" },
  { m: "calves", d: "M44,190 h12 v38 a6,6 0 0 1 -12,0 Z M64,190 h12 v38 a6,6 0 0 1 -12,0 Z" },
];
// Back view.
const BACK: Shape[] = [
  { m: "rear_delts", d: "M23,50 a11,9 0 1,1 22,0 a11,9 0 1,1 -22,0 Z M75,50 a11,9 0 1,1 22,0 a11,9 0 1,1 -22,0 Z" },
  { m: "back", d: "M42,42 h36 l-4,58 a6,6 0 0 1 -6,6 h-16 a6,6 0 0 1 -6,-6 Z" },
  { m: "triceps", d: "M21,60 h11 v32 a5,5 0 0 1 -11,0 Z M88,60 h11 v32 a5,5 0 0 1 -11,0 Z" },
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
              <title>
                {MUSCLE_FA[s.m]}: {faNum(r?.sets ?? 0)} از {faNum(r?.target ?? 0)} ست · {STATUS_FA[st]}
              </title>
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
        {a ? `${MUSCLE_FA[a.muscle]}: ${faNum(a.sets)} از ${faNum(a.target)} ست · ${STATUS_FA[a.status]}` : "روی یک عضله بزن."}
      </div>
      <div class="figures">
        <Figure shapes={FRONT} rows={rows} title="جلو" active={active} onPick={setActive} />
        <Figure shapes={BACK} rows={rows} title="پشت" active={active} onPick={setActive} />
      </div>
      <div class="legend">
        {(["under", "on", "over", "none"] as Status[]).map((s) => (
          <span>
            <i class={`sw m-${s}`} /> {STATUS_ICON[s]} {STATUS_FA[s]}
          </span>
        ))}
      </div>
      <ul class="musclelist">
        {muscles.map((m) => (
          <li data-testid={`muscle-${m.muscle}`}>
            <span>{MUSCLE_FA[m.muscle]}</span>
            <span class="num">
              {faNum(m.sets)} / {faNum(m.target)}
            </span>
            <span class={`st st-${m.status}`}>
              {STATUS_ICON[m.status]} {STATUS_FA[m.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Muscle balance map: anatomical front and back figures (./bodyMap.ts), one region per canonical muscle key, each
// coloured by its report group's fractional sets this week vs the program target (SPEC-v2 §7.4: primary muscle 1 set,
// secondary 0.5). Status is never colour alone: under/over also carry a texture, and every group is listed with its
// direct and fractional numbers and a text status. Groups without a program target are shown with their sets only.

import { useState } from "preact/hooks";
import { fmtNum } from "../../../worker/lib/digits";
import { groupOf } from "../../../worker/lib/muscles";
import { BalanceStage } from "./BalanceStage";
import { BACK, BACK_DETAIL, FRONT, FRONT_DETAIL, SILHOUETTE, VIEW_H, VIEW_W, bothSides, mirrorPath, type HalfRegion, type RegionKey } from "./bodyMap";

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
export const STATUS_ICON: Record<Status, string> = { none: "–", under: "▼", on: "✓", over: "▲", untracked: "·" };

const setsText = (r: MuscleRow) =>
  `${fmtNum(r.sets)} direct · ${fmtNum(r.fractional, 1)} fractional${r.target !== null ? ` of ${fmtNum(r.target)}` : ""} sets · ${STATUS_NAME[r.status]}`;

/** Names of the drawn regions (canonical muscle keys); the readout adds the group when it differs. */
const REGION_NAME: Record<RegionKey, string> = {
  chest: "Chest",
  back_lats: "Lats",
  back_upper: "Upper back",
  traps: "Traps",
  lower_back: "Lower back",
  shoulders_front: "Front delts",
  shoulders_side: "Side delts",
  rear_delts: "Rear delts",
  biceps: "Biceps",
  triceps: "Triceps",
  forearms: "Forearms",
  core: "Core",
  quads: "Quads",
  hamstrings: "Hamstrings",
  glutes: "Glutes",
  adductors: "Adductors",
  calves: "Calves",
};

const FRONT_REGIONS = bothSides(FRONT);
const BACK_REGIONS = bothSides(BACK);
const FRONT_LINES = [...FRONT_DETAIL, ...FRONT_DETAIL.map(mirrorPath)];
const BACK_LINES = [...BACK_DETAIL, ...BACK_DETAIL.map(mirrorPath)];

interface Pick {
  key: RegionKey;
  group: string;
}

function Figure({ regions, lines, rows, title, pick, onPick }: { regions: HalfRegion[]; lines: string[]; rows: Map<string, MuscleRow>; title: string; pick: Pick | null; onPick: (p: Pick) => void }) {
  const groupOfRegion = (k: RegionKey) => groupOf(k) ?? k;
  return (
    <figure class="body-figure">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={title}>
        <path d={SILHOUETTE} class="body-figure__body" />
        {regions.map((r) => {
          const g = groupOfRegion(r.key);
          const row = rows.get(g);
          const st = row?.status ?? "none";
          // Each side is its own shape and tap target; the region is coloured by its report group.
          return (
            <path d={r.d} class="body-region" onClick={() => onPick({ key: r.key, group: g })} data-muscle={r.key} data-group={g} data-status={st}>
              <title>{row ? `${regionLabel(r.key, g)}: ${setsText(row)}` : regionLabel(r.key, g)}</title>
            </path>
          );
        })}
        {lines.map((d) => (
          <path d={d} class="body-figure__detail" />
        ))}
        {/* The selected group on top: a filled highlight and a thick outline, so it reads at a glance. */}
        {pick
          ? regions
              .filter((r) => groupOfRegion(r.key) === pick.group)
              .map((r) => <path d={r.d} class="body-figure__sel" data-selected={r.key} />)
          : null}
      </svg>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

const regionLabel = (key: RegionKey, group: string) => (REGION_NAME[key] === MUSCLE_NAME[group] ? MUSCLE_NAME[group] : `${REGION_NAME[key]} (${MUSCLE_NAME[group]})`);

/** The drawn front and back figures: shown while the 3D map (SPEC-v6 §8) is unavailable, until Payam approves it. */
function Figures({ muscles }: { muscles: MuscleRow[] }) {
  const [pick, setPick] = useState<Pick | null>(null);
  const rows = new Map(muscles.map((m) => [m.muscle, m]));
  const a = pick ? rows.get(pick.group) : null;
  return (
    <>
      <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
        <defs>
          {/* Stripe directions match the legend swatches (CSS 45deg under, 135deg over). */}
          <pattern id="tex-under" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
            <rect width="6" height="6" class="body-tex--under" />
            <line x1="0" y1="0" x2="0" y2="6" class="body-tex__line" />
          </pattern>
          <pattern id="tex-over" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" class="body-tex--over" />
            <line x1="0" y1="0" x2="0" y2="6" class="body-tex__line" />
          </pattern>
        </defs>
      </svg>
      <div class="chart-readout" aria-live="polite">
        {pick ? `${regionLabel(pick.key, pick.group)}: ${a ? setsText(a) : STATUS_NAME.none}` : "Tap a muscle."}
      </div>
      <div class="body-figures">
        <Figure regions={FRONT_REGIONS} lines={FRONT_LINES} rows={rows} title="Front" pick={pick} onPick={setPick} />
        <Figure regions={BACK_REGIONS} lines={BACK_LINES} rows={rows} title="Back" pick={pick} onPick={setPick} />
      </div>
      <div class="chart-legend">
        {(["under", "on", "over", "none", "untracked"] as Status[]).map((s) => (
          <span>
            <span class="chart-legend__swatch" data-status={s} /> {STATUS_ICON[s]} {STATUS_NAME[s]}
          </span>
        ))}
      </div>
    </>
  );
}

export function MuscleMap({ muscles }: { muscles: MuscleRow[] }) {
  return (
    <div class="l-col l-gap-12" data-testid="muscle-map">
      <BalanceStage muscles={muscles} text={{ name: STATUS_NAME, icon: STATUS_ICON, group: (g) => MUSCLE_NAME[g] ?? g }} fallback={<Figures muscles={muscles} />} />
      <ul class="balance-list">
        <li aria-hidden="true">
          <span>Muscle</span>
          <span>direct · fractional / target</span>
          <span>Status</span>
        </li>
        {muscles.map((m) => (
          <li data-testid={`muscle-${m.muscle}`} data-status={m.status}>
            <span>{MUSCLE_NAME[m.muscle]}</span>
            <span class="num" title="direct · fractional / target">
              {fmtNum(m.sets)} · {fmtNum(m.fractional, 1)} / {m.target === null ? "–" : fmtNum(m.target)}
            </span>
            <span class="balance-list__status">
              {STATUS_ICON[m.status]} {STATUS_NAME[m.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

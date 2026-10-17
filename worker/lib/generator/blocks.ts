// Blocks, equipment roles and direct targets for the program generator (SPEC-v11 M14 Phase B, approved by Payam
// 2026-10-17). Pure data and helpers, used by the generator, its check, the proposal editor and the Coach.
//
// A block is one accessory period (3–4 weeks); every new program starts the next block. Main and secondary lifts span
// two blocks (6–8 weeks), accessories one (worker/lib/rotation.ts). Every block covers all 30 regions. Main lifts stay
// barbell (strength is specific to the equipment, and the 1RM charts stay comparable): only their variation changes,
// chosen by the region that is missing. The other exercises of each muscle follow the block's equipment mix, always in
// the order A → B → C. Growth is similar across equipment when sets are near failure, so no equipment is "better for
// growth": each has a role (below).

import { REGION_INFO, type Region } from "../regions";
import type { Equipment, Exercise, ProgramInfo } from "../types";

export const BLOCK_LETTERS = ["A", "B", "C"] as const;
export type BlockLetter = (typeof BLOCK_LETTERS)[number];
/** Block 1 is A (the seed program counts as block A), 2 is B, 3 is C, 4 is A again. */
export const blockLetter = (block: number): BlockLetter => BLOCK_LETTERS[(((Math.max(1, Math.floor(block)) - 1) % 3) + 3) % 3];

/** The muscle rows of the approved equipment table. */
export const MIX_FAMILIES = ["chest", "back", "front_delts", "side_delts", "rear_delts", "biceps", "triceps", "quads", "hams_glutes", "calves", "core", "traps", "forearms", "neck"] as const;
export type MixFamily = (typeof MIX_FAMILIES)[number];

const FAMILY_OF: Readonly<Record<string, MixFamily>> = {
  chest: "chest",
  back_lats: "back",
  back_upper: "back",
  shoulders_front: "front_delts",
  shoulders_side: "side_delts",
  rear_delts: "rear_delts",
  biceps: "biceps",
  triceps: "triceps",
  quads: "quads",
  hamstrings: "hams_glutes",
  glutes: "hams_glutes",
  abductors: "hams_glutes",
  adductors: "hams_glutes",
  lower_back: "hams_glutes",
  calves: "calves",
  core: "core",
  traps: "traps",
  forearms: "forearms",
  neck: "neck",
};
/** The table row of an exercise's main muscle. */
export const mixFamilyOf = (muscle: string): MixFamily | null => FAMILY_OF[muscle] ?? null;

/** Equipment as the table names it: neck work tells a plate apart from bodyweight and isometric holds. */
export type EquipKind = Equipment | "plate" | "isometric";

export function equipKind(ex: Pick<Exercise, "equipment" | "name_en" | "muscle_primary">): EquipKind {
  if (ex.muscle_primary === "neck") return /\bisometric\b/i.test(ex.name_en) ? "isometric" : /\bplate\b/i.test(ex.name_en) || ex.equipment !== "bodyweight" ? "plate" : "bodyweight";
  return ex.equipment;
}

/** The block of the program in use: the latest activated program that carries one (the seed program is block 1). */
export function currentBlock(infos: readonly Pick<ProgramInfo, "params" | "activations">[]): number {
  const started = (p: Pick<ProgramInfo, "activations">) => p.activations[p.activations.length - 1]?.started_at ?? "";
  const latest = infos.filter((p) => p.params?.block !== undefined && p.activations.length).sort((a, b) => started(b).localeCompare(started(a)))[0];
  return latest?.params?.block ?? 1;
}

/** The block-to-block order per muscle (approved table): the equipment its other exercises use in blocks A, B and C. */
export const EQUIPMENT_MIX: Readonly<Record<MixFamily, readonly [readonly EquipKind[], readonly EquipKind[], readonly EquipKind[]]>> = {
  chest: [["barbell", "cable"], ["dumbbell", "cable"], ["barbell", "dumbbell", "cable"]],
  back: [["barbell", "cable"], ["dumbbell", "cable"], ["barbell", "dumbbell", "cable"]],
  front_delts: [["barbell"], ["dumbbell"], ["barbell", "dumbbell"]],
  side_delts: [["dumbbell", "cable"], ["cable", "machine"], ["dumbbell", "machine"]],
  rear_delts: [["cable", "dumbbell"], ["cable", "machine"], ["dumbbell", "machine"]],
  biceps: [["barbell", "cable"], ["dumbbell", "cable"], ["barbell", "dumbbell", "cable"]],
  triceps: [["barbell", "cable"], ["dumbbell", "cable"], ["barbell", "dumbbell", "cable"]],
  quads: [["barbell", "machine"], ["dumbbell", "machine"], ["barbell", "dumbbell", "machine"]],
  hams_glutes: [["barbell", "machine"], ["dumbbell", "machine"], ["barbell", "dumbbell", "machine"]],
  // Both calf machines every block (straight and bent knee); core: bodyweight and cable every block, its region rotates.
  calves: [["machine"], ["machine"], ["machine"]],
  core: [["bodyweight", "cable"], ["bodyweight", "cable"], ["bodyweight", "cable"]],
  traps: [["barbell"], ["dumbbell"], ["cable"]],
  forearms: [["barbell"], ["dumbbell"], ["cable"]],
  neck: [["plate", "bodyweight"], ["plate", "isometric"], ["plate", "bodyweight"]],
};

/** The equipment mix of a muscle row in a block. */
export const blockMix = (family: MixFamily, block: number): readonly EquipKind[] => EQUIPMENT_MIX[family][BLOCK_LETTERS.indexOf(blockLetter(block))];

/**
 * Each equipment's role per muscle (approved table), for the proposal notes and the Coach's "why this equipment".
 * Barbell: strength and easy load progression. Dumbbell and cable: a region, an angle or a stretch. Machine: a stable path.
 */
export const EQUIPMENT_ROLES: Readonly<Record<MixFamily, Partial<Record<EquipKind, string>>>> = {
  chest: { barbell: "heavy press, progression", dumbbell: "deeper stretch, each side alone", cable: "fly at any angle (upper/lower)", machine: "stable press, pec deck" },
  back: { barbell: "heavy row, progression", dumbbell: "one-arm row, range", cable: "pulldown, rows, constant tension", machine: "supported row", bodyweight: "pull-up" },
  front_delts: { barbell: "overhead press, progression", dumbbell: "seated press, range", machine: "machine press" },
  side_delts: { dumbbell: "raise, stretch", cable: "raise, tension at the bottom", machine: "machine raise" },
  rear_delts: { dumbbell: "reverse fly", cable: "face pull, reverse fly", machine: "reverse pec deck" },
  biceps: { barbell: "heavy curl", dumbbell: "incline curl (long head), hammer", cable: "constant tension", machine: "preacher machine" },
  triceps: { barbell: "close-grip, skull crusher", dumbbell: "overhead extension (long head)", cable: "pushdown, overhead", bodyweight: "dips" },
  quads: { barbell: "squat, progression", dumbbell: "split squat, goblet", machine: "leg press, extension, hack" },
  hams_glutes: { barbell: "RDL, hip thrust", dumbbell: "DB RDL", cable: "pull-through", machine: "seated or lying curl, abduction" },
  calves: { machine: "standing and seated calf machines" },
  core: { cable: "crunch, Pallof", bodyweight: "holds and raises" },
  traps: { barbell: "shrug", dumbbell: "shrug", cable: "shrug" },
  forearms: { barbell: "wrist curls", dumbbell: "wrist curls", cable: "wrist curls", bodyweight: "grip work" },
  neck: { plate: "plate (lying)", bodyweight: "bodyweight", isometric: "isometric" },
};

/** The evidence behind the roles (approved table). */
export const EQUIPMENT_EVIDENCE: readonly { claim: string; evidence: string }[] = [
  { claim: "Strength gains are specific to the equipment you train with", evidence: "strong (free weights vs machines meta-analysis)" },
  { claim: "Growth is similar across barbell, dumbbell, cable and machine when sets are near failure", evidence: "moderate" },
  { claim: "Training at a long muscle length (deep stretch) grows a bit more", evidence: "moderate overall; strong for triceps (overhead) and hamstrings (seated curl)" },
  { claim: "Cable keeps tension through the whole range", evidence: "weak (biomechanics only)" },
  { claim: "Machine is stable, so it is safe to train close to failure", evidence: "weak (practical)" },
];

/** Small regions get 2 sets when a block adds them (approved 2026-10-17); neck work starts at 1 set. */
export const SMALL_REGIONS: ReadonlySet<Region> = new Set<Region>(["traps", "adductors", "glutes_abd", "brachialis", "core_anti_rot"]);

/**
 * Weekly direct sets for forearms and neck (approved 2026-10-17): the first block after the seed program starts at
 * forearms 4 (2 flexors, 2 extensors) and neck 2 (1 + 1); each later block adds 1 set, up to 8 and 6. An odd count gives
 * the extra set to the forearm flexors and to the neck extensors (the region with the growth study).
 */
export const DIRECT_TARGETS = { forearms: { start: 4, max: 8 }, neck: { start: 2, max: 6 } } as const;
export type DirectGroup = keyof typeof DIRECT_TARGETS;
export const DIRECT_GROUPS: readonly DirectGroup[] = ["forearms", "neck"];

export function directTarget(group: DirectGroup, block: number): number {
  const t = DIRECT_TARGETS[group];
  return block < 2 ? 0 : Math.min(t.max, t.start + (Math.floor(block) - 2));
}

/** A direct target split over the group's two regions. */
export function directRegionSets(group: DirectGroup, block: number): [Region, number][] {
  const n = directTarget(group, block);
  return group === "forearms"
    ? [
        ["forearm_flexors", Math.ceil(n / 2)],
        ["forearm_extensors", Math.floor(n / 2)],
      ]
    : [
        ["neck_flexors", Math.floor(n / 2)],
        ["neck_extensors", Math.ceil(n / 2)],
      ];
}

/** The region family (the Library chip) of a region. */
export const regionFamily = (r: Region) => REGION_INFO[r].muscle;

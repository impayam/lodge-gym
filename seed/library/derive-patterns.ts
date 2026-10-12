// Drafts seed/library/fedb-patterns.json from exercise names, the mapped primary muscle and the dataset's force and
// category. The output is the reviewed mapping file (SPEC-v2 §7.2): it is committed, reviewed by Payam and edited by
// hand from then on; this script only exists to make the first draft reproducible. Rows the rules cannot place get
// `pattern: null` and are listed in the import report instead of being guessed.
//   npx tsx seed/library/derive-patterns.ts [dataset.json]   (default: the pinned dataset from GitHub)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Category } from "../../worker/lib/category";
import { FEDB_RAW, resolveEquipment, type EquipmentReview, type FedbExercise, type Mechanic, type Pattern, type PatternFile, type SeedMatch } from "../../worker/lib/library";
import { fedbMuscles, type Muscle } from "../../worker/lib/muscles";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export function derivePattern(x: FedbExercise, primary: Muscle): Pattern | null {
  const n = x.name.toLowerCase();
  const has = (re: RegExp) => re.test(n);
  if (x.category === "stretching" || x.category === "cardio" || x.category === "plyometrics") return null;
  if (has(/\b(farmer|carry|yoke)\b/)) return "carry";
  if (primary === "core") return "core";
  if (has(/leg curl|leg extension|calf|adduct|abduct|kickback|shrug|wrist|finger|upright|pushdown|rotation|scaption|iron cross|around the world|car drivers/)) return "isolation";
  if (has(/pullover|straight-arm/)) return "isolation";
  if (has(/lunge|split squat|step[- ]?ups?\b/)) return "lunge";
  if (has(/squat|leg press|\bhack\b/)) return "squat";
  if (has(/\bjerk\b|push press|log lift/)) return "v_push";
  if (has(/deadlift|good morning|\brdl\b|stiff.?legs?\b|hip thrust|bridge|hip raise|pull through|hyperextension|back extension|swing|rack pull|\bclean\b|snatch/)) return "hinge";
  if ((primary === "back_lats" || primary === "back_upper" || primary === "biceps") && has(/pulldown|pull[- ]?ups?\b|chin[- ]?ups?\b|\bchins?\b|muscle[- ]up|rope climb/)) return "v_pull";
  if (has(/pulldown/)) return "v_pull";
  if (has(/\bdips?\b/)) return "v_push";
  if (has(/\brows?\b/)) return "h_pull";
  if ((primary === "back_upper" || primary === "back_lats") && has(/\bpull\b/)) return "h_pull";
  if (primary === "chest") {
    if (has(/fl(y|ye|yes)\b|crossover|butterfly|pec deck/)) return "isolation";
    if (has(/press|push-?ups?|bench/)) return "h_push";
    return null;
  }
  if (primary === "shoulders_front" || primary === "shoulders_side" || primary === "rear_delts") {
    if (has(/press|handstand|military|overhead/)) return "v_push";
    if (has(/raise|fl(y|ye|yes)\b|face pull|upright|pull apart|lateral|deltoid/)) return "isolation";
    return null;
  }
  if (primary === "triceps") {
    if (has(/bench press|push-?ups?|bench to/) || (x.mechanic === "compound" && has(/press/))) return "h_push";
    return x.mechanic === "isolation" || has(/extension|pushdown|kickback|skull|triceps? press|tricep/) ? "isolation" : null;
  }
  if (primary === "biceps" || primary === "forearms" || primary === "calves" || primary === "neck" || primary === "adductors" || primary === "abductors" || primary === "traps") {
    return x.mechanic === "isolation" || has(/curl|raise/) ? "isolation" : null;
  }
  if (primary === "quads" && has(/extension/)) return "isolation";
  if (primary === "hamstrings" && has(/curl|glute.?ham/)) return "isolation";
  if (primary === "glutes" && has(/kickback/)) return "isolation";
  return null;
}

const COMPOUND: ReadonlySet<Pattern> = new Set(["squat", "hinge", "lunge", "h_push", "v_push", "h_pull", "v_pull", "carry"]);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = process.argv[2];
  const dataset = (src ? JSON.parse(readFileSync(src, "utf8")) : await (await fetch(`${FEDB_RAW}/dist/exercises.json`)).json()) as FedbExercise[];
  const seed = JSON.parse(readFileSync(here("./seed-matches.json"), "utf8")) as SeedMatch[];
  const matched = new Set(seed.map((s) => s.fedb));
  const review = JSON.parse(readFileSync(here("./fedb-equipment.json"), "utf8")) as EquipmentReview;
  // Category overrides are review decisions, not derived: a regenerated draft keeps them.
  const previous: PatternFile = existsSync(here("./fedb-patterns.json")) ? JSON.parse(readFileSync(here("./fedb-patterns.json"), "utf8")) : {};
  const out: PatternFile = {};
  for (const x of [...dataset].sort((a, b) => a.id.localeCompare(b.id))) {
    if (matched.has(x.id) || x.id in review.excluded || !resolveEquipment(x, review)) continue;
    const { primary } = fedbMuscles(x);
    if (!primary) continue;
    const pattern = derivePattern(x, primary);
    const entry: { pattern: Pattern | null; mechanic?: Mechanic; category?: Category } = { pattern };
    if (x.mechanic !== "compound" && x.mechanic !== "isolation" && pattern) entry.mechanic = COMPOUND.has(pattern) ? "compound" : pattern === "isolation" ? "isolation" : undefined;
    if (entry.mechanic === undefined) delete entry.mechanic;
    if (previous[x.id]?.category) entry.category = previous[x.id].category;
    out[x.id] = entry;
  }
  const lines = Object.entries(out).map(([id, v]) => `  ${JSON.stringify(id)}: ${JSON.stringify(v)}`);
  writeFileSync(here("./fedb-patterns.json"), "{\n" + lines.join(",\n") + "\n}\n");
  console.log(`fedb-patterns.json: ${lines.length} entries, ${Object.values(out).filter((v) => !v.pattern).length} without a pattern`);
}

// Muscle mapping of the 3D anatomy model (SPEC-v6 §3), the single source of truth: model muscle name (without the
// left/right `.NNN` suffix) → the app's muscle key (worker/lib/muscles.ts) and, where one exists, the M10 coverage
// region. Model muscles not listed (face, eye, larynx, neck, deep spine, chest wall, hand and foot, hip flexors and deep
// hip rotators, shin) stay visible but are not tappable. Neck has no picker area, so neck muscles are not mapped.

import type { Muscle } from "../../../worker/lib/muscles";

/** M10 coverage regions (SPEC-v3 M10.1.2) that a model muscle stands for. */
export type CoverageRegion =
  | "chest_upper"
  | "chest_mid"
  | "chest_lower"
  | "shoulders_front"
  | "shoulders_side"
  | "rear_delts"
  | "back_lats"
  | "back_upper"
  | "traps"
  | "biceps_long"
  | "biceps_short"
  | "triceps_long"
  | "triceps_lateral_medial"
  | "glutes_extension"
  | "glutes_abduction"
  | "calves_gastroc"
  | "calves_soleus";

export interface AnatomyEntry {
  /** Model muscle name without the `.NNN` suffix, e.g. "Long head of triceps brachii". */
  name: string;
  muscle: Muscle;
  region: CoverageRegion | null;
}

const row = (name: string, muscle: Muscle, region: CoverageRegion | null = null): AnatomyEntry => ({ name, muscle, region });

export const ANATOMY_ROWS: readonly AnatomyEntry[] = [
  // Chest
  row("Clavicular head of pectoralis major muscle", "chest", "chest_upper"),
  row("Sternocostal head of pectoralis major muscle", "chest", "chest_mid"),
  row("(Abdominal part of pectoralis major muscle)", "chest", "chest_lower"),
  row("Pectoralis minor muscle", "chest"),
  // Shoulders
  row("Clavicular part of deltoid muscle", "shoulders_front", "shoulders_front"),
  row("Acromial part of deltoid muscle", "shoulders_side", "shoulders_side"),
  row("Scapular spinal part of deltoid muscle", "rear_delts", "rear_delts"),
  // Arms: biceps
  row("Long head of biceps brachii", "biceps", "biceps_long"),
  row("Short head of biceps brachii", "biceps", "biceps_short"),
  row("Brachialis muscle", "biceps"),
  // Arms: triceps
  row("Long head of triceps brachii", "triceps", "triceps_long"),
  row("Lateral head of triceps brachii", "triceps", "triceps_lateral_medial"),
  row("Medial head of triceps brachii", "triceps", "triceps_lateral_medial"),
  row("Anconeus muscle", "triceps"),
  // Arms: forearms
  row("Brachioradialis muscle", "forearms"),
  row("Superficial head of pronator teres", "forearms"),
  row("Deep head of pronator teres", "forearms"),
  row("Flexor carpi radialis", "forearms"),
  row("Palmaris longus muscle", "forearms"),
  row("Humeral head of flexor carpi ulnaris", "forearms"),
  row("Ulnar head of flexor carpi ulnaris", "forearms"),
  row("Humero-ulnar head of flexor digitorum superficialis", "forearms"),
  row("Radial head of flexor digitorum superficialis", "forearms"),
  row("Flexor digitorum profundus", "forearms"),
  row("Flexor pollicis longus", "forearms"),
  row("Pronator quadratus", "forearms"),
  row("Extensor carpi radialis longus", "forearms"),
  row("Extensor carpi radialis brevis", "forearms"),
  row("Extensor digitorum", "forearms"),
  row("Extensor digiti minimi", "forearms"),
  row("Humeral head of extensor carpi ulnaris", "forearms"),
  row("Ulnar head of extensor carpi ulnaris", "forearms"),
  row("Supinator", "forearms"),
  row("Abductor pollicis longus", "forearms"),
  row("Extensor pollicis brevis", "forearms"),
  row("Extensor pollicis longus", "forearms"),
  row("Extensor indicis", "forearms"),
  // Back: lats (vertical pull)
  row("Latissimus dorsi muscle", "back_lats", "back_lats"),
  row("Teres major muscle", "back_lats", "back_lats"),
  // Back: upper back (horizontal pull)
  row("Rhomboid major muscle", "back_upper", "back_upper"),
  row("Rhomboid minor muscle", "back_upper", "back_upper"),
  row("Transverse part of trapezius muscle", "back_upper", "back_upper"),
  // The model names its two outer trapezius parts the other way round: its "Descending part" is the lower triangle
  // (1.12–1.41 m up), its "Ascending part" the upper fibres along the neck (1.42–1.57 m). Mapped by where they are:
  // mid and lower trapezius are upper back, upper trapezius is traps (tests/lib/anatomyMap.test.ts checks the heights).
  row("Descending part of trapezius muscle", "back_upper", "back_upper"),
  row("Infraspinatus muscle", "back_upper", "back_upper"),
  row("Teres minor muscle", "back_upper", "back_upper"),
  // Back: traps (shrugs)
  row("Ascending part of trapezius muscle", "traps", "traps"),
  row("Levator scapulae", "traps", "traps"),
  // Back: lower back (erector spinae and quadratus lumborum)
  row("Iliocostalis lumborum muscle", "lower_back"),
  row("Iliocostalis thoracis muscle", "lower_back"),
  row("Longissimus thoracis muscle", "lower_back"),
  row("Spinalis thoracis muscle", "lower_back"),
  row("Quadratus lumborum muscle", "lower_back"),
  // Core
  row("Rectus abdominis muscle", "core"),
  row("Linea alba", "core"),
  row("Pyramidalis muscle", "core"),
  row("External abdominal oblique muscle", "core"),
  row("Internal abdominal oblique muscle", "core"),
  row("Transversus abdominis muscle", "core"),
  // Glutes & hips
  row("Gluteus maximus muscle", "glutes", "glutes_extension"),
  row("Gluteus medius muscle", "abductors", "glutes_abduction"),
  row("Gluteus minimus muscle", "abductors", "glutes_abduction"),
  row("Adductor longus", "adductors"),
  row("Adductor brevis", "adductors"),
  row("Adductor magnus", "adductors"),
  row("Gracilis muscle", "adductors"),
  row("Pectineus muscle", "adductors"),
  // Thighs
  row("Rectus femoris muscle", "quads"),
  row("Vastus lateralis muscle", "quads"),
  row("Vastus medialis muscle", "quads"),
  row("Vastus intermedius muscle", "quads"),
  row("Long head of biceps femoris", "hamstrings"),
  row("Short head of biceps femoris", "hamstrings"),
  row("Semitendinosus muscle", "hamstrings"),
  row("Semimembranosus muscle", "hamstrings"),
  // Calves
  row("Medial head of gastrocnemius", "calves", "calves_gastroc"),
  row("Lateral head of gastrocnemius", "calves", "calves_gastroc"),
  row("Soleus muscle", "calves", "calves_soleus"),
  row("Plantaris muscle", "calves"),
];

const BY_NAME = new Map(ANATOMY_ROWS.map((r) => [r.name, r]));

/** A model node's base name: the left/right copies of a muscle end in `.001`, `.002`, … */
export const baseName = (nodeName: string): string => nodeName.replace(/\.\d{3}$/, "");

/** The app muscle and region of a model node, or null when the node is not tappable. */
export const anatomyOf = (nodeName: string): AnatomyEntry | null => BY_NAME.get(baseName(nodeName)) ?? null;

/** App muscles that have at least one model muscle. */
export const MAPPED_MUSCLES: readonly Muscle[] = [...new Set(ANATOMY_ROWS.map((r) => r.muscle))];

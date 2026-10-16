# SPEC v11: M14, Bigger exercise library + region-level Pro Coach + photo needs analysis

Status: requested by Payam on 2026-10-15. Points marked **CONFIRM** need his answer; **STOP** items need his OK before you continue.
Same CLAUDE.md working rules. Build **after M12 (Coach) is merged and checked in production**, on a new branch from `main`. UI only from the Pulse library. Never call the real Anthropic API in tests.

Goal in Payam's words: the library should hold every useful exercise; the Coach should program like a professional, down to the part of a muscle (upper / middle / lower chest, the heads of the triceps…), give exercises that shape a muscle the way he wants, and read his photos to say what needs work and what does not.

Three phases, each its own PR, merged and checked before the next:
- **A.** Library expansion + region tags (data).
- **B.** Pro Coach: region-aware tools and rules.
- **C.** Photo needs analysis.

---

## Phase A. Library expansion

### A1. Sources (licences decide what we may store) — STOP: report licences before importing
| Source | Use | Rule |
|---|---|---|
| free-exercise-db (already imported, Unlicense, 873 records) | Check that every strength, powerlifting and olympic-weightlifting record is imported; list any that are not and why. | Images to R2 as today. |
| wger (exercise data under Creative Commons Attribution-ShareAlike; **check the licence field of each record**) | Import exercises not already in the library. | Store only records whose licence allows it; keep `license`, `license_author` per row; add wger to Settings → About with the licence link; images only if their own licence allows, else no image. |
| Manual gap fill (written by you from training knowledge, not copied from any site or dataset) | Common gym variations still missing: angles (flat / incline / decline), grips, unilateral versions, cable and machine versions (pec deck, chest-supported row, plate-loaded machines, Smith machine, belt squat, hip thrust machine, etc.). | `source = 'manual'`, no media, YouTube form-video link as today. Payam reviews the list. |
| ExerciseDB, MuscleWiki and other sites without an open licence | **Not used.** | Same rule as SPEC v2 §7.1. |

### A2. Import rules
- Idempotent (re-run changes nothing). Snapshot of each source to R2 with date.
- **De-duplication:** normalise name (lowercase, strip punctuation, unify "DB/dumbbell", "BB/barbell", singular/plural) + equipment + pattern. Probable duplicates go to a review list, not merged silently. Existing exercise ids never change (history is immutable).
- Every row: primary muscle, secondary muscles, equipment, pattern, mechanic (compound/isolation), category, **region tags (A3)**. Rows the mapper cannot fill go to the report, not guessed.
- Import report for Payam (counts per source, per muscle, per region; duplicates; skipped rows with reason; the manual list).

### A3. Muscle regions (single source of truth) — STOP: show Payam the region list and the tagging table
Regions reuse the keys already used by the 3D anatomy map and M10 coverage. Proposal:
- Chest: `chest_upper`, `chest_mid`, `chest_lower`
- Shoulders: `shoulders_front`, `shoulders_side`, `rear_delts`
- Back: `back_lats` (vertical pull), `back_upper` (horizontal pull), `traps`
- Arms: `triceps_long`, `triceps_lateral_medial`, `biceps_long`, `biceps_short`, `brachialis`
- Legs: `quads_squat`, `quads_knee_ext`, `hamstrings_hinge`, `hamstrings_curl`, `glutes_ext`, `glutes_abd`, `calves_gastroc`, `calves_soleus`, `adductors`
- Core: `core_anti_ext`, `core_flexion`, `core_anti_rot`

New table (migration, **STOP**: show SQL):
`exercise_regions(exercise_id, region_key, emphasis 'primary'|'secondary', evidence 'strong'|'moderate'|'weak', note)`.
- Filled by a reviewed rule file (e.g. bench angle ≥ 15° incline → `chest_upper` primary; decline press and dips → `chest_lower`; overhead triceps extension → `triceps_long`; leg curl → `hamstrings_curl`; RDL → `hamstrings_hinge`; straight-knee calf raise → `calves_gastroc`, bent-knee → `calves_soleus`).
- `evidence` says how well research supports that the exercise emphasises that region. Ideas without support ("inner chest", "outer chest", shaping a muscle's insertion) are **not** tagged; the Coach must say they are not supported if asked.
- Unit tests: every strength exercise has ≥1 region; every region has ≥3 exercises; no exercise has two primary regions of the same muscle unless reviewed.

### A4. Library UI
- Region chips under each muscle chip (e.g. Chest → Upper / Middle / Lower).
- Exercise detail shows its regions with the evidence word ("Upper chest · strong evidence").
- Filters: equipment, "New to me" (never logged).

---

## Phase B. Pro Coach (region-aware)

### B1. New / changed tools (read-only)
- `get_coverage(weeks)` → per region: fractional sets per week, last trained date, status vs a region floor, "overdue" when not trained in N weeks (N = M10 coverage window, default 3, editable).
- `get_library` gains `region`, `new_to_me` (only never-logged), `exclude_ids`, and returns `regions[]` with evidence for each exercise; still max 60 results.
- `get_exercise_history(exercise_id)` → exposures, weeks in the program, e1RM trend, stalled flag (no e1RM gain in 3 exposures; same rule as M10).
- `propose_program` result adds the draft's **region coverage** (sets per region per week vs floor), shown on the draft card.

### B2. Rules added to the Coach prompt — STOP: show the added prompt text
- Program by **region**, not only by muscle: each muscle's regions covered within the coverage window; Payam's priority muscle (chest) gets every region trained each week.
- **Shape goals:** when Payam asks to change how a muscle looks (e.g. "fuller upper chest"), translate it into region emphasis + exercise choice + weekly sets, explain the reason and the evidence level, and say plainly what training cannot change (muscle shape set by genetics and insertions).
- **Variety with a reason:** main lifts stay fixed so progress is measurable; accessory and isolation slots rotate every 3–4 weeks, or earlier when stalled, choosing a different angle / equipment / grip for the same region; prefer some `new_to_me` exercises when they fit. Never change for the sake of change.
- Each exercise in a draft gets a one-line reason (region + why this one).
- All existing rules stay (app progression, no deloads, Payam's groups never criticised, 48 h rule as advice, pull ≥ push, every change needs his tap, numbers only from tools).

---

## Phase C. Photo needs analysis

### C1. Photo protocol
- Built in M13 §11 (guide camera: outline, ghost, level, timer). Phase C relies on it.

### C2. What the Coach does with photos
- With one photo: visible development and balance per **region** (left/right, upper/lower body), each marked `ahead` / `even` / `behind` / `unclear` with a one-line reason and a confidence word (high / medium / low).
- With two photos of the same pose and different dates: what changed, same format.
- Says when a photo cannot be judged (pose, light, clothing, distance) and asks for a better one instead of guessing.
- Always says it is a visual estimate; no body-fat % as fact (rough range only if asked); no medical judgments.
- Output = a **photo assessment card** (regions with status, reason, confidence). Button **Use in my next program**: the Coach then uses the `behind` regions as priorities in its next draft (still only on Payam's tap).

### C3. Storage — CONFIRM
Default: assessments live in the chat message only (no new table). Alternative: a `photo_assessments` table so trends over months can be shown on Me → Photos (data change, separate STOP).

---

## Tests
- Unit: import idempotency; dedupe rules; region rule file (fixtures per region); coverage function (overdue, floors, week boundaries); `get_library` filters; draft region coverage.
- Worker: Coach tools with a mocked model; `propose_program` keeps working with region data; photo assessment JSON validated (Zod), invalid → shown as plain text, never invented.
- E2E: Library region chips and "New to me"; Coach "make my upper chest fuller" (mocked) → draft with `chest_upper` sets ↑ and reasons; photo assessment card → "Use in my next program" → next draft priorities include those regions.
- Screenshots (iPhone, dark) for each phase; import report; real cost of 5 messages after deploy.

## CONFIRM before building
1. Sources: free-exercise-db (check gaps) + wger (licence-checked) + manual list. Any other source he wants checked?
2. Region list (A3) as proposed?
3. Accessory rotation every 3–4 weeks, coverage window 3 weeks?
4. Photo assessments: chat only, or a table for long-term trends?

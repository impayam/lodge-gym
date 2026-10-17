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

### Phase A decisions (Payam, 2026-10-16) and how they are built
- **Sources** (STOP 1, approved; replaces the A1 table where they differ): every database reachable, as a source of
  names and facts only (name, muscles, equipment, pattern, mechanic); exercises are common knowledge. Descriptions,
  instructions and media only under an open licence. Used: free-exercise-db (unchanged), wger (licence per record,
  images per their own licence with author; **AI-generated wger images are left out**: they may show the wrong form),
  everkinetic (CC BY-SA 4.0, images), ExerciseDB v1 dataset, Liftosaur and exercemus (facts only). MuscleWiki and
  exercisedb.dev were not reachable from the build environment and are not used.
- Kettlebell, band and ball stay excluded (with foam roller and TRX). From the new sources stretching and cardio are
  imported too: they count 0 toward volume, carry no region and stay out of the region tests. Plyometrics and
  strongman are not imported. Source records without muscles (wger: 130 strength records) are listed in the report
  and not imported.
- **Review** (approved): one decision file per source, pinned to the source commit; the dedupe review list filled
  first by us, Payam can change any line; our own short instructions (two or three steps) on every added row.
- The 22 hand-written exercises (approved) join `manual.json`.
- Migration `0013_exercise_regions.sql` (approved) has no CHECK on `region_key`; the import and the tests check the 26
  keys. It also adds `license` and `license_author` to `exercises`.
- The region rule table (approved) lives in `worker/lib/regions.ts` with its evidence levels; first matching rule per
  muscle wins; reviewed exceptions go to `seed/library/region-overrides.json`. A plain curl tags both biceps heads as
  main focus (the reviewed exception to "one primary region per muscle").
- The program generator chooses from the whole library, so the new rows can appear in a new program; history and the
  current program are still preferred (approved on review, 2026-10-16, as is leaving out the AI-generated wger images).
- Review of the PR (Payam, 2026-10-16): presses, push-ups and dips (bench, incline, decline, overhead press, dips…) tag
  the triceps lateral and medial heads only, never the long head (rule `triceps-press`); the overhead, lying and
  pushdown extensions keep theirs. When an exercise's two images are the same picture, one is kept
  (`seed/library/duplicate-images.json`, listed in the import report). The Library's three filter dropdowns sit one under
  another so their labels show in full on the iPhone.

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
- **Variety with a reason:** main lifts change every 6–8 weeks, so progress stays measurable in between; accessory and isolation slots rotate every 3–4 weeks (Payam, 2026-10-16), or earlier when stalled, choosing a different angle / equipment / grip for the same region; prefer some `new_to_me` exercises when they fit. Never change for the sake of change.
- Each exercise in a draft gets a one-line reason (region + why this one).
- All existing rules stay (app progression, no deloads, Payam's groups never criticised, 48 h rule as advice, pull ≥ push, every change needs his tap, numbers only from tools).

### B3. Forearm and neck regions (Payam, 2026-10-16) — STOP: show the rules and evidence levels before building
- Add regions for the forearms and the neck so their exercises count toward weekly volume (today wrist curls and neck
  work carry no region, A3). Propose the region keys, the tagging rules and each rule's evidence level, the same way as
  the A3 table, and wait for Payam's OK before any code or migration.

### Phase B decisions (Payam, 2026-10-17) and how they are built
- **Regions (30).** Forearm flexors and extensors, neck flexors and extensors join the A3 list (rules and evidence in
  `worker/lib/regions.ts`). Forearms stay off as "also trained" in rows, pulls and deadlifts. Cable Reverse Wrist Curl no
  longer tags the brachialis. Neck: the gym has no 4-way neck machine and no head harness, so only plate, bodyweight and
  isometric exercises; four were added (`seed/library/manual.json`): Lying Neck Extension, Lying Neck Flexion, Isometric
  Neck Extension (Hand Resistance), Isometric Neck Flexion. The Library shows neck under All only.
- **Rotation** (`worker/lib/rotation.ts`). Main and secondary lifts: kept at least 6 weeks, due at 6–8 weeks when stalled
  (the overview's rule: the last 3 sessions did not beat the best before them) or without a new best in their last 2
  weeks, always due at 8. Accessory, isolation and core: kept at least 3 weeks, due at 3–4 weeks when stalled, always at
  4. Weeks count from when the exercise entered the program in that role, across programs that kept it; weeks with no
  training at all do not count. Nothing changes on its own.
- **Program screen.** One line per due exercise, most overdue first, at most 3, with "Nothing changes until you pick a
  replacement." Each line has an Ask Coach button: the Coach says which region the exercise trained these weeks, offers
  2–3 replacements (`suggest_replacements`) with a one-line reason each, and shows each as the one-exercise card in
  replace mode ("Only this session" / "Whole program").
- **Blocks.** A block is one accessory period; the seed program is block A and each new program starts the next block
  (A → B → C → A, `params.block`). Every block covers all 30 regions with at least one main-focus exercise: a region left
  out in the last block replaces an exercise whose region is covered twice. Within a day, no two exercises share a
  main-focus region and the equipment.
- **Equipment.** Barbell: strength and easy load progression, so main lifts stay barbell and only the variation or angle
  changes (Bench → Incline/Decline, Squat → Front/Pause, Deadlift → Trap Bar/Deficit). Dumbbell and cable: a region, an
  angle or a stretch, for the region work. Growth is similar across equipment when sets are near failure (moderate
  evidence), so no equipment is called better for growth. The other exercises of each muscle follow the approved
  A → B → C table (`EQUIPMENT_MIX` in `worker/lib/generator/blocks.ts`).
- **Replacing.** A main lift: a close barbell variation of the same pattern. An accessory: nothing used in the last 8
  weeks, at most one "New to me" exercise per day. A day never changes its main lift and all its accessories at once;
  exercises that are not due are kept, and the proposal shows "replaces X: N weeks".
- **Forearm and neck weekly targets (direct sets).** Forearms start at 4 (2 flexors, 2 extensors), neck at 2 (1 + 1) in
  the first block after the seed program; each later block adds 1 set, up to 8 and 6. Neck work starts light and
  progresses slowly: 1–3 sets of 15–25 reps, 3–4 reps in reserve, 60 s rest, and the smallest load step (2.5 lb /
  1.25 kg, never doubled). Reports compare forearm and neck direct sets with the program's direct sets (fractional counts
  would always read as over: rows and curls add half a forearm set). Sources: Conley et al. 1997
  (https://pubmed.ncbi.nlm.nih.gov/9189733), Schoenfeld, Ogborn & Krieger 2017 (J Sports Sci 35(11):1073–1082), RP
  forearm guide (https://rpstrength.com/expert-advice/forearm-growth-training-tips),
  https://pubmed.ncbi.nlm.nih.gov/17086765/.
- **PR #25 review (Payam, 2026-10-17).**
  - A region an exercise alone covers in the program stays the main focus of its replacement: a side-delt exercise is
    replaced by a side-delt exercise (other equipment, then another angle) unless side delts are covered elsewhere.
  - The replace card first says what happens to the replaced exercise's own region (kept by the new exercise, still
    covered by others, or lost) and its muscle group's weekly sets, even when they do not change.
  - The triceps long head counts as covered only by overhead work, its strong-evidence exercise (`coverRegions`), so
    every block keeps an overhead extension. When a due exercise's region is filled again, other equipment than the due
    one comes first within the block's equipment mix (block B: a dumbbell overhead extension for the cable one).
  - Seven overhead extensions whose names do not say overhead are tagged by review, and Smith Machine Reverse Calf Raises
    (a shin exercise) carries no region (`seed/library/region-overrides.json`); the generator never picks an exercise
    without a main-focus region.
  - The Calendar's contrast check runs at a pinned clock (06:00 Denver, or earlier).
- **Session length.** Covering all 30 regions with the current 4 days takes about 40 exercises instead of 25 (the
  estimate before building was 35): 57–68 minutes a day over 50 seeds, inside the 75-minute setting that New program now
  defaults to.
- **Coach.** B1's `get_exercise_history` is served by `get_e1rm_history` and `get_program` (weeks, due, reason, stalled,
  new best); `get_program` adds the block and the regions without a main focus; `get_library` gains the `region` filter
  and returns the region tags. The B2 variety rule is replaced by the rotation rule; the prompt adds the equipment roles
  (say why an equipment fits: strength progress or a region, angle or stretch). The weekly review names exercises due
  now and next week. Not built in Phase B: `get_coverage`, `get_library`'s `new_to_me` and `exclude_ids`, and per-region
  sets on the draft card (the draft card shows the coverage and same-region warnings instead).

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
3. Accessory rotation every 3–4 weeks, coverage window 3 weeks? (Payam, 2026-10-16: main lifts every 6–8 weeks, accessories every 3–4 weeks.)
4. Photo assessments: chat only, or a table for long-term trends?

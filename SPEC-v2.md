# SPEC v2: English UI, exercise library, training styles and program generator

Status: APPROVED by Payam on 2026-10-12. Decisions are recorded inline as **[DECIDED]**.

This document extends `SPEC.md`. Where the two conflict, this document wins only after Payam approves it.

Milestones run in order:

- **M6** English UI
- **M7** Exercise library + extra exercises in a session
- **M8** Training styles + program generator

Each milestone ships on its own, behind green tests, with D1 migrations applied remotely.

---

## 0. Non-negotiables (all milestones)

1. **History is immutable.**
   - Never delete or rewrite rows in `workout_sessions`, `set_entries`, `photos`, `body_metrics`, `health_workouts` or `weekly_reviews`.
   - A program change never touches past sessions.
2. **Programs are never deleted.**
   - Switching programs sets the old one to `active = 0` with `archived_at`.
   - Past sessions keep their `program_day_id`, so the history view can still show "Day 2 – Legs (Full Body 4-day, archived)".
3. **Progression follows the exercise, not the program.**
   - Suggestions and e1RM come from `set_entries` by `exercise_id` across all programs.
   - If Barbell Bench Press is in the new program, its next suggestion continues from the last real performance.
4. **No program goes live without Payam's tap on "Approve program".**
   - The generator only proposes.
5. **Generator logic is pure and unit-tested.**
   - It lives in `/worker/lib/generator/`.
   - It is deterministic: the same inputs and the same seed give the same output.

---

## M6. English UI

Payam asked for the whole app in English.

- Convert all UI strings to English, LTR layout, Latin digits.
- Remove the Persian digit and RTL code paths.
- Keep input parsing that accepts Persian digits. It is harmless and avoids breakage.
- Exercise display shows `name_en` only. Keep `name_fa` and `cue_fa` columns as data; do not drop them.
- Write English form cues (`cue_en`) for the 20 seeded exercises. Show them in the app; Payam reviews them.
- Dates: Gregorian only. **[DECIDED]** Remove Jalali display and the Jalali conversion code from the UI.
- Font: system font stack. Remove Vazirmatn from the bundle.
- Weekly AI review: **[DECIDED]** It stays in Persian.
  - No schema change.
  - The review card renders `summary_fa`, `highlights` and `suggestions` with `dir="rtl" lang="fa"` inside the English UI.
  - Bundle no Persian web font; the iOS system font renders Persian.
- Update `CLAUDE.md`: "UI strings in English."

**Acceptance:**

- No Persian UI text remains, except stored user notes and the weekly review card.
- Existing sessions, photos and reports render unchanged in English.
- Playwright tests pass on both projects.

---

## M7. Exercise library

### 7.1 Source **[DECIDED, revised 2026-10-13]**

**Primary source: free-exercise-db** (github.com/yuhonas/free-exercise-db).

- License: Unlicense (public domain). Storing data and images locally is allowed.
- Import into D1, and copy images to R2. Never hotlink at runtime.
- Snapshot JSON goes to R2 under `library/free-exercise-db/<date>.json`.

**ExerciseDB is NOT used.** Its RapidAPI terms prohibit storing data or media. Do not import, store or copy any ExerciseDB names, instructions or GIFs. If a paid perpetual dataset is bought later, it will be a separate approved milestone.

**Gap fill (no images):**

- Common gym exercises missing from free-exercise-db are added by hand from general training knowledge, not copied from any dataset.
- These rows use `source = 'manual'`, have empty media, and include primary and secondary muscles, equipment, pattern and mechanic.
- List them in the import report for Payam to review.

**Video link on every exercise:**

- Every exercise in the library (seed, imported, manual, custom) shows a "Watch form video" link.
- The link is a YouTube search URL built from `name_en` + " form": `https://www.youtube.com/results?search_query=<urlencoded>`.
- Store nothing extra; build the link at render time.
- Exercises with no image show a neutral placeholder plus the video link.

### 7.2 Data model changes (needs approval, per CLAUDE.md)

Migration `0004_exercise_library.sql`:

```sql
ALTER TABLE exercises ADD COLUMN source TEXT;              -- 'seed' | 'fedb' | 'manual' | 'custom'
ALTER TABLE exercises ADD COLUMN source_id TEXT;
ALTER TABLE exercises ADD COLUMN cue_en TEXT;
ALTER TABLE exercises ADD COLUMN muscles_secondary TEXT;   -- JSON array of canonical muscle keys
ALTER TABLE exercises ADD COLUMN pattern TEXT;             -- squat|hinge|lunge|h_push|v_push|h_pull|v_pull|isolation|core|carry
ALTER TABLE exercises ADD COLUMN mechanic TEXT;            -- 'compound' | 'isolation'
ALTER TABLE exercises ADD COLUMN level TEXT;               -- 'beginner' | 'intermediate' | 'expert'
ALTER TABLE exercises ADD COLUMN media TEXT;               -- JSON: [{kind:'image'|'gif', r2_key|url}]
ALTER TABLE exercises ADD COLUMN instructions_en TEXT;     -- JSON array of steps
ALTER TABLE exercises ADD COLUMN archived_at TEXT;
CREATE UNIQUE INDEX ux_exercises_source ON exercises(source, source_id);

ALTER TABLE set_entries ADD COLUMN is_extra INTEGER NOT NULL DEFAULT 0;  -- exercise added during the session, not in the plan
ALTER TABLE set_entries ADD COLUMN position INTEGER;                     -- display order inside the session
```

- The 20 existing seeded exercises keep their ids, which protects history. They are matched to library entries and enriched; they are not duplicated.
- **Canonical muscle keys** use the same keys as the muscle map: chest, back_lats, back_upper, quads, hamstrings, glutes, shoulders_front, shoulders_side, rear_delts, biceps, triceps, calves, core, forearms, traps, adductors, abductors, lower_back, neck.
- Each source's muscle names map to these keys through one table, `/worker/lib/muscles.ts`, which is unit-tested.
- `pattern` and `mechanic` are filled from source fields where they exist. Otherwise a reviewed mapping file fills them, and unmapped rows are listed in the import report rather than guessed.

### 7.3 UI

- **Library tab:**
  - Search by name, with filters for muscle, equipment and pattern.
  - The detail view shows media, instructions, the primary and secondary muscles, and **your history with this exercise**: last sets, best e1RM, and a chart.
- **"+ Add exercise" inside an active session:**
  - Uses the same picker.
  - Adds the exercise to this session only: rows in `set_entries` with `is_extra = 1`, default 3 empty sets, no progression target.
  - It never changes the program.
  - The exercise can be removed while it has no done sets.
- **"+ Custom exercise":**
  - Fields: name, primary muscle, secondary muscles, equipment, pattern, and an optional photo (R2).
  - Saved with `source = 'custom'`.
  - Editable and archivable; never hard-deleted once it has history.

### 7.4 Reports

- Extra exercises count in weekly volume and the muscle map.
- **[DECIDED] Secondary muscles count as 0.5 set** (the "fractional" method).
  - The primary muscle counts 1 set.
  - Source: the fractional count gave the best model fit in Pelland et al. 2025, *Sports Medicine*, doi 10.1007/s40279-025-02344-w.
  - Why it matters for safety: with direct-only counting, the generator would add extra triceps and front-delt work on top of heavy pressing. That over-counts fatigue on small joints.
  - The muscle map shows both numbers, direct and fractional. The 80% and 120% thresholds apply to the fractional number.
  - This replaces the earlier direct-only rule. Update the README section "Approved report rules"

**Acceptance:**

- Import is idempotent: re-running changes nothing.
- Every imported exercise has at least a primary muscle key.
- Adding an extra exercise offline syncs exactly once.
- Muscle map totals match a fixture.

---

## M8. Training styles + program generator

### 8.1 Evidence base the rules come from

1. **ACSM 2026 Position Stand**: "Resistance Training Prescription for Muscle Function, Hypertrophy, and Physical Performance in Healthy Adults", *MSSE*, April 2026; an overview of 137 systematic reviews.
   - Train every major muscle group at least 2× per week.
   - Strength: about 80% of 1RM, 2–3 sets per exercise.
   - Hypertrophy: about 10 sets per muscle per week.
   - Training to failure, and complex periodization, did not consistently change outcomes.
2. **Pelland et al. 2025 meta-regressions (*Sports Medicine*)**:
   - Weekly volume increases strength and hypertrophy, with diminishing returns.
   - Frequency has a consistent positive effect on strength and a negligible one on hypertrophy when volume is equal.
3. **Existing approved program rules (SPEC §6)**:
   - RIR-based progression.
   - Increments: upper +5 lb, lower +10 lb, dumbbell +5 lb.
   - No more than 2 training days in a row for full-body styles.
   - A light week every 6–8 weeks.

### 8.2 Generator inputs (Settings → Program → "New program")

- `days_per_week`: 2–6
- `style`:
  - `auto`
  - `full_body`
  - `upper_lower`
  - `ppl`
  - `ppl_ul` (a 5-day hybrid)
  - `bro_split`
  - `strength`: barbell-focused, squat, bench, deadlift and overhead press
- `session_minutes`: 45 | 60 | 75 | 90
- `priority_muscles`: multi-select. The default comes from the current program: chest.
- `avoid`: exercises to exclude, for example after an injury.
- `equipment`: full gym (default), dumbbells only, or bodyweight.

### 8.3 Style rules

| Style | Allowed days | Frequency per major muscle | Notes |
|---|---|---|---|
| full_body | 2, 3, 4 | 2–4× | Max 2 consecutive days |
| upper_lower | 2, 4 | 1× (2 days), 2× (4 days) | 2-day version shows a frequency warning |
| ppl | 3, 6 | 1× (3 days), 2× (6 days) | 6-day: Push/Pull/Legs ×2, one rest day |
| ppl_ul | 5 | ~2× | Push, Pull, Legs, Upper, Lower |
| bro_split | 5 | 1× | Shows a warning: below the ACSM 2×/week minimum; weaker for strength |
| strength | 3, 4 | 2–3× for the main lifts | Main lifts 1–5 reps; accessories 6–12 |
| auto | any | ≥2× | 2–3 days → full_body; 4 → upper_lower; 5 → ppl_ul; 6 → ppl |

### 8.4 Prescription rules (pure functions, unit-tested)

**Weekly volume per muscle**

- Start from the approved targets in SPEC §6:

  | Muscle | Sets per week |
  |---|---|
  | Chest | 13 |
  | Back | 13 |
  | Quads | 10 |
  | Hamstrings/glutes | 9 |
  | Shoulders | 9 |
  | Rear delts | 6 |
  | Calves | 6 |
  | Core | 6 |
  | Biceps | 3 |
  | Triceps | 3 |

- Each priority muscle gets +3 sets.
- Floor: 10 sets for chest, back, quads and hamstrings/glutes.
- Volume is counted fractionally, per §7.4.

**Per-session cap [DECIDED]**

- At most **10 fractional sets per muscle per session**. Above that, sets move to another day.
- Source: Pelland et al., per-session volume meta-regression (SportRxiv preprint 537).
  - Detectable hypertrophy benefit ends at about 11 fractional sets per session.
  - For strength, it ends at about 2 direct sets per session.
- Strength styles: main lifts use the 3–5 working sets from §8.4; extra strength volume goes to another day rather than more sets.

**Order inside a session**

1. Main compound
2. Secondary compound
3. Accessories
4. Isolation and core

Supersets only pair non-competing muscles, for example lateral raise with face pull.

**Rep and load schemes**

| Slot | Sets × reps | Target RIR |
|---|---|---|
| Main (strength styles) | 3–5 × 3–5 | 1–2 |
| Main (other styles) | 3–4 × 5–8 | 1–3 |
| Secondary compound | 3 × 6–10 | 1–3 |
| Accessory | 2–3 × 8–12 | 1–2 |
| Isolation | 2–3 × 10–15 | 0–2 |

**Recovery constraints (hard rules)**

- The same muscle never gets a main compound slot on two consecutive calendar days.
- Heavy hinges (deadlift, RDL, good morning) at most once per 72 h.
- Heavy squat and heavy deadlift never share a session as main lifts. One may appear as a lighter secondary.
- Consecutive days:
  - Full-body: max 2.
  - Split styles: sequencing rules instead, so no muscle is trained on two back-to-back days.

**Balance rules**

- Weekly horizontal + vertical pull sets must be ≥ push sets.
- Rear delts are ≥ 6 sets per week in every style.
- Every style includes at least 1 hinge and 1 squat pattern per week.

**Session length**

- Estimate per set: (rest + 40 s) × sets, plus a 5-minute warm-up.
- If a day exceeds `session_minutes`, drop isolation sets first and never main lifts.

**Exercise choice**

- Filtered by equipment and the `avoid` list.
- Prefer, in order:
  1. Exercises with history
  2. Exercises in the current program
  3. Compound movements
  4. Library exercises at `level` beginner or intermediate
- Deterministic tie-break by seed.

### 8.5 Safe transition (injury prevention)

- **Week 1 of any new program is the intro week.** Sets are about 30% lower and RIR is 3–4.
- **Starting loads:**
  - Exercises with history: 90% of the last working weight, rounded to the plate increment.
  - Exercises without history: no number suggested. The first session asks for an easy weight at RIR 3–4, and progression starts from there.
- **Deload:** a light week every 6–8 weeks continues across program switches. The counter does not reset on a switch.
- **Too many switches:** if Payam switches more than once in 3 weeks, the app shows a notice. It does not block the switch.

### 8.6 Flow

1. **Settings → Program → New program:** fill in the inputs.
2. **The generator returns a proposal:**
   - Days, exercises, sets and reps, RIR, rest, and estimated minutes.
   - The weekly volume per muscle against the targets.
   - Any warnings, for example "Bro split: each muscle 1×/week".
3. **Edit the proposal:**
   - Swap any exercise for one with the same pattern and primary muscle, picked from the library.
   - Change sets within the allowed range.
   - Validation re-runs after every edit. Hard-rule violations block approval; soft warnings do not.
4. **Approve program:**
   - The new program becomes active and the old one is archived.
   - Starting points for weekly targets, adherence and the muscle map:
     - The new program's targets apply from the next session.
     - Past weeks stay scored against the program that was active then.
5. **History screen:**
   - A program timeline: name, style, active dates.
   - Sessions are grouped by program.
   - Payam can re-activate any archived program. That creates a fresh activation and leaves the history as it is.

### 8.7 Data model changes (needs approval)

Migration `0005_program_styles.sql`:

```sql
ALTER TABLE programs ADD COLUMN style TEXT;           -- 'seed_full_body' for the current program
ALTER TABLE programs ADD COLUMN days_per_week INTEGER;
ALTER TABLE programs ADD COLUMN params TEXT;          -- JSON of generator inputs + seed
ALTER TABLE programs ADD COLUMN generated_by TEXT;    -- 'seed' | 'generator'
ALTER TABLE programs ADD COLUMN approved_at TEXT;
ALTER TABLE programs ADD COLUMN archived_at TEXT;
CREATE TABLE program_activations(id TEXT PRIMARY KEY, program_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
ALTER TABLE day_exercises ADD COLUMN target_rir_min INTEGER;
ALTER TABLE day_exercises ADD COLUMN target_rir_max INTEGER;
ALTER TABLE day_exercises ADD COLUMN slot TEXT;       -- 'main'|'secondary'|'accessory'|'isolation'|'core'
```

- The current program is backfilled with `style = 'seed_full_body'`, `generated_by = 'seed'`, and one activation starting at its `created_at`.
- **API additions:**
  - `POST /api/programs/generate`: returns a proposal and stores nothing.
  - `POST /api/programs`: saves an edited proposal as a draft.
  - `POST /api/programs/:id/approve`
  - `POST /api/programs/:id/activate`
  - `GET /api/programs`: lists the programs with their activations.
- All input is validated with Zod.

### 8.8 Tests (minimum)

- **Property tests**, for every allowed style × day combination and 50 random seeds, check that:
  - No hard rule is violated.
  - Every major muscle is ≥ its floor.
  - Pull sets are ≥ push sets.
  - Each day fits `session_minutes`.
- **Snapshot test:** the generator with Payam's inputs (4 days, full_body, 60 min, priority chest) produces a program within ±2 sets per muscle of the current approved program.
- **E2E:**
  1. Generate a program, swap an exercise, approve it.
  2. Old sessions still show under the archived program.
  3. Bench press progression continues from the old weights.
- **Migration test:**
  - Run 0004 and 0005 on a copy of the production D1 export.
  - Session, set and photo counts are unchanged.
  - Every old session still resolves its day name.

---

## Decisions log (2026-10-12)

1. Jalali date display: removed.
2. Weekly AI review: stays in Persian, rendered RTL inside the English UI.
3. Exercise source: free-exercise-db, plus hand-written gap fill without images, and a YouTube form-video link on every exercise. ExerciseDB is not used because of its storage restriction.
6. Migrations 0004 and 0005 approved as shown by Claude Code, including the foreign key, the index, the backfill and the archived upper/lower program.
7. Finer muscle keys for seeded exercises are approved. Reports roll them up into the existing targets.
8. Equipment: if the 5-value limit is app-level only (Zod or TypeScript), extend it to free-exercise-db's equipment values with no table rebuild. If it is a SQL CHECK constraint, map onto the 5 values and list the rest; do not rebuild the table.
9. Claude Code merges each milestone to `main` once it is green, then verifies the production deploy and migrations.
4. Secondary muscles count as 0.5 set (fractional).
5. Per-session cap: 10 fractional sets per muscle.

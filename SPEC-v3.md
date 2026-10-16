# SPEC v3: M9 + M10 (single file)

Status: APPROVED by Payam on 2026-10-12. Build after M8 is merged and verified.
This file replaces the separate SPEC-v3-M9.md and SPEC-v4-M10.md. Add it to the repo as `SPEC-v3.md`.

**Working rules:**
- Same rules as CLAUDE.md.
- Show every migration SQL, every new default number and every data mapping to Payam before applying.
- Send screenshots for approval before each merge.
- Report in Persian after each milestone.

**Build order:**
1. **M9b:** body-map exercise picker. No secrets, no cost.
2. **M9c:** session planner, without the AI button. No secrets, no cost.
3. **M9a + AI advice:** the AI session report and the planner's **Get advice** button. Payam must add `ANTHROPIC_API_KEY` first.
4. **M10:** Training Control Panel.

Each step ships on its own: green Playwright on both projects, merged, production verified.

**Payam's standing preferences, which apply everywhere:**
- Payam can group any 2–3 exercises as a superset or tri-set.
- Strength and balance.
- Chest is the current priority.
- **No deloads, no light weeks, no intro weeks.** He reduces sets himself when tired.
- Every program change needs his explicit approval.
- History is never deleted.

---

# M9


## 0. Non-negotiables

- History is immutable. The report reads data and writes only its own table.
- **Secrets:**
  - `ANTHROPIC_API_KEY` is a Worker secret (`wrangler secret put`), never committed and never sent to the client.
  - Payam creates the key at console.anthropic.com and sets a monthly spend limit there.
- **Offline:**
  - Finishing a session offline still works.
  - The report is generated when the session reaches the server, and the app shows "Report pending" until then.

---

## M9a. AI session report (Persian)

### Trigger
1. Payam taps **Finish session**.
2. The session syncs, and the Worker generates the report in the background (`ctx.waitUntil`).
3. The report screen opens and shows a loading state, then the report.
4. If generation fails (network error, API error, key missing):
   - Show "Report unavailable" with a **Retry** button.
   - Never block finishing the session.
- The report can be **regenerated** later from History → session → Report. This creates a new row; the older rows are kept.
- The report covers **all done sets of the session, including extra exercises** (`is_extra = 1`) and sets of exercises that count 0 volume. The latter are listed but marked "not counted in volume".

### Model and cost
- Model: `claude-opus-5-5`, via the Messages API (`https://api.anthropic.com/v1/messages`).
- Set the model ID in config (`REPORT_MODEL`) so it can be changed without a code change.
- Settings:
  - `max_tokens`: 1500
  - Temperature: low (0.3)
- Estimated cost: ~$0.04 per report, ~$0.60/month at 4 sessions/week. Price check 2026-10-12: Opus 5.5 is $4 input and $20 output per million tokens.
- Log the input/output token counts per report, and show "This month: N reports, ~$X" in Settings.
- **Network:** the Claude Code environment and the Worker must be able to reach `api.anthropic.com`. If it is blocked in the build environment, stop and tell Payam which domain to add.

### Input sent to the model (built server-side; no photos, no personal data beyond training data)
- **Session:**
  - Date, program day name, start and end time, duration, unit, and the session note.
  - Every done set: exercise name, category, primary and secondary muscles, weight, reps or seconds, RIR, `is_extra`, and the planned target for planned exercises.
  - Planned exercises or sets that were not done.
- **Comparison:**
  - The previous session of the same program day: same exercises, weight, reps and e1RM.
  - Personal records (PRs) hit today, using the existing PR rule.
- **Week so far:**
  - Fractional volume per group against the T2 targets, using the same rules as the muscle map. A set counts at most 1.0 per group.
  - Sessions this week.
- **Apple Watch:** HR average and max, and active kcal, if a matched record exists.
- **Body weight:** today's entry and the last 4 weeks' trend, if present.

### Output format (the model returns JSON, validated with Zod, then rendered RTL)
```json
{
  "summary_fa": "2–4 sentences",
  "highlights": ["PRs, progress vs last time"],
  "volume": [{"group": "Chest", "today": 7, "week": 13, "target": 13, "status": "on"}],
  "extras_note_fa": "what the added exercises contributed, or null",
  "missed_note_fa": "what was skipped and its effect on the week, or null",
  "next_time": ["concrete suggestions per exercise: weight/reps for next session, following the app's progression rules"],
  "warnings": ["only real issues: big drop in performance, pain noted, very high RIR 0 count"]
}
```

The **system prompt** must state:
- Write in Persian.
- Be honest and concise.
- Use only the numbers given, with no invented data.
- Suggest weights only by the app's progression rules (+5 lb upper, +10 lb lower, +5 lb per dumbbell, and RIR rules).
- No medical advice. If a pain note exists, suggest rest or seeing a professional.
- Never suggest deloads or light weeks unless Payam's note says he is tired. This is Payam's stated preference.

If the output fails validation, retry once. If it fails again, store the error and show "Report unavailable" with **Retry**.

### Data (migration, show SQL first)
```sql
CREATE TABLE session_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES workout_sessions(id),
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'ok' | 'error'
  report_json TEXT,                -- validated JSON above
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX session_reports_session ON session_reports(session_id, created_at);
```

### API (Zod-validated, behind sign-in)
- `POST /api/sessions/:id/report`: generate a report or regenerate it. Rate limit: 10 per day.
- `GET /api/sessions/:id/report`: returns the latest report.
- The weekly backup includes `session_reports`.

### UI
- Shown after Finish, and from History → session → **Report**.
- Persian, RTL card inside the English app, the same style as the weekly review.
- The PNG share card can include the summary.

### Tests
- **Unit:**
  - The input builder includes extra exercises, 0-volume exercises and missed sets.
  - Group volume counts each set at most once per group.
  - Bad model JSON is retried once, then stored as an error.
- **Worker:** the Anthropic API is mocked. Never call the real API in tests.
- **E2E:** finish a session with one extra exercise. The report shows the extra exercise and the volume table. Then the failure path: the Retry button appears.

---

## M9b. Body-map exercise picker (two-step)

### Flow
- In a session, **+ Add exercise** opens the picker on the **Body** tab. The existing **Search** tab stays.
- **Step 1, the body:**
  - The same front and back figures as the muscle map, without status colours.
  - Tapping anywhere selects a **region**. The regions are:
    - Chest
    - Shoulders
    - Arms (biceps, triceps, forearms)
    - Back (lats, upper back, traps, lower back)
    - Core
    - Glutes & hips (glutes, adductors, abductors)
    - Thighs (quads, hamstrings)
    - Calves
- **Step 2, the region view:**
  - The region is shown enlarged with each muscle as its own tappable area.
  - A row of large chips with the muscle names sits below it. Chips are the accessible alternative to tapping the drawing.
  - Back/front toggle where relevant. For example, the arm view shows biceps on the front and triceps on the back.
- **Step 3, the exercise list for the chosen muscle:**
  - Order:
    1. Exercises with this muscle as **primary**.
    2. Then a collapsible "Also works this muscle" section with exercises that have it as secondary.
  - Sorting within each group:
    1. Exercises Payam has done before, most recent first.
    2. Exercises in the current program.
    3. Compound before isolation.
    4. Name.
  - Filters: equipment (barbell / dumbbell / cable / machine / bodyweight) and category (default Strength; others are shown with "not counted").
  - Each row shows:
    - Thumbnail or placeholder
    - English name
    - Equipment
    - Last performance, if any
    - **Watch form video ↗** link
- **Step 4:** tap an exercise to add it to the session as an extra (`is_extra = 1`, 3 empty sets, the same behaviour as M7). The picker closes.
- **Navigation:** Back goes from list to region to body. The selection persists if the picker is reopened in the same session.

### Requirements
- Tap targets are at least 44×44 pt. The region view must make small muscles (rear delts, forearms, calves) easy to hit.
- Reuse the M7 geometry and muscle keys, with no new data model. The region → muscle mapping lives in one unit-tested module.
- It works offline: the library is already cached.
- Light and dark mode, at iPhone width.

### Tests
- **Unit:** the region → muscles mapping covers all 17 drawn muscle keys. Each key belongs to exactly one region.
- **E2E (both projects):**
  1. Open + Add exercise, tap Arms, then Triceps.
  2. The list shows triceps-primary exercises first.
  3. Select one. It is added as an extra, and it appears in the session report input.
- Send screenshots of the body step, the Arms region and the triceps list (light and dark) for Payam's approval before merge.

---

## M9c. Session planner + AI plan advice

Approved by Payam on 2026-10-12.

### Flow
1. **Home → next day card → Plan session.** This opens a **planned** session built from the program day: exercises, sets, reps and rest. Nothing is timed yet.
2. **In the planner Payam can:**
   - **Replace** an exercise, using the M9b body picker or search.
   - **Delete** an exercise.
   - **Add** an exercise.
   - **Reorder** exercises with a drag handle, plus Move up / Move down buttons for accessibility and precise taps.
   - **Edit** sets, reps and rest per exercise.
3. **Save:** the planned session is stored in D1 and shows on Home as "Planned: Day 1 – Chest (edited)".
   - It works offline through the outbox.
   - There is at most one planned session per program day.
   - **Discard plan** returns to the program default.
4. **Start session (at the gym):**
   - Open the planned session and tap **Start session**. The timer and set logging begin, and `started_at` is set then, not at planning time.
   - Starting without a plan works exactly as today.
5. **Scope of changes:**
   - By default, changes apply to **this session only**.
   - The planner has a button: **Apply to program**. It creates a new program version with this day changed (M8 program versioning: the new version becomes active and the old one is archived, never deleted). Confirm before applying.
   - Progression follows the exercise, so history is unaffected.
6. **During an active session:**
   - Exercises can be **reordered** and **deleted**.
   - An exercise with done sets cannot be deleted. Payam must clear its done sets first, so history is never silently removed.
   - Its remaining undone sets can be removed.

### Supersets and tri-sets (Payam's request)
- **Where:** in the planner and in an active session, Payam can group **2 exercises (superset)** or **3 exercises (tri-set)**.
- **How:**
  1. Select the exercises, then tap **Group**. Ungroup with **Ungroup**.
  2. Grouped exercises are shown together with a bracket and labels A1/A2/A3. The next group is B1/B2, and so on.
  3. The members of a group must be adjacent. Reordering moves the whole group, and Payam can reorder inside a group.
- **Fully free grouping, no warnings.** Payam can group any 2–3 exercises, including members that train the same muscle (e.g. a chest-only tri-set) or heavy `main` compounds. The app shows **no warning** for the grouping itself. Decision by Payam on 2026-10-13; this replaces the earlier same-muscle warning.
- The normal per-session cap still applies to volume: if the session goes over 10 fractional sets for a muscle, the existing cap message shows, as for any session.
- **Logging flow in an active session:**
  1. Round 1 is set 1 of A1, then set 1 of A2 (and A3).
  2. After the last exercise of the round, the rest timer starts.
- **Rest settings:**
  - Rest between exercises inside a round defaults to 0–15 s, so no timer runs.
  - Rest after a round defaults to the longest planned rest of the members. It can be edited per group.
- **Set counts:**
  - If members have different set counts, the extra sets of the longer one are done alone after the last round.
  - Volume counting, progression and history are unchanged: each set counts for its own exercise.
- **Apply to program** keeps the grouping. It is stored as `superset_tag` in `day_exercises`, which already exists.
- **AI advice:**
  - It may suggest a grouping only between non-competing muscles, for example chest + back, or biceps + triceps.
  - It never criticizes or flags Payam's own groups (same-muscle groups included) as a problem.
  - It never changes Payam's groups without an **Apply** tap.

### Change by Payam, 2026-10-16: the session screen (Step 2)
Replaces the logging flow and rest settings above, and SPEC §7's "rest timer with that exercise's rest time". Rules in `worker/lib/rest.ts` (pure, unit-tested).
- **Rest timer:**
  - An exercise alone: 30 s between its sets; after its last set, 2 min before the next exercise.
  - A superset or tri-set: no timer inside a round; the group's rest after each round (the planner's group rest, by default the longest planned rest of its members, e.g. 75 s); 2 min after its last round.
  - Both defaults are in **Settings → Training** ("Rest between sets": 15 s–3 min; "Rest before the next exercise": 30 s–5 min). They are settings keys `rest_between_sets_sec` and `rest_next_exercise_sec` (no migration); the API takes only the offered values.
  - The label says what comes next: "Rest · next: set 3 of 4", "Rest · next: round 2 of 3", "Rest · next: Pull-Up". The next set is the first one not done; the next exercise is the next card with a set left (round to one he skipped). Nothing left in the session: no timer. +30 s and Skip stay. The "Rest is over" push says "Next: set 3 of 4".
- **Supersets and tri-sets on one card:**
  - The card shows the group's name ("Superset A"), its exercises' numbers and its rest; each member keeps its own Last time, suggested weight, cue, form video, target and RIR.
  - Sets are interleaved round by round (A1 set 1, A2 set 1, then round 2 …); the current row moves through the round. A member's extra sets (more than the others, or added with + Add set) are rounds of their own at the end, each followed by the group's rest.
  - No swiping inside a group: Prev / Next and the swipe move between cards (an exercise alone or a whole group).
  - Volume, progression, reports and history are unchanged: each set still counts for its own exercise.
- **Body weight after Finish:** the end-of-session screen has an optional "Body weight today (lb)" with − / +, shown from his last entry (the − / + start from it). It is the same value as the session's More sheet (one manual value per day); skipping it blocks nothing.
- **Ask Coach** from the session's More sheet: SPEC-v9 §13.

### AI plan advice (button only)
- The planner has an **Get advice** button. It is never automatic, and each tap is one model call.
- Model: the same as the session report (`REPORT_MODEL`, `claude-opus-5-5`), with the same `ANTHROPIC_API_KEY`, cost log and Settings cost line.
- Rate limit: 20 per day.
- It needs a connection. When offline, the button is disabled with "Needs connection".

**Input:**
- The current plan: exercises in order, with sets, reps and rest.
- The original program day.
- The last 14 days of done sets, with group volume against the T2 targets (same rollup rules as the muscle map).
- The dates of the last heavy compound per muscle group, for recovery.
- The active program style.
- Payam's stated preferences:
  - Strength and balance.
  - Chest is a priority.
  - No deload or light-week suggestions.
- A **candidate list** of library exercises (id, name, equipment, primary/secondary muscles, category), filtered to the muscles under discussion, so the model can only suggest real exercises.

**Rules in the system prompt:**
- Persian.
- Honest, concise.
- Evaluate the plan against recent training:
  - Weekly volume per group.
  - Recovery: no heavy compound for a muscle within 48 h of the last one.
  - Order: heavy compounds first, isolation last. When the model itself suggests a superset, only for non-competing muscles; Payam's own groups are accepted as they are.
  - Balance: pull ≥ push.
- Suggest complementary work only when needed. Example: "If you train chest today, triceps is under target this week, so add X after the presses."
- Respect Payam's choice: advise, never insist.
- No medical advice.

**Output (JSON, Zod-validated; exercise ids must exist in the candidate list, otherwise the item is dropped):**
```json
{
  "assessment_fa": "2–4 sentences on the plan vs recent training",
  "suggestions": [
    {"type": "add|remove|replace|reorder|sets",
     "exercise_id": "…", "replace_exercise_id": "… or null",
     "position": 3, "sets": 3,
     "reason_fa": "one sentence"}
  ]
}
```

**UI:**
- Advice shows as a Persian RTL card.
- Each suggestion has an **Apply** button. Nothing changes without that tap.
- Applied suggestions are marked. Payam can still edit or undo.

### Data — AS BUILT (2026-10-13)
`workout_sessions` has `CHECK (status IN ('active','done'))` and `started_at NOT NULL`, so Payam chose **option A**: plans live in a separate table. Migration `0008_planned_sessions.sql` (in production) created `planned_sessions` (status `planned|started|discarded`, one open plan per program day; Start creates the workout session with the same id) and `session_plan_items` referencing `planned_sessions(id)`, plus `per_leg` and `target_rir_min/max`. `workout_sessions` was not changed. The repo migration is the source of truth.

**Still to build in M9a (show SQL first):** `plan_advice`, referencing `planned_sessions(id)` (not `workout_sessions`):
```sql
CREATE TABLE plan_advice (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES planned_sessions(id),
  created_at TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
  advice_json TEXT, error TEXT, input_tokens INTEGER, output_tokens INTEGER
);
```

Original draft (superseded, kept for history):
```sql
-- planned sessions reuse workout_sessions with status = 'planned' and started_at NULL
CREATE TABLE session_plan_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES workout_sessions(id),
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  position INTEGER NOT NULL,
  sets INTEGER NOT NULL,
  reps_min INTEGER, reps_max INTEGER, is_time INTEGER NOT NULL DEFAULT 0,
  rest_sec INTEGER,
  origin TEXT NOT NULL,            -- 'program' | 'added' | 'replaced' | 'ai'
  replaced_exercise_id TEXT,
  group_tag TEXT,                  -- NULL | 'A' | 'B' ... members ordered by position
  group_rest_sec INTEGER,          -- rest after a full round of the group
  removed_at TEXT,                 -- soft delete; never hard-deleted
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX session_plan_items_session ON session_plan_items(session_id, position);
CREATE TABLE plan_advice (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES workout_sessions(id),
  created_at TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
  advice_json TEXT, error TEXT, input_tokens INTEGER, output_tokens INTEGER
);
```
- Check whether `workout_sessions.status` has a CHECK constraint before adding `'planned'`. If it does, propose the safest change and wait.
- Reports, the weekly review and the session report **ignore** planned sessions until they are started.
- Backups include the new tables.

### API (Zod, behind sign-in)
- `POST /api/sessions/plan`: create or get the planned session for a program day.
- `PUT /api/sessions/:id/plan-items`: full ordered list, idempotent.
- `POST /api/sessions/:id/start`
- `POST /api/sessions/:id/apply-to-program`
- `POST /api/sessions/:id/plan-advice`
- `DELETE` routes are not used. Removal is a soft delete through `removed_at`.

### Tests
- **Unit:**
  - Plan → start keeps the order, sets and reps.
  - Apply-to-program creates a new version and archives the old one. Old sessions still resolve their day.
  - Advice validation drops unknown exercise ids.
  - Planned sessions are excluded from reports.
- **Worker:** the Anthropic API is mocked. Never call the real API in tests.
- **E2E (both projects):**
  1. Plan Day 1 offline: replace the incline press, delete one exercise, reorder two exercises, save.
  2. Reopen the plan and start it. The session shows the edited order.
  3. Log a set. Reorder during the session. Deleting an exercise with done sets is blocked.
  5. Group 3 exercises as a tri-set. Logging alternates A1→A2→A3, and the rest timer starts only after A3. Ungroup restores normal order. Grouping three chest exercises as a tri-set shows no warning.
  4. Advice with a mocked model shows a suggestion. Apply adds the exercise at the given position.
- Send screenshots of the planner, the advice card and the started session (light and dark) for approval before merge.

---

# M10: Training Control Panel

The Control Panel drives the M8 generator and the M9c planner. Nothing changes in Payam's program without his tap on **Approve**.


## M10.0 Principles (from the evidence and Payam's decisions)
- **Main lifts stay stable** so that strength progress stays measurable. They are the slot `main` exercises, for example bench, squat, deadlift and overhead press.
- **Variation is systematic, never random.** Only accessory and isolation slots rotate, at most once per cycle, and only for a reason: coverage or priority.
  - Source: Kassiano et al. 2022, *JSCR* 36(6):1753–1762, a systematic review of 8 studies in young men. Some systematic variation improved regional hypertrophy and strength. Excessive or random rotation may compromise gains.
- **No deloads and no light weeks**, which is Payam's stated preference. The detail phase changes exercise selection and rep ranges, **not total volume**.
- The existing safety rules stay:
  - At most 10 fractional sets per muscle per session.
  - Every major group at least 2×/week (ACSM 2026). The exception is maintenance-tier muscles, where the panel shows a warning if the frequency falls below 2.
  - At most 2 consecutive days for full body.
  - No heavy compound for the same group within 48 h.
- The UI copy for the detail phase must not promise "shaping" a muscle. It says: *"Detail phase: more isolation and higher reps to cover every part of each muscle. Muscle shape itself is largely genetic."*

---

## M10.1 Control Panel (Settings → Training)

### 1.1 Priorities: ranking plus tiers
- A drag-to-rank list of the 10 report groups:
  - Chest
  - Back
  - Quads
  - Hamstrings & glutes
  - Shoulders
  - Rear delts
  - Calves
  - Core
  - Biceps
  - Triceps
- Each group also has a tier toggle: **Priority**, **Normal** or **Maintain**. The default comes from the rank:
  - Rank 1–2: Priority
  - Rank 3–7: Normal
  - Rank 8–10: Normal
  - Payam can set any group to Maintain.
- **Weekly target per group** = T2 base (the fractional volume of the current approved program) × the tier multiplier:

  | Tier | Multiplier | Limits |
  |---|---|---|
  | Priority | ×1.25 | Capped at 20 fractional sets per week. Within a session, still capped at 10 per muscle. |
  | Normal | ×1.0 | — |
  | Maintain | ×0.33 | Floor of 4 sets per week |

- **These multipliers are editable defaults**, shown under "Advanced", not hard science.
  - Maintenance needs much less volume than building (e.g. Bickel et al. 2011, *MSSE*). The exact amount is individual.
  - Weekly benefit shows diminishing returns (Pelland et al. 2025, *Sports Medicine*).
- **Live preview:** the panel shows the resulting weekly targets per group and the estimated session length per day before saving. It warns if a day would exceed the session minutes from M8.

### 1.2 Coverage (sub-regions)
- **Regions per group (data model below):**
  - Chest: upper, mid, lower
  - Shoulders: front, side
  - Rear delts
  - Back: vertical pull (lats), horizontal pull (upper back), traps
  - Triceps: long head (overhead or behind-the-body work), lateral/medial (pushdowns, presses)
  - Biceps: long head (incline or neutral), short head (preacher or curls)
  - Hamstrings: hip hinge, knee flexion (curls)
  - Glutes: hip extension, abduction
  - Quads: squat pattern, knee extension
  - Calves: gastrocnemius (straight knee), soleus (bent knee)
  - Core: anti-extension, flexion, anti-rotation
- **Coverage window:** each region should be trained at least once per N weeks. N is editable and defaults to 3.
- **The panel shows a coverage grid:** each region with the date it was last trained, and a status of covered, due or overdue.

### 1.3 Cycles
- **Cycle:** Strength phase **3 weeks**, then Detail phase **1 week**. Both lengths are editable. The cycle can be turned **Off**.
- **Strength phase:**
  - Main lifts 3–5 × 3–6, RIR 1–2.
  - Accessories 6–10 reps.
  - Isolation 8–12 reps.
- **Detail phase:**
  - Main lifts stay in place: same sets, 5–8 reps, RIR 1–2.
  - Total weekly volume is unchanged.
  - Accessory and isolation slots switch to exercises chosen to cover the regions that are due, at 10–15 reps, RIR 0–2.
- **Position:** the current cycle position is stored and continues across program switches.
- **Manual override:** "Switch phase now" and "Skip detail week".

### 1.4 History-based adaptation
These rules are pure, unit-tested functions in `/worker/lib/adapt/`.

**Rules, evaluated weekly:**
1. **Under-target:** if a Priority or Normal group was under 80% of its target for **2 consecutive weeks**, propose +2 fractional sets next week. Put them on a day where the session cap and recovery allow it.
2. **Overdue region:** if a coverage region is overdue, propose swapping one accessory or isolation slot for an exercise covering that region.
   - Prefer exercises Payam has done before, then exercises in the library with the right equipment.
3. **Over-target:** if a group is over 120% for 2 consecutive weeks and is not Priority, propose −2 sets.
4. **Stalled exercise:** if the e1RM of an accessory has not improved for 3 exposures, propose a variation that keeps the same pattern and region. Never do this for main lifts; for those, only show a note.
5. **Cycle change:** propose the next phase's exercise and rep changes.

**Hard limits:**
- Never violate the safety rules above.
- Never propose more than **3 changes per week**. Pick the highest-impact ones.
- Every change carries a one-line English reason with the numbers behind it, for example "Triceps 6.5/9.5 for 2 weeks".

---

## M10.2 Weekly proposal flow
- On `week_start`, or when Payam taps **Review next week**, the Worker builds a proposal for the next week's planned sessions.
- **The Home card:** "Next week: 3 suggested changes". Tapping it opens the proposal list.
- **Each change has:**
  - A before/after view.
  - The reason.
  - **Approve**, **Reject**, or **Edit**. Edit opens the M9c planner.
- **Bulk actions:** Approve all and Reject all.
- **Approved changes** go into the M9c planned sessions for that week, as one-off changes.
- **Apply to program:** an optional toggle per change. It creates a new program version (M8 versioning) instead of a one-off.
- **Optional AI:** the M9c **Get advice** button can explain or critique the proposal in Persian. It is never automatic.
- Proposals and decisions are stored for history: what was proposed, what was approved, and when.

---

## M10.3 Data (one migration; show SQL first)
```sql
-- control panel settings live in settings(key,value) as JSON under key 'training_panel' (no schema change)
ALTER TABLE exercises ADD COLUMN regions TEXT;      -- JSON array of region keys, e.g. ["chest_upper"]
CREATE TABLE weekly_proposals (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cycle_phase TEXT NOT NULL,                       -- 'strength' | 'detail' | 'off'
  status TEXT NOT NULL,                            -- 'open' | 'closed'
  UNIQUE(week_start)
);
CREATE TABLE proposal_items (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES weekly_proposals(id),
  kind TEXT NOT NULL,                              -- 'add_sets'|'remove_sets'|'swap'|'phase'|'note'
  program_day_id TEXT, exercise_id TEXT, new_exercise_id TEXT, sets_delta INTEGER,
  reason TEXT NOT NULL, evidence_json TEXT,
  decision TEXT,                                   -- NULL | 'approved' | 'rejected' | 'edited'
  apply_to_program INTEGER NOT NULL DEFAULT 0,
  decided_at TEXT
);
```

**Regions mapping:**
- A reviewed mapping file, `/seed/regions.json`, assigns exercise → regions for:
  - The seed exercises.
  - The 15 manual exercises.
  - The common free-exercise-db exercises.
- Unmapped exercises keep `regions = NULL` and are not used for coverage swaps. They are listed in a report.
- **Show Payam the mapping for the seed and manual exercises before merging.**

---

## M10.4 Tests
- **Property tests:** for every tier mix and cycle phase, the generated weeks never violate the safety rules or the 3-changes cap.
- **Scenario tests (fixtures from realistic history):**
  - Triceps under target for 2 weeks → +2 sets is proposed.
  - Upper chest not trained for 3 weeks → swap cable fly → incline DB fly.
  - Main lift stalled → note only, no swap.
  - Detail week → same total volume ±1 set per group, and main lifts unchanged.
- **E2E (both projects):**
  1. Rank Chest first and set Calves to Maintain. The preview targets update.
  2. Review next week. Approve one change and reject one.
  3. The planned session shows the approved change.
  4. History keeps the decisions.
- Send screenshots of the Control Panel, the coverage grid and the proposal screen (light and dark) for approval before merge.

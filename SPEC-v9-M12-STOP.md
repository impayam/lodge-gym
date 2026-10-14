# SPEC v9 M12, Coach chat: STOP items for Payam's approval

Prepared 2026-10-14. Nothing is built, migrated or deployed. Building starts after PR #12 (Pulse) is merged and Payam
says go. Each section below is one STOP item from `SPEC-v9-M12-coach.md`; the defaults I picked are listed at the end
under "Decisions to confirm".

## 0. Price check (§7)

Checked **2026-10-14** on the official pricing page, https://platform.claude.com/docs/en/about-claude/pricing.

| Claude Opus 5.5 | USD per million tokens |
|---|---|
| Base input | $4 |
| Cache write, 5 minutes | $5 (1.25 × input) |
| Cache write, 1 hour | $8 (2 × input) |
| Cache read (hits and refreshes) | $0.20 (0.05 × input; the page notes Opus 5.5 uses 0.05× instead of the usual 0.1×) |
| Output (thinking counts as output) | $20 |

Not used: US-only inference (`inference_geo: "us"`, 1.1×), Batch, fast mode. Every tool request also carries 286 tokens of
the API's own tool-use system prompt (Opus 5.5, `tool_choice` auto).

Cost of one model call, from the token counts the API returns:

```
cost_usd = (input_tokens × 4 + cache_write_tokens × 5 + cache_read_tokens × 0.20 + output_tokens × 20) / 1 000 000
```

The cost caption under an answer is the sum of the calls that produced it (a tool round trip is a second call).

## 1. System prompt (§3)

The system prompt has two blocks. Block 1 never changes, so it is cached together with the tool definitions
(`cache_control` on block 1). Block 2 is a short context line written by the app for each request; it sits after the
cache breakpoint, so it does not break the cache.

### Block 1 (cached)

```text
You are the coach in GYM time, Payam's personal training app. You are an experienced strength and hypertrophy coach, and you coach one person: Payam.

LANGUAGE AND FORM
- Answer in Persian (Farsi) unless Payam's message is in English; then answer in English. Exercise names may stay in English. Write numbers with Latin digits (0-9), as the app does.
- Be honest and direct. No flattery, no filler. Praise only what his numbers show, and say plainly when something got worse.
- Keep answers short: a few short paragraphs, or a short list with "-" bullets. Plain text only: no headings, bold, tables or code blocks. The app draws tables and charts itself as data cards.
- If the answer depends on something he did not say, ask one short question instead of guessing.

WHAT YOU KNOW
- The established training methods and when each fits: progressive overload; linear, double, undulating and block periodization; RIR and RPE autoregulation; volume landmarks (maintenance, minimum effective, maximum adaptive and maximum recoverable volume); supersets, tri-sets and giant sets; drop sets, rest-pause, myo-reps and cluster sets; tempo and pauses; unilateral work; exercise selection by muscle length and region; technique cues for the squat, bench press, deadlift, overhead press and rows; warm-up ramps; recovery and sleep; basic nutrition for muscle and strength.
- Explain the reason behind every piece of advice. When the evidence is mixed or weak, say so plainly. Never invent studies, authors, numbers or sources. If you are not sure, say so.

PAYAM'S DATA
- Facts about Payam's own training (sessions, sets, weights, records, volume, consistency, body weight, his program, his photos) come only from the tools. Call a tool before you state any number of his. Never guess or estimate his numbers, and never reuse a number from earlier in the chat when a tool can give it now.
- If a tool returns no data, say there is no data for that period. Do not fill the gap.
- Use the numbers exactly as the tools return them: the app calculates them with the same math as its Reports. You may round in prose, but never calculate a different e1RM, volume or adherence yourself.
- Every tool result is shown to Payam as a data card under your answer, captioned "Numbers calculated by the app from your logs". Do not repeat the whole table in text; say what it means and what to do.
- Dates are local dates (YYYY-MM-DD) in his time zone; the context line gives today's date. Weights are in his unit.
- A week that is not over yet is marked partial by the tools. Do not call a partial week under target.
- You cannot change anything in the app: you cannot log sets, edit sessions or change his program. The only thing you can create is a program draft (propose_program), which he may add with a tap.

HOW THE APP TRAINS HIM (do not contradict these)
- The app sets the next weights. When every planned set of an exercise reaches the top of its rep range, the next session adds 5 lb for upper-body lifts, 10 lb for lower-body lifts and 5 lb per dumbbell (kg: 2.5, 5 and 2 per dumbbell). RIR 3 or more on every planned set doubles the step. Otherwise the weight stays. Do not set other weights for his program unless he asks.
- Reps in reserve: each exercise of a generated program has its own target RIR (get_program). The original full-body program uses RIR 3-4 in weeks 1-2 and RIR 1-2 from week 3. A logged RIR of 3 means 3 or more.
- Weekly volume: each done set counts 1 for its main muscle group and 0.5 for each secondary group, at most once per group per set. Only strength work counts, not stretching, plyometrics, cardio or strongman. Each group's weekly target is the volume his current program plans for it. A group is under below 80 % of its target and over above 120 %.
- Planned sessions come from the program's days per week.

HIS STANDING PREFERENCES
- Goals: strength and balance. Chest is the current priority; get_program lists his priority muscles.
- No deloads, light weeks or intro weeks, and no cutting volume for rest, unless he says he is tired.
- He may group any 2 or 3 exercises as a superset or tri-set, including the same muscle. Never criticise his groups or suggest breaking them up.
- Every change to his program needs his tap. Never say that a program was saved or changed.

PROGRAMS
- When he asks for a program, a new day, or a change to his program, read get_program and his recent training first, then call propose_program once with the whole draft.
- Use only exercise ids from get_library, exactly as written. Ids that are not in the library are dropped, and the tool result tells you which.
- Follow his preferences and the app's rules: one main lift first on each day, heavy compound lifts before isolation work, enough weekly sets for each group's target, groups of 2-3 consecutive exercises only.
- After the draft, say in two or three sentences what it changes and why. The app shows the draft as a card with "Add to Planner" and "Change". Adding it never replaces his active program.

PHOTOS
- He may attach up to 4 photos: progress photos or stills of an exercise. You may comment on visible muscle development and balance (left and right, upper and lower body), compare two dates, posture or position in a still photo, and what to train more.
- Always say it is a visual estimate. Never state a body-fat percentage as fact. Give a rough range, labelled as a rough estimate, only if he asks for one.
- One still photo cannot fully judge lifting technique. Say so, and ask for more angles when it matters.
- No medical judgments from photos.

HEALTH AND SAFETY
- No medical diagnosis or treatment. If he mentions pain or injury, suggest rest and seeing a doctor or physiotherapist. Do not prescribe rehab.
- Nutrition stays basic. For medical diets, drugs or anything beyond basic nutrition, suggest a doctor or dietitian.
```

### Block 2 (written by the app for each request, not cached)

```text
CONTEXT (written by the app for this message)
Today: Wednesday 2026-10-14. Time zone: America/Denver.
Weight unit: lb. Weeks start on Monday.
Active program: Full body · 4 days, active since 2026-09-27.
```

Values come from Settings and the active program; the example shows today's.

## 2. Tools and their JSON shapes (§4)

Common rules:

- All tools run on the Worker, read only (except that `propose_program` creates a card, not data). Results are JSON text in a
  `tool_result`; a bad input returns `is_error: true` with `{"error": "…"}` so the model can correct it.
- Numbers come from the existing functions in `worker/lib/reports.ts` and `worker/lib/ai/overview.ts` (the same math as
  Reports): Epley e1RM `weight × (1 + reps / 30)`, best set per session, fractional sets per group, T2 targets,
  `balanceStatus` (under < 80 %, over > 120 %), planned sessions option A. Weights are converted to Payam's unit like
  Reports, rounded to 0.1.
- Dates are local `YYYY-MM-DD` in his time zone. Ranges are inclusive and at most 92 days per call (token budget).
- Every result is saved in the message's `content_json` and drawn by the client as the data card named in "Card".
- Inputs are validated with Zod on the Worker as well as by the schema.

### get_sessions

```json
{
  "name": "get_sessions",
  "description": "Payam's logged sessions between two local dates (inclusive), newest first, with every done set. The open session, if he is training now, is included with status \"active\". At most 92 days per call.",
  "input_schema": {
    "type": "object",
    "properties": {
      "from": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": "First local date, YYYY-MM-DD." },
      "to": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": "Last local date, YYYY-MM-DD; not before from, at most 92 days after it." }
    },
    "required": ["from", "to"],
    "additionalProperties": false
  }
}
```

Result:

```json
{
  "unit": "lb",
  "from": "2026-10-01",
  "to": "2026-10-14",
  "sessions": [
    {
      "id": "01JA7Y2K9QH4M1T0B8E5X6C3VD",
      "date": "2026-10-13",
      "status": "done",
      "day": "Day 3 · Back",
      "program": "Full body · 4 days",
      "duration_min": 55,
      "note": "",
      "exercises": [
        {
          "exercise_id": "deadlift",
          "name": "Conventional Deadlift",
          "is_extra": false,
          "counts_volume": true,
          "sets": [
            { "set": 1, "weight": 255, "reps": 5, "seconds": null, "rir": 2 },
            { "set": 2, "weight": 255, "reps": 5, "seconds": null, "rir": 1 }
          ]
        }
      ]
    }
  ]
}
```

Only done sets; `weight` is null for body-weight sets; `rir` 0–3, where 3 means "3+". Card: sessions table (date, day,
exercises with sets).

### get_e1rm_history

```json
{
  "name": "get_e1rm_history",
  "description": "Estimated 1RM history of one exercise: the best set of each session day (Epley) over the last N weeks, with the % change from the first to the latest point.",
  "input_schema": {
    "type": "object",
    "properties": {
      "exercise_id": { "type": "string", "description": "Exercise id from get_program, get_sessions or get_library." },
      "weeks": { "type": "integer", "minimum": 1, "maximum": 104, "description": "How many weeks back from today; default 12." }
    },
    "required": ["exercise_id"],
    "additionalProperties": false
  }
}
```

Result:

```json
{
  "unit": "lb",
  "exercise_id": "bench",
  "name": "Barbell Bench Press",
  "from": "2026-07-22",
  "to": "2026-10-14",
  "points": [
    { "date": "2026-09-17", "weight": 135, "reps": 5, "e1rm": 157.5 },
    { "date": "2026-10-08", "weight": 150, "reps": 5, "e1rm": 175 }
  ],
  "first_e1rm": 157.5,
  "latest_e1rm": 175,
  "best_e1rm": 175,
  "change_pct": 11.1
}
```

`change_pct` is null with fewer than two points. Unknown id: error. Card: line chart with Table view.

### get_volume

```json
{
  "name": "get_volume",
  "description": "Weekly sets per muscle group (fractional count) against the weekly targets of the program active that week, with status none, under, on, over or untracked. One row set per week that overlaps the range; the current week is marked partial. At most 92 days per call.",
  "input_schema": {
    "type": "object",
    "properties": {
      "from": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
      "to": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
    },
    "required": ["from", "to"],
    "additionalProperties": false
  }
}
```

Result:

```json
{
  "weeks": [
    {
      "start": "2026-10-12",
      "end": "2026-10-18",
      "partial": true,
      "program": "Full body · 4 days",
      "groups": [
        { "group": "chest", "name": "Chest", "direct_sets": 8, "fractional_sets": 9.5, "target": 13, "status": "under" },
        { "group": "traps", "name": "Traps", "direct_sets": 0, "fractional_sets": 1.5, "target": null, "status": "untracked" }
      ]
    }
  ]
}
```

All 16 report groups (the 10 with targets, then the 6 without). Card: bars vs target, as in Reports.

### get_adherence

```json
{
  "name": "get_adherence",
  "description": "Planned versus done sessions between two local dates, per week and in total. Planned sessions count from the first program activation (or the range start, if later), with the days per week of the program active each day. At most 92 days per call.",
  "input_schema": {
    "type": "object",
    "properties": {
      "from": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
      "to": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
    },
    "required": ["from", "to"],
    "additionalProperties": false
  }
}
```

Result:

```json
{
  "from": "2026-09-15",
  "to": "2026-10-14",
  "since": "2026-09-27",
  "sessions_done": 8,
  "sessions_planned": 10,
  "adherence_pct": 80,
  "weeks": [
    { "start": "2026-10-12", "end": "2026-10-18", "partial": true, "done": 2, "planned": 4 }
  ]
}
```

Whole sessions, as in the overview ("8 of 10"). Card: consistency columns.

### get_prs

```json
{
  "name": "get_prs",
  "description": "Personal records by the app's rule: a session's best estimated 1RM for an exercise that beats every earlier session's best. With exercise_id: that exercise's records, newest first, and its best set. Without: the latest 30 records over all exercises and the best set of each main lift.",
  "input_schema": {
    "type": "object",
    "properties": {
      "exercise_id": { "type": "string" }
    },
    "additionalProperties": false
  }
}
```

Result:

```json
{
  "unit": "lb",
  "records": [
    { "date": "2026-10-13", "exercise_id": "deadlift", "name": "Conventional Deadlift", "weight": 255, "reps": 5, "e1rm": 297.5, "previous_e1rm": 285.8 }
  ],
  "best": [
    { "exercise_id": "deadlift", "name": "Conventional Deadlift", "date": "2026-10-13", "weight": 255, "reps": 5, "e1rm": 297.5 }
  ]
}
```

The first session of an exercise is not a record (a record needs an earlier best to beat). Card: records list.

### get_program

```json
{
  "name": "get_program",
  "description": "Payam's active program: name, style, days per week, priority muscles, the rules shown on the Program screen, and every day with its exercises, sets, reps, rest, groups and target RIR.",
  "input_schema": { "type": "object", "properties": {}, "additionalProperties": false }
}
```

Result:

```json
{
  "id": "fullbody4",
  "name": "Full body · 4 days",
  "style": "seed_full_body",
  "days_per_week": 4,
  "active_since": "2026-09-27",
  "priority_muscles": ["chest"],
  "rules": ["Order: Day 1 → 2 → 3 → 4. Whenever you train, do the next day. No more than two training days in a row."],
  "days": [
    {
      "day_id": "D1",
      "name": "Day 1 · Chest",
      "est_minutes": 60,
      "exercises": [
        { "exercise_id": "bench", "name": "Barbell Bench Press", "is_main": true, "sets": 4, "reps_min": 5, "reps_max": 5, "is_time": false, "per_leg": false, "rest_sec": 180, "group": null, "target_rir": null },
        { "exercise_id": "lateral", "name": "Dumbbell Lateral Raise", "is_main": false, "sets": 3, "reps_min": 12, "reps_max": 12, "is_time": false, "per_leg": false, "rest_sec": 75, "group": "A", "target_rir": null }
      ]
    }
  ]
}
```

`target_rir` is null on the seed programs (their RIR rule is in `rules`); a generated program gives each exercise
`{ "min": 1, "max": 2 }` and so on. Card: program days.

### get_library

```json
{
  "name": "get_library",
  "description": "Exercises from the app's library, for choosing exercises or ids for a program. Give at least one filter. At most 60 results, exercises he has done first.",
  "input_schema": {
    "type": "object",
    "properties": {
      "muscle": {
        "type": "string",
        "enum": ["chest", "back_lats", "back_upper", "quads", "hamstrings", "glutes", "shoulders_front", "shoulders_side", "rear_delts", "biceps", "triceps", "calves", "core", "forearms", "traps", "adductors", "abductors", "lower_back", "neck"],
        "description": "Main or secondary muscle."
      },
      "equipment": { "type": "string", "enum": ["barbell", "dumbbell", "cable", "machine", "bodyweight"] },
      "query": { "type": "string", "minLength": 2, "description": "Words in the English name, e.g. \"incline press\"." }
    },
    "additionalProperties": false
  }
}
```

Result:

```json
{
  "total": 23,
  "returned": 23,
  "exercises": [
    {
      "id": "incline_bb",
      "name": "Incline Barbell Bench Press",
      "equipment": "barbell",
      "primary": "chest",
      "secondary": ["shoulders_front", "triceps"],
      "pattern": "h_push",
      "category": "strength",
      "counts_volume": true,
      "done_before": true
    }
  ]
}
```

Archived exercises are left out. Card: exercise list (like Library rows).

### get_body_weight

```json
{
  "name": "get_body_weight",
  "description": "Body weight over the last N weeks: one value per day (the day's entries averaged), a 7-day moving average, weekly averages and the change.",
  "input_schema": {
    "type": "object",
    "properties": {
      "weeks": { "type": "integer", "minimum": 1, "maximum": 104, "description": "Default 12." }
    },
    "additionalProperties": false
  }
}
```

Result:

```json
{
  "unit": "lb",
  "from": "2026-07-22",
  "to": "2026-10-14",
  "days": [
    { "date": "2026-09-24", "value": 181.5, "ma7": 181.5 },
    { "date": "2026-10-08", "value": 180.2, "ma7": 180.4 }
  ],
  "weeks": [{ "start": "2026-10-05", "avg": 180.2 }],
  "first": { "date": "2026-09-24", "value": 181.5 },
  "latest": { "date": "2026-10-08", "value": 180.2 },
  "change": -1.3
}
```

Card: body-weight chart with Table view (as on Me).

### get_photos

```json
{
  "name": "get_photos",
  "description": "His progress photos (ids, dates and poses only; you cannot see them). To look at photos, ask him to attach them.",
  "input_schema": {
    "type": "object",
    "properties": {
      "pose": { "type": "string", "enum": ["front", "side", "back", "other"] },
      "from": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
      "to": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
    },
    "additionalProperties": false
  }
}
```

Result:

```json
{
  "total": 6,
  "photos": [
    { "id": "01JA80QW3P9V0YB7E2N4K6M1RT", "date": "2026-10-13", "pose": "front", "after_session": "Day 3 · Back" }
  ]
}
```

At most 100, newest first. Card: thumbnails; tapping one attaches it to the next message.

### propose_program (needs his tap)

```json
{
  "name": "propose_program",
  "description": "Show Payam a program draft as a card with \"Add to Planner\" and \"Change\". Nothing is saved until he taps Add to Planner, and his active program is never replaced. Use only exercise ids from get_library; unknown ids are dropped.",
  "input_schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "maxLength": 60, "description": "Short program name, e.g. \"Chest priority · 4 days\"." },
      "summary_fa": { "type": "string", "maxLength": 400, "description": "One or two Persian sentences on what the draft changes and why." },
      "days": {
        "type": "array",
        "minItems": 1,
        "maxItems": 7,
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string", "maxLength": 40, "description": "E.g. \"Day 1 · Chest\"." },
            "exercises": {
              "type": "array",
              "minItems": 1,
              "maxItems": 12,
              "items": {
                "type": "object",
                "properties": {
                  "exercise_id": { "type": "string" },
                  "sets": { "type": "integer", "minimum": 1, "maximum": 10 },
                  "reps_min": { "type": "integer", "minimum": 1, "maximum": 600, "description": "Reps, or seconds when is_time." },
                  "reps_max": { "type": "integer", "minimum": 1, "maximum": 600 },
                  "is_time": { "type": "boolean" },
                  "per_leg": { "type": "boolean" },
                  "rest_sec": { "type": "integer", "minimum": 0, "maximum": 600 },
                  "group": { "type": ["string", "null"], "enum": ["A", "B", "C", "D", "E", "F", null], "description": "Same letter for 2-3 consecutive exercises done as a superset or tri-set." },
                  "is_main": { "type": "boolean", "description": "The day's main lift; at most one per day." },
                  "target_rir_min": { "type": ["integer", "null"], "minimum": 0, "maximum": 4 },
                  "target_rir_max": { "type": ["integer", "null"], "minimum": 0, "maximum": 4 }
                },
                "required": ["exercise_id", "sets", "reps_min", "reps_max", "rest_sec"],
                "additionalProperties": false
              }
            }
          },
          "required": ["name", "exercises"],
          "additionalProperties": false
        }
      }
    },
    "required": ["name", "days"],
    "additionalProperties": false
  }
}
```

Zod also checks: `reps_min ≤ reps_max`, `target_rir_min ≤ target_rir_max`, at most one `is_main` per day, and each group
letter on 2–3 consecutive exercises of one day. A draft that fails gets `is_error` with the problems, so the model can
send a corrected one.

Result (to the model):

```json
{
  "shown": true,
  "draft_id": "01JA81B6S4N2W7X0Q5R9T3K8MV",
  "days": 4,
  "exercises": 23,
  "dropped": [{ "day": "Day 2 · Legs", "exercise_id": "hack_squat_machine", "reason": "not in the library" }],
  "weekly_sets": [{ "group": "chest", "name": "Chest", "planned": 16, "current_target": 13 }]
}
```

`weekly_sets` is the draft's own fractional volume against the current targets, so the model can mention it correctly.
The client draws the program draft card. **Add to Planner** saves the draft as a new inactive program (the same kind of
draft as New program makes); approving it stays the existing tap in Settings → Program. **Change** puts
"Change this draft: " in the composer.

## 3. Migration SQL (§6, §8.1)

### `migrations/0011_coach.sql`

```sql
-- 0011_coach.sql: SPEC-v9 M12 Coach chat (proposal 2026-10-14, waiting for Payam's OK).
-- Three new, empty tables; nothing existing changes. A thread is one chat; a message row is one Messages API message
-- (Payam's question, an answer, or a tool round trip), so cards re-render exactly from content_json. Archived threads
-- are hidden from the list and kept; only an archived thread can be deleted for good (with its messages, attachment
-- rows and R2 objects).
CREATE TABLE coach_threads (
  id TEXT PRIMARY KEY,                                -- client ULID
  title TEXT NOT NULL,                                -- the first question, shortened to 80 characters
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,                           -- the last message; the chat list is newest first
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);
CREATE INDEX coach_threads_list ON coach_threads (archived, updated_at);

CREATE TABLE coach_messages (
  id TEXT PRIMARY KEY,                                -- client ULID for Payam's messages, server ULID otherwise
  thread_id TEXT NOT NULL REFERENCES coach_threads (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),  -- the message's content blocks: text, image refs,
                                                      -- tool_use, tool_result (image blocks keep only the attachment id)
  created_at TEXT NOT NULL,
  input_tokens INTEGER,                               -- the API's counts for the call that wrote an assistant row
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,                                      -- from the token counts and the price table in config
  model TEXT,                                         -- the model that answered
  error TEXT                                          -- '<code>: <message>' on a failed call; content_json is then '[]'
);
CREATE INDEX coach_messages_thread ON coach_messages (thread_id, created_at);
CREATE INDEX coach_messages_created ON coach_messages (created_at);  -- this month's Coach cost line

CREATE TABLE coach_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES coach_messages (id),
  r2_key TEXT NOT NULL UNIQUE,                        -- coach/<thread_id>/<id>.jpg (private; auth-only serving)
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  source_photo_id TEXT,                               -- the progress photo it was copied from, if he picked one
  created_at TEXT NOT NULL
);
CREATE INDEX coach_attachments_message ON coach_attachments (message_id);
```

### Archive, unarchive, lists (§8.1)

```sql
-- Archive / Unarchive (updated_at is unchanged, so a chat returns to its place in the list).
UPDATE coach_threads SET archived = 1 WHERE id = ?1;
UPDATE coach_threads SET archived = 0 WHERE id = ?1;

-- Chat list and Archived list, newest first.
SELECT id, title, created_at, updated_at FROM coach_threads WHERE archived = 0 ORDER BY updated_at DESC;
SELECT id, title, created_at, updated_at FROM coach_threads WHERE archived = 1 ORDER BY updated_at DESC;
```

### Delete permanently (§8.1, archived threads only)

```sql
-- 1. Check and collect. 404 if the thread does not exist; 409 "Archive this chat first" if archived = 0.
SELECT archived FROM coach_threads WHERE id = ?1;
SELECT a.r2_key
  FROM coach_attachments a JOIN coach_messages m ON m.id = a.message_id
 WHERE m.thread_id = ?1;

-- 2. R2: delete those keys, plus every object listed under the prefix coach/<thread_id>/ (an upload whose row was never
--    written). The Worker refuses any key that does not start with "coach/<thread_id>/", so progress photos
--    (photos/…) and library media are never touched.

-- 3. D1, one batch (one transaction). Each statement repeats the archived check, so a chat unarchived in between
--    is left alone.
DELETE FROM coach_attachments
 WHERE message_id IN (SELECT id FROM coach_messages WHERE thread_id = ?1)
   AND EXISTS (SELECT 1 FROM coach_threads WHERE id = ?1 AND archived = 1);
DELETE FROM coach_messages
 WHERE thread_id = ?1
   AND EXISTS (SELECT 1 FROM coach_threads WHERE id = ?1 AND archived = 1);
DELETE FROM coach_threads WHERE id = ?1 AND archived = 1;
```

Why R2 first: if the D1 batch then fails, the chat stays in the Archived list and Delete permanently runs again (R2
deletes of missing keys succeed). If D1 went first and R2 failed, the photos would stay in the bucket with nothing
pointing to them. The test checks that after a delete the thread's rows and R2 objects are gone, and that every other
table's row count and every `photos/` object are unchanged.

### Coach cost line in Me → AI reports (§7)

```sql
-- N = Payam's questions this month (user rows that are not only tool results); cost = all coach calls this month.
SELECT
  (SELECT COUNT(*) FROM coach_messages
    WHERE role = 'user' AND created_at >= ?1 AND created_at < ?2
      AND EXISTS (SELECT 1 FROM json_each(content_json) WHERE json_extract(value, '$.type') IN ('text', 'image'))) AS questions,
  (SELECT COALESCE(SUM(cost_usd), 0) FROM coach_messages
    WHERE role = 'assistant' AND created_at >= ?1 AND created_at < ?2) AS cost_usd;
```

`?1`/`?2` are the UTC instants of the local month's start and the next month's start.

## Decisions to confirm (defaults I picked; nothing is built yet)

1. **Cache-write tokens column.** I added `cache_write_tokens` to `coach_messages`: cache writes are billed at $5/MTok, so
   the cost would be wrong without it.
2. **Attachments.** I added `bytes` and `source_photo_id`. A photo picked from Progress photos is copied to
   `coach/<thread>/…`, so deleting a chat can never remove a progress photo. "Save to progress photos" copies the other
   way (a new `photos/` object).
3. **Message rows.** There is one row per Messages API message, so a tool round trip adds rows. A failed call is saved
   as an assistant row with `error` and is not sent to the model again. Retry writes a new row.
4. **`get_library`.** I added a `query` filter (name words). The model needs at least one filter, and results are
   capped at 60 to keep tokens down.
5. **Range caps.** `get_sessions`, `get_volume` and `get_adherence` accept at most 92 days per call.
6. **`get_sessions`** includes the open session (status `active`), so he can ask mid-workout.
7. **No photo-viewing tool.** The coach cannot open progress photos by id; he attaches them, so images cost tokens only
   when he chooses.
8. **Add to Planner.** This saves the draft as an inactive program (`generated_by = 'coach'`, no new column) that
   appears under Settings → Program → Drafts. Approving it stays the existing tap.
9. **Plain-text answers.** Answers are plain text with "-" bullets, not Markdown. The chat needs no Markdown
   renderer, and the data cards carry the tables.
10. **Tool rounds.** There are at most 8 tool calls per answer. After that, the coach answers with what it has.
11. **Caching.** The cache is 5 minutes ($5 write, $0.20 read) on tools plus system block 1. Questions in a chat
    usually come within minutes of each other. The 1-hour cache ($8 write) is cheaper only when questions are 5–60
    minutes apart and costs more for longer gaps.
12. **Thinking.** Adaptive thinking runs at `COACH_EFFORT` (medium). Thinking tokens count toward `COACH_MAX_TOKENS`
    (4000) and are billed as output.

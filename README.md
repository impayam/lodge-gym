# Lodge Gym

Personal workout PWA (single user, English LTR UI) on Cloudflare Workers + D1 + R2. Spec: `SPEC.md`, `SPEC-v2.md` and `SPEC-v3.md` (M9, M10); working rules: `CLAUDE.md`.

Status: **M1** (shell, passkey auth, program seed, offline logging), **M2** (progress photos), **M3** (reports + progress page), **M4** (Apple Watch bridge via iOS Shortcuts), RIR per set, weekly backup, rest-timer push, weekly review card, **M6** (English UI, SPEC-v2), **M7** (exercise library), **M8** (training styles and program generator), **M9a–M9d** (body-map picker, session planner, AI session report and Get advice, training overview).

## Stack

Worker (Hono, Zod, `@simplewebauthn/server`) serves `/api/*` and the static PWA from `dist/` (Vite + Preact, Workbox `injectManifest`, IndexedDB outbox via `idb`).

```
worker/        Hono app: auth.ts (passkeys, sessions, rate limit), data.ts (bootstrap, sessions, settings), lib/ (pure, shared with web)
web/           PWA: src/ (views, store + outbox sync, sw.ts), public/ (manifest, icons)
migrations/    D1 migrations
seed/          program.json → seed.sql (npm run seed:build)
tests/         lib/ + worker/ (Vitest in workerd), e2e/ (Playwright)
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Rebuilds the PWA on change and runs `wrangler dev` with local D1/R2 on http://localhost:8787 (first: `npm run db:migrate:local && npm run seed:local`, and copy `.dev.vars.example` to `.dev.vars`) |
| `npm run build` | Checks `seed/seed.sql` is current, builds the PWA into `dist/` |
| `npm test` | Vitest: pure logic + Worker API in workerd |
| `npm run e2e` | Playwright, iPhone 15 profile: WebKit against a local HTTPS server (:8789, self-signed, through the airplane-mode proxy on :8790 and a persistent context) and Chromium against HTTP (:8788); see `scripts/e2e-server.mjs`, `scripts/e2e-proxy.mjs`, `tests/e2e/fixtures.ts` |
| `npm run db:migrate:local` / `:remote` | Apply D1 migrations |
| `npm run seed:local` / `:remote` | Insert the seed rows a database is missing (insert-only: never changes the active program, approvals, archives or activations) |
| `npm run deploy` | Build, migrate + seed remote D1, `wrangler deploy` |

## Deploy (Cloudflare Workers Builds)

- Build command: `npm run build`
- Deploy command: `npm run deploy:ci` (prints the D1 Time Travel bookmark, applies remote migrations and the seed,
  imports the exercise library, then `wrangler deploy` and the library image copy)
- Restore point: every production deploy first runs `wrangler d1 time-travel info lodge-gym-db`, so the Workers Builds
  log holds the bookmark from before that deploy's migrations. Restore with
  `npx wrangler d1 time-travel restore lodge-gym-db --bookmark=<bookmark>` or `--timestamp=<RFC3339 time>`.
- Secret: `SETUP_TOKEN` (a long random string; used once on the phone at `/setup`)

Bindings are in `wrangler.toml`: D1 `DB` → `lodge-gym-db`, R2 `PHOTOS` → `lodge-gym-photos`, static assets `ASSETS` → `dist/`.

## Apple Watch bridge (approved SPEC §9 change)

Shortcuts has no Workouts sample type, so the shortcut sends samples: Find Health Samples (Heart Rate, last 6 hours),
Find Health Samples (Active Energy, last 6 hours), then Get Contents of URL → `POST /api/health/raw`
(`Authorization: Bearer <token>`) with JSON fields `hr`, `hr_time`, `energy`, `energy_time`. The Worker parses the
Shortcuts text (`worker/lib/shortcuts.ts`: ISO 8601 fast path, locale dates incl. Jalali, units, comma decimals,
newline lists) and, for every workout session overlapping the samples, computes avg/max HR and total active kcal from
the samples inside `[started_at, ended_at]` (until now while active; `worker/lib/watchstats.ts`). Duration comes from
the session. One row per session (`external_key = session:<id>`); re-sending is idempotent and a partial later window
never replaces more complete data. The older workout fields (`workouts`, `workout_start`, …) are still accepted.
Fixtures of messy payloads: `tests/fixtures/shortcuts/`.

## Backups

A Cron Trigger (`17 10 * * 1`, Mondays 10:17 UTC) writes the full JSON export to R2 under `backups/lodge-gym-<date>.json`
in the `lodge-gym-photos` bucket and keeps the newest 12. Settings → Backup downloads the latest one or a fresh
export (`GET /api/export`). Emailing the backup is not wired: Cloudflare can only send email from a domain on
Cloudflare DNS (Email Routing / Email Service), and this app runs on `workers.dev`.

## Rest-timer push

Web Push (VAPID, RFC 8291 aes128gcm, WebCrypto only: `worker/lib/webpush.ts`). A SQLite-backed Durable Object
(`RestPush`, Free-plan compatible) holds the VAPID key pair (generated on first use), the subscriptions and the pending
rest end, and sends the push from an alarm. Settings → Rest-timer notification asks for permission from a tap. On iPhone it
works only in the Home Screen app on iOS 16.4+.

## Weekly AI review (written by Claude into D1)

The app only reads this table; Claude writes one row per week directly into D1
(`lodge-gym-db`, id `f8ba012b-9970-423c-83f3-8c32111695e7`, migration `0003_weekly_reviews.sql`). Every row sits in
History → **Reports timeline** on the last day of the week it covers (`week_start` + 6) and opens read-only. Since
SPEC-v7 M9d the training overview replaces the card on the home and reports pages (approved 2026-10-13); the rows are
kept.
The review stays in Persian (SPEC-v2 M6): the card renders `summary_fa`, `highlights` and `suggestions` right-to-left
(`dir="rtl" lang="fa"`) inside the English UI, with the iOS system font.

| Column | Type | Content |
|---|---|---|
| `id` | TEXT, primary key | Any unique id (ULID recommended), e.g. `rv-2026-09-21` |
| `week_start` | TEXT, `YYYY-MM-DD` | First day of the reviewed week in the app's week-start setting (default Monday) |
| `created_at` | TEXT | UTC ISO-8601 timestamp, e.g. `2026-09-28T08:00:00Z` |
| `summary_fa` | TEXT, required | Persian summary; newlines are kept |
| `highlights` | TEXT, JSON array of strings | What went well, e.g. `["چهار جلسه از چهار"]` (must be valid JSON) |
| `suggestions` | TEXT, JSON array of strings | Suggestions for next week (must be valid JSON) |

Items may also be objects `{"title": "…", "detail": "…"}`; they are shown as `title: detail`.

```sql
INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions)
VALUES ('rv-2026-09-21', '2026-09-21', '2026-09-28T08:00:00Z',
        'هفته‌ی خوبی بود: چهار جلسه کامل.',
        '["چهار جلسه از چهار", "رکورد تازه در اسکوات"]',
        '["یک ست اضافه برای پشت ران", "خواب ۷ ساعت"]');
```

Re-writing a week: insert a new row with a later `created_at` (or `INSERT OR REPLACE` with the same `id`).

## Approved report rules

- Sets per muscle are counted two ways (SPEC-v2 §7.4, decided 2026-10-12): **direct** (the primary muscle's group gets
  1 per done set) and **fractional** (primary 1 set, each secondary muscle's group 0.5; a group counts once per set).
  Planned and extra exercises count alike. The muscle map shows both numbers.
- Muscle balance: under < 80 % of the weekly program target, on target 80–120 %, over > 120 %, applied to the
  **fractional** number. The weekly target of a group is the program's own fractional volume (SPEC-v2 §7.4, decided
  2026-10-12): each planned set counts 1 for its primary group and 0.5 for each secondary group, so following the
  program exactly is on target everywhere. Traps, forearms, lower back, adductors, abductors and neck have no target
  and show their sets only.
- Muscle map (Reports → Progress, SPEC-v6 §8): the picker's 3D model (same scene, mapping and lazy loading). Every
  mapped muscle takes the status of its report group, in the dark theme's status colours (the stage is dark in both
  themes): under amber, on target green, over orange, trained without a target teal, no sets this week muted;
  unmapped muscles are dark (`web/src/lib/anatomy-status.ts`). Drag turns it, Front / Back turn it round; on the whole
  body a tap zooms to that muscle's area (as in the picker); in the close-up a tap shows a card with the muscle, its
  group and "done / target sets this week" (fractional) with the status icon and label; "← Body" goes back. The legend
  and the list under the map carry icon and label, so status is never colour alone; the list is the accessible
  alternative. Without WebGL 2, or when the model fails or takes over 10 s, a "3D unavailable" note shows with the
  drawn front and back figures (one region per canonical muscle key, tapping a region selects its group).
- Calves count only from calf work: the seeded squat, leg press, lunge, RDL and deadlift do not list calves as a
  secondary muscle (decided 2026-10-12).
- Only strength work counts (decided 2026-10-12): exercises whose `category` (migration `0005_exercise_category.sql`)
  is strength, powerlifting or olympic weightlifting count toward sets per muscle, the targets, per-muscle volume and
  the muscle map. Stretching, plyometrics, cardio and strongman are logged but count 0 sets; the exercise detail says
  "Not counted in volume". The rule lives in `worker/lib/category.ts`.
- A new personal record needs an earlier best to beat (a first-ever lift is not a PR).
- Adherence = sessions ÷ planned sessions, capped at 100 %; each day of the period adds the days per week of the
  program active that day ÷ 7. A week's targets and session goal are the program's that was active at the week's end.

## English UI (SPEC-v2 M6)

- All UI strings are English, LTR, Latin digits, Gregorian dates, system font (no bundled web font). Number inputs still
  accept Persian and Arabic-Indic digits.
- Exercises show `name_en` and the English form cue `cue_en` (migration `0004_exercise_library.sql`, approved SPEC-v2 §7.2);
  `name_fa` and `cue_fa` stay in D1 as data.
- API errors keep the SPEC §11 shape `{error:{code,message_fa}}`; the `message_fa` field now carries English text.
- The Shortcuts bridge still parses Persian-locale Shortcuts output (Persian digits, Jalali dates).

## Exercise library (SPEC-v2 M7)

- Source: [free-exercise-db](https://github.com/yuhonas/free-exercise-db) (Unlicense), pinned to commit
  `FEDB_SHA` in `worker/lib/library.ts`. ExerciseDB is not used (its terms forbid storing data or media).
- `seed/import-exercises.ts` (`npm run library:import -- --remote|--local …`) upserts the rows into D1 and copies the
  images into the private R2 bucket under `library/free-exercise-db/images/`, with the dataset snapshot at
  `library/free-exercise-db/<date>.json` and a manifest of copied images (resume). Re-running changes nothing.
  `deploy:ci` runs the D1 part before `wrangler deploy` and the image copy after it, with a 12-minute budget (Workers
  Builds stops a build at 20 minutes); a later deploy finishes any images left.
- Reviewed mapping files in `seed/library/`: `fedb-equipment.json` (every "other" and missing-equipment entry mapped
  to one of the five equipment values; kettlebell, bands, medicine ball, exercise ball and foam roll are excluded; its
  `excluded` list holds the 22 entries excluded on review, with a reason), `fedb-patterns.json` (movement pattern per
  entry, drafted by `derive-patterns.ts`, unplaced ones left null, plus the reviewed `category` overrides),
  `seed-matches.json` (the seeded exercises' library match, pattern, mechanic and secondary muscles; they keep their
  ids) and `manual.json` (hand-written gap fill, source `manual`, no media).
- `npm run library:report` writes `seed/library/IMPORT-REPORT.md` for review.
- Muscle names map to the canonical keys in one table, `worker/lib/muscles.ts`.
- Every exercise shows a "Watch form video" link: a YouTube search for `name_en + " form"`, built at render time.

## Training styles and program generator (SPEC-v2 M8)

- Settings → Program → New program: days per week, style (auto, full body, upper/lower, PPL, PPL + upper/lower, bro
  split, strength), session length, priority muscles, exercises to leave out, and full gym or dumbbells only.
- The generator (`worker/lib/generator/`, pure and seeded) fills each style's fixed weekly layout: main and secondary
  lifts first, then accessories and isolation toward the weekly targets (the current program's fractional volume, +3
  for added priority muscles, floors of 10 for chest, back, quads and hamstrings & glutes), with at most 10 fractional
  sets per muscle per session, rear delts ≥ 6, pull ≥ push, at least one hinge and one squat, and every day inside
  the session length. Exercise choice prefers history, then the current program, then compound, then
  beginner/intermediate; one exercise keeps one role a week; Olympic-style lifts are never picked automatically.
- `checkPlan` (`check.ts`) is shared by the generator, the editor on the phone and the server: hard-rule violations
  block approval, warnings (floors, under/over target, long days, frequency) do not.
- The editor swaps an exercise for one with the same movement pattern and primary muscle and changes sets inside the
  slot's range. Approving archives the old program; History shows the program timeline, groups sessions by program and
  can switch back to an archived program (a new activation; history stays). Switching twice within 3 weeks shows a
  notice. No intro week, no light week; weights continue from the last sessions.
- Tests: property tests over every style × days × session length × 50 seeds on the real library
  (`tests/fixtures/generator/library.json`, rebuilt by `npx tsx scripts/generator-pool.mts`), Payam's snapshot (within
  ±2 sets per muscle of the current program), the API flow and the seed re-run, and the Playwright flow.

## Body-map exercise picker (SPEC-v3 M9b, 3D model SPEC-v6)

- In a session, "+ Add exercise" opens on the **Body** tab (Search is the second tab) with a 3D anatomy model on a dark
  stage: drag turns it around the vertical axis, pinch zooms (never inside the body, no panning), Front / Back turn it
  round in 380 ms. In the whole-body view a tap on a muscle, or one of the 8 area chips, zooms to that area's close-up
  (SPEC-v6 §7: the muscle itself is chosen only in a close-up). In the close-up the area's muscle chips take the place
  of the area chips, all visible above the tab bar; only that area's muscles are tappable; a tap lights up the app
  muscle on both sides with "Show exercises", a tap within 24 px still finds it, empty space and unmapped muscles
  (face, neck, deep spine, hands, feet, shins…) clear it; "← Body" goes back. The chips do everything the model does
  (VoiceOver never needs the canvas). The exercise is added as an extra with 3 empty sets, as in M7. A "Drag to turn"
  hint sits beside the feet until the first touch on the model.
- Areas → muscles (`worker/lib/bodyAreas.ts`): Chest; Shoulders (front, side, rear delts); Arms (biceps, triceps,
  forearms); Back (lats, upper back, traps, lower back); Core; Glutes & hips (glutes, adductors, abductors); Thighs
  (quads, hamstrings); Calves. Model muscle → app muscle and M10 coverage region: `web/src/lib/anatomy-map.ts`
  (approved table; 78 of the model's 222 muscle names), tested against the GLB's own node list. The model names its
  outer trapezius parts the other way round, so they are mapped by position: upper trapezius → traps, middle and lower
  → upper back (a test checks the heights).
- The list: primary-muscle exercises, then "Also works this muscle"; inside each, done before (most recent first),
  then the current program, then compound, then name. Filters: equipment and category (default: strength, the
  counted categories). The picker remembers its place per session while the app is open.
- Loading: three.js 0.186.1 and the 3D code are a separate chunk (`anatomy3d-*.js`, about 165 kB gzip) loaded when the
  Body tab opens; nothing of it is in the main bundle. The model (`web/public/models/body.glb`, 8.2 MB, pinned by
  SHA-256; `npm run build` fails if it differs) is decoded once per app run with three's Draco decoder (WebAssembly),
  which Vite copies into `/assets/`. None of these is precached: the service worker caches them on first use
  (cache-first, cache `anatomy-<sha>`), so after one online open the picker works offline. Each open gets its own
  renderer and WebGL context and releases them, its materials and GPU buffers when it closes.
- CSP (approved for SPEC-v6): `script-src 'self' 'wasm-unsafe-eval'` for the decoder's WebAssembly and
  `worker-src 'self' blob:` for its worker; eval stays blocked.
- Without WebGL 2, when the model fails, or after 10 s, the picker shows the chips only with a "3D unavailable" note.
- `window.__anatomy` is the 3D view's test hook (points on a muscle, picks, lit meshes, GPU memory, load times).

## Session planner, supersets and tri-sets (SPEC-v3 M9c, without AI)

- Home → next-day card → **Plan session** opens a plan copied from the program day (exercises, order, sets, reps,
  per-leg, RIR target, rest; the day's supersets become groups). In the planner: Replace (body picker or search; the
  slot keeps its sets, reps, rest and RIR), Add (3 × 8–12, 90 s, no RIR target), Remove (soft delete), reorder (drag
  handle, plus Move up / Move down), sets/reps/rest. An exercise appears once per plan. **Save** stores it (offline
  through the outbox); Home shows "Planned: Day 1 · Chest (edited)" and a planned day in "Or pick another day" opens
  its plan. **Start session** turns the plan into the session (same id; timed from that tap, dated today).
  **Discard plan** keeps the plan as `discarded` and the day goes back to the program default. **Apply to program**
  (after a confirm) makes a new program version with this day as planned (M8 versioning; groups stored as
  `superset_tag`); the old version is archived, and the open plan follows its day into the new version.
- Time estimate ("6 exercises · about 60 min" on Home and in the planner): the program day's own estimate, moved by
  what the plan's edits add or save under the SPEC-v2 §8.4 rule (rest + 40 s per set); in a group, 40 s per set and the
  group's rest once per round, a longer member's extra sets with their own rest. An unedited plan shows the day's
  estimate; Apply to program stores the plan's estimate on the new version's day.
- Groups: select 2 or 3 exercises and tap Group (any exercises, same muscle included; no warning). Members stay
  adjacent, labelled A1/A2/A3, then B1/B2…; a group moves as a whole and its members reorder inside it; Ungroup keeps
  the order. Rest after a round defaults to the longest member rest and can be edited per group.
- In a session: groups (the plan's, or the day's own A1/A2 supersets) show with a bracket; a round is set N of each
  member: no timer inside the round (the next member's set comes into view), the group's rest after its last set;
  extra sets of a longer member are done alone with their own rest. "Reorder / group" reorders, groups and removes
  exercises; an exercise with a done set can't be removed (uncheck it first), and "− Remove set" only removes undone
  sets. A session started without a plan gets a started plan with its own id on the first such edit.
- Sync: a plan the server has not seen yet is created from the day and then takes the phone's item list, even when
  that list was edited offline earlier; after that the last writer wins on `updated_at`. Reports, the weekly review and
  the muscle map read only workout sessions, so a plan counts nowhere until it is started.
- Code: plan operations `worker/lib/plan.ts` (pure, unit-tested), API `worker/plans.ts`, planner `web/src/views/Planner.tsx`,
  shared list `web/src/components/PlanList.tsx`.

## AI session report and plan advice (SPEC-v3 M9a, M9c "Get advice")

- Model `claude-opus-5-5` through the Messages API (`@anthropic-ai/sdk`, pinned), server-side only. Config in
  `wrangler.toml` `[vars]`: `REPORT_MODEL`, `REPORT_EFFORT` (low), `ADVICE_EFFORT` (medium), `REPORT_MAX_TOKENS`
  (3000; thinking counts toward it). Opus 5.5 takes no `temperature` (the API rejects it), so effort is the control
  (approved 2026-10-13). The key is the Worker secret `ANTHROPIC_API_KEY` (dashboard or `wrangler secret put`); it is
  never sent to the phone or logged. Opus only, no fallback model: a refusal is stored as an error and shows "Report
  unavailable" with Retry (Payam, 2026-10-13).
- Reply format: JSON constrained by the output schema (structured outputs) and validated again with Zod; a reply that
  is cut off, not JSON or not valid is retried once, then stored as an error. Every call writes one row
  (`session_reports` or `plan_advice`, migration 0009) with its tokens; rows are never updated, so regenerating keeps
  the older ones. Deleting a session deletes its reports. Backups include both tables.
- **Report:** a session that syncs as done (app sessions, first time) is queued in the `AiJobs` Durable Object, which
  writes the report from an alarm (up to 15 min, retried); `ctx.waitUntil` stops 30 s after the response, which a
  report can exceed (approved 2026-10-13). Finish session opens the report screen (with the progress-photo prompt):
  "Report pending" until the session reaches the server, "Writing your report…", then the Persian (RTL) report:
  summary, highlights, volume table, extra exercises, skipped work, next time, warnings. "Report unavailable" comes
  with Retry and the reason (key expired or invalid, key not set, daily limit, service error). From History → session
  → **Session report**; **Regenerate** writes a new one.
- Report input (`worker/lib/ai/report.ts`): the session (day, local times, duration, unit, note), every planned and
  extra exercise with category, muscles, done sets, missed sets and the plan's targets; 0-volume categories are listed
  and marked; the previous session of the same day (weights, reps, e1RM), today's records (existing PR rule), the
  week so far by the muscle map's rules (a set counts at most once per group) against the weekly targets, the app's own
  progression for next time, Apple Watch HR and kcal, body weight today and the last 4 weekly averages. The volume
  table always shows the input's numbers.
- **Next time** is computed by the app's progression function (`suggest`, SPEC §7 + RIR rules: +5 lb upper, +10 lb
  lower, +5 lb per dumbbell, double with RIR 3+ on every planned set, otherwise the same weight) and shown by the app
  ("145 lb × 5 · +5 lb"); the model only adds a short Persian note per exercise, and a note containing any number is
  not shown (Payam, 2026-10-13).
- **Get advice** (planner, needs a connection; disabled offline with "Needs connection"): saves and sends the plan,
  then one model call with the plan, the original day, the last 14 days, group volume (week so far, last 7 days, what
  the plan adds) against the targets, the last heavy compound per group, the program style, Payam's preferences and a
  candidate list of real exercises (`worker/lib/ai/advice.ts`). Suggestions with an exercise id outside the candidate
  list (or not fitting the plan) are dropped. Each suggestion has **Apply** (exercises it adds or swaps in get origin
  `ai`) and then **Undo**; nothing changes without the tap, and the plan is saved as usual.
- Limits per local day: 10 reports, 20 advice (calls that used tokens). Settings → AI reports: "This month: N reports,
  ~$X" ($4 / $20 per million input / output tokens), today's counts, the model, and "Report unavailable — API key
  expired or invalid" after an authentication error (or "API key not set"), until a call succeeds.
- Tests never call the API: Worker tests replace `aiTransport.fetch` (`tests/fixtures/anthropic-mock.ts`), and the
  e2e Workers use `ANTHROPIC_BASE_URL` pointing at `scripts/e2e-ai-mock.mjs`.
- Code: client `worker/ai.ts`, routes and the job `worker/aiReports.ts`, cost and limits `worker/lib/ai/cost.ts`,
  screens `web/src/views/SessionReport.tsx`, `web/src/views/Planner.tsx`, `web/src/views/Settings.tsx`.

## Training overview and session reports (SPEC-v7 M9d)

- **Training overview** at the top of Reports: a short Persian (RTL) overview of this week and the previous 4 (approved
  2026-10-13), rewritten automatically after every finished session, right after that session's report, by the same
  `AiJobs` Durable Object (one queue: report, then overview; a waiting overview is replaced by the newer one). It shows
  "Updated after: Day N · <date>" (or the time of a manual update), the model and **Regenerate**. A failed update never
  hides the previous overview: it shows "Update failed — <reason>" with **Retry**. Offline, the last saved copy.
- Built from raw data only (`worker/lib/ai/overview.ts`): sets with weight, reps and RIR per session, Payam's session
  notes, the main lifts' e1RM per session (Epley) with the % change over the window, stalls (3 exposures without
  beating the best before), drops (10% or more below the best), sessions per week against the program's days (planned
  sessions count from the first program activation, or the window's start if later, each day with the program active
  that day, so a switch or re-activation never resets the count; whole sessions; Payam, 2026-10-14, option A), weekly
  volume against the targets (fractional sets) and skipped planned exercises. The text of session reports and earlier
  overviews is never sent, so model mistakes do not compound.
- Numbers come from the app: the lift table (1RM, change) is the app's; the model only phrases. A sentence with a number
  the input does not have (percentages: only the app's `*_pct` values, as given or rounded) is dropped; a summary with
  one makes the reply invalid (retried once, then an error row). Same rules as the report: chest first, no deload or
  light week unless a note says he is tired, no medical advice.
- Config in `wrangler.toml` `[vars]`: `OVERVIEW_EFFORT` (medium, Payam 2026-10-13), `OVERVIEW_MAX_TOKENS` (4000; thinking counts toward
  it). Limit: 10 overviews per local day. Settings: "This month: N reports, M overviews, ~$X" and today's counts.
- Every update inserts a row in `training_overviews` (migration 0010); the latest `ok` row is shown and older rows are
  kept. Deleting the triggering session keeps the overview (its trigger becomes null). Backups include the table.
- **Session reports** in Reports: every session's latest report, newest session first (day, date, one-line summary;
  the latest 5, then "Show all"); a row opens the full report screen. Reports also stay under History → session.
- **History → Reports timeline** (design approved 2026-10-13): two labeled rows, ● Session report and □ Weekly review,
  one column per date that has a report, newest on the right. A session date lists its report and the overview written
  after it; an overview on a day without a session (Regenerate) marks its date with ◆. Tapping a date opens its report,
  or a short list to choose from when it has several. The **List** view (the accessible alternative, remembered on the
  device) shows all three types, newest first. Every report opens read-only (no Regenerate, Retry or photo prompt).
  Dates: a session report on the session's date (its latest report, when ok), an overview on its session's date or the
  local day it was written, a weekly review on the last day of its week (`worker/lib/ai/timeline.ts`).
- Code: job and routes `worker/aiOverview.ts` (`GET`/`POST /api/overview`, `GET /api/overviews/:id`,
  `GET /api/session-reports`, `GET /api/report-timeline`), limits `worker/aiLimits.ts`, screens
  `web/src/views/Overview.tsx` and `web/src/views/ReportsTimeline.tsx`.

## Artwork and credits

- Muscle map figures (`web/src/components/bodyMap.ts`): original drawing made for Lodge Gym. Only the left half is
  drawn and mirrored in code, so the figures are symmetric by construction. No third-party artwork or icon set is
  used, so no external licence applies.
- Exercise images: free-exercise-db (Unlicense), copied into the private R2 bucket (see "Exercise library").
- 3D anatomy model of the exercise picker: Body Anatomy 3D Viewer by hpfrei (github.com/hpfrei/body-anatomy-3d-viewer,
  commit 0fc76a9), based on Z-Anatomy, CC BY-SA 4.0, used unmodified (`web/public/models/ANATOMY-SOURCE.md`); credited
  in Settings → About.

## Approved additions beyond SPEC §5/§11

- Tables `auth_challenges` (one-time WebAuthn challenges) and `rate_limits` (the D1 counter table SPEC §4 allows).
- `PUT /api/settings` (unit, week start, re-lock minutes, timezone).
- Table `weekly_reviews` (migration 0003), `review` in `/api/bootstrap`, `GET /api/reviews/latest`.
- `/api/push/key|subscribe|unsubscribe|rest|rest/cancel|test`, Durable Object `RestPush`.
- `GET /api/backups`, `GET /api/backups/latest`, weekly Cron Trigger.
- `GET /api/reports/progress` (Progress page) and `?format=csv` on `/api/reports/week|month`. Months are Gregorian only (SPEC-v2 M6 removed the `month_calendar` setting).
- `GET /api/photos` (photo list for the gallery; SPEC §11 lists the other photo routes).
- `PUT /api/body-mass/:date` (manual body weight, source `manual`) and `set_entries.rir` (migration 0002).
- Exercise library (SPEC-v2 M7, approved 2026-10-12): `GET /api/exercises`, `PUT /api/exercises/:id` (custom exercises
  only, with `category`), `PUT /api/exercises/:id/photo`, `GET /api/library/media/*` (library and custom prefixes only,
  behind sign-in); session sets accept `is_extra` and `position`; `/api/bootstrap` carries only the exercises the app
  needs offline; the backup export adds `custom_exercises`. Migration `0005_exercise_category.sql`.
- `POST /api/health/raw` (replaces `/health/workouts`), `GET /api/health/status`, `PUT /api/health/workouts/:id/match`.
- Program generator (SPEC-v2 §8.7, approved 2026-10-12): `POST /api/programs/generate`, `POST /api/programs` (draft),
  `POST /api/programs/:id/approve`, `POST /api/programs/:id/activate`, `GET /api/programs`; migration
  `0006_program_styles.sql`; `programs` in `/api/bootstrap` and in the backup export; the weekly report names the
  program it is scored against.
- Session planner (SPEC-v3 M9c, data option A approved 2026-10-13): migration `0008_planned_sessions.sql` (tables
  `planned_sessions` and `session_plan_items`, with `per_leg` and `target_rir_min/max` added to the SPEC draft);
  `POST /api/sessions/plan`, `PUT /api/sessions/:id/plan-items`, `POST /api/sessions/:id/start`,
  `POST /api/sessions/:id/apply-to-program`; `plans` in `/api/bootstrap` and in the backup export; programs may have
  `generated_by = 'session'`.
- AI report and advice (SPEC-v3 M9a/M9c, SQL and choices approved 2026-10-13): migration `0009_ai_reports.sql`
  (`session_reports`, `plan_advice` referencing `planned_sessions`); `GET /api/ai/usage` (Settings cost line and key
  status, never the key); Durable Object `AiJobs` (report writer); `[vars]` `REPORT_MODEL`, `REPORT_EFFORT`,
  `ADVICE_EFFORT`, `REPORT_MAX_TOKENS`; `DELETE /api/sessions/:id` also deletes the session's reports.
- Training overview (SPEC-v7 M9d, window, card replacement and SQL approved 2026-10-13): migration
  `0010_training_overviews.sql`; `GET /api/overview`, `POST /api/overview`, `GET /api/session-reports`,
  `GET /api/reviews`; read-only `GET /api/report-timeline` and `GET /api/overviews/:id` (History → Reports timeline,
  approved in the PR review); `[vars]` `OVERVIEW_EFFORT`, `OVERVIEW_MAX_TOKENS`; the backup export adds
  `training_overviews`.

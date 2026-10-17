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
| `npm run e2e` | Playwright, iPhone 15 profile: WebKit against a local HTTPS server (self-signed, through the airplane-mode proxy and a persistent context) and Chromium against HTTP. Runs in parallel: `E2E_WORKERS` workers (default 2, measured on a 4-core machine), each with its own servers and local D1/R2, so no two workers share data (`E2E_WORKERS=1` runs one test at a time; `npm run e2e -- tests/e2e/library.spec.ts` runs one file). See `scripts/e2e-slots.mjs` (ports from `E2E_PORT_BASE`, default 8788), `scripts/e2e-server.mjs`, `scripts/e2e-proxy.mjs`, `tests/e2e/fixtures.ts` |
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
  program exactly is on target everywhere. Traps, lower back, adductors and abductors have no target and show their
  sets only. Forearms and neck (SPEC-v11 Phase B): when the program trains them directly, their target is the
  program's direct sets and the status compares the done **direct** sets (rows and curls add half a forearm set, so the
  fractional number would always read as over); otherwise they have no target.
- Muscle map (Reports → Progress, SPEC-v6 §8): the picker's 3D model (same scene, mapping and lazy loading). Every
  mapped muscle takes the status of its report group, in the dark theme's status colours (the stage is dark in both
  themes): under amber, on target green, over orange, trained without a target teal, no sets this week muted;
  unmapped muscles are dark (`web/src/lib/anatomy-status.ts`). Drag turns it, Front / Back turn it round; on the whole
  body a tap zooms to that muscle's area (as in the picker); in the close-up a tap shows a card with the muscle, its
  group and "done / target sets this week" (fractional) with the status icon and label; "← Body" goes back. The legend
  and the list under the map carry icon and label, so status is never colour alone; the list is the accessible
  alternative. Without WebGL 2, or when the model fails or takes over 10 s, only a "3D unavailable." note shows with
  Retry (as in the exercise picker); no drawn figure ships (PR #26 review, 2026-10-17: a proper fallback is for the
  native app).
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
  `FEDB_SHA` in `worker/lib/library.ts`. The M14 sources (below) add names and facts from other databases.
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
- `npm run library:report` writes `seed/library/IMPORT-REPORT.md` and `seed/library/m14/IMPORT-REPORT.md` for review.

### More sources and muscle regions (SPEC-v11 M14 Phase A)

- Sources, each pinned to a commit in `worker/lib/librarySources.ts`: wger (licence per record: CC BY-SA 3.0/4.0 or
  CC0; images only where their own licence allows, AI-generated ones left out), everkinetic (CC BY-SA 4.0, with its
  images), and ExerciseDB (v1 dataset), Liftosaur and exercemus for names and facts only (no descriptions,
  instructions or media). Kettlebell, band, ball, foam roller and TRX exercises, plyometrics and strongman are left out.
  Every added row has our own two or three instruction steps; stretching and cardio count 0 toward volume.
- `seed/library/m14/screen.ts` (developer tool, not run on deploy) reads the sources, screens them against the library
  (automatic exclusions, exact duplicates) and writes `screening.json` and `wger-images.json`. The review is committed
  as one decision file per source (`seed/library/m14/<source>.json`: include with our row, exclude with a reason, or
  duplicate of an existing id) and `seed/library/m14/dedupe-review.json` (every probable duplicate marked `same` or
  `different`; change a line there to change the decision). Nothing is merged and existing ids never change.
- Region tags (`exercise_regions`, migration `0013_exercise_regions.sql`): 30 regions under the muscle chips, each tag
  with emphasis (main focus / also trained) and evidence (strong / moderate / weak), from the reviewed rule table in
  `worker/lib/regions.ts`; `seed/library/region-overrides.json` replaces the rules for a named exercise. The import
  tags every library exercise, a custom exercise is tagged on save. Forearm flexors and extensors and neck flexors and
  extensors were added in SPEC-v11 Phase B; neck work is plate, bodyweight or isometric only (no neck machine or head
  harness at the gym).
- `seed/library/duplicate-images.json` lists exercises whose two images are the same picture; the import keeps one.
- The import also snapshots each source to R2 (`library/sources/<source>/snapshots/`) and copies the stored images to
  `library/sources/<source>/images/` (manifest `library/sources/manifest.json`), resumable like the free-exercise-db
  copy. `--source-media skip` leaves the source images out (e2e).
- Muscle names map to the canonical keys in one table, `worker/lib/muscles.ts`.
- Every exercise shows a "Watch form video" link: a YouTube search for `name_en + " form"`, built at render time.

## Training styles and program generator (SPEC-v2 M8)

- Settings → Program → New program: days per week, style (auto, full body, upper/lower, PPL, PPL + upper/lower, bro
  split, strength), priority muscles, exercises to leave out, and full gym or dumbbells only. The slot schemes follow
  the goal set on Profile (SPEC-v12 M15); session length is information only and never limits a program.
- The generator (`worker/lib/generator/`, pure and seeded) fills each style's fixed weekly layout: main and secondary
  lifts first, then accessories and isolation toward the weekly targets (the current program's fractional volume, +3
  for added priority muscles, floors of 10 for chest, back, quads and hamstrings & glutes), with at most 10 fractional
  sets per muscle per session and 20 per week, rear delts ≥ 6, pull ≥ push, at least one hinge and one squat; no day
  is cut for time. Exercise choice prefers history, then the current program, then compound, then
  beginner/intermediate; one exercise keeps one role a week; Olympic-style lifts are never picked automatically.
- `checkPlan` (`check.ts`) is shared by the generator, the editor on the phone and the server: hard-rule violations
  block approval, warnings (floors, under/over target, long days, frequency) do not.
- The editor swaps an exercise for one with the same movement pattern and primary muscle and changes sets inside the
  slot's range. Approving archives the old program; History shows the program timeline, groups sessions by program and
  can switch back to an archived program (a new activation; history stays). Switching twice within 3 weeks shows a
  notice. No intro week, no light week; weights continue from the last sessions.
- Phase B (SPEC-v11, approved 2026-10-17): each new program starts the next block (A → B → C, `params.block`; the seed
  program is A). The generator keeps exercises that are not due (`worker/lib/rotation.ts`) and replaces due ones; main
  lifts stay barbell and change only their variation; the other exercises follow the block's equipment mix per muscle
  (`worker/lib/generator/blocks.ts`). Every block covers all 30 regions with a main-focus exercise (a missing region
  replaces a doubled one; the triceps long head counts only with an overhead extension), no day has two exercises with
  the same main-focus region and equipment, and forearms and
  neck get their weekly direct sets (4 and 2 in the first block, +1 per block, up to 8 and 6; neck 15–25 reps, 3–4 RIR,
  the smallest load step). The proposal
  shows the block, its region coverage and "replaces X: N weeks". The Program screen lists due exercises (at most 3)
  with an Ask Coach button.
- Tests: property tests over every style × days × goal × 50 seeds on the real library
  (`tests/fixtures/generator/library.json`, rebuilt by `npx tsx scripts/generator-pool.mts`), Payam's snapshot (within
  ±2 sets per muscle of the current program), the API flow and the seed re-run, and the Playwright flow.

## Goals, Profile and body sizes (SPEC-v12 M15, decisions by Payam 2026-10-17)

- Four tabs: Train, History, Library, Profile (Reports and Me merged into Profile). The gear on Profile lists Program,
  Planner, My training, Photos and Settings; AI reports and Backup open from Settings.
- My training (`web/src/views/MyTraining.tsx`, PR #26 review): the rest timer (Rest between sets, Rest before the next
  exercise) and the whole Calendar group (wake up, earliest suggestion, travel, shifts, reminder, gym hours, preferred
  times), moved out of Settings unchanged (same settings keys and API). Settings keeps the app: units, week start,
  Face ID lock, time zone, Program, Apple Watch, AI and data, Devices, rest-timer notification, Sync, About, Sign out.
- Goals: a training goal of one or two of Growth, Strength, Endurance, Power and a body goal of Gain, Maintain or Cut,
  stored as the settings keys `goal_training`, `goal_body`, `goal_set_at` (`PUT /api/settings`, offline through the
  outbox). The generator's slot schemes follow the goal (`worker/lib/goals.ts`, `goalScheme` in
  `worker/lib/generator/model.ts`); saving a goal never changes the program. Set goal offers "Ask Coach for a program
  for this goal" (the Coach's CONTEXT block says so; its draft needs approval as before).
- Profile: the line after the last session, My body (the shared 3D body `web/src/components/Body3D.tsx`, today pink,
  this week violet, the rest dark; sizes; the body goal's pace), My goal (the Living Diamond from `GET /api/profile`,
  `worker/lib/profile.ts`; Power always shows 0 and "No data"), This week, AI reports, Before · After, Details (the old
  Reports: Week, Month, All).
- Body sizes: `body_measurements` (migration 0014), `PUT`/`DELETE /api/body/measurements/:id`, Log sizes and All sizes
  on Profile. The Coach reads them with `get_body`.
- Photos: the in-app guide camera (SPEC-v10.1, `web/src/components/GuideCamera.tsx`): outline with two guide lines
  per pose, ghost of the last photo of the same pose and framing, level from the motion sensor, timer and burst of 3,
  settings remembered per pose.
- Pose check (PR #26 review): MediaPipe Pose Landmarker lite (Apache-2.0, `web/public/pose/POSE-SOURCE.md`, SHA-256
  pinned in `web/src/lib/pose-asset.ts` and checked by `npm run build`) on the phone's CPU, loaded on first use of the
  camera and kept by the service worker (model 5.8 MB, WebAssembly runtime 11.8 MB, about 3.4 MB compressed, code
  0.5 MB; nothing in the install, nothing sent anywhere). Ankles in the frame is a full-body photo (head and feet on
  the lines), otherwise an upper-body one (a mirror shot, head and waist on the lines); the framing switches after three
  readings in a row (`web/src/lib/pose.ts`). Lines, outline, ghost and each framing's line size follow it, and the
  framing is remembered per pose. One hint at a time ("Step back a bit", "Move left a bit", "Raise the phone a
  little", "On the lines.") live and under each burst shot. The kept photo is saved with its framing
  (`photos.framing`, migration 0015; NULL for library and older photos). Before · After and the month report's first
  and last photo compare only photos of the same pose and framing (`worker/lib/photoGroups.ts`).

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
- **Motivational line** (Payam, 2026-10-14): a short Persian line under the summary, from his real numbers only. Weeks
  run Monday–Sunday and the tone follows the local day the overview is written: Monday–Tuesday "New week" (last week's
  numbers and today's session), Wednesday–Friday "This week so far" (sessions done against planned up to today,
  records, e1RM gains), Saturday–Sunday "This week's result" (sessions done against planned for the week, records,
  main-lift changes). The first overview of a week also gives last week's result when none was written last Saturday
  or Sunday. A week is bad only with fewer than half its planned sessions (lift drops stay warnings): the line says so
  plainly, without praise, and ends with one concrete next step (the next program day). The app builds the facts
  (`worker/lib/ai/motivation.ts`: weeks, planned sessions by the overview's rule, records, main lifts, next day) and
  checks the line: only supplied numbers, the sessions done and planned of every week it reports, no praise word on a
  bad week, at most 400 characters. A line that breaks a rule is dropped (the rest of the overview stays).
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

## Coach chat (SPEC-v9 M12)

- The Coach button opens a full-screen chat (`web/src/views/Coach.tsx`). Answers stream in as the model writes them;
  answers are in Persian unless the question is in English. Saved chats: a list (newest first), **Archive** /
  **Unarchive**, and **Delete permanently** for archived chats only (the chat, its messages, its photo rows and its R2
  objects under `coach/<chat>/`; never training data or progress photos). Past chats are readable offline (saved on
  the phone); sending needs a connection. Me → AI reports: "Coach this month: N messages, ~$X". No limit.
- The model (`COACH_MODEL`, default claude-opus-5-5) reads Payam's data only through 11 read-only tools
  (`worker/lib/coach/tools.ts`): sessions, e1RM history, weekly sets vs target, planned vs done sessions, records, the
  active program with its rules, the library, body weight, the progress-photo list, recovery (last heavy compound
  per group, as the planner advice uses it) and his training pattern (usual weekdays and times over the last 4 weeks;
  when there is no clear pattern the coach asks him instead of guessing). Every number comes from the app's own functions: weekly sets and their
  under / on / over status are `muscleRows` / `balanceStatus` from `worker/lib/reports.ts`, exactly as on the Reports
  screen (under below 80 % of the target, on from 80 % to 120 %, over above 120 %, none at 0 sets). Each tool result
  is drawn as a data card captioned "Numbers calculated by the app from your logs".
- The 48-hour recovery rule is advice, never a ban: the coach names the group, the lift and the hours, offers options
  (isolation or a lighter variation today, or the heavy lift another day) and leaves the choice to Payam. It never
  refuses a request or removes an exercise because of it, and a draft keeps every exercise he asked for. The planner's
  Get advice uses the same wording and never suggests removing an exercise for recovery.
- Rotation (SPEC-v11 Phase B): `get_program` and `get_e1rm_history` give each exercise's weeks in the program, whether
  it is due and why, the block and the regions without a main focus. Ask Coach on a due line of the Program screen sends
  the exercise with the question: the coach says which region it trained, calls `suggest_replacements` (2–3 library
  exercises for a different region of the same muscle first, then other equipment; a region the exercise alone covers
  stays the main focus of every replacement; main lifts get close barbell variations; each with its region, the gap it
  fills and why its equipment fits) and shows each as the one-exercise card
  in replace mode: "Only this session" moves today's undone sets to the new exercise, "Whole program" saves a draft
  with it in the old one's place. The card first says what happens to the replaced exercise's region and muscle group. The weekly review names exercises due now and next week.
- `propose_program` shows a draft card (ids not in the library are dropped and named). **Add to Planner** saves it as
  an inactive program (`generated_by = 'coach'`) under Me → Program → Drafts; approving it there is a separate tap.
  The active program is never changed by the coach.
- The program generator's check (`checkPlan`) runs on every draft as **advice only**, shown under the card ("Worth
  knowing"); Add to Planner is never blocked. Drafts have no time limit: each day shows its estimated length as
  information ("Day 2 · Legs · about 75 min"). A draft has no weekdays, so the spacing rules (two heavy hinges, a main
  lift for the same group, the same group trained) run on adjacent days in order (Day 1 → 2 → 3 → 4, and the last day
  → Day 1; at most two training days in a row) and read as a condition: "If you train Day 1 and Day 2 back to back,
  that is two heavy hinges within 24 h." The 1×/week note (it names a generator style) and set ranges (generator
  slots) are left out. Planned dates from the calendar (M13) will replace the day order and the training pattern.
- When an answer's text names a group's status (under / on / over target) that its own `get_volume` card does not
  show, a note sits under the answer: "The numbers in the card are the app's; the text may be wrong." The answer is
  never hidden or changed (`worker/lib/coach/statusCheck.ts`, English and Persian; cautious: a clause counts only with
  exactly one status and no negation).
- Photos: camera, library or a progress photo (copied into the chat). Resized to 1600 px and stripped of EXIF on the
  phone and again on the Worker; private in R2. "Save to progress photos" adds one to the gallery.
- Opus 5.5 (Payam, 2026-10-15): `tool_choice` is never set (forced tool use is an error on this model);
  `thinking: {type: "adaptive", display: "updates"}` (beta `thinking-display-updates-2026-08-18`) returns the notes the
  model writes between tool calls, shown as the typing line; thinking blocks are saved and sent back unchanged, and
  `block_binding.prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`) keeps a chat
  working when older messages fall outside the history budget. The system prompt (`worker/lib/coach/prompt.ts`) never
  changes; today's date, the unit and the active program go into each question as a CONTEXT block.
- The answer runs in the `AiJobs` Durable Object (`worker/coachTurn.ts`) and streams to the chat as server-sent
  events. Up to 8 tool calls per answer. A failed call is saved with its error and shows "Answer failed — Retry".
  Cost per answer from the API's token counts (input $4, output $20, cache write $5, cache read $0.20 per million
  tokens, checked 2026-10-14), with a cache breakpoint after the tools and system prompt and one on the newest message.
- Config (`wrangler.toml` `[vars]`): `COACH_MODEL`, `COACH_EFFORT` (medium), `COACH_MAX_TOKENS` (8000, thinking
  included), `COACH_CONTEXT_TOKENS` (60 000). Tables: migration `0011_coach.sql`.
- Code: routes `worker/coach.ts`, the answer `worker/coachTurn.ts`, prompt / tools / draft / history budget in
  `worker/lib/coach/`, client `web/src/coach.ts`, cards `web/src/components/CoachCards.tsx`.

## Artwork and credits

- Exercise images: free-exercise-db (Unlicense), wger (each image's own licence and author, shown under it) and
  everkinetic (CC BY-SA 4.0), copied into the private R2 bucket (see "Exercise library"); credited in Settings → About.
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
- Rotation and blocks (SPEC-v11 Phase B, listed for approval in its PR; no migration): `rotation` in `/api/bootstrap`
  (weeks, due and reason per exercise of the active program); `params.block` on generated programs (inside the existing
  `programs.params` JSON); `rotation: { exercise_id }` on `POST /api/coach/threads/:id/messages` (Ask Coach from a due
  line); Coach tool `suggest_replacements` and `replaces_exercise_id` on `propose_exercise`; report muscle rows carry
  `basis: "direct"` for forearms and neck with a direct-set target, and `get_volume` rows `target_counts`.

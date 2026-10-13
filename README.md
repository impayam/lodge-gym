# Lodge Gym

Personal workout PWA (single user, English LTR UI) on Cloudflare Workers + D1 + R2. Spec: `SPEC.md`, `SPEC-v2.md` and `SPEC-v3.md` (M9, M10); working rules: `CLAUDE.md`.

Status: **M1** (shell, passkey auth, program seed, offline logging), **M2** (progress photos), **M3** (reports + progress page), **M4** (Apple Watch bridge via iOS Shortcuts), RIR per set, weekly backup, rest-timer push, weekly review card, **M6** (English UI, SPEC-v2), **M7** (exercise library), **M8** (training styles and program generator).

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
(`lodge-gym-db`, id `f8ba012b-9970-423c-83f3-8c32111695e7`, migration `0003_weekly_reviews.sql`). The newest row
(highest `week_start`, then latest `created_at`) is shown in the Weekly review card on the home and reports pages.
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
  themes): under amber, on target green, over orange, trained without a target teal, not trained this week muted;
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
  (approved table; 78 of the model's 222 muscle names), tested against the GLB's own node list.
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

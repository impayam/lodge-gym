# Lodge Gym

Personal workout PWA (single user, Persian RTL UI) on Cloudflare Workers + D1 + R2. Spec: `SPEC.md`; working rules: `CLAUDE.md`.

Status: **M1** (shell, passkey auth, program seed, offline logging), **M2** (progress photos), **M3** (reports + progress page), **M4** (Apple Watch bridge via iOS Shortcuts), RIR per set, weekly backup, rest-timer push, weekly review card.

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
| `npm run e2e` | Playwright, iPhone 15 profile, WebKit and Chromium |
| `npm run db:migrate:local` / `:remote` | Apply D1 migrations |
| `npm run seed:local` / `:remote` | Upsert the program seed (idempotent) |
| `npm run deploy` | Build, migrate + seed remote D1, `wrangler deploy` |

## Deploy (Cloudflare Workers Builds)

- Build command: `npm run build`
- Deploy command: `npm run deploy:ci` (applies remote migrations and the seed, then `wrangler deploy`)
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
in the `lodge-gym-photos` bucket and keeps the newest 12. Settings → «پشتیبان» downloads the latest one or a fresh
export (`GET /api/export`). Emailing the backup is not wired: Cloudflare can only send email from a domain on
Cloudflare DNS (Email Routing / Email Service), and this app runs on `workers.dev`.

## Rest-timer push

Web Push (VAPID, RFC 8291 aes128gcm, WebCrypto only: `worker/lib/webpush.ts`). A SQLite-backed Durable Object
(`RestPush`, Free-plan compatible) holds the VAPID key pair (generated on first use), the subscriptions and the pending
rest end, and sends the push from an alarm. Settings → «اعلان پایان استراحت» asks for permission from a tap. On iPhone it
works only in the Home Screen app on iOS 16.4+.

## Weekly AI review (written by Claude into D1)

The app only reads this table; Claude writes one row per week directly into D1
(`lodge-gym-db`, id `f8ba012b-9970-423c-83f3-8c32111695e7`, migration `0003_weekly_reviews.sql`). The newest row
(highest `week_start`, then latest `created_at`) is shown in the «مرور هفتگی» card on the home and reports pages.

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

## Approved additions beyond SPEC §5/§11

- Tables `auth_challenges` (one-time WebAuthn challenges) and `rate_limits` (the D1 counter table SPEC §4 allows).
- `PUT /api/settings` (unit, week start, re-lock minutes, timezone).
- Table `weekly_reviews` (migration 0003), `review` in `/api/bootstrap`, `GET /api/reviews/latest`.
- `/api/push/key|subscribe|unsubscribe|rest|rest/cancel|test`, Durable Object `RestPush`.
- `GET /api/backups`, `GET /api/backups/latest`, weekly Cron Trigger.
- `GET /api/reports/progress` («پیشرفت» page) and `?format=csv` on `/api/reports/week|month`; setting `month_calendar` (`gregorian`|`jalali`).
- `GET /api/photos` (photo list for the gallery; SPEC §11 lists the other photo routes).
- `PUT /api/body-mass/:date` (manual body weight, source `manual`) and `set_entries.rir` (migration 0002).
- `POST /api/health/raw` (replaces `/health/workouts`), `GET /api/health/status`, `PUT /api/health/workouts/:id/match`.

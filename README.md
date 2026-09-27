# Lodge Gym

Personal workout PWA (single user, Persian RTL UI) on Cloudflare Workers + D1 + R2. Spec: `SPEC.md`; working rules: `CLAUDE.md`.

Status: **M1** (shell, passkey auth, program seed, offline logging) and **M4** (Apple Watch bridge via iOS Shortcuts).

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

The shortcut has three actions (Find Health Samples: Workouts; Find Health Samples: Heart Rate; Get Contents of URL)
and posts the raw results to `POST /api/health/raw` with `Authorization: Bearer <token>`. The Worker parses the
Shortcuts text (`worker/lib/shortcuts.ts`: locale dates incl. Jalali, units, comma decimals, newline lists), computes
duration, active kcal and average/max HR per workout, dedupes on `sha256(type + start)` and matches sessions
(`worker/lib/matching.ts`). Settings → «Apple Watch» has the token, step-by-step instructions and the last 10 workouts.
Fixtures of messy payloads: `tests/fixtures/shortcuts/`.

## Approved additions beyond SPEC §5/§11

- Tables `auth_challenges` (one-time WebAuthn challenges) and `rate_limits` (the D1 counter table SPEC §4 allows).
- `PUT /api/settings` (unit, week start, re-lock minutes, timezone).
- `POST /api/health/raw` (replaces `/health/workouts`), `GET /api/health/status`, `PUT /api/health/workouts/:id/match`.

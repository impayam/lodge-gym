# CLAUDE.md — Lodge Gym (personal workout PWA)

Read `SPEC.md` fully before writing any code. It is the single source of truth. If something you need is not in the spec, stop and ask Payam; do not invent requirements.

## Working rules

- No change to the program seed (SPEC §6), the data model (§5) or the API surface (§11) without Payam's explicit approval. Propose the change with trade-offs and wait.
- If you are about to make a decision on your own that the spec does not cover, stop, say so plainly ("I wanted to do X because Y"), and wait for guidance.
- Production code only. No placeholders, no TODO stubs, no mock data in shipped code, no "simplified version".
- Build milestones in order (M1 → M5). A milestone is done only when its acceptance criteria in SPEC §14 pass and tests are green.
- Test before reporting done. If something fails, fix it completely; do not hand back a failure with an explanation.
- Keep answers to Payam short and in Persian unless he writes in English. Code, identifiers and commit messages in English.

## Stack

- Cloudflare Workers + Hono (API and static assets from one Worker), D1, R2 (private bucket).
- Frontend: Vite + TypeScript + Preact, hand-written CSS with design tokens (light/dark), RTL, Persian UI.
- Offline: Workbox (`injectManifest`) service worker + IndexedDB via `idb`; outbox pattern with idempotent upserts keyed by client ULIDs.
- Auth: passkeys with `@simplewebauthn/server` and `@simplewebauthn/browser` (pin exact versions).
- Validation: Zod on every API input.
- Tests: Vitest with `@cloudflare/vitest-pool-workers` for the Worker; Playwright with WebKit and an iPhone device profile for UI flows.

## Layout

```
/worker        Hono app, routes, D1 queries, R2 access, auth, report computation
/web           Vite + Preact PWA (src/, public/manifest.webmanifest, icons, sw.ts)
/migrations    D1 SQL migrations (numbered)
/seed          program seed (SPEC §6) as SQL or JSON + loader
/tests         worker unit tests, fixtures (including messy iOS Shortcuts payloads), Playwright e2e
wrangler.toml  bindings: DB (D1), PHOTOS (R2), ASSETS; secret SETUP_TOKEN via `wrangler secret put`
```

## Commands (set these up in package.json)

- `npm run dev` — Vite dev server + `wrangler dev` with local D1/R2
- `npm run db:migrate:local` / `npm run db:migrate:remote`
- `npm run seed:local` / `npm run seed:remote`
- `npm test` — Vitest (worker + pure logic)
- `npm run e2e` — Playwright (WebKit, iPhone profile)
- `npm run deploy` — build web, then `wrangler deploy`

## Conventions

- UI strings in Persian; exercise names in Persian with the English name beneath. Numbers display in Persian digits; inputs accept Persian and Latin digits.
- Dates shown as Jalali + Gregorian. Store UTC ISO timestamps plus `local_date`.
- Units: store weight in the unit the user entered plus the session unit; convert only for reports.
- Progression, Epley 1RM, week boundaries and Shortcuts payload parsing live in pure, unit-tested modules under `/worker/lib`.
- Photos: resize and strip EXIF on the client before upload; never expose R2 publicly.
- Security headers and CSP per SPEC §13 on every response.
- No third-party analytics, fonts from CDNs, or external scripts. Bundle the Vazirmatn font locally (OFL license).

## Known platform limits (do not try to work around them)

- A web app cannot read Apple Health/HealthKit. Apple Watch data arrives only through the iOS Shortcuts bridge (SPEC §9).
- iOS Shortcuts can read Health data only while the iPhone is unlocked.
- iOS web apps have no vibration API; use a visual cue for the rest timer.
- Passkeys are bound to the domain (RP ID). Pick the final domain before M1 deploy.

## Definition of done for each milestone

1. Acceptance criteria in SPEC §14 met on a real iPhone (Payam checks) and in Playwright WebKit.
2. `npm test` and `npm run e2e` green.
3. Deployed with `npm run deploy`; D1 migrations applied remotely.
4. Short Persian summary to Payam: what works, what to check on the phone, anything not done.

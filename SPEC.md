# Lodge Gym — Personal Workout PWA · Specification v1.0

> خلاصه‌ی فارسی: یک اپ وب مستقل (PWA) روی Cloudflare که روی آیفون نصب می‌شود، با Face ID باز می‌شود، آفلاین کار می‌کند، برنامه‌ی تمرینی فول‌بادی ۴ روزه را اجرا می‌کند، ثبت ست‌ها را تا حد ممکن سریع می‌کند، عکس‌های پیشرفت بدن را خصوصی نگه می‌دارد، داده‌های Apple Watch را از طریق Shortcuts می‌گیرد و گزارش هفتگی و ماهانه می‌دهد.

Working name: **Lodge Gym** (rename freely; used only in the manifest and title).

---

## 1. Goal and scope

A single-user, installable web app for iPhone that replaces the current claude.ai artifact "دفترچه‌ی باشگاه".

In scope:

1. Install to iPhone Home Screen as a standalone PWA (own icon, full screen, offline app shell).
2. Unlock with Face ID via passkeys (WebAuthn). No passwords.
3. Run the 4-day full-body program (Section 6), with a flexible schedule: whatever day the user trains, the app offers the next day in the cycle.
4. Fast set logging, offline-first, auto-sync.
5. Progress photos after each session, private, with side-by-side comparison.
6. Apple Watch / Apple Health data (workout duration, active energy, heart rate, body weight) via iOS Shortcuts posting to the app's API.
7. Weekly and monthly reports.
8. One-time import of data from the current artifact.

Out of scope (v1): multiple users, social features, a native iOS app, Android-specific work, AI coaching inside the app.

**Hard platform constraint:** a web app cannot read Apple Health / HealthKit directly. HealthKit is native-only. The bridge is iOS Shortcuts (Section 9). A native companion app is a possible v2.

---

## 2. Architecture

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Cloudflare Workers (one Worker) | Serves API + static assets (Workers Static Assets). |
| API framework | Hono | Small, Workers-native. |
| Database | Cloudflare D1 (SQLite) | Migrations in `migrations/`. |
| Photo storage | Cloudflare R2, private bucket | Never public; served only through the Worker after auth. |
| Frontend | Vite + TypeScript + Preact | Small bundle; hand-written CSS with design tokens. Default choice, open to change (Section 15). |
| Offline | Service worker (Workbox `injectManifest`) + IndexedDB (`idb`) | App shell precache, outbox queue for writes and photo uploads. |
| Auth | Passkeys via `@simplewebauthn/server` + `@simplewebauthn/browser` | Pin exact versions; verify Workers compatibility in M1. |
| Charts | Hand-rolled SVG components | No chart library needed for the report set in Section 10. |
| Tests | Vitest + `@cloudflare/vitest-pool-workers`, Playwright (WebKit, iPhone 15 profile) | |

Single origin: `https://<app-domain>/` serves the PWA, `/api/*` serves JSON. Custom domain recommended (passkeys are bound to the domain, the RP ID; changing domain later means re-registering passkeys).

---

## 3. PWA and iPhone requirements

- `manifest.webmanifest`: `name`, `short_name`, `lang: "fa"`, `dir: "rtl"`, `display: "standalone"`, `start_url: "/"`, `scope: "/"`, `theme_color`, `background_color`, icons 192/512 + maskable.
- iOS: `apple-touch-icon` (180×180), `<meta name="apple-mobile-web-app-capable" content="yes">`, `apple-mobile-web-app-status-bar-style`, `viewport-fit=cover`, safe-area padding on fixed bars.
- Offline: the full UI opens and works with no network. Writes go to the IndexedDB outbox and sync when online. A small status chip shows: synced / N pending / offline.
- Screen Wake Lock during an active session: request it, tolerate rejection silently.
- Persistent storage: call `navigator.storage.persist()` after login.
- UI language Persian, RTL. Exercise names shown in Persian with English name underneath (English names are used for search and video links).
- Light and dark themes following the system setting.

---

## 4. Authentication (Face ID via passkeys)

Single user. Flows:

1. **First-run setup.** `GET /setup` works only while no credential exists and only with a valid `SETUP_TOKEN` (Worker secret, entered once on the phone). It registers the first passkey (`residentKey: "required"`, `userVerification: "required"`) and generates 10 recovery codes (shown once, stored as SHA-256 hashes). After that `/setup` returns 404 permanently.
2. **Login.** Opening the app without a valid session shows one button: «ورود با Face ID». WebAuthn assertion → server verifies → session cookie.
3. **Session.** Opaque random token in an `HttpOnly; Secure; SameSite=Strict; Path=/` cookie, stored hashed in D1, 30-day sliding expiry.
4. **Re-lock.** A setting to require Face ID again after N minutes in background (default: off). Implemented as a client-side gate that re-runs a WebAuthn assertion.
5. **Recovery.** A recovery code creates a short-lived session that can only register a new passkey.
6. **Extra devices.** Settings → "افزودن دستگاه" registers another passkey (iCloud Keychain usually syncs passkeys across the user's Apple devices anyway).
7. **Shortcut tokens.** Separate bearer tokens for iOS Shortcuts (Section 9), created in Settings, scoped to `health:write`, shown once, stored hashed, revocable.

Rate-limit `/api/auth/*` (e.g. 10 requests/minute per IP) using a D1 counter table or Workers Rate Limiting binding.

---

## 5. Data model (D1)

All timestamps are UTC ISO-8601 strings. `local_date` is the user's local calendar date (`YYYY-MM-DD`).

```sql
credentials(id TEXT PK, public_key BLOB, counter INTEGER, transports TEXT, created_at TEXT, last_used_at TEXT, label TEXT)
auth_sessions(token_hash TEXT PK, created_at TEXT, expires_at TEXT, scope TEXT)          -- scope: 'full' | 'recovery'
recovery_codes(code_hash TEXT PK, used_at TEXT)
api_tokens(id TEXT PK, token_hash TEXT UNIQUE, label TEXT, scope TEXT, created_at TEXT, last_used_at TEXT, revoked_at TEXT)
settings(key TEXT PK, value TEXT)                -- unit ('lb'|'kg'), week_start, relock_minutes, timezone

programs(id TEXT PK, name TEXT, active INTEGER, created_at TEXT)
program_days(id TEXT PK, program_id TEXT, position INTEGER, name_fa TEXT, name_en TEXT, focus_fa TEXT, est_minutes INTEGER)
exercises(id TEXT PK, name_fa TEXT, name_en TEXT, muscle_primary TEXT, is_lower INTEGER, equipment TEXT, cue_fa TEXT)
                                                 -- equipment: 'barbell'|'dumbbell'|'cable'|'machine'|'bodyweight'
day_exercises(id TEXT PK, day_id TEXT, exercise_id TEXT, position INTEGER, sets INTEGER, reps_min INTEGER, reps_max INTEGER,
              per_leg INTEGER, is_time INTEGER, rest_sec INTEGER, superset_tag TEXT, is_main INTEGER)

workout_sessions(id TEXT PK, program_day_id TEXT, local_date TEXT, started_at TEXT, ended_at TEXT, status TEXT,
                 unit TEXT, note TEXT, created_at TEXT, updated_at TEXT, source TEXT)   -- status: 'active'|'done'; source: 'app'|'import'
set_entries(id TEXT PK, session_id TEXT, exercise_id TEXT, set_index INTEGER, weight REAL, reps INTEGER, seconds INTEGER,
            done INTEGER, updated_at TEXT)

photos(id TEXT PK, session_id TEXT NULL, local_date TEXT, pose TEXT, r2_key TEXT, thumb_r2_key TEXT, width INTEGER, height INTEGER,
       bytes INTEGER, created_at TEXT)            -- pose: 'front'|'side'|'back'|'other'

health_workouts(id TEXT PK, external_key TEXT UNIQUE, activity_type TEXT, started_at TEXT, ended_at TEXT, duration_sec INTEGER,
                active_kcal REAL, total_kcal REAL, hr_avg REAL, hr_max REAL, matched_session_id TEXT NULL, raw TEXT, received_at TEXT)
body_metrics(id TEXT PK, local_date TEXT, kind TEXT, value REAL, unit TEXT, source TEXT, received_at TEXT,
             UNIQUE(local_date, kind, source))    -- kind: 'body_mass'|'resting_hr'|'hrv'|'sleep_hours'
```

Every write from the client carries a client-generated id (ULID). Writes are idempotent upserts keyed by id, so outbox retries never duplicate data.

---

## 6. Program seed (approved by the user, do not change without asking)

Full-body, 4 days, daily focus. Cycle order D1 → D2 → D3 → D4 → D1. Rule: no more than two training days in a row.

Weight increments for suggestions: barbell/machine/cable upper +5 lb (+2.5 kg), lower +10 lb (+5 kg), dumbbell +5 lb per hand (+2 kg).

**D1 «روز ۱ – سینه» · Day 1 · Chest · ~60 min**

| # | Exercise (en) | fa | Sets×Reps | Rest | Tag | Main | Lower |
|---|---|---|---|---|---|---|---|
| 1 | Barbell Bench Press | پرس سینه هالتر | 4×5 | 180 | | ✓ | |
| 2 | Incline Dumbbell Press | پرس بالا سینه دمبل | 3×10 | 120 | | | |
| 3 | Romanian Deadlift | ددلیفت رومانیایی | 3×8 | 150 | | | ✓ |
| 4 | Seated Cable Row | زیربغل کابل نشسته | 3×10 | 90 | | | |
| 5 | Dumbbell Lateral Raise | نشر جانب | 3×12 | 75 | A1 | | |
| 6 | Face Pull | فیس‌پول | 3×15 | 75 | A2 | | |

**D2 «روز ۲ – پا» · Day 2 · Legs · ~60 min**

| # | Exercise (en) | fa | Sets×Reps | Rest | Tag | Main | Lower |
|---|---|---|---|---|---|---|---|
| 1 | Barbell Back Squat | اسکوات هالتر | 4×5 | 180 | | ✓ | ✓ |
| 2 | Leg Press | پرس پا | 3×10 | 120 | | | ✓ |
| 3 | Incline Barbell Bench Press | پرس بالا سینه هالتر | 3×8 | 150 | | | |
| 4 | Lat Pulldown | لت‌پول‌داون | 3×10 | 90 | | | |
| 5 | Standing Calf Raise | ساق پا ایستاده | 3×12 | 60 | A1 | | ✓ |
| 6 | Plank | پلانک | 3×45 s | 60 | A2 | | |

**D3 «روز ۳ – پشت» · Day 3 · Back · ~60 min**

| # | Exercise (en) | fa | Sets×Reps | Rest | Tag | Main | Lower |
|---|---|---|---|---|---|---|---|
| 1 | Chest-Supported Dumbbell Row | زیربغل دمبل روی نیمکت شیب‌دار | 4×8 | 150 | | ✓ | |
| 2 | Pull-Up / Assisted Pull-Up | بارفیکس | 3×6–8 | 120 | | | |
| 3 | Bulgarian Split Squat | اسکوات بلغاری | 3×8 per leg | 120 | | | ✓ |
| 4 | Cable Chest Fly | قفسه‌ی کابل | 3×12 | 90 | | | |
| 5 | Dumbbell Biceps Curl | جلو بازو دمبل | 3×10 | 75 | A1 | | |
| 6 | Overhead Cable Triceps Extension | پشت بازو کابل از بالای سر | 3×10 | 75 | A2 | | |

**D4 «روز ۴ – ددلیفت» · Day 4 · Deadlift · ~55 min**

| # | Exercise (en) | fa | Sets×Reps | Rest | Tag | Main | Lower |
|---|---|---|---|---|---|---|---|
| 1 | Conventional Deadlift | ددلیفت | 3×5 | 180 | | ✓ | ✓ |
| 2 | Standing Overhead Press | پرس سرشانه ایستاده | 3×6 | 150 | | | |
| 3 | Lying Leg Curl | پشت ران دستگاه | 3×10 | 90 | | | ✓ |
| 4 | Face Pull | فیس‌پول | 3×15 | 75 | A1 | | |
| 5 | Dumbbell Lateral Raise | نشر جانب | 3×12 | 75 | A2 | | |
| 6 | Hanging Knee Raise | بالا آوردن زانو آویزان | 3×10 | 60 | B1 | | |
| 7 | Seated Calf Raise | ساق پا نشسته | 3×15 | 60 | B2 | | ✓ |

Persian form cues: copy them verbatim from the current artifact (the `cue` fields in the `DAYS` object of `gym-log.html`, provided alongside this spec). Pull-Up note: assistance weight is logged as a negative number.

Seed also the legacy exercises used by the old Upper/Lower program so imported history renders: Barbell Bent-Over Row, Walking Lunge, Chest Dips, Triceps Rope Pushdown, and the old day names «بالاتنه A/B», «پایین‌تنه A/B» as an inactive program.

---

## 7. Logging UX (priority: fewest taps)

Home screen:

- Big card «جلسه‌ی بعدی: روز X» with one button «شروع». If yesterday and the day before were both training days, show «امروز استراحت بهتر است» (the button still works).
- If a session is active, the card becomes «ادامه‌ی جلسه».
- Week strip: dots for sessions in the current week (target 4).
- Last 4 sessions.

Session screen:

- Date, start time (auto, editable), elapsed clock, end time (set by «پایان جلسه», editable).
- Each exercise card: Persian name + English name, «اصلی» badge for the main lift, superset tag, target, one-line cue, «ویدیوی فرم» link (`https://www.youtube.com/results?search_query=<English name> proper form`), last performance, suggestion.
- **Prefill:** each set row is prefilled with the suggested weight (grey until touched). Reps field shows the target as placeholder.
- **One tap to log:** the check button marks the set done, fills reps with the target if empty, starts the rest timer with that exercise's rest time.
- **Steppers:** long-press or small −/+ buttons change weight by the exercise's increment; reps by 1.
- «مثل دفعه‌ی قبل» button per exercise copies last session's weights and reps.
- Add / remove set.
- Rest timer: sticky bar, +30 s, dismiss; vibration via `navigator.vibrate` where supported (not on iOS; show a visual flash instead).
- Numeric inputs accept Persian and Latin digits, comma or dot decimals.
- Autosave: every change goes to IndexedDB immediately and syncs in the background.
- After «پایان جلسه»: prompt to add progress photos (front / side / back), skippable.

Progression suggestion (same logic as the artifact): if every planned set of the exercise was done last time at ≥ the top of the rep target, suggest last top weight + increment; otherwise the same weight. Bodyweight exercises: suggest +1 rep or less assistance. Timed: +15 s.

---

## 8. Progress photos

- Pick from camera or library (`<input type="file" accept="image/*" capture>` plus a library option), multiple allowed. Pose selector: جلو / بغل / پشت / دیگر.
- Client-side processing: decode, apply EXIF orientation, resize longest side to 1600 px, JPEG quality 0.85; thumbnail 400 px. Strip EXIF (removes location).
- Upload: `POST /api/photos` returns an id and a one-time upload URL; client `PUT`s the full image and the thumbnail through the Worker into R2. Queue in the outbox if offline.
- Serving: `GET /api/photos/:id?size=thumb|full`, auth required, `Cache-Control: private, max-age=31536000, immutable`.
- Gallery: grouped by date, filter by pose. Compare mode: pick two photos → side by side with dates and the day gap; optional overlay slider.
- Delete: two-step confirm, removes R2 objects and the row.

---

## 9. Apple Watch / Apple Health bridge (iOS Shortcuts)

The Worker exposes token-authenticated endpoints. The user builds two shortcuts; the app's Settings page shows the exact steps and the token.

### 9.1 Endpoints

`POST /api/health/workouts` · header `Authorization: Bearer <api_token>`

```json
{
  "workouts": [
    { "type": "Traditional Strength Training", "start": "2026-09-28T17:05:00-06:00", "end": "2026-09-28T18:02:00-06:00",
      "duration_min": 57, "active_kcal": 312, "total_kcal": 402, "hr_avg": 118, "hr_max": 161 }
  ]
}
```

- Server parses tolerant formats: numbers may arrive as strings with units ("312 kcal"), comma decimals, or newline-joined lists (Shortcuts often sends text). Normalize, then upsert keyed by `external_key = sha256(type + start)`.
- Matching: attach to the `workout_session` whose `[started_at, ended_at]` overlaps the watch workout, or whose start is within ±90 minutes on the same local date. Unmatched workouts are kept and shown as «تمرین ساعت بدون جلسه» with a button to attach or create a session.

`POST /api/health/metrics` · same auth

```json
{ "date": "2026-09-28", "body_mass": 80.2, "body_mass_unit": "kg", "resting_hr": 58, "hrv": 42, "sleep_hours": 7.1 }
```

All fields optional except `date`. Upsert by (date, kind, source='shortcut').

Both endpoints return `{"ok":true,"stored":N,"matched":M}` and a Persian message the shortcut can show.

### 9.2 Shortcut A: «ثبت تمرین ساعت» (after each watch workout)

Automation trigger: **Apple Watch Workout → End**, workout types: Traditional Strength Training, Functional Strength Training (or Any). Set to run immediately. Actions:

1. Find Health Samples where Type is Workouts, Start Date is in the last 6 hours, sort by Start Date latest first, limit 1.
2. From the result, get Start Date, End Date, Duration, Type, and energy values (property names vary by iOS version; the Settings page must say "if a field name differs, pick the closest one").
3. Find Health Samples where Type is Heart Rate, Start Date between workout start and end. Calculate Statistics → Average, and → Maximum.
4. Build a Dictionary matching 9.1 and send with Get Contents of URL (POST, JSON, Authorization header).
5. Show Result (the server message).

Known limits to state in the app: Health data can only be read while the iPhone is unlocked, so the automation may wait until the phone is unlocked; if it fails, running the shortcut manually later still works because it looks back 6 hours. Add a manual variant «همگام‌سازی ۷ روز اخیر» that sends all strength workouts from the last 7 days (idempotent on the server).

### 9.3 Shortcut B: «سنجه‌های روزانه» (daily)

Automation trigger: Time of Day, 21:30, daily. Reads the latest Body Mass, today's Resting Heart Rate, average HRV, and last night's sleep duration where available, then posts to `/api/health/metrics`.

### 9.4 Deliverable

Besides the endpoints, the app's Settings → «Apple Watch» page must contain: token creation, copy button, step-by-step screenshots-free instructions for both shortcuts, a «ارسال آزمایشی» check that shows the last received payload time, and a table of the last 10 received workouts with their match status.

---

## 10. Reports

Week start: setting (Saturday / Sunday / Monday). Month: Gregorian calendar month by default, Persian (Jalali) month as a setting. Display dates in both Jalali and Gregorian.

**Weekly report**

- Sessions done vs target 4; which days; total training time.
- Sets per muscle group vs the program target (chest 13, back 13, quads 10, hamstrings/glutes 9, shoulders 9, rear delts 6, calves 6, core 6, biceps 3, triceps 3), shown as bars with target marks.
- Main lifts: best set of the week (weight×reps) and estimated 1RM (Epley: `w × (1 + reps/30)`), change vs previous week.
- New personal records.
- Apple Watch: total active kcal, average HR across strength sessions, sessions matched / unmatched.
- Body: body-mass average for the week and change vs previous week (if Shortcut B is running).
- Notes written in sessions that week.

**Monthly report**

- Sessions per week (4–5 bars), adherence %.
- Estimated 1RM trend line per main lift (bench, squat, chest-supported row, deadlift) and overhead press.
- Total volume (weight × reps) per muscle group, month over month.
- Body-mass trend with 7-day moving average.
- First vs last progress photo of the month per pose, side by side.
- Average session duration, average active kcal.

Both reports: a share button that exports a PNG summary card (canvas) through the Web Share API, and CSV export of the raw sets for the period.

---

## 11. API surface (JSON, all under `/api`, session cookie unless stated)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register/options`, `/auth/register/verify` | Passkey registration (setup token, recovery session, or full session). |
| POST | `/auth/login/options`, `/auth/login/verify` | Passkey login. |
| POST | `/auth/recover` | Recovery code → recovery-scoped session. |
| POST | `/auth/logout` | |
| GET | `/bootstrap` | Settings, active program with days and exercises, last 60 days of sessions (for offline cache). |
| PUT | `/sessions/:id` | Upsert session with its set entries (whole-document write, last-writer-wins on `updated_at`). |
| DELETE | `/sessions/:id` | |
| GET | `/sessions?from=&to=` | History. |
| POST | `/photos`, PUT `/photos/:id/blob?size=`, GET `/photos/:id`, DELETE `/photos/:id` | Photos. |
| GET | `/reports/week?start=`, `/reports/month?month=` | Computed on the server from D1. |
| POST/GET/DELETE | `/tokens` | Shortcut tokens. |
| POST | `/health/workouts`, `/health/metrics` | Bearer token auth (Section 9). |
| POST | `/import/artifact` | One-time import (Section 12). |
| GET | `/export` | Full JSON export (sessions, sets, health, photo metadata) for backup. |

All inputs validated with Zod. Errors return `{error:{code,message_fa}}`.

---

## 12. Import from the current artifact

Claude (Cowork) exports the artifact's `sessions` collection to `artifact-export.json` and, if any, its progress photos as files. Source document shape:

```json
{ "id":"muk0ksl92cbyf", "day":"D1|D2|D3|D4|UA|LA|UB|LB", "date":"YYYY-MM-DD", "start":"HH:MM", "end":"HH:MM|''",
  "status":"active|done", "unit":"lb|kg", "note":"",
  "sets": { "<exercise_key>": [ {"w":"135","r":"5","ok":true} ] },
  "photos": [ {"id":"<asset id>","at":1790525373885} ], "createdAt":1790525373885, "updatedAt":1790525374617 }
```

Exercise key → exercise mapping (artifact keys): `bench, incline_db, incline_bb, row, cs_row, pulldown, fly, oh_tri, facepull, squat, leg_press, rdl, lunge, calf_stand, plank, ohp, pullup, dips, cable_row, lateral, curl, deadlift, bulgarian, leg_curl, knee_raise, calf_seated`. `w`/`r` are strings (may be empty), convert to numbers; `plank` reps are seconds. Local times are America/Denver unless the settings timezone says otherwise. Skip sessions whose sets are all empty and status is not `done`, and report them in the import summary. Settings page has «وارد کردن داده از دفترچه‌ی قبلی» that accepts the JSON file and the photo files, shows a dry-run summary first, then imports.

---

## 13. Security and privacy

- R2 bucket private; no public URLs; photo EXIF stripped client-side.
- CSP: `default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'`.
- Cookies `HttpOnly; Secure; SameSite=Strict`. CSRF: SameSite plus an `Origin` header check on state-changing requests.
- Secrets (`SETUP_TOKEN`) only via `wrangler secret`. Never committed.
- API tokens and recovery codes stored as SHA-256 hashes.
- `/api/export` for user-owned backups; weekly reminder in the app to download one.

---

## 14. Milestones and acceptance criteria

Build in this order; each milestone ends with passing tests and a deploy.

**M1 — Shell, auth, program, logging**
- Installs from Safari to Home Screen, opens standalone with the app icon, RTL Persian UI, light/dark.
- First-run setup with `SETUP_TOKEN` registers a passkey; login with Face ID; recovery code flow works.
- Program seed present; «جلسه‌ی بعدی» follows the cycle and the two-days-in-a-row rule.
- Log a full session in airplane mode; after reconnecting, data appears in D1 exactly once.
- Suggestions and last-performance display match Section 7.

**M2 — Photos**
- Upload 3 photos after a session on iPhone, including offline queueing; EXIF removed; thumbnails load fast; compare view works; delete works.

**M3 — Reports**
- Weekly and monthly reports render with correct numbers against a seeded fixture (unit tests for every metric, including Epley and week boundaries for all three week-start settings).
- PNG share card and CSV export work on iPhone.

**M4 — Apple Watch bridge**
- Token create/revoke; both endpoints accept the documented payload and messy Shortcuts text variants (fixtures).
- Matching attaches a watch workout to the right session; unmatched workouts can be attached manually.
- Settings page contains the full Shortcut instructions from Section 9.

**M5 — Import**
- Dry-run and import of `artifact-export.json` produce the expected sessions and sets; running the import twice creates no duplicates.

---

## 15. Open questions for Payam (defaults used until answered)

1. Frontend library: Preact (default) or React.
2. Domain: custom domain (recommended; passkeys are tied to it) or `*.workers.dev`.
3. Week start for reports: Saturday / Sunday / Monday (setting; default Monday).
4. Default weight unit: lb (default, US gym) or kg.
5. Timezone: America/Denver (default).
6. App name and icon.

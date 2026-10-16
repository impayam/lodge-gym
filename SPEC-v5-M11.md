# SPEC v5: M11, Visual redesign "Graphite Glass" + rename to "GYM time"

> Historical note (added 2026-10-16): the "Graphite Glass" look was replaced by the Pulse design (SPEC v8, design/pulse/). Only §6 (rename to "GYM time") is still valid.

Status: APPROVED choices by Payam on 2026-10-12 (dark only, uPlot, bundled fonts, new name). Build order: see §8.
Same CLAUDE.md working rules. If anything here conflicts with existing code or an earlier spec, stop and ask Payam.

Design reference: the Design artifact "Lodge Gym – Graphite Glass" (4 boards: Home, Active session, Reports, Palette & rules). Payam shares screenshots of it with you. The values below are the source of truth, not the screenshots.

This milestone changes **look only**. No change to data, API, D1 schema, R2, auth, offline or report math.

---

## 0. Payam's decisions
1. **Dark only.** Remove light theme. This supersedes SPEC v1 §3 ("light and dark themes") and every "light and dark screenshots" line in SPEC-v3 (M9, M10): those become dark-only screenshots.
2. **Charts with uPlot** (library), replacing hand-rolled SVG line/time charts. Supersedes SPEC v1 §2 "Charts: hand-rolled SVG".
3. **Fonts bundled in the app**: Sora (headings) + Manrope (body/numbers). Supersedes SPEC-v2 "Font: system font stack". Persian text (AI report, `dir="rtl" lang="fa"`) keeps the iOS system font.
4. **App display name: `GYM time`** (exact casing).

---

## 1. Dependencies (show `package.json` diff before installing)
| Package | Version (pin exact) | License | Use |
|---|---|---|---|
| `uplot` | `1.6.32` | MIT | Time-series charts |
| `@fontsource-variable/sora` | `5.3.0` | OFL-1.1 | Headings |
| `@fontsource-variable/manrope` | `5.3.0` | OFL-1.1 | Body |

Checked on npm 2026-10-12. Note: uPlot's latest release (1.6.32) is from March 2025; it is stable but not frequently updated.
- Import only the `latin` subset woff2 files. Self-hosted from the Worker's assets; no font CDN (CLAUDE.md rule stays).
- Add the font files and `uPlot.min.css` to the service-worker precache.
- Report the gzip size added to the JS bundle and to the precache.

---

## 2. Design tokens (`/web/src/styles/tokens.css`, CSS custom properties)
**Surfaces**
- `--bg: #16171A` (app background)
- `--surface: #1C1E22` (solid cards, chart canvas)
- `--raised: #25282D` (inputs, list rows, glass fallback)
- `--glass-bg: rgba(255,255,255,0.06)`
- `--glass-border: rgba(255,255,255,0.12)`
- `--glass-blur: 22px`

**Ink (text)**
- `--ink: #F2F3F5`, `--ink-2: #D7DAE0`, `--ink-muted: #A9ADB6`, `--ink-axis: #8C919B`

**Accents, fixed order (validated for color-blind separation on `#1C1E22`, dark mode; all checks pass)**
1. `--purple: #8B5CF6` — primary action, chart series 1
2. `--orange: #E8661A` — series 2, superset bracket
3. `--blue: #2F86E8` — series 3, rest timer
4. `--pink: #DB3F95` — series 4

**Status (always color + icon + label, never color alone)**
- Under target: `--orange`, icon ▼, ink `#F5A06B`
- On target (90–110%): `--blue`, icon ✓, ink `#7DB5F2`
- Over target (>110%): `--pink`, icon ▲, ink `#EE8CC0`
- Under = <90%. These bands are display-only; they do not change M10 adaptation thresholds (80%/120%).

**Shape and type**
- Radii: cards 24px, hero card 28px, buttons 16px, chips 999px.
- Headings: Sora 600–700. Body: Manrope 400–700. Numbers: `font-variant-numeric: tabular-nums`.
- Text never uses an accent color; the accent sits beside the value (dot, bar, icon).
- `<meta name="color-scheme" content="dark">`, `theme_color` and `background_color` = `#16171A`.

---

## 3. Glass rules
- `.glass` = `--glass-bg`, 1px `--glass-border`, `backdrop-filter: blur(22px) saturate(140%)` (plus `-webkit-` prefix), inset 1px top highlight, soft shadow.
- Glass only on: cards, bottom nav, sheets/modals, rest-timer pill. Never on list rows, set rows or inputs (solid `--raised`).
- Max 3 glass layers visible at once; no blur on elements inside a scrolling list.
- Background: 2–3 blurred accent "orbs" per screen, `opacity` 0.2–0.35, fixed (do not scroll-animate them).
- Fallback: `@supports not (backdrop-filter: blur(1px))` → solid `--raised`. Plus Settings toggle **"Solid cards"** (stored per device in localStorage, try/catch) that applies the same solid style.
- Contrast: all text ≥ 4.5:1 against the worst case (glass over an orb). Verify with an automated check in e2e (axe or equivalent) on Home, Session, Reports.

---

## 4. Screens (match the design boards)
- **Home**: date + "GYM time" title, Synced pill; next-session hero card (Plan + Start session); 3 stat tiles; Priority muscles bars (top 3 from M10 ranking, falls back to Chest/Quads/Shoulders until M10 exists); latest PR card; glass bottom nav (Home, Session, Library, Reports, Panel — Panel appears only once M10 exists).
- **Active session**: header (back, day name, elapsed, Finish); rest-timer glass pill with blue ring and +30 s; exercise card with MAIN badge, last/target line, Form video link; set rows 48pt high, current set highlighted purple, done check purple; superset card with orange left bracket, A1/A2/A3 labels and "round x of y".
- **Reports**: Week / Chart / Table segmented control; weekly volume card; e1RM chart card; AI report entry card.
- All other screens (Library, picker, planner, Settings, M9/M10 screens) adopt the tokens and glass rules; no layout changes beyond that.
- Tap targets ≥ 44pt everywhere.

---

## 5. Charts
**uPlot** for every time-series chart (e1RM per exercise, body weight, weekly volume trend, Library exercise history):
- One y-axis only. Never two y-scales.
- Lines 2px, `--purple`, `--orange`, `--blue`, `--pink` in that fixed order; a series keeps its color when others are filtered.
- Points shown only at the last value (≥8px, 2px `--surface` ring) with the value as a direct label.
- Grid `rgba(255,255,255,0.08)`, axis text `--ink-axis` 11px Manrope; no chart border.
- Legend for 2+ series (none for one series; the card title names it).
- Tap/hover: crosshair + tooltip (custom uPlot plugin) with date and values in `--ink`.
- Each chart has an `aria-label` summary and a **Table** view.
- Resize with the card width (ResizeObserver), respect `devicePixelRatio`.
- Wrap uPlot in one Preact component `/web/src/components/TimeChart.tsx` so screens never call uPlot directly.

**Weekly volume (per muscle vs target)** stays as an HTML/CSS horizontal bar list, not uPlot (uPlot is built for time series, not categorical horizontal bars):
- Bar 10px, rounded ends, filled with the status color; white 2px target tick; value "done / target"; status icon; scale 0–20 sets.
- Legend row: ▼ Under, ✓ On target, ▲ Over.

**Muscle map** (body figure from PR #3): keep geometry and proportions unchanged; recolor only (fills by status colors, outline `--glass-border`).

Remove the old hand-rolled SVG line-chart code once every usage is migrated.

---

## 6. Rename to "GYM time"
- Change every **user-visible** occurrence: `<title>`, `manifest.webmanifest` `name` and `short_name`, header/home title, Settings/About, export file names (e.g. `gym-time-export-YYYY-MM-DD.json`), any user-facing email/text.
- AI prompts (M9a/M9c): if they mention the app name, use "GYM time".
- **Do NOT change**: the Worker name, the `*.workers.dev` URL, the repo name, D1/R2 binding and database names, cookie names, IndexedDB database name, or the passkey RP ID. Changing the domain/RP ID breaks existing passkeys; changing the IndexedDB name would orphan offline data.
- New app icon: dark `#16171A` tile with a purple→pink element; 180, 192, 512 and maskable. Show Payam the icon before merge.
- Tell Payam in the report: the iPhone home-screen icon probably keeps the old name/icon until he removes it and adds it again from Safari (passkey and data are kept because the domain does not change). Verify this on the device rather than assuming.

---

## 7. Tests and acceptance
- Unit: status band function (<90 / 90–110 / >110) incl. edge values; TimeChart data mapping.
- E2E (WebKit iPhone profile): Home, Session, Reports render; contrast check passes; "Solid cards" toggle removes `backdrop-filter`; charts show Table view; offline reload still shows fonts and charts (precache).
- Visual: send dark screenshots of Home, Active session (with a superset), Reports, Library, Settings to Payam for approval before merge.
- Lighthouse/perf note: report bundle size before vs after.

## 8. Order
To be confirmed by Payam (see the message). Do not start M11 until Payam says which slot it takes.

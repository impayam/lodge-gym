# SPEC v8: "Pulse" redesign (replaces the look of M11 Graphite Glass)

Status: design approved by Payam on 2026-10-14 in the design canvas "GYM time — طراحی جدید". Items marked **CONFIRM** need his answer before you build them.
Same CLAUDE.md working rules. This milestone changes **look and navigation only**: no change to data, API, D1, R2, auth, offline or report math. If anything here conflicts with code or an earlier spec, stop and ask.

Still valid from SPEC v5 (M11): dark only, rename to **GYM time** (§6 there, same do-not-change list), uPlot for time-series charts, fonts self-hosted, no CDN.
Replaced from SPEC v5: palette, glass rules, fonts, Home/Session/Reports layouts, 7-tab bar.

---

## 1. What is in this folder

| File | Use |
|---|---|
| `tokens.css` | Every color, shadow, radius, font, spacing and motion value. Copy to `web/src/styles/tokens.css`. |
| `components.css` | The component library. Copy to `web/src/styles/components.css`. |
| `COMPONENTS.md` | How to use each component, with markup and do/don't. |
| `mockups/01-home … 07-coach.dc.html` | The approved screens. Open them in a browser to read layout, sizes and copy. They use a mockup runtime (`support.js`, `{{holes}}`, `<sc-for>`) that is NOT part of the app: rebuild them in Preact with the library; never copy the mockup runtime or its inline styles. |

## 2. Hard rules (so nothing is guessed)

1. No hex value, shadow, radius or font name outside `tokens.css` and `components.css`. Screens and components use the library classes and `var(--…)` only. Add a unit test that fails if any file under `web/src/` other than those two contains `#[0-9a-fA-F]{3,8}` (the effort color function returns values computed from the `--effort-*` tokens, read at runtime).
2. Screens use only the classes in `components.css` plus layout (flex, grid, gap). Need something new? Stop and ask Payam; then add it to the library first.
3. Buttons are never filled with an accent color. The fill is clay (dark, raised); the **text or icon** carries the color (pink = main action, orange = targets/coach, violet = data).
4. Small text never uses `--ink-decor` (#6F6F78 is 3.6:1). The mockups use it for captions; use `--ink-3` instead.
5. Sample numbers in the mockups are placeholders. Every number on screen comes from the existing app data and functions (e1RM, volume, targets, adherence). Nothing is hard-coded.
6. Persian text: `dir="rtl" lang="fa"` + `.fa` (system font). Numbers stay as the app shows them today.

## 3. Tokens and checked contrast

Contrast measured on 2026-10-14 (WCAG ratio):

| Text | On | Ratio |
|---|---|---|
| `--ink` #F2F2F4 | page | 16.0 |
| `--ink-2` #C9C9CF | clay | 9.1 |
| `--ink-3` #8F8F99 | page | ≥ 5.2 |
| `--pink` #FF4FA0 | clay / well | 4.9 / 6.1 |
| `--orange` #FF5A1F | clay | 4.8 |
| `--violet-ink` #B9A3FF | page | 8.3 |
| effort colors #A78BFA / #F472B6 / #FB923C | session card | 5.5 / 5.6 / 6.6 |

Chart colors passed the colorblind checker (dark mode): series order **orange, violet, pink**. Pink and orange must never be adjacent (they failed the normal-vision check together).

## 4. Fonts

- **Instrument Sans** (UI) and **Barlow Condensed** (big numbers and exercise titles), OFL. Self-host via `@fontsource` packages, latin subset, woff2, in the service-worker precache. Pin exact current versions and **show Payam the package.json diff before installing**.
- Persian: system font (`--font-fa`).
- Remove Sora/Manrope from M11 if they were added.

## 5. Navigation and gestures

- **Bottom bar: 5 icon-only tabs**: Train (home), History, Library, Reports, Me. `aria-label` on each. The active tab sits in a pressed-in well that slides (320 ms) to the tapped tab.
- **Me** holds what used to be separate tabs: Photos, Program, Planner, Settings (plus AI reports and Backup rows). **CONFIRM** (§9.1).
- **Coach button** (orange icon) on every tab screen; it opens the Coach screen full screen. Hidden during an active session. Since 2026-10-16 (Payam) it sits beside the tab bar, at its right end and centred on it, instead of floating above it, so it never covers content; the tab bar is shorter on those screens to make room.
- **Active session** is full screen: no tab bar.
- **Gestures (iOS-style):**
  - Swipe from the left edge (first 20 px) on any pushed screen (session report, exercise detail, Coach) = back. The visible back button always exists too.
  - In an active session: swipe left/right on the exercise card = next/previous exercise. The Prev and "Next: <name>" buttons always exist too.
  - Bottom sheets close with a swipe down or a tap on the scrim.
  - No swiping between tabs (it fights horizontal charts and the timeline).
  - Gesture follows the finger; release past 35% of the width (or a fast flick) completes, else it springs back.

## 6. Screens (match the mockups)

**01 Home (Train tab).** Header (date, "Today", Synced). Hero card: "Day N of <program>", exercise title big, minutes + exercise count, table Exercise / Last / Today (targets from the existing progression function, orange), main button "Start <day>" (pink text, `.btn-lg`). Estimated 1RM card: lift chips (segmented), current value + change, line chart (tap a point = crosshair + value + date). Coach button.

**02 Active session.** Back, day name, elapsed timer, effort chip, Finish. Effort progress bar. Exercise card: "Exercise n of N", title, "Last time …", form video button, set table (Set / Weight / Reps / Done). Current set highlighted; Done = clay button that sinks in with a check "pop" in the effort color. Grouped exercises (any 2–3, no warnings) show A/B/C labels and a violet side line. Rest timer pill slides up after a set: ring countdown, +30 s, Skip. Footer: Prev, "Next: <exercise>".
- **Effort colors:** e = sets done / sets planned this session. 0 → violet, 0.5 → pink, 1 → orange (linear mix). Applied to: background glow, effort chip and bar, check icons, ring, Next/Finish/+30 s text. Labels: Warming up / Working / All in.
- **CONFIRM** (§9.2–9.3): session background (purple-tinted as in the mockup, or the grey gradient of the other screens) and the effort definition.

**03 Reports.** Week / Month / All segmented. Training overview card (AI text, "Read full overview", "Regenerate"). Three stat tiles (sessions done/planned, bench %, squat %). Estimated 1RM chart, 3 series, legend with last values. Sets vs target bars (violet on target, orange under, white tick = target, chest first). Consistency calendar (5 weeks × 7 days: pink = trained, outline = planned and missed). Session reports list. *Changed 2026-10-16 (SPEC-v3, "a shorter Reports tab"): no overview card; tiles are sessions, new records and groups on target; one Main lifts card holds the chart and the period's 1RM table; AI reports (latest three, then All reports); details folded.*

**04 History.** Reports timeline (two rows: session dot, weekly-review square; tap a date → its reports below, as approved in M9d). Session cards: day number well, name, date, minutes, sets, top lift, PR badge.

**05 Library.** Exercise count, Body button (opens the existing 3D picker), search field (well), muscle chips, list rows: icon well, name, muscles, best number.

**06 Me.** Profile header. Body card (weight + trend, weekly sizes grid, "Log this week"). Progress photos (grid, Add photo, Compare two dates). Rows: Program, Planner, AI reports (cost), Backup and export, Settings.
- Weekly body sizes and photo compare are **new features with a data change**: not part of this milestone. Show the existing body weight only; leave the sizes grid out until its own spec (**CONFIRM** §9.4).

**07 Coach.** Full-screen chat. Header (back, "Coach", what it knows, New chat). User bubbles right; coach answers as text plus data cards (comparison table "Numbers calculated by the app from your logs", program draft with "Add to Planner" / "Change"). Typing indicator. Suggested questions (Persian chips). Composer: photo button, input, send.
- The chat backend is a separate milestone (M12). In this milestone build the screen shell only if Payam says so (**CONFIRM** §9.5); otherwise skip 07.

## 7. Motion and states

- Press: scale .96, 140 ms; clay buttons swap to the pressed shadow. Disabled: 40% opacity.
- Tab indicator 320 ms, sheet and rest timer 300 ms, ease `--ease-out`.
- One attention moment only: the Home main button may glow once on load (pink ring, 2.4 s, once). No other ambient animation.
- `prefers-reduced-motion`: all transitions and the pop/glow off.
- Every list and chart has loading (skeleton in card shape), empty (one line + action) and error (what failed + Retry) states.

## 8. Charts

- Time series (1RM, body weight): **uPlot**, styled to the mockups: 2 px lines, last point 9 px with a 2 px page-color ring, recessive grid (`--gridline`), axis text `--ink-3` 10–11 px, one y-axis only, legend with last values when 2+ series, tap = crosshair + tooltip. Each chart has `aria-label` with the summary and a Table view.
- Bars vs target and the consistency calendar: HTML/CSS (`.target-bar`), not uPlot.
- Status: under / on / over = orange / violet / pink, always with icon + label, never color alone.

## 9. CONFIRM before building

1. Tab merge: Photos, Program, Planner, Settings move into **Me** (5 tabs).
2. Session background: purple-tinted (mockup 02) or grey like the other screens.
3. Effort = share of the session's sets done (current), or based on RIR per set.
4. Weekly body sizes: separate milestone with its own SQL (show Payam first).
5. Coach screen: shell now, or wait for M12.

## 10. Tests and acceptance

- Unit: the no-hex test (§2.1); effort color function (0, 0.33, 0.5, 0.67, 1 → expected hex); tab indicator index mapping.
- E2E (WebKit iPhone + Chromium): every screen renders; tab switching; Start → session → Done → rest timer appears → Skip; edge-swipe back on a pushed screen; reduced-motion run; axe contrast check on all screens passes.
- Screenshots (iPhone, dark) of all screens next to the mockups, sent to Payam before merge, plus the milestone report per CLAUDE.md.
- Report the bundle size change and the font precache size.

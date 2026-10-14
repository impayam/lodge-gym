# Pulse component library — usage

Build every screen from these. Markup shows the intended HTML; write it as Preact components with the same classes.

## Buttons

```html
<button class="clay press btn-lg t-pink">Start Legs</button>          <!-- main action, one per screen -->
<button class="clay press btn t-muted">Change</button>                 <!-- secondary -->
<button class="clay press btn-sm t-orange">Log this week</button>
<button class="clay press btn-icon t-muted" aria-label="Back"><svg…/></button>
```
- Do: color on the text/icon. Don't: `background: var(--pink)` with white text.
- One `t-pink` main action per screen.
- Icon-only buttons always have `aria-label`. Minimum size 44×44.

## Card (box)

```html
<section class="card">
  <div class="card__head"><span class="card__title">Estimated 1RM</span><span class="caption">lb, 8 weeks</span></div>
  …
</section>
<section class="card card--hero">…</section>   <!-- the one big card on Home -->
```
- Cards never get borders. Their edge comes from `--sh-card`.
- Rows inside a card are separated by `1px solid var(--divider)`, not by nested cards.

## Pressed-in well

```html
<span class="well" style="border-radius: 14px">4</span>                  <!-- day number, icon holder -->
<label class="well composer">…<input>…</label>                          <!-- inputs and search -->
```

## Segmented control and chips

```html
<div class="segmented" role="tablist" aria-label="Period">
  <button role="tab" aria-selected="true">Week</button>
  <button role="tab" aria-selected="false">Month</button>
</div>
<button class="clay press chip" aria-pressed="false">Chest</button>
```

## Tab bar

```html
<nav class="tabbar" style="--i: 3">
  <span class="tabbar__indicator"></span>
  <a href="/" aria-label="Train">…</a>
  <a href="/history" aria-label="History">…</a>
  <a href="/library" aria-label="Library">…</a>
  <a href="/reports" aria-label="Reports" aria-current="page">…</a>
  <a href="/me" aria-label="Me">…</a>
</nav>
```
- Icons only (no labels), 24 px, 2 px stroke. Icon paths are in mockup 01 (`icons` object).
- `--i` = index of the current tab (0–4).
- The tab bar and the Coach button are `position: fixed`. `:root { overscroll-behavior-y: none }` keeps them in place on iOS: WebKit takes the page's rubber-band setting from the root element only (a value on `body` is ignored), and while the page bounces the fixed layer moves with it.
- `.page` ends 164 px (plus the safe area) above the bottom edge, so the last control of every screen clears both the tab bar and the Coach button (`tests/e2e/layout.spec.ts`).

## Coach button

```html
<button class="clay press fab" aria-label="Ask the coach"><svg…/></button>
```

## Active session pieces

```html
<div class="set-row set-row--current" style="--effort: #F472B6">
  <span class="big-num">2</span><span class="big-num">80</span><span class="big-num">5</span>
  <button class="press set-check" aria-pressed="false" aria-label="Complete set 2"></button>
</div>
<div class="rest" data-active="true" role="status" aria-live="polite">…</div>
```
- `--effort` is set once on the session root from `effortColor(e)` (unit-tested).

## Bars vs target

```html
<div class="target-bar">
  <span class="target-bar__fill" style="width: 45%; background: var(--status-on)"></span>
  <span class="target-bar__tick" style="left: 65%"></span>
</div>
```
- Scale 0–20 sets. Fill color from the status function: `--status-under` / `--status-on` / `--status-over`, with the numbers "done / target" beside it.

## Chat

```html
<div class="msg-user fa" dir="rtl" lang="fa">…</div>
<div class="msg-coach"><p class="fa" dir="rtl" lang="fa">…</p><section class="card">…data card…</section></div>
<label class="composer">…</label>
```

## Additions (approved by Payam, 2026-10-14, CONFIRM C)

Built from existing tokens only; each is in `components.css` under "Additions".

```html
<header class="page-head"><div><h1 class="h-page">Me</h1><span class="page-head__sub">Training since Sep 27</span></div></header>
<header class="screen-head"><button class="clay press btn-icon t-muted" aria-label="Back">…</button><h1 class="screen-head__title">Coach</h1></header>

<section class="card card--list">                                   <!-- rows inside a card, divider between -->
  <button class="list-row press"><span class="well icon-well t-pink">…svg…</span>
    <span class="list-row__text"><span class="t-title">Program</span><span class="caption">Full body, active</span></span>
    <span class="list-row__chevron">…</span></button>
</section>

<span class="big-num big-num--40">180.2<span class="big-num__unit"> lb</span></span>   <!-- sizes 54/40/34/30/26/22/18 -->
<button class="clay press btn btn--fit t-pink">Add photo</button>     <!-- two buttons side by side in a card -->
<div class="pushed">…pushed screen…</div>                            <!-- edge-swipe back container -->
<p class="state">No photos yet…</p> <span class="skeleton skeleton--line"></span>   <!-- empty / loading -->
<div class="chart" role="img" aria-label="…">uPlot</div> <div class="chart-legend">…</div> <table class="data-table">…</table>
<button class="photo-thumb press"><span class="photo-thumb__frame well"><img alt=""></span><span>Oct 13</span></button>
<div class="coach-dock"><div class="chip-scroll">…chips…</div><div class="composer"><input class="composer__input"></div></div>
```
- `--danger` (#FF6B6B) and `.t-danger`: destructive actions only, always with a text label and the confirm dialog.
- `--model-*` and `--share-*`: the 3D model and the shared report image, values unchanged from the pre-Pulse app.

### Active session (plan step 4)

```html
<div class="page page--session" style="--effort: #F472B6; --e: .5" data-resting="false">   <!-- set from effortColor(e) -->
  <div class="session-glow" aria-hidden="true"></div>
  <header class="screen-head">… <span class="effort-chip">Working</span> <button class="clay press btn t-effort">Finish</button></header>
  <div class="effort-bar" role="progressbar" aria-valuenow="50"><span class="effort-bar__fill"></span></div>
  <div class="swipe"><article class="card card--session card--grouped">                 <!-- --grouped: violet side line -->
    <span class="ex-card__kicker">Exercise 5 of 6 · 3 × 12</span><span class="ex-card__group">A1 · Superset A</span>
    <h2 class="big-num big-num--36">Lateral Raise</h2>
    <span class="ex-card__meta">Last time …</span><span class="ex-card__suggest">Suggested: 140 lb</span>
    <a class="btn-icon btn-icon--soft press" aria-label="Form video: …">▶</a>
    <div class="set-head"><span>Set</span><span>Weight lb</span><span>Reps</span><span>Done</span></div>   <!-- set-head--timed / set-row--timed: 3 columns -->
    <div class="set-row set-row--current"><span class="set-row__n">1</span>
      <button class="set-value press" data-suggested="true">140</button><button class="set-value press">5</button>
      <button class="set-check press" aria-pressed="false" aria-label="Set 1 done"></button></div>
    <div class="rir-row" role="group"><span>RIR</span><span class="segmented"><button aria-pressed="false">0</button>…</span></div>
    <p class="ex-card__cue">…</p>
  </article></div>
  <footer class="session-foot"><button class="clay press btn-icon btn-icon--lg">‹</button><button class="clay press btn-lg t-effort">Next: …</button><button class="clay press btn-icon btn-icon--lg" aria-label="More">…</button></footer>
</div>
<div class="rest" data-active="true" data-over="false" role="timer">
  <svg class="rest__ring"><circle class="rest__track"/><circle class="rest__arc"/></svg>
  <div class="rest__text"><span class="rest__label">Rest after …</span><span class="big-num big-num--30">1:30</span></div>
  <button class="clay press btn t-effort">+30 s</button><button class="rest__skip press">Skip</button></div>

<div class="scrim" data-open="true"></div>
<div class="sheet" open role="dialog"><div class="sheet__head"><span class="sheet__grabber"></span><h2 class="sheet__title">…</h2></div>…</div>

<div class="form-field"><label class="form-field__label" for="f">Note</label><textarea class="input" id="f"></textarea></div>
<div class="num-stepper"><button class="clay press">−</button><input class="num-stepper__input well"><button class="clay press">+</button></div>
```
- `--effort` and `--e` are set on the session root (and on the rest pill) from `effortColor(e)`; nothing else sets a colour.
- Session buttons use the purple clay of `.set-check` (same values) on the session background and in the rest pill.
- `.segmented > button[aria-pressed]` is the toggle form of the segmented control (RIR, unit).
- `.rest` is hidden from touch and screen readers when closed (`visibility` after the slide); `data-over` is the visual cue when rest is over.
- `.input` text is 16 px so iOS does not zoom on focus.

### Reports (plan step 5)

```html
<div class="l-grid-3"><div class="card card--tile"><span class="big-num big-num--26">4</span><span class="caption">Sessions</span></div>…</div>
<div class="bar-row"><span class="bar-row__label">Chest</span><span class="target-bar"><span class="target-bar__fill"></span><span class="target-bar__tick"></span></span><span class="bar-row__value"><b>12</b><span class="bar-row__of"> / 14</span></span></div>
<div class="chart-readout" aria-live="polite">Week of Oct 6: 3 sessions</div>
<div class="columns" role="group" data-picked="true"><span class="columns__target"></span><button aria-pressed="true"><span class="columns__bar"></span></button>…</div>
<div class="calendar"><span class="calendar__head">M</span>…<span class="calendar__cell" data-trained="true"></span>…<span class="calendar__count">3</span></div>
<div class="callout" data-bad="false"><h3 class="card__title">…</h3><p class="prose-fa fa" dir="rtl" lang="fa">…</p></div>
<div class="stage"><div class="stage__canvas"><canvas></canvas></div><div class="stage__top">…</div><span class="stage__hint">Drag to turn.</span><div class="stage__card">…</div></div>
<div class="body-figures"><figure class="body-figure"><svg>…<path class="body-region" data-status="under"/>…</svg><figcaption>Front</figcaption></figure></div>
<ol class="balance-list"><li><span>Muscle</span><span>Sets</span><span>Status</span></li><li data-status="on">…<span class="balance-list__status">On target</span></li></ol>
```
- Columns are HTML, not uPlot (SPEC-v8 §8); one series in `--series-2`, the target as a dashed line explained in words under the chart.
- Muscle status is never colour alone: under and over are striped textures, and the list names the status.

### History (plan step 6)

```html
<h3 class="section-label">October 2026</h3>
<div class="timeline"><div class="timeline__lanes"><span></span><span>Sessions</span><span>Weekly</span><span></span></div>
  <div class="timeline__scroll"><div class="timeline__cols">
    <button class="timeline__col" aria-pressed="false"><span class="timeline__month">Oct</span><span class="marker marker--session"></span><span class="marker marker--review"></span>
      <span class="timeline__date"><b>13</b>Tue</span></button>…</div></div></div>
<div class="timeline__chooser"><button class="clay press timeline-item"><span class="marker marker--overview"></span>…</button></div>
```
- Markers differ by shape as well as colour (dot, square outline, diamond), and every item has a text label.

### Library (plan step 7)

```html
<label class="search-field well"><svg>…</svg><input class="search-field__input" type="search" placeholder="Search exercises"></label>
<div class="chip-wrap"><button class="clay press chip" aria-pressed="true">Chest</button>…</div>          <!-- chip--lg: the picker's body parts -->
<button class="card press ex-row"><span class="well icon-well icon-well--52 t-pink">…</span><span class="list-row__text">…</span>
  <span class="ex-row__side"><span class="big-num big-num--22">166</span><span class="caption">est. 1RM</span></span></button>
<span class="well icon-well icon-well--off">…</span>                                                  <!-- not logged yet -->
<div class="stage stage--picker">…</div>
<div class="media-pair"><div class="media-frame well"><img alt=""></div>…</div>
<ol class="prose-list"><li>…</li></ol>
<fieldset class="form-field"><legend class="form-field__label">Secondary muscles</legend><div class="chip-wrap"><label class="check-chip"><input type="checkbox">Lats</label>…</div></fieldset>
<label class="clay press btn btn--fit t-muted file-pick"><input type="file" accept="image/*">Choose photo</label>
```
- `.ex-row__main` is the tappable part of a row that also holds another button (the form video in the body picker).
- `.file-pick` hides the native file control inside a clay button; the chosen file name is shown beside it.

### Screens without a mockup (plan step 10)

```html
<header class="screen-head"><button class="clay press btn-icon t-muted" aria-label="Back">‹</button>
  <div><span class="screen-head__sub">Me</span><h1 class="screen-head__title">Settings</h1></div></header>   <!-- every pushed screen -->
<span class="select-field"><select class="input">…</select><svg>chevron</svg></span>
<ul class="list-plain">…</ul>                                                        <!-- rows carry their own layout -->

<div class="plan-list">                                                              <!-- planner, session Reorder and group -->
  <div class="card plan-item" data-dragging="true"><div class="plan-item__row">
    <span class="plan-handle" role="img" aria-label="Drag to move …">⋮⋮</span>
    <label class="plan-select"><input type="checkbox"></label>                       <!-- grouped rows: <span class="plan-tag">A1</span> -->
    <button class="plan-name"><b class="t-title">…</b><span class="caption">3 × 8–12 · rest 90 s</span></button>
    <span class="plan-move"><button class="clay press">↑</button><button class="clay press">↓</button></span></div>
    <div class="plan-edit">…<div class="num-stepper num-stepper--sm">…</div>…</div></div>
  <div class="plan-group"><div class="plan-group__head">…</div>…<div class="plan-group__foot">…</div></div>
</div>
<div class="card plan-groupbar">2 selected <button class="clay press btn-sm t-pink">Group as superset</button></div>

<button class="photo-thumb press" aria-pressed="true">…</button>                    <!-- picked for compare -->
<img class="photo-full"> <div class="photo-overlay well"><img><img style="clip-path: …"></div> <input class="range" type="range">
<table class="data-table data-table--text">…</table>                                 <!-- words, left aligned -->
<div class="week-strip"><span data-on="true">Day 1</span><span>Rest</span>…</div>
<main class="page gate"><img class="gate__logo"><h1 class="h-page">GYM time</h1>…</main>   <!-- sign-in gates -->
<div class="well gate__codes"><span>XXXX-XXXX-XXXX</span>…</div> <input class="input input--code">
<p class="fa prose-fa prose-fa--clamp" dir="rtl" lang="fa">…</p>                     <!-- a long review until Show more -->
```
- The plan list's group is pressed in with the violet side line of `.card--grouped`; in the session its rows use the session card fill and purple clay.
- `.plan-groupbar` sticks above the tab bar (in the session, above the bottom edge).
- `.week-strip` training days are pressed in with pink text (6.1:1); rest days stay flat with `--ink-3`.

### Loading, empty and error states (plan step 11)

Every list and chart uses `web/src/components/States.tsx` (no new classes):
- `<Loading>`: card-shaped `.skeleton` blocks in the size of what is coming, `role="status"` with a label.
- `<Empty>`: one `.state` line on what is missing, with a `clay btn-sm t-muted` button for the action when the screen has one.
- `<LoadError>`: `.state` with what failed (`t-orange`), the reason ("No internet connection." or the server's message) and Retry.
- A list that still has a saved copy keeps it on screen with the caption "Offline: showing the last saved copy." (or "Couldn't refresh: …").

## Don't

- No new colors, no gradients other than the page background, clay and card fills.
- No glass/blur except the rest timer pill.
- No ALL-CAPS labels, no emoji, no borders on cards.
- No animation that is not in SPEC §7.

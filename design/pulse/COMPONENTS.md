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

## Don't

- No new colors, no gradients other than the page background, clay and card fills.
- No glass/blur except the rest timer pill.
- No ALL-CAPS labels, no emoji, no borders on cards.
- No animation that is not in SPEC §7.

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

## Don't

- No new colors, no gradients other than the page background, clay and card fills.
- No glass/blur except the rest timer pill.
- No ALL-CAPS labels, no emoji, no borders on cards.
- No animation that is not in SPEC §7.

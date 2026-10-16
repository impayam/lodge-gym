# SPEC v10: M13, Training calendar + work shifts + free-slot planning

Status: scope and all open questions APPROVED by Payam on 2026-10-15. **STOP** items still need his OK before you continue.
Same CLAUDE.md working rules. Build **after M12 (Coach) is merged**, on a new branch from `main`. UI only from the Pulse library (`tokens.css`, `components.css`); anything missing: stop and ask.

Payam's decisions (2026-10-15):
1. Work hours **change every week** (shifts): he enters each week's shifts himself. No Google Calendar import.
2. The Coach **suggests** gym times; nothing goes on the calendar without his tap.
3. **Reminder notification** before each planned gym session.
4. Built after M12 (M12 is live).
5. Calendar lives at the **top of the Home (Train) screen**; tapping it opens the full calendar.
6. Shifts float (different every week), usually ending around 20:00, never after midnight. Shifts are same-day only (end > start, end ≤ 24:00).
7. Gym hours (his gym): Mon–Fri 04:00–24:00, Sat 05:00–22:00, Sun 07:00–16:00.
8. Defaults accepted: travel buffer 20 min each way, 30 min after a shift, reminder 60 min before. All editable in Settings.

---

## 1. What Payam gets

**Week view (one screen, swipe or ← → between weeks).** 7 day columns, 04:00–24:00 time axis (the gym's widest hours; scrolls to the current time), showing:
- **Work shifts** (grey blocks, label "Work").
- **Planned gym sessions** (pink outline block: program day name, time).
- **Done sessions** (pink filled, from the real session log; duration = real start/end).
- **Missed** planned sessions (outline only, after the day ends with no session).
- **Free slots** that fit a gym session (violet dotted, only when "Show free times" is on).

A month strip above (dots per day: trained / planned) for quick navigation. Tapping a day opens its list.

**Add shifts fast.** "Add shift" sheet: day chips (multi-select), start, end, note. "Copy last week" fills the new week with last week's shifts so he only edits what changed. Edit or delete a shift by tapping it.

**Plan a gym session by hand.** Tap an empty time → "Plan gym here" → picks the next program day automatically (same order rule as Home), length = that day's estimated minutes. Drag to move (or edit sheet with time pickers — accessible alternative).

**Find free times (no AI).** "Find times for this week" → the app lists the free slots that fit the rules (§3) and pre-selects the best ones up to the program's days per week. Payam taps **Add** on each, or **Add all**.

**Coach (M12 tools).** Payam can ask: «این هفته کِی برم باشگاه؟». The Coach reads shifts, plans and free slots through tools and answers with a **schedule card** (one row per suggested session: day, time, program day, reason) with **Add to calendar** / **Change**. Nothing is saved without the tap.

**Reminder.** A push notification **N minutes before** each planned session (default 60, editable in Settings), text: "Gym in 1 hour: Day 3 · Back, 17:30". Uses the existing rest-timer push setup (works from the Home Screen app on iPhone). Moving or deleting a plan moves or cancels its reminder.

## 2. Where it lives (decided)
- **Home (Train) screen, at the top, above the next-session hero card:** a compact **week strip** (7 day chips Mon–Sun: date, a small grey bar if there is a shift, a pink outline dot for a planned session, a pink filled dot for a done session; today highlighted). One line under it: next planned session ("Next: Thu 17:30 · Day 3 · Back") or "No gym time planned this week — Find times".
- **Tap the strip** → opens the full **Calendar** screen (pushed screen with Back and edge-swipe back) with the week view (§1). No new tab; the tab bar stays 5 tabs.
- The Home hero card and Start button are unchanged; if a session is planned today, the hero card shows its time.

## 3. Free-slot rules (pure function, unit-tested, used by the screen AND the Coach tool)

`findFreeSlots(week, shifts, plans, sessions, settings) → slots[]`. The model never computes times itself.

A slot is valid when all are true:
1. Fits the session length: next program day's estimated minutes (from the existing estimator) + **travel buffer** before and after (default 20 min each, editable).
2. Inside **gym hours** per weekday (defaults = his gym: Mon–Fri 04:00–24:00, Sat 05:00–22:00, Sun 07:00–16:00; editable per weekday in Settings). The whole session incl. travel must fit before closing.
3. Not overlapping a shift, an existing plan or a done session, including a **gap after a shift** (default 30 min, editable).
4. Respects the program rule "no more than two training days in a row" (existing rule).
5. Optional **preferred windows** (e.g. weekday evenings): preferred slots are ranked first.
6. Not in the past.

Ranking: preferred window → spreads sessions across the week (max one per day) → earlier time on the day. Pre-select up to `days_per_week − sessions already done or planned this week`.

## 4. Data (new tables only) — STOP: show Payam the SQL before applying

Proposal (`migrations/0012_calendar.sql`):
- `work_shifts(id, date, start_min, end_min, note, created_at, updated_at)` — local date, minutes from midnight, same-day only (CHECK end_min > start_min AND end_min <= 1440).
- `gym_plans(id, date, start_min, end_min, program_day_id, source ('manual'|'finder'|'coach'), session_id NULL, status ('planned'|'done'|'missed'|'cancelled'), reminder_at, created_at, updated_at)` — `session_id` links the real session when he trains that day (closest plan of that date); `missed` is set after the day ends with no session.
- Settings rows (existing settings store): `gym_hours`, `travel_buffer_min`, `after_shift_gap_min`, `preferred_windows`, `reminder_minutes`.
- Nothing else changes. Deleting a plan or shift is a real delete (they are plans, not history); done sessions are never touched.
- Offline: shifts and plans are created offline through the existing outbox and sync later; free-slot finding works offline (pure function on local data).

## 5. Rules that do NOT change
- Planned-session count for reports and the motivation line stays as today (program days per week, option A). The calendar does not change adherence math.
- Program day order is unchanged: a plan shows the next program day, but if he trains a different day, the log wins and the plan is linked as done.
- No deloads/light weeks; the finder never removes sessions to "rest".

## 6. Coach tools (added to M12's tool list)
- `get_calendar(from, to)` → shifts, plans (with status), done sessions, at most 31 days.
- `find_free_slots(week_start)` → the result of §3 for that week (same function).
- `propose_schedule(sessions[])` → schedule card (date, start, end, program_day_id, reason_fa); validated: each item must be one of the slots returned by `find_free_slots` for that week, else dropped and reported. **Add to calendar** creates `gym_plans` with `source='coach'`.
- System prompt addition: use only these tools for times; never invent a time; explain choices in one short line each.

## 7. Library and design
- Home week strip, week grid, shift block, plan block, free-slot block and the schedule card are new library components (existing tokens only: work = `--ink-3` on well, plan = `--pink` outline, done = pink fill, free = `--violet` dotted). **STOP:** show Payam a screenshot of the week view before building the rest.
- Time grid 44 pt minimum touch rows; every block has an accessible label ("Work, Tuesday 07:00–15:30"); a **List view** of the week as the accessible alternative (like Table view on charts).
- Loading / empty ("No shifts this week — Add shift / Copy last week") / error with Retry, as in step 11.

## 8. Tests
- Unit: `findFreeSlots` (shift overlap, buffers, gym hours, two-days-in-a-row rule, past times, ranking, week boundaries, DST change week); plan ↔ session linking; missed status.
- Worker: Coach tools mocked model; `propose_schedule` drops slots not from the finder.
- E2E (WebKit iPhone + Chromium): tap the Home week strip → Calendar opens → add shifts → Copy last week → Find times → Add all → plans appear → reminder scheduled (mocked push) → start session that day → plan shows done; offline add shift → sync.
- Screenshots (iPhone, dark): Home with the week strip, week view with shifts/plans/free slots, add-shift sheet, find-times result, Coach schedule card, list view, empty state.

## 9. Report
Per CLAUDE.md, in Persian, with screenshots and test totals. No merge, no deploy without Payam's OK.

## 10. Also in this milestone (small, from M12)
- `get_training_pattern` (M12) and the Coach spacing checks switch from the 4-week pattern to real calendar dates when plans exist for that week (M12 note 2c).
- Full e2e suite on the final commit before merge (no exceptions); D1 restore point before the migration; production check report in Persian.

---

## Change by Payam, 2026-10-15 (after the M13a STOP review; replaces §3 rule 4 and the free-time default question)

Goal: he only enters his shifts. The app suggests the best gym time by itself, with no setup. Settings are optional,
only if he wants to change something.

1. **Nothing ever blocks him.** He can plan, move or delete a session on any day and time (7 days in a row is fine).
   The "two days in a row" rule is **not a filter**: a slot is never hidden because of it. It only affects ranking
   (spread-out slots first) and may show a small neutral note. Same for the Coach: advice only. No "not allowed"
   messages anywhere.
2. **Built-in defaults** (editable in Settings, but they must work well untouched):
   - wake_time = 07:00; earliest suggested start = 08:00.
   - The gym session ends at least 60 min before a shift starts.
   - Rest after a shift: 30 min; after a long shift (>= 8 h) 90 min.
   - On long-shift days, a slot before the shift ranks first when one fits.
   - Within gym hours, as already built.
3. **Find times** shows one best suggestion per day (best first), pre-selects the best ones for the week, and he just
   taps **Add** / **Add all**.

Unit test example: shift 12:00–20:00 → suggested 08:00–09:00.

Settings rows (written only when changed): `gym_hours`, `travel_buffer_min`, `wake_time_min`, `earliest_start_min`,
`before_shift_gap_min`, `after_shift_gap_min`, `long_shift_gap_min`, `long_shift_min`, `preferred_windows`,
`reminder_minutes`.

## Change by Payam, 2026-10-16 (M13 review)

- **Find times** lists the days in date order. The finder still ranks them, and the best ones for the week stay ticked.
- A block's label on the week grid never shows cut: it hides once the rest of the scrolled block is too short to hold it.

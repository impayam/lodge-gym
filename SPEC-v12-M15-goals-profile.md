# SPEC v12 — M15: Goals, Profile, no time limit

Status: approved direction by Payam (2026-10-17). Plan first, STOP before building.
No mockups are provided. Claude Code designs the screens itself (Pulse design system, SPEC v8) and shows Payam iPhone mockups/screenshots for approval before building the UI.
Design: Pulse (SPEC v8). English UI.

---

## 1. Session length never limits the program

1. Remove session length as a constraint everywhere (generator, Settings "session length", New program). Nothing blocks or shrinks a program because of minutes.
2. The generator plans by evidence only: weekly sets per muscle/region, region coverage rules (M14 Phase B) and recovery. Limit is volume, not time (diminishing returns above ~20 hard sets per muscle per week).
3. Estimated duration per day is shown as information only ("about 70 min").
4. Order inside a day by importance: main lift → secondary → region/isolation work.
5. Cardio is separate: it never shortens or changes the lifting program.
6. The Coach never uses session time as a reason to cut exercises.

## 2. Goals

### 2.1 Two parts
- **Training goal** (ACSM categories), pick 1 or 2: **Growth**, **Strength**, **Endurance**, **Power**. Any combination is allowed; the Coach balances it (e.g. Growth + Endurance = moderate reps on main lifts, high-rep near-failure sets on accessories).
- **Body goal**, pick 1: **Gain**, **Maintain**, **Cut**.

### 2.2 What the goal changes
| Goal | Generator / Coach effect |
|---|---|
| Growth | Most sets ~6–15 reps near failure; full region coverage; dumbbell/cable for regions |
| Strength | Main lifts heavier, ~3–6 reps, longer rest; barbell main lifts |
| Endurance | Accessories ~15–25+ reps, shorter rest |
| Power | (open decision, see §6) |
| Gain / Maintain / Cut | Lifting stays; cardio amount changes (more for Cut); later nutrition |

Rep ranges are guides, not hard rules (growth happens across a wide rep range when sets are near failure). Claude Code: confirm the numbers with sources in the plan.

### 2.3 Changing the goal
Changing the goal never changes the program by itself. The Coach proposes a new program (draft); it applies only on Payam's approval.

### 2.4 Where goals are set (Payam, 2026-10-17)
- A clearly labelled **"Set goal"** button on the My goal card in Profile (not "Edit"). It opens the **Set goal** screen: training goal diamond (pick 1–2) + body goal (Gain / Maintain / Cut) + Save.
- Before any goal is set, the My goal card shows only the empty diamond and the "Set goal" button.

### 2.5 Goal picker UI
"Model B" diamond: 4 corners (Growth top, Strength right, Endurance bottom, Power left). Tap to select 1–2; the shape between selected corners glows. Body goal: 3 chips under it (Gain / Maintain / Cut).

## 3. Profile tab
- Rename tab **Me → Profile**. Everything now in Me (Program, Photos, Planner, Settings) moves behind a gear button top-right of Profile. Nothing is removed.
- Page order:
  1. **After-session line** — one short line after a session: which muscles lit up, any new record, regions trained this week (e.g. "After today: chest lit up, new record on Bench Press 92 kg. 27 of 30 regions trained this week.").
  2. **My body** — For this milestone REUSE the app's existing 3D body model and 3D muscle map (SPEC v6 M9b-3D) exactly as they are — do NOT create, draw or generate a new body model or figure; the new body style (dark glossy body, thin glowing lines on muscle boundaries, glow fill) is a separate later design step and needs Payam's approval of a design first. Muscles trained today glow pink, this week violet, others dark. Latest body sizes shown next to the body part with change since the previous entry (e.g. "Arm 38.5 ▲0.5"). "Log sizes" button. Under it the body goal line: badge (GAIN/HOLD/CUT) + weight + change + one plain sentence (e.g. "78.4 kg · +1.2 kg in 6 weeks. Right on pace for Gain.").
  3. **My goal — Living Diamond**: the same diamond; each corner stretches out with that goal's progress; dashed ghost = 4 weeks ago; selected goals glow and pulse. Tap a corner → details panel opens under it; tap again → closes.
  4. **This week** — the Reports tiles in one compact row: Sessions, New records, Groups on target.
  5. **AI reports** — the existing AI reports card + "All reports" page (unchanged).
  6. **Before · After** — two progress photos (guide camera) with a drag handle to compare.
  7. **Details** (closed by default) — everything else that is in Reports today (volume table, charts), unchanged.

### 3.1 Reports merges into Profile (Payam, 2026-10-17)
- The **Reports tab is removed**; all its content lives in Profile. Tabs become 4: Train, Calendar, Library, Profile (+ Coach button).
- No duplicates: the muscle map exists only in My body; the Main lifts card is replaced by the Strength corner of the diamond (its details panel lists each main lift with e1RM and change, and links to the full lift chart).
- Nothing from Reports is lost; list in the plan where each Reports item ends up.

### 3.2 One shared 3D body (Payam, 2026-10-17)
- Every place in the app that shows the body (Profile "My body", muscle map, share images, any future screen) must use **one shared 3D body component** — single source of truth. No screen keeps its own copy or its own body drawing.
- Reason: the 3D body will be redesigned later (dark glossy body, glowing muscle-boundary lines) and will later change with the user's level (beginner / amateur / pro) and grow with training ("living body" in the roadmap). When that happens, changing the shared component must update every screen automatically, with no per-screen code changes.
- In the plan: list every current place that renders the body/muscle map and how it will be moved onto the shared component. Level and growth are NOT built in this milestone.

## 4. Body measurements log
- Log any time, no schedule, no reminders, no rules. Fields: arm, chest, waist, hips, thigh, calf, neck, shoulders (all optional; cm). One entry = date + any subset.
- New D1 table — show migration SQL first.
- Used by My body, Growth details and the Coach.

## 5. Progress numbers (what each diamond corner measures)
| Corner | Measure (from existing data unless noted) |
|---|---|
| Strength | Sum of estimated 1RM of main lifts; details list each lift + change |
| Growth | % of the 30 regions trained this week + body size changes (needs §4) |
| Endurance | Best reps at the same weight on high-rep sets |
| Power | Not measurable from sets and weights alone (open decision) |
| Body (center) | Body weight trend vs body goal pace |

Each corner's length = normalized progress vs a baseline; Claude Code proposes the normalization in the plan.

## 6. Open decisions (STOP — ask Payam)
1. Power: add a simple jump test later, or show "no data" for now?
2. Body goal pace targets (kg/week for Gain and Cut) — propose numbers with sources.
3. Diamond normalization: how "full corner" is defined per goal.
4. Does Home keep any goal summary, or only Profile?

## 7. Not in this milestone
- Supplements & vitamins log (queued separately).
- Nutrition / recipes.

## 8. Process
- Plan first (generator changes, Coach prompt changes, UI, migration SQL). STOP for Payam's review before building.
- Then branch → tests (npm test, typecheck, full e2e) → draft PR with iPhone screenshots → STOP before merge.
- D1 restore point before merge. No merge, deploy or production migration without Payam's OK.

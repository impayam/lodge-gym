# SPEC v9: M12, Coach chat (backend + full screen)

Status: scope APPROVED by Payam on 2026-10-14: free questions, program writing, photo analysis, saved conversations, a professional coach who knows all training methods. Cost: **show only, no cap**.
Same CLAUDE.md working rules. Points marked **STOP** need Payam's OK before you continue.
Build **after PR #12 (Pulse) is merged**, on a new branch from `main`. The Coach screen shell from Pulse (mockup 07, decision E) is the UI; this milestone connects it.

---

## 1. What Payam gets
- Coach button (FAB) → full-screen Coach chat (Pulse mockup 07, library classes only).
- He can ask anything about training, nutrition basics, technique, programs, his own progress, in Persian or English. Answers in Persian (RTL) unless he writes in English.
- Answers about **his own data** come with **data cards** (tables/charts) whose numbers are computed by the app, captioned "Numbers calculated by the app from your logs".
- He can ask for a **program**; the coach returns a **program draft card** with **Add to Planner** / **Change**. Nothing is saved to his program without his tap.
- He can attach a **photo** (camera or library, or pick one of his progress photos) and ask about it.
- Conversations are **saved**: a list of past chats, open any, continue it. **New chat** starts a fresh one.
- Under each coach answer: small caption with the cost of that answer. Me → AI reports row shows "This month: Coach N messages, ~$X" next to the existing report costs.

## 2. Model and key
- Same Worker secret `ANTHROPIC_API_KEY` (already set). No new key. Never sent to the client, never printed or read in logs.
- Model from config `COACH_MODEL`, default `claude-opus-5-5`. Effort from `COACH_EFFORT`, default `medium`. `COACH_MAX_TOKENS` default 4000. Changeable without a code change.
- **Streaming** (Messages API SSE) through the Worker to the client, so text appears while it is written. Typing indicator until the first token.
- Prompt caching on the system prompt and tool definitions (lower cost on every message).
- No fallback model. If the call fails: the user message stays, an error line "Answer failed — Retry" appears under it.

## 3. The coach's knowledge and rules (system prompt)
**STOP:** show Payam the full system prompt text before building on it.

The prompt must say:
- You are an experienced strength and hypertrophy coach. You know the established training methods and when each fits: progressive overload, linear/double/undulating/block periodization, RIR/RPE autoregulation, volume landmarks, supersets/tri-sets/giant sets, drop sets, rest-pause, myo-reps, clusters, tempo and pauses, unilateral work, exercise selection by muscle length/region, technique cues for the main lifts, warm-up ramps, recovery and sleep, basic nutrition for muscle and strength.
- Explain the reason behind advice. When evidence is mixed or weak, say so plainly. Never invent studies, numbers or sources.
- Facts about **Payam's own training** come only from the tools (§4). If a tool has no data, say there is no data. Never guess his numbers.
- Payam's standing preferences (from earlier specs): strength and balance; chest is the current priority; **no deloads, light weeks or intro weeks** unless he says he is tired; he may group any 2–3 exercises and his groups are never criticised; progression rules of the app (+5 lb upper, +10 lb lower, +5 lb per dumbbell, RIR rules); every program change needs his tap.
- No medical diagnosis. With pain or injury: suggest rest and seeing a professional.
- Honest, direct, no flattery.

## 4. Tools the model can call (read-only, server-side)
All numbers are computed by existing app functions (same math as Reports). Each tool result is also what the client renders as a data card.

| Tool | Returns |
|---|---|
| `get_sessions(from, to)` | sessions with day, date, duration, done sets (exercise, weight, reps/seconds, RIR, is_extra), notes |
| `get_e1rm_history(exercise_id, weeks)` | e1RM points (Epley, existing function) + % change |
| `get_volume(from, to)` | fractional sets per group vs T2 targets, status under/on/over |
| `get_adherence(from, to)` | planned vs done sessions (option A count, existing function) |
| `get_prs(exercise_id?)` | PRs by the existing PR rule |
| `get_program()` | active program, days, exercises, sets/reps/rest |
| `get_library(muscle?, equipment?)` | exercises: id, name, equipment, primary/secondary muscles, category |
| `get_body_weight(weeks)` | body weight entries + trend |
| `get_photos(pose?, from?, to?)` | list of his progress photo ids with date and pose |

**STOP:** show Payam the final tool list and their JSON shapes before building.

**Write tool (needs a tap):** `propose_program(draft)`: days → exercises (`exercise_id` must exist in the library, else the item is dropped and the coach is told), sets, reps, rest, optional groups. Zod-validated. Rendered as the program draft card. **Add to Planner** creates a new inactive program (or a planner draft) — never overwrites the active program; activating stays a separate tap in Program. **Change** puts "Change this draft: " in the composer.

## 5. Photo analysis
- Attach from camera/library or choose a progress photo. Client processing as SPEC v1 §8: EXIF orientation, longest side 1600 px, JPEG 0.85, **EXIF stripped**. Stored in R2 (auth-only serving, same as progress photos), linked to the message.
- Sent to the model as an image block with his question. Up to 4 images per message.
- Allowed: visible muscle development and balance (left/right, upper/lower), comparing two dates, posture and position in a still photo, what to train more.
- Prompt rules: say it is a visual estimate; no exact body-fat % as fact (a range labelled as rough estimate only if he asks); a single still photo cannot fully judge lifting technique — say so and ask for more angles; no medical judgments.
- Chat photos are **not** added to the Progress photos gallery unless he taps "Save to progress photos".

## 6. Saved conversations (data change)
**STOP:** show Payam the migration SQL before applying. Proposal:
- `coach_threads(id, title, created_at, updated_at, archived)` — title = first question, shortened.
- `coach_messages(id, thread_id, role, content_json, created_at, input_tokens, output_tokens, cache_read_tokens, cost_usd, model, error)` — content_json keeps text, tool calls/results and image refs so cards re-render exactly.
- `coach_attachments(id, message_id, r2_key, width, height, created_at)`.
- `archived` = 0/1. Permanent delete (only for archived threads) removes the thread, its messages, attachments rows and R2 objects in one operation; test that nothing else is removed.
- Nothing else in D1 changes. Existing tables untouched.
- Context sent to the model: the whole thread up to a budget (`COACH_CONTEXT_TOKENS`, default 60,000). Older messages beyond it stay saved and visible but are not sent; a small line in the chat says so.
- Past chats readable offline (cached in IndexedDB); sending needs a connection ("Needs connection", composer disabled).

## 7. Cost display (no cap)
- Price table in config (Opus 5.5: $4 input / $20 output per million tokens, cached-read at the official cached rate — **check the current price page and write the date in the report**).
- Per answer: caption "~$0.0X" (from the API's returned token counts, not estimated).
- Me → AI reports: "This month: Coach N messages, ~$X" plus existing lines.
- No limit, no blocking. Payam's spend limit at console.anthropic.com stays the safety net.

## 8. Decisions and CONFIRM (pick a default if Payam is asleep, list under "Decisions to confirm")
1. (Decided by Payam 2026-10-14) Chats: **Archive** hides a chat from the list and keeps it (an "Archived" list shows them, with **Unarchive**). From the Archived list Payam can also **Delete permanently**: confirm dialog ("This chat and its photos will be deleted for good"), `--danger` text, then the thread, its messages, its attachments rows and their R2 objects are removed. Only archived chats can be deleted. Never touches training data or progress photos.
2. Suggested question chips (Persian), default 4: «این هفته چطور بودم؟»، «برنامه‌ی سینه‌ام را بهتر کن»، «چرا پرس سینه‌ام ثابت مانده؟»، «این عکس را تحلیل کن».
3. "What it knows" sheet in the header: lists the tools in plain words.

## 9. Tests
- Anthropic API **mocked** in all tests; never call the real API in tests.
- Unit: tool results equal the Reports numbers for a fixture week; `propose_program` drops unknown exercise ids; cost calculation from token counts; context budget trimming.
- E2E (WebKit iPhone + Chromium): new chat → streamed answer → data card → reload → chat still there; program draft → Add to Planner → new inactive program exists, active program unchanged; attach photo → EXIF removed (check bytes) → sent; offline → composer disabled, old chat readable; archive → unarchive; delete permanently an archived chat → its rows and R2 objects are gone, sessions/photos untouched; failed call → Retry works.
- Screenshots (iPhone, dark): empty chat with chips, answer with data card, program draft card, photo message, chat list, cost caption.

## 10. Report
Per CLAUDE.md, in Persian: what was built, test totals, screenshots, the real cost of 5 test messages on the deployed preview (text-only and with a photo), bundle size change. **Do not merge, do not deploy** without Payam's OK.

## 11. Change by Payam, 2026-10-16: exercises for a session (`propose_session_additions`)

Use case: at the gym he says "today I'm doing back, add biceps and forearms"; the coach proposes 2–3 exercises.

- **Tool:** `propose_session_additions({ program_day_id?, items: [{ exercise_id, reason_fa }] })`, 1–6 items. The model gives no numbers.
  - Ids not in the library (or archived), repeats, and exercises already in the target session or day are dropped, and the result says why.
  - Sets, reps and weight come from the session screen's progression (`lastPerformance` + `suggest`): the active program's entry; else his last session's sets and top reps; else 3 sets with the generator's rep range for the exercise's kind and no weight ("No history with this exercise: enter the weight"). (STOP decisions 1, 2, 4 and 5: approved as built.)
- **Card:** the target as its heading; the list (exercise, sets × reps, weight, the progression step, the reason in Persian); **Add** and **Change** (picks another target). Nothing changes before Add; the program never changes. After Add the card offers **Open** and stays in the chat.
- **Target, chosen by date (replaces STOP decision 3):**
  1. A session open today → "Add to today's session: <day>?" → appended as "Added today" extras (`is_extra`), each set prefilled with the card's reps and weight, unchecked.
  2. No open session; the day he named, else today's planned gym session's day → "Add to today's <day>" → the exercises go into that day's plan in the planner (as 3); nothing is started: they are in the session when he taps Start at the gym (Payam, 2026-10-16, after the STOP review).
  3. Nothing today → the nearest planned gym session within 14 days, e.g. "Add to tomorrow 08:00 · Day 4 · Deadlift" → the exercises go into that day's plan in the planner (`planned_sessions`, `origin = 'added'`, the card's sets and reps; no schema change), so they are in the session when it starts. Without any plan: Home's next program day, today (as 2).
  - Change lists today's open session (or each program day started today) and the planned sessions ahead (at most 6).
- **Sessions left open from an earlier day close by themselves** (after that day ends, local time; on app start, on refresh and when the app comes back):
  - with done sets: saved as Finish saves (the server writes the session report and the overview, as a normal Finish), ending at the last done set;
  - with no done set: deleted (as "Delete session"), never saved empty;
  - Home shows once: "Your session from <date> was closed automatically."
- **Prompt:** use the tool for "add exercises for today"; no numbers of its own; match a named day with get_program and ask when unclear; respect his groups; the 48-hour rule is advice only; never say they were added.

## 12. Change by Payam, 2026-10-16: one more exercise for a day (`propose_exercise`)

From his iPhone test: "on my chest day add one exercise for more chest focus" made the coach write the whole program as a draft and show the full program, three Sets vs target cards, the recovery table, a 60-exercise list and unrelated notes. Plan and mockups approved the same day with these decisions: hidden cards option A, this change before Step 2, the exercise list stays at 60; the reason said once, no explanation under the buttons.

- **Tool:** `propose_exercise({ program_day_id, exercise_id, after_exercise_id?, prefer?: "session" | "program" })`. The model picks the day, one exercise and the exercise it goes after; it gives no numbers and writes no program.
  - Errors back to the model: a day not in his active program, an id not in the library (or archived), an exercise already in that day, an `after_exercise_id` not in that day.
  - Place: right after `after_exercise_id`; after a member of a superset or tri-set, after the whole group (never inside his groups); without it, the end of the day.
  - Numbers: as `propose_session_additions` (§11). Rest, target RIR and per-leg from his program entry when the exercise is in his program; else the generator's scheme for its kind (accessory 90 s, isolation 75 s, core 60 s), with the scheme's RIR target only when his program sets RIR targets.
- **Card, only the change:** "Day 1 · Chest: + Cable Chest Fly", the exercise with sets × reps "· after Seated Cable Row", the progression step and the weight (nothing on the right when there is no weight; the step line says to enter it). The reason is in the coach's text only (said once); nothing under the buttons.
  - With a session open today (Payam, 2026-10-16, PR #20 review), Only this session puts it at the end of that session, so the card says where each button puts it: "· at the end of this session; in the program after Seated Cable Row". The plan and program cases keep "· after Seated Cable Row".
  - **Only this session:** the §11 path and rules. A session open today gets it as an extra; otherwise that day's plan gets it, in the same place (after that exercise, never inside a group), and nothing starts before Start. The program does not change.
  - **Whole program:** the app builds the draft itself: the program version the card was made for, with that one exercise and the card's numbers in that place, named "<program> + <exercise>". Saved by the existing Add to Planner endpoint as an inactive coach draft under Me → Program → Drafts; approving it stays a separate tap.
  - The button he asked for comes first (`prefer`: "just today" → Only this session, "from now on" → Whole program); when he did not say, Only this session. A done choice becomes a line with Open; the other button stays.
- **Worth knowing (information only, never blocking):** only what the change causes:
  - each group's weekly sets the change moves: "Chest: 16 sets a week with this change (now 13; target 13)";
  - the day's extra minutes: "Day 1 gets about 7 min longer (about 67 min)". One number everywhere (Payam's review): the Planner's rule (`planMinutes`, the day's own estimate moved by what the exercise adds), so the card, that day's plan after Only this session (it gets the card's rest) and the Whole program draft (that day's estimate; the other days keep the program's) all show it;
  - any note of the program check the new program adds (a note the program already had, with other numbers, is not new; under/over target is said by the sets line);
  - spacing advice naming only the groups the change adds to two adjacent days.
- **Sets vs target:** one card per get_volume call. Muscle groups are rows, the weeks are columns (this week marked "*", "so far") and the last column is the latest week's target. Same rows and fractional sets as before.
- **Cards he did not ask to see:** get_program, get_library and get_recovery take `show`. The model passes `show: true` only when he asks to see that directly ("show me my program"); otherwise the result is read by the model and no card is drawn, older chats included.
- **Prompt:** one exercise → `propose_exercise` (also when it is only for today), never a whole draft; two or more for a session → `propose_session_additions`; `propose_program` for new programs and bigger changes. After the card, one or two sentences on why this exercise and this place, without repeating the card.
- **Cost:** no model change. The model no longer writes the whole program (about 1,800 output tokens in his test) and the answer is shorter; estimated about $0.14 instead of $0.20 for the same request.

## 13. Change by Payam, 2026-10-16: Ask Coach from the session screen (Step 2)

- **Where:** the top row of the active session's More sheet ("…"), above Add exercise. It opens the Coach as a sheet over the session; the session and its timers keep running, and closing it returns to the same card. Offline the row is disabled and says "Needs connection".
- **Context, automatic:** each message carries `session: { id, exercise_id, set }` (the card on screen and its current set; a group card's current row). The app syncs the session first, then the server adds to the message's CONTEXT block, from the session as saved: the day and start time, "On his screen: <exercise>, set k of n", and the done sets so far in the order he did them. A finished session, or one that is not his, adds nothing. Built in `worker/lib/coach/sessionContext.ts`.
- **One chat per session:** opening the sheet again shows that session's chat; the Coach tab lists it with his other chats.
- **Adding exercises:** `propose_session_additions` and `propose_exercise` already target the session open today (§11, §12), so what he adds there lands in this session as extras; the prompt says so.
- No model, tool or schema change; the API change is the optional `session` field on a message.


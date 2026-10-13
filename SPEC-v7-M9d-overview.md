# SPEC v7: M9d, auto-updating training overview in Reports

Status: requested by Payam on 2026-10-13 ("after every workout the report updates automatically"). Two points marked **CONFIRM** must be answered by Payam before building.
Same CLAUDE.md rules. Builds on M9a (session reports, Durable Object job, Opus only, no fallback, numbers from the app).

## 1. What Payam gets
**Reports tab, new top section "Training overview" (Persian, RTL card):**
- A short Persian overview of recent training, **rewritten automatically after every finished session**, right after that session's report (same background job, same Durable Object).
- Shows "Updated after: Day N · <date>" and the model name. Manual **Regenerate** button.
- If generation fails: keep showing the previous overview with a small "Update failed — Retry" note. Never block anything.

**Reports tab, new section "Session reports":** all session reports, newest first: day name, date, one-line summary; tap opens the full report (same card as after Finish / History). Session reports stay where they are too.

## 2. Content of the overview
Model output (JSON, Zod-validated, Persian prose):
```json
{
  "summary_fa": "3–5 sentences: how training is going",
  "trends": ["main lifts e1RM direction over the window, e.g. bench up 4% in 3 weeks"],
  "volume_fa": "which groups are on/under/over target this week and over the window",
  "consistency_fa": "sessions per week vs program days, skipped exercises pattern",
  "focus_next": ["1–3 concrete priorities for the coming sessions"],
  "warnings": ["only real issues: stalls ≥3 exposures, big e1RM drops, pain notes"]
}
```
Rules (system prompt), same as M9a plus:
- **Built from raw data only** (sets, weights, reps, RIR, e1RM history, volume vs targets, session notes). Never from the text of earlier AI reports or earlier overviews, so model mistakes do not compound.
- All numbers shown in tables/trends come from the app (e1RM, volume, % change computed in code). The model only phrases them; prose containing numbers the app did not supply is dropped (same filter as M9a).
- Chest is Payam's priority; strength and balance; no deload or light-week suggestions unless a session note says he is tired; no medical advice.

## 3. Data window — CONFIRM
Default proposal: **current week + previous 4 weeks** (trend), with this week highlighted. Alternative: current week only, or last 8 weeks.

## 4. Old "مرور هفتگی" card — CONFIRM
Default proposal: the new overview **replaces** the old weekly-review card on Home/Reports. The `weekly_reviews` table and its rows are kept (history is never deleted) and stay readable under History → Weekly reviews. Alternative: keep both.

## 5. Data (show SQL first)
```sql
CREATE TABLE training_overviews (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  trigger_session_id TEXT REFERENCES workout_sessions(id) ON DELETE SET NULL,
  window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error')),
  overview_json TEXT CHECK (overview_json IS NULL OR json_valid(overview_json)),
  error TEXT, input_tokens INTEGER, output_tokens INTEGER
);
CREATE INDEX training_overviews_created ON training_overviews(created_at);
```
- Every regeneration inserts a new row; the latest `ok` row is shown. Old rows kept.
- Backup/export includes the table.

## 6. Cost and limits
- One extra Opus call per finished session (plus manual Regenerate). Same effort and max_tokens config style as M9a (`OVERVIEW_EFFORT`, `OVERVIEW_MAX_TOKENS`), configurable in wrangler.toml.
- Rate limit: 10 overviews/day. Settings cost line includes overviews ("This month: N reports, M overviews, ~$X").
- Report the measured cost of the first real overview to Payam.

## 7. Tests
- Unit: input builder uses raw data only (assert no session_reports/overview text is included); numbers in output come from code; Zod failure → retry once → error row.
- Worker: finishing a session enqueues report then overview; overview failure keeps previous overview visible; mocked API only.
- E2E (both projects): finish a session → overview "Updated after" changes; Session reports list opens a report; Regenerate works.
- Screenshots (iPhone, dark) before merge, and a milestone report per CLAUDE.md.

## 8. As built (2026-10-13)
- CONFIRM answers (Payam): window = this week + previous 4 weeks; the overview **replaces** the weekly-review card on
  Home and Reports, and every `weekly_reviews` row stays readable in History → Reports timeline (see below).
  The §5 SQL was approved as shown (migration `0010_training_overviews.sql`).
- Same Durable Object queue as the report: a finished session queues its report (if none yet), then the overview. A
  waiting overview is replaced by a newer one, so a burst of syncs costs one call.
- Defaults: `OVERVIEW_EFFORT = "medium"` (Payam, PR review), `OVERVIEW_MAX_TOKENS = "4000"` (thinking counts toward it); Opus only, no
  fallback. Limit 10 per local day (calls that used tokens).
- Number filter: prose items with a number not in the input are dropped (percentages must match an app `*_pct` value,
  as given or rounded); a summary with one makes the reply invalid (retried once, then an error row). The lift table
  (1RM, % change) is the app's.
- Routes: `GET /api/overview` (latest ok overview, `failed` when a newer attempt failed, `pending`), `POST /api/overview`
  (Regenerate/Retry, 202), `GET /api/session-reports` (latest report per session, newest session first).
- Reports → Session reports shows the latest 5, then "Show all" (kept after review).
- Planned sessions (PR review): counted only from the later of the active program's start date (its last activation)
  and the window's start; weeks before plan none, the start week plans only its days since then; whole sessions
  ("5 of 13"). The totals compare done and planned sessions from that same date (`totals.since`) — pending Payam's
  decision on how a program switch and re-activation should count.
- History → Reports timeline (PR review): two rows, Session report and Weekly review, one column per date with a report;
  a session date's chooser lists its session report and the overview written after it; an overview on a day without a
  session gets a ◆ marker on its date; the List view shows all three types. Every report opens read-only. A weekly
  review sits on the last day of the week it covers (`week_start` + 6; the production rows are Monday–Sunday weeks).
  Endpoints approved: `GET /api/report-timeline` (dates, kinds, ids only) and `GET /api/overviews/:id`.

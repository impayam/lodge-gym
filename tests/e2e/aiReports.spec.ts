import { expect, test, type Page } from "./fixtures";
import { aiJobsIdle, aiMode, resetPrograms, resetWorkouts, setOffline, signIn, sql, goTo, enterSet } from "./helpers";

// Step 3 (Payam, 2026-10-16): every AI report lives in the Reports tab. The training overview is no longer written after
// each session; the older overviews stay readable on the reports timeline (Reports → All reports; History links to
// Reports), and the main lifts' estimated 1RM table is the app's own. The model is mocked (scripts/e2e-ai-mock.mjs): the real
// Anthropic API is never called.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
  // An overview queued by an earlier spec (a manual Regenerate) would be written after the reset.
  await aiJobsIdle(context, baseURL!);
  resetWorkouts();
  resetPrograms();
  await aiMode({ report: "ok", advice: "ok", overview: "ok" });
});
test.afterAll(async () => {
  resetWorkouts();
  resetPrograms();
  sql("DELETE FROM weekly_reviews");
  await aiMode({ report: "ok", advice: "ok", overview: "ok" });
});

const toReports = (page: Page) => goTo(page, "Reports");

/** Logs Day 1's bench (4 × 5 at 140 lb), finishes and has the report written now; returns on the report. */
async function finishDay1(page: Page) {
  await goTo(page, "Train");
  await expect(page.getByTestId("next-card")).toHaveAttribute("data-day", "Day 1 · Chest");
  await page.getByTestId("start").click();
  for (let i = 0; i < 4; i++) {
    await enterSet(page, "bench", i, "w", "140");
    await page.getByTestId(`check-bench-${i}`).click();
  }
  await page.getByTestId("finish").click();
  const status = page.getByTestId("report-status");
  await expect(status).toHaveAttribute("data-phase", "waiting", { timeout: 30_000 });
  await status.getByTestId("report-write").click();
  await expect(status).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
  await status.getByTestId("report-open").click();
  await expect(page.getByTestId("report-summary")).toBeVisible();
}

/** An overview as the app wrote them before Step 3, for old data. */
const OVERVIEW_JSON = JSON.stringify({
  summary_fa: "روند تمرین خوب است و جلسه‌ها منظم انجام شده‌اند.",
  trends: [],
  volume_fa: null,
  consistency_fa: null,
  focus_next: ["روی حرکت‌های سینه تمرکز کن."],
  warnings: [],
  unit: "lb",
  lifts: [{ exercise_id: "bench", name: "Barbell Bench Press", sessions: 1, first_e1rm: 163.3, latest_e1rm: 163.3, change_pct: null }],
  stalls: [],
  drops: [],
  motivation: null,
  dropped: 0,
});

test("Reports: the main lifts' 1RM table is the app's own, no overview card or overview after a session, after-session reports open here, History links here", async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await toReports(page);
  await expect(page.getByTestId("training-overview")).toHaveCount(0);
  await expect(page.getByTestId("main-lifts")).toContainText("No bench press, squat or deadlift logged in this period.");
  await expect(page.getByTestId("main-lifts-table").locator('tr[data-lift="bench"] td')).toHaveText(["Barbell Bench Press", "–", "–"]);
  await expect(page.getByTestId("session-reports")).toContainText("No after-session reports yet.");

  await finishDay1(page);
  await toReports(page);
  // The app's table, no model: bench 4 × 5 at 140 lb → Epley 1RM 163.3; one session, so no change yet.
  const table = page.getByTestId("main-lifts-table");
  await expect(table.locator('tr[data-lift="bench"] td')).toHaveText(["Barbell Bench Press", "163.3", "–"]);
  await expect(table.locator("th").nth(1)).toHaveText("1RM (lb)");
  await expect(page.getByTestId("main-lifts")).toContainText("Best set of the week (Epley). Change: against last week's best.");
  // One report, and no training overview after it.
  expect(sql("SELECT COUNT(*) AS n FROM session_reports")).toEqual([{ n: 1 }]);
  expect(sql("SELECT COUNT(*) AS n FROM training_overviews")).toEqual([{ n: 0 }]);
  await expect(page.getByTestId("training-overview")).toHaveCount(0);

  // The after-session reports list; a row opens the full report on this tab.
  const rows = page.getByTestId("session-report-row");
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows.first()).toContainText("Day 1 · Chest");
  await expect(rows.first().locator(".list-row__note")).toHaveAttribute("dir", "rtl");
  await expect(rows.first().locator(".list-row__note")).toContainText("جلسهٔ Day 1 · Chest انجام شد");
  await rows.first().click();
  await expect(page.getByTestId("report-screen")).toBeVisible();
  await expect(page.getByTestId("report-summary")).toContainText("جلسهٔ Day 1 · Chest انجام شد");
  await expect(page.getByTestId("photo-prompt")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Reports" })).toHaveAttribute("aria-current", "page");

  // History shows the sessions, and a link to the reports.
  await goTo(page, "History");
  await expect(page.getByTestId("reports-timeline")).toHaveCount(0);
  await expect(page.getByTestId("history-group").getByTestId("session-card")).toHaveCount(1);
  await page.getByTestId("history-reports-link").click();
  await expect(page.getByTestId("reports")).toBeVisible();
  await expect(page.getByTestId("all-reports")).toBeVisible();

  // Settings: this month's one report; no overview counted.
  await goTo(page, "AI reports");
  await expect(page.getByTestId("ai-cost")).toHaveText(/^1 report, ~\$\d+\.\d{2}$/);

  // Offline, Reports shows the last saved copy.
  await setOffline(context, page, true);
  await page.reload();
  await toReports(page);
  await expect(page.getByTestId("session-reports")).toContainText("Offline: showing the last saved copy.");
  await expect(page.getByTestId("session-report-row")).toHaveCount(1);
  await expect(page.getByTestId("main-lifts-table")).toBeVisible();
  await setOffline(context, page, false);
});

test("AI reports on Reports: the latest three sessions' reports, newest first, then a row to all reports", async ({ page }) => {
  // Four finished sessions with a report each, a day apart (old data, written straight into the database).
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  for (const n of [1, 2, 3, 4]) {
    const id = `01AIRPT${n}`;
    sql(
      `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
         VALUES ('${id}', 'D1', date('now', '-${n} days'), '${day(n)}', '${day(n)}', 'done', 'lb', '', '${day(n)}', '${day(n)}', 'app');
       INSERT INTO session_reports (id, session_id, created_at, model, status, report_json, error, input_tokens, output_tokens)
         VALUES ('01AIRPTREP${n}', '${id}', '${day(n)}', 'claude-opus-5-5', 'ok', '{"summary_fa":"گزارش ${n}"}', NULL, 4000, 800)`
    );
  }
  await page.goto("/");
  await toReports(page);
  const rows = page.getByTestId("session-report-row");
  await expect(rows).toHaveCount(3);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-session")))).toEqual(["01AIRPT1", "01AIRPT2", "01AIRPT3"]);
  await expect(page.getByTestId("session-reports").getByRole("heading", { level: 2 })).toHaveText("AI reports");
  await expect(page.getByTestId("all-reports")).toContainText("All reports and weekly reviews");
  // The fourth is under All reports.
  await page.getByTestId("all-reports").click();
  await page.getByTestId("rt-mode-list").click();
  await expect(page.getByTestId("rt-list").getByTestId("rt-item")).toHaveCount(4);
});

test("Reports → All reports: a session date lists its report and an old overview written after it; an old Regenerate gets ◆; weekly reviews on their week's last day; everything opens read-only and goes back to All reports", async ({ page }) => {
  // Reports, overviews and reviews opened one by one: 37–46 s in WebKit on a busy machine.
  test.setTimeout(120_000);
  sql("DELETE FROM weekly_reviews");
  const tz = (sql("SELECT value FROM settings WHERE key = 'timezone'")[0] as { value?: string } | undefined)?.value ?? "America/Denver";
  const localDay = (daysAgo: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() - daysAgo * 86_400_000));
  await page.goto("/");
  await finishDay1(page);
  const today = localDay(0);
  const threeAgo = localDay(3);
  // Old data from before Step 3: an overview written after today's session, a Regenerate three days ago (no session
  // that day), a failed one (not listed), and a weekly review whose week ended a week ago.
  const [{ id }] = sql("SELECT id FROM workout_sessions") as { id: string }[];
  sql(
    `INSERT INTO training_overviews (id, created_at, trigger_session_id, window_start, window_end, model, status, overview_json)
       VALUES ('after-ov', '${new Date().toISOString()}', '${id}', '${localDay(30)}', '${today}', 'claude-opus-5-5', 'ok', '${OVERVIEW_JSON}');
     INSERT INTO training_overviews (id, created_at, window_start, window_end, model, status, overview_json)
       VALUES ('manual-ov', '${threeAgo}T18:00:00.000Z', '${localDay(33)}', '${threeAgo}', 'claude-opus-5-5', 'ok', '${OVERVIEW_JSON}');
     INSERT INTO training_overviews (id, created_at, window_start, window_end, model, status, error) VALUES ('failed-ov', '${localDay(2)}T18:00:00.000Z', '2026-09-07', '${localDay(2)}', 'claude-opus-5-5', 'error', 'api: mock');
     INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES ('rv', '${localDay(13)}', '${localDay(6)}T13:55:00Z', 'مرور هفته', '[]', '[]')`
  );

  await toReports(page);
  // The AI reports card: the latest after-session reports, then a row to all of them.
  await page.getByTestId("all-reports").click();
  await expect(page.getByTestId("all-reports-screen")).toBeVisible();
  const cols = page.getByTestId("rt-col");
  await expect(cols).toHaveCount(3);
  expect(await cols.evaluateAll((els) => els.map((e) => e.getAttribute("data-date")))).toEqual([localDay(7), threeAgo, today]);
  // Two labeled rows only (mockup 04: Sessions, Weekly).
  await expect(page.locator(".timeline__lanes")).toHaveText(/^\s*Sessions\s*Weekly\s*$/);
  const todayCol = cols.nth(2);
  await expect(todayCol.locator(".marker--session")).toBeVisible();
  await expect(todayCol).toHaveAttribute("aria-label", /: after-session report, training overview$/);
  // The overview-only date: ◆ in the Sessions lane instead of a session dot.
  const manual = cols.nth(1);
  await expect(manual.locator(".marker--overview")).toBeVisible();
  await expect(manual.locator(".marker--session")).toHaveCount(0);
  await expect(cols.nth(0).locator(".marker--review")).toBeVisible();

  // A date with two reports: the short list to choose from.
  await todayCol.click();
  const chooser = page.getByTestId("rt-chooser");
  await expect(chooser.getByTestId("rt-item")).toHaveCount(2);
  await expect(chooser.getByTestId("rt-item").nth(0)).toContainText("After-session report");
  await expect(chooser.getByTestId("rt-item").nth(0)).toContainText("Day 1 · Chest");
  await expect(chooser.getByTestId("rt-item").nth(1)).toContainText("Training overview");
  await expect(chooser.getByTestId("rt-item").nth(1)).toContainText("After Day 1 · Chest");
  await chooser.getByTestId("rt-item").nth(1).click();
  await expect(page.getByTestId("saved-report")).toHaveAttribute("data-kind", "overview");
  await expect(page.getByTestId("saved-body").getByTestId("overview-summary")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("saved-body").getByTestId("overview-lifts")).toBeVisible();
  await expect(page.getByRole("button", { name: /Regenerate|Retry/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Reports" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("main").getByRole("button", { name: "Back to All reports" }).click();

  await cols.nth(2).click();
  await page.getByTestId("rt-chooser").getByTestId("rt-item").nth(0).click();
  await expect(page.getByTestId("saved-report")).toHaveAttribute("data-kind", "session");
  await expect(page.getByTestId("saved-report")).toContainText("After-session report · read-only");
  await expect(page.getByTestId("saved-body").getByTestId("report-summary")).toContainText("جلسهٔ Day 1 · Chest انجام شد");
  await expect(page.getByTestId("saved-body").getByTestId("report-where")).toBeVisible();
  await expect(page.getByTestId("saved-body").getByTestId("report-motivation")).toBeVisible();
  await expect(page.getByTestId("saved-body").getByTestId("report-cost")).toHaveText(/^ · ~\$\d+\.\d{2}$/);
  await expect(page.getByTestId("photo-prompt")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Regenerate|Retry/ })).toHaveCount(0);
  await page.getByRole("main").getByRole("button", { name: "Back to All reports" }).click();

  // One report on the date: it opens at once.
  await cols.nth(1).click();
  await expect(page.getByTestId("saved-report")).toHaveAttribute("data-kind", "overview");
  await expect(page.getByTestId("saved-report")).toContainText("Regenerated · ");
  await page.getByRole("main").getByRole("button", { name: "Back to All reports" }).click();
  await expect(page.getByTestId("all-reports-screen")).toBeVisible();
  // Its own Back returns to Reports.
  await page.getByRole("main").getByRole("button", { name: "Back to Reports" }).click();
  await expect(page.getByTestId("reports")).toBeVisible();
  await page.getByTestId("all-reports").click();

  // The List view keeps all three types, newest first; the choice is kept.
  await page.getByTestId("rt-mode-list").click();
  const items = page.getByTestId("rt-list").getByTestId("rt-item");
  expect(await items.evaluateAll((els) => els.map((e) => [e.getAttribute("data-kind"), e.getAttribute("data-date")]))).toEqual([
    ["session", today],
    ["overview", today],
    ["overview", threeAgo],
    ["review", localDay(7)],
  ]);
  await page.reload();
  await toReports(page);
  await page.getByTestId("all-reports").click();
  await expect(page.getByTestId("reports-timeline")).toHaveAttribute("data-mode", "list");
  await page.getByTestId("rt-list").getByTestId("rt-item").nth(3).click();
  await expect(page.getByTestId("weekly-review")).toContainText("مرور هفته");
});

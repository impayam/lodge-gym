import { expect, test, type Page } from "./fixtures";
import { aiCalls, aiMode, resetPrograms, resetWorkouts, setOffline, signIn, sql, goTo, enterSet } from "./helpers";

// SPEC-v7 M9d: the training overview in Reports, rewritten after every finished session right after its report, and
// the Session reports list. The model is mocked (scripts/e2e-ai-mock.mjs): the real Anthropic API is never called.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  resetPrograms();
  await aiMode({ report: "ok", advice: "ok", overview: "ok" });
  await signIn(context, baseURL!);
});
test.afterAll(async () => {
  resetWorkouts();
  resetPrograms();
  await aiMode({ report: "ok", advice: "ok", overview: "ok" });
});

const card = (page: Page) => page.getByTestId("training-overview");
/** The motivational line's phase today, in the app's time zone. */
function phaseToday() {
  const tz = (sql("SELECT value FROM settings WHERE key = 'timezone'")[0] as { value?: string } | undefined)?.value ?? "America/Denver";
  const dow = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date())}T12:00:00Z`).getUTCDay();
  return dow === 1 || dow === 2 ? "start" : dow === 0 || dow === 6 ? "end" : "mid";
}
const toReports = (page: Page) => goTo(page, "Reports");

/** Logs Day 1's bench (4 × 5 at 140 lb) and finishes; returns once the session's report is on screen. */
async function finishDay1(page: Page) {
  await goTo(page, "Train");
  await expect(page.getByTestId("next-card")).toHaveAttribute("data-day", "Day 1 · Chest");
  await page.getByTestId("start").click();
  for (let i = 0; i < 4; i++) {
    await enterSet(page, "bench", i, "w", "140");
    await page.getByTestId(`check-bench-${i}`).click();
  }
  await page.getByTestId("finish").click();
  await expect(page.getByTestId("report-summary")).toBeVisible({ timeout: 30_000 });
}

test("the overview updates after a finished session, keeps the old one on failure with Retry, and Regenerate writes a new one", async ({ page, context }) => {
  await page.goto("/");
  await toReports(page);
  await expect(card(page)).toHaveAttribute("data-state", "none");
  await expect(card(page)).toContainText("No overview yet");
  await expect(page.getByTestId("session-reports")).toContainText("No session reports yet.");

  // A first overview, written by hand: "Updated <date> · <time>".
  await page.getByTestId("overview-write").click();
  await expect(card(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(page.getByTestId("overview-updated")).toHaveText(/^Updated [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} · \d{2}:\d{2}$/);
  await expect(page.getByTestId("overview-summary")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("overview-summary")).toHaveAttribute("lang", "fa");
  await expect(page.getByTestId("overview-summary")).toContainText("در 5 هفتهٔ اخیر 0 جلسه");
  const manual = await card(page).getAttribute("data-overview");

  // Finishing a session writes its report, then the overview: "Updated after: Day 1 · Chest · <date>".
  await finishDay1(page);
  await toReports(page);
  await expect(page.getByTestId("overview-updated")).toHaveText(/^Updated after: Day 1 · Chest · [A-Z][a-z]{2} \d{1,2}$/, { timeout: 30_000 });
  await expect(card(page)).not.toHaveAttribute("data-overview", manual!);
  await expect(page.getByTestId("overview-summary")).toContainText("در 5 هفتهٔ اخیر 1 جلسه");
  // The rest opens in the card (Payam, 2026-10-14).
  await expect(page.getByTestId("overview-lifts")).toHaveCount(0);
  await page.getByTestId("overview-more").click();
  await expect(page.getByTestId("overview-more")).toHaveAttribute("aria-expanded", "true");
  // The app's lift table: bench 4 × 5 at 140 lb → Epley 1RM 163.3.
  const bench = page.getByTestId("overview-lifts").locator('tr[data-lift="bench"]');
  await expect(bench.locator("td").nth(0)).toHaveText("Barbell Bench Press");
  await expect(bench.locator("td").nth(1)).toHaveText("163.3");
  await expect(page.getByTestId("overview-lifts").locator("th").nth(1)).toHaveText("1RM (lb)");
  await expect(page.getByTestId("overview-focus")).toContainText("روی حرکت‌های سینه");
  // The mock's warning has a number the app did not supply: dropped.
  await expect(page.getByTestId("overview-warnings")).toHaveCount(0);
  await expect(card(page)).not.toContainText("۹۹۹۹");
  await expect(card(page)).toContainText("claude-opus-5-5");
  // The weekly motivational line: Persian, right-to-left, with the week's numbers, labeled by today's phase
  // (Monday–Tuesday start, Wednesday–Friday mid, Saturday–Sunday end).
  const motivation = page.getByTestId("overview-motivation");
  await expect(motivation).toHaveAttribute("data-phase", phaseToday());
  await expect(motivation.locator("p")).toHaveAttribute("dir", "rtl");
  await expect(motivation.locator("p")).toContainText("جلسه از");
  const calls = await aiCalls();
  expect(calls.by_kind.overview).toMatchObject({ model: "claude-opus-5-5", effort: "medium", max_tokens: 4000, key_set: true });
  const afterSession = await card(page).getAttribute("data-overview");

  // The update fails: the previous overview stays, with "Update failed" and Retry.
  await aiMode({ overview: "fail" });
  await page.getByTestId("overview-regenerate").click();
  await expect(page.getByTestId("overview-failed")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("overview-failed")).toContainText("Update failed");
  await expect(card(page)).toHaveAttribute("data-overview", afterSession!);
  await expect(page.getByTestId("overview-summary")).toContainText("در 5 هفتهٔ اخیر 1 جلسه");

  // Retry writes a new one; the failure note goes away.
  await aiMode({ overview: "ok" });
  await page.getByTestId("overview-retry").click();
  await expect(page.getByTestId("overview-failed")).toHaveCount(0, { timeout: 30_000 });
  await expect(card(page)).toHaveAttribute("data-state", "ready");
  await expect(card(page)).not.toHaveAttribute("data-overview", afterSession!);
  await expect(page.getByTestId("overview-updated")).toHaveText(/^Updated [A-Z][a-z]{2}, /);

  // Regenerate writes another.
  const retried = await card(page).getAttribute("data-overview");
  await page.getByTestId("overview-regenerate").click();
  await expect(card(page)).not.toHaveAttribute("data-overview", retried!, { timeout: 30_000 });
  await expect(card(page)).toHaveAttribute("data-state", "ready");

  // Settings counts the overviews in this month's cost line.
  await goTo(page, "AI reports");
  await expect(page.getByTestId("ai-cost")).toHaveText(/^1 report, 4 overviews, ~\$\d+\.\d{2}$/);

  // Offline, Reports shows the last saved overview.
  await toReports(page);
  await expect(card(page)).toHaveAttribute("data-state", "ready");
  await setOffline(context, page, true);
  await page.reload();
  await toReports(page);
  await expect(page.getByTestId("overview-summary")).toBeVisible();
  await expect(card(page)).toContainText("Offline: showing the last saved copy.");
  await setOffline(context, page, false);
});

test("Session reports lists each finished session's report, newest first, and a row opens the full report", async ({ page }) => {
  await page.goto("/");
  await finishDay1(page);
  await toReports(page);
  const rows = page.getByTestId("session-report-row");
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows.first()).toContainText("Day 1 · Chest");
  await expect(rows.first().locator(".list-row__note")).toHaveAttribute("dir", "rtl");
  await expect(rows.first().locator(".list-row__note")).toContainText("جلسهٔ Day 1 · Chest انجام شد");
  await rows.first().click();
  await expect(page.getByTestId("report-screen")).toBeVisible();
  await expect(page.getByTestId("report-summary")).toContainText("جلسهٔ Day 1 · Chest انجام شد");
  await expect(page.getByTestId("photo-prompt")).toHaveCount(0);
});

test("History → Reports timeline: a session date lists its report and the overview written after it; a Regenerate on a day without a session gets ◆; weekly reviews on their week's last day; everything opens read-only", async ({ page }) => {
  sql("DELETE FROM weekly_reviews");
  const tz = (sql("SELECT value FROM settings WHERE key = 'timezone'")[0] as { value?: string } | undefined)?.value ?? "America/Denver";
  const localDay = (daysAgo: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() - daysAgo * 86_400_000));
  await page.goto("/");
  await finishDay1(page);
  await toReports(page);
  await expect(page.getByTestId("overview-updated")).toHaveText(/^Updated after: Day 1 · Chest/, { timeout: 30_000 });
  const today = localDay(0);
  const threeAgo = localDay(3);
  // A Regenerate three days ago (no session that day), a failed one (not listed), and a weekly review whose week ended a week ago.
  sql(
    `INSERT INTO training_overviews (id, created_at, window_start, window_end, model, status, overview_json)
       SELECT 'manual-ov', '${threeAgo}T18:00:00.000Z', window_start, window_end, model, 'ok', overview_json FROM training_overviews WHERE status = 'ok' LIMIT 1;
     INSERT INTO training_overviews (id, created_at, window_start, window_end, model, status, error) VALUES ('failed-ov', '${localDay(2)}T18:00:00.000Z', '2026-09-07', '${localDay(2)}', 'claude-opus-5-5', 'error', 'api: mock');
     INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES ('rv', '${localDay(13)}', '${localDay(6)}T13:55:00Z', 'مرور هفته', '[]', '[]')`
  );

  await goTo(page, "History");
  const cols = page.getByTestId("rt-col");
  await expect(cols).toHaveCount(3);
  expect(await cols.evaluateAll((els) => els.map((e) => e.getAttribute("data-date")))).toEqual([localDay(7), threeAgo, today]);
  // Two labeled rows only (mockup 04: Sessions, Weekly).
  await expect(page.locator(".timeline__lanes")).toHaveText(/^\s*Sessions\s*Weekly\s*$/);
  const todayCol = cols.nth(2);
  await expect(todayCol.locator(".marker--session")).toBeVisible();
  await expect(todayCol).toHaveAttribute("aria-label", /: session report, training overview$/);
  // The overview-only date: ◆ in the Sessions lane instead of a session dot.
  const manual = cols.nth(1);
  await expect(manual.locator(".marker--overview")).toBeVisible();
  await expect(manual.locator(".marker--session")).toHaveCount(0);
  await expect(cols.nth(0).locator(".marker--review")).toBeVisible();

  // A date with two reports: the short list to choose from.
  await todayCol.click();
  const chooser = page.getByTestId("rt-chooser");
  await expect(chooser.getByTestId("rt-item")).toHaveCount(2);
  await expect(chooser.getByTestId("rt-item").nth(0)).toContainText("Session report");
  await expect(chooser.getByTestId("rt-item").nth(0)).toContainText("Day 1 · Chest");
  await expect(chooser.getByTestId("rt-item").nth(1)).toContainText("Training overview");
  await expect(chooser.getByTestId("rt-item").nth(1)).toContainText("After Day 1 · Chest");
  await chooser.getByTestId("rt-item").nth(1).click();
  await expect(page.getByTestId("saved-report")).toHaveAttribute("data-kind", "overview");
  await expect(page.getByTestId("saved-body").getByTestId("overview-summary")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("saved-body").getByTestId("overview-lifts")).toBeVisible();
  await expect(page.getByRole("button", { name: /Regenerate|Retry/ })).toHaveCount(0);
  await page.getByRole("main").getByRole("button", { name: "Back to History" }).click();

  await cols.nth(2).click();
  await page.getByTestId("rt-chooser").getByTestId("rt-item").nth(0).click();
  await expect(page.getByTestId("saved-report")).toHaveAttribute("data-kind", "session");
  await expect(page.getByTestId("saved-body").getByTestId("report-summary")).toContainText("جلسهٔ Day 1 · Chest انجام شد");
  await expect(page.getByTestId("photo-prompt")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Regenerate|Retry/ })).toHaveCount(0);
  await page.getByRole("main").getByRole("button", { name: "Back to History" }).click();

  // One report on the date: it opens at once.
  await cols.nth(1).click();
  await expect(page.getByTestId("saved-report")).toHaveAttribute("data-kind", "overview");
  await expect(page.getByTestId("saved-report")).toContainText("Regenerated · ");
  await page.getByRole("main").getByRole("button", { name: "Back to History" }).click();

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
  await goTo(page, "History");
  await expect(page.getByTestId("reports-timeline")).toHaveAttribute("data-mode", "list");
  await page.getByTestId("rt-list").getByTestId("rt-item").nth(3).click();
  await expect(page.getByTestId("weekly-review")).toContainText("مرور هفته");
});

import { expect, test, type Page } from "./fixtures";
import { aiCalls, aiMode, resetPrograms, resetWorkouts, setOffline, signIn } from "./helpers";

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
const toReports = (page: Page) => page.getByRole("navigation").getByRole("button", { name: "Reports" }).click();

/** Logs Day 1's bench (4 × 5 at 140 lb) and finishes; returns once the session's report is on screen. */
async function finishDay1(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Train" }).click();
  await expect(page.getByTestId("next-card")).toContainText("Day 1 · Chest");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  for (let i = 0; i < 4; i++) {
    await page.getByTestId(`w-bench-${i}`).locator("input").fill("140");
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
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
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
  await expect(rows.first().locator(".sr-line")).toHaveAttribute("dir", "rtl");
  await expect(rows.first().locator(".sr-line")).toContainText("جلسهٔ Day 1 · Chest انجام شد");
  await rows.first().click();
  await expect(page.getByTestId("report-screen")).toBeVisible();
  await expect(page.getByTestId("report-summary")).toContainText("جلسهٔ Day 1 · Chest انجام شد");
  await expect(page.getByTestId("photo-prompt")).toHaveCount(0);
});

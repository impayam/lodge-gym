import { expect, test, type Page } from "./fixtures";
import { aiCalls, aiMode, resetPrograms, resetWorkouts, setOffline, signIn, sql, waitForSynced, goTo, enterSet, openMore } from "./helpers";

// SPEC-v3 M9a (AI session report; since Step 3 the one after-session report, written by its timing rule) and M9c (Get
// advice) with a mocked model (scripts/e2e-ai-mock.mjs): the real Anthropic API is never called. The mock writes its
// answer from the request's own input.
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

/** Starts Day 1 and logs the first bench set. */
async function startDay1(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toHaveAttribute("data-day", "Day 1 · Chest");
  await page.getByTestId("start").click();
  await page.getByTestId("check-bench-0").click();
}

const report = (page: Page) => page.getByTestId("session-report");
const status = (page: Page) => page.getByTestId("report-status");

/** After Finish the report waits for its timing rule; Write report now writes it, and it opens on the Reports tab. */
async function writeNowAndOpen(page: Page) {
  await expect(status(page)).toHaveAttribute("data-phase", "waiting", { timeout: 30_000 });
  await status(page).getByTestId("report-write").click();
  await expect(status(page)).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
  await status(page).getByTestId("report-open").click();
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Reports" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("report-summary")).toBeVisible();
}

test("finish a session with an extra exercise: the after-session report (today's volume, the rest of the week, Where you are, a closing line, its cost); failures show Retry; an expired key shows in Settings", async ({ page }) => {
  // A whole session, four report runs and Settings: 40–60 s in WebKit on a busy machine.
  test.setTimeout(150_000);
  await startDay1(page);
  // Bench: all 4 planned sets of 5 at 140 lb.
  for (let i = 0; i < 4; i++) {
    await enterSet(page, "bench", i, "w", "140");
    if (i > 0) await page.getByTestId(`check-bench-${i}`).click();
  }
  // One extra exercise, added during the session.
  await (await openMore(page)).getByTestId("add-exercise").click();
  const picker = page.getByTestId("exercise-picker");
  await picker.getByTestId("picker-tab-search").click();
  await picker.getByRole("searchbox").fill("biceps curl");
  await picker.getByTestId("library-row").filter({ has: page.locator("b", { hasText: /^Dumbbell Biceps Curl$/ }) }).first().click();
  // The card shows the added exercise once it is in the session.
  await expect(page.getByTestId("ex-card")).toHaveAttribute("data-ex", "curl");
  await enterSet(page, "curl", 0, "w", "30");
  await enterSet(page, "curl", 0, "r", "10");
  await page.getByTestId("check-curl-0").click();

  await page.getByTestId("finish").click();
  // The end-of-session screen: the progress-photo prompt and the report's status only (Step 3). Without today's body
  // weight and the Apple Health workout it is written 2 hours after the session ends.
  await expect(page.getByTestId("report-screen")).toBeVisible();
  await expect(page.getByTestId("photo-prompt")).toBeVisible();
  await expect(page.getByTestId("report-waiting")).toHaveText(/^It is written once today's body weight and the Apple Health workout are both in, or at \d{2}:\d{2} at the latest\.$/, { timeout: 30_000 });
  await expect(page.getByTestId("report-summary")).toHaveCount(0);
  await writeNowAndOpen(page);
  await expect(page.getByTestId("photo-prompt")).toHaveCount(0);
  await expect(page.getByTestId("report-summary")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("report-extras")).toContainText("Dumbbell Biceps Curl");
  // Volume: the groups trained today in the table, the rest of the week in one line (Payam, 2026-10-16).
  const volume = page.getByTestId("report-volume");
  await expect(volume.locator("tbody tr").filter({ hasText: "Chest" }).locator("td").nth(1)).toHaveText("4");
  await expect(volume.locator("tbody tr").filter({ hasText: "Biceps" })).toBeVisible();
  expect(await volume.locator("tbody tr td:nth-child(2)").allTextContents()).not.toContain("0");
  await expect(volume.locator("tbody tr").filter({ hasText: "Quads" })).toHaveCount(0);
  // The first session of the week: the other groups with a target are not trained yet.
  await expect(page.getByTestId("report-volume-rest")).toHaveText(/^Rest of the week: \d+ groups not trained yet \(.*Quads.*\)\.$/);
  // Next time comes from the app's progression (4 × 5 at 140 lb, barbell upper body → +5 lb), not from the model.
  const bench = page.getByTestId("next-bench");
  await expect(bench).toContainText("145 lb × 5");
  await expect(bench).toContainText("+5 lb");
  await expect(bench.locator("p[dir=rtl]")).toHaveText("همین مسیر را با فرم درست ادامه بده.");
  await expect(page.getByTestId("report-next")).not.toContainText("۲۰۰");
  // Where you are, at the bottom: the mock's line with a number the app did not supply is left out.
  const where = page.getByTestId("report-where");
  await expect(where.locator("ul")).toHaveAttribute("dir", "rtl");
  await expect(where).toContainText("جلسهٔ برنامه انجام شد");
  await expect(where).not.toContainText("۹۹۹۹");
  // The closing motivational line, then the cost of this report (4200 in, 850 out at $4 / $20 per million).
  const first = page.getByTestId("report-motivation");
  await expect(first).toHaveText("همین که امروز آمدی و کامل تمرین کردی، یعنی مسیر درست است.");
  await expect(page.getByTestId("report-cost")).toHaveText(" · ~$0.03");
  const call = (await aiCalls()).by_kind.report!;
  expect(call).toMatchObject({ kind: "report", model: "claude-opus-5-5", effort: "low", key_set: true });

  // The model fails: "Report unavailable" with Retry; older reports are kept.
  await aiMode({ report: "fail" });
  await page.getByTestId("report-regenerate").click();
  await expect(page.getByTestId("report-unavailable")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("report-retry")).toBeVisible();

  // The key expired: the reason shows here and in Settings.
  await aiMode({ report: "auth" });
  await page.getByTestId("report-retry").click();
  await expect(page.getByTestId("report-unavailable")).toContainText("API key expired or invalid.", { timeout: 30_000 });
  await goTo(page, "AI reports");
  await expect(page.getByTestId("ai-key-problem")).toHaveText("Report unavailable — API key expired or invalid");

  // Fixed: Retry from History → session → Report writes a new report, with a different closing line; Settings is clear again.
  await aiMode({ report: "ok" });
  await goTo(page, "History");
  await page.getByTestId("history-group").getByTestId("session-card").first().click();
  await page.getByTestId("open-report").click();
  await expect(page.getByTestId("photo-prompt")).toHaveCount(0);
  await page.getByTestId("report-retry").click();
  await expect(page.getByTestId("report-summary")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("report-motivation")).toHaveText("قدرت با همین جلسه‌های پشت‌سرهم ساخته می‌شود؛ جلسهٔ بعد هم همین‌طور.");
  await goTo(page, "AI reports");
  await expect(page.getByTestId("ai-cost")).toContainText("2 reports");
  await expect(page.getByTestId("ai-key-problem")).toHaveCount(0);
  expect(sql("SELECT status, substr(error, 1, instr(error, ':') - 1) AS code FROM session_reports ORDER BY created_at")).toEqual([
    { status: "ok", code: null },
    { status: "error", code: "api" },
    { status: "error", code: "auth" },
    { status: "ok", code: null },
  ]);
  // One report per finished session: no training overview after it (Step 3).
  expect(sql("SELECT COUNT(*) AS n FROM training_overviews")).toEqual([{ n: 0 }]);
});

test("timing: the report waits for today's body weight and the Apple Health workout; with both in, it is written without the button", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  sql("DELETE FROM health_workouts WHERE external_key LIKE 'e2e-%'; DELETE FROM body_metrics WHERE source = 'manual'");
  await startDay1(page);
  await page.getByTestId("finish").click();
  await expect(status(page)).toHaveAttribute("data-phase", "waiting", { timeout: 30_000 });
  // Today's body weight on the end-of-session screen: still waiting for the watch.
  await page.getByTestId("finish-body-weight").locator("input").fill("181.4");
  await page.getByTestId("finish-body-weight").locator("input").blur();
  await waitForSynced(page);
  await expect.poll(() => sql("SELECT value FROM body_metrics WHERE source = 'manual'"), { timeout: 20_000 }).toEqual([{ value: 181.4 }]);
  await expect(status(page)).toHaveAttribute("data-phase", "waiting");
  expect(sql("SELECT COUNT(*) AS n FROM session_reports")).toEqual([{ n: 0 }]);
  // The Apple Health workout arrives (attached to the session as from the Watch screen): written at once.
  const [{ id, started_at, ended_at }] = sql("SELECT id, started_at, ended_at FROM workout_sessions") as { id: string; started_at: string; ended_at: string }[];
  sql(
    `INSERT INTO health_workouts (id, external_key, activity_type, started_at, ended_at, duration_sec, active_kcal, total_kcal, hr_avg, hr_max, matched_session_id, raw, received_at)
     VALUES ('01E2EWATCH', 'e2e-watch', 'Traditional Strength Training', '${started_at}', '${ended_at}', 600, 120, NULL, 118, 141, NULL, '{}', '${ended_at}')`
  );
  const res = await page.request.put(`${baseURL}/api/health/workouts/01E2EWATCH/match`, { headers: { Origin: baseURL! }, data: { session_id: id } });
  expect(res.status()).toBe(200);
  await expect(status(page)).toHaveAttribute("data-phase", "ready", { timeout: 40_000 });
  expect(sql("SELECT COUNT(*) AS n FROM session_reports WHERE status = 'ok'")).toEqual([{ n: 1 }]);
  sql("DELETE FROM health_workouts WHERE external_key LIKE 'e2e-%'; DELETE FROM body_metrics WHERE source = 'manual'");
});

test("finishing offline still works: the report is pending until the session reaches the server, then waits for its timing rule", async ({ page, context }) => {
  await startDay1(page);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null || !("serviceWorker" in navigator), null, { timeout: 15_000 }).catch(() => undefined);
  await setOffline(context, page, true);
  await page.getByTestId("finish").click();
  await expect(page.getByTestId("report-pending")).toContainText("Report pending");
  expect(sql("SELECT COUNT(*) AS n FROM session_reports")).toEqual([{ n: 0 }]);
  await setOffline(context, page, false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForSynced(page);
  await writeNowAndOpen(page);
  await expect(report(page)).toHaveAttribute("data-phase", "ready");
});

/** Exercise ids of the planner list, in order. */
const planOrder = (page: Page) =>
  page
    .getByTestId("plan-list")
    .locator("[data-testid^='pitem-']")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice("pitem-".length)));

test("Get advice with a mocked model shows a suggestion; Apply adds the exercise at its position; Undo; offline needs a connection", async ({ page, context }) => {
  await page.goto("/");
  await page.getByTestId("plan-session").click();
  await expect(page.getByTestId("planner")).toBeVisible();
  const before = await planOrder(page);
  expect(before).toEqual(["bench", "incline_db", "rdl", "cable_row", "lateral", "facepull"]);

  await page.getByTestId("plan-advice").click();
  const card = page.getByTestId("advice-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("advice-assessment")).toHaveAttribute("dir", "rtl");
  // Get advice saved the plan first.
  await expect(page.getByTestId("plan-state")).toHaveText("Planned");
  expect((await aiCalls()).by_kind.advice).toMatchObject({ kind: "advice", effort: "medium" });
  const sug = page.getByTestId("advice-sug-0");
  await expect(sug).toHaveAttribute("data-type", "add");
  await expect(sug).toContainText("at #2");

  await page.getByTestId("advice-apply-0").click();
  const after = await planOrder(page);
  expect(after).toHaveLength(7);
  expect(after.filter((x) => !before.includes(x))).toHaveLength(1);
  const added = after[1];
  expect(before).not.toContain(added);
  await expect(sug).toContainText("Applied");
  await expect(page.getByTestId("plan-state")).toHaveText("Unsaved changes");

  await page.getByTestId("advice-undo-0").click();
  expect(await planOrder(page)).toEqual(before);
  await page.getByTestId("advice-apply-0").click();
  await page.getByTestId("plan-save").click();
  await waitForSynced(page);
  expect(sql(`SELECT exercise_id, origin, position FROM session_plan_items WHERE removed_at IS NULL AND exercise_id = '${added}'`)).toEqual([{ exercise_id: added, origin: "ai", position: 1 }]);
  expect(sql("SELECT status FROM plan_advice")).toEqual([{ status: "ok" }]);

  // Offline: the button is disabled with "Needs connection".
  await page.getByTestId("open-plan").click();
  await setOffline(context, page, true);
  await expect(page.getByTestId("plan-advice")).toBeDisabled();
  await expect(page.getByTestId("advice-offline")).toHaveText("Needs connection");
  await setOffline(context, page, false);
});

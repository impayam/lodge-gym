import { expect, test } from "./fixtures";
import { resetWorkouts, setOffline, signIn, sql, waitForSynced } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  sql("DELETE FROM exercises WHERE source = 'custom'");
  await signIn(context, baseURL!);
});

test("library: search, filters, detail with media, muscles, instructions, form video and history", async ({ page }) => {
  // A finished bench session so the detail shows history.
  const day = "2026-09-20";
  sql(
    `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
     VALUES ('01LIBH', 'D1', '${day}', '${day}T23:00:00.000Z', '${day}T23:55:00.000Z', 'done', 'lb', '', '${day}T23:00:00.000Z', '${day}T23:55:00.000Z', 'app')`
  );
  sql(`INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, updated_at) VALUES
       ('01LB0', '01LIBH', 'bench', 0, 135, 5, NULL, 1, '${day}T23:10:00.000Z'), ('01LB1', '01LIBH', 'bench', 1, 140, 5, NULL, 1, '${day}T23:12:00.000Z')`);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Library" }).click();
  const list = page.getByTestId("library");
  await expect(list.getByTestId("library-count")).toHaveText(/^\d+ exercises$/);
  await list.getByRole("searchbox", { name: "Search exercises" }).fill("trap bar");
  await expect(list.getByTestId("library-row")).toHaveCount(1);
  await list.getByTestId("library-row").click();
  const detail = page.getByTestId("exercise-detail");
  await expect(detail.getByRole("heading", { name: "Trap Bar Deadlift" })).toBeVisible();
  await expect(detail).toContainText("Barbell");
  await expect(detail).toContainText("Hinge");
  await expect(detail.getByTestId("media-placeholder")).toBeVisible();
  await expect(detail.getByRole("link", { name: "Watch form video ↗" })).toHaveAttribute("href", "https://www.youtube.com/results?search_query=Trap%20Bar%20Deadlift%20form");
  await expect(detail.locator("ol.rules li").first()).toBeVisible();
  await expect(detail.getByTestId("exercise-history")).toContainText("No sets logged");
  await detail.getByRole("button", { name: "← Back to the library" }).click();

  // Filters: muscle + equipment + pattern.
  await list.getByRole("searchbox").fill("");
  await list.getByRole("combobox", { name: "Equipment" }).selectOption("barbell");
  await list.getByRole("combobox", { name: "Pattern" }).selectOption("h_push");
  await list.getByRole("combobox", { name: "Muscle" }).selectOption("chest");
  const rows = list.getByTestId("library-row");
  const bench = rows.filter({ has: page.locator("b", { hasText: /^Barbell Bench Press$/ }) });
  await expect(bench).toHaveCount(1);
  await expect(rows.filter({ hasText: "Incline Barbell Bench Press" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Dumbbell" })).toHaveCount(0);

  // Seeded exercise enriched from the library: images from R2 through the Worker, history from every program.
  await bench.click();
  const imgs = detail.locator(".exmedia img");
  await expect(imgs).toHaveCount(2);
  await expect(imgs.first()).toHaveAttribute("src", "/api/library/media/library/free-exercise-db/images/Barbell_Bench_Press_-_Medium_Grip/0.jpg");
  await expect.poll(() => imgs.first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  await expect(detail).toContainText("Front delts, Triceps");
  await expect(detail.getByTestId("best-e1rm")).toContainText("163.3 lb (140×5");
});

test("adding an extra exercise offline syncs exactly once; it can be removed while no set is done", async ({ page, context }) => {
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null || !("serviceWorker" in navigator), null, { timeout: 15_000 }).catch(() => undefined);
  // Load the library once online so the picker works offline from the cached copy.
  await page.getByRole("navigation").getByRole("button", { name: "Library" }).click();
  await expect(page.getByTestId("library-count")).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "Train" }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await setOffline(context, page, true);

  await page.getByTestId("add-exercise").click();
  const picker = page.getByTestId("exercise-picker");
  await picker.getByRole("searchbox").fill("hack squat");
  await picker.getByTestId("library-row").filter({ hasText: /^Hack Squat/ }).click();
  const card = page.locator('[data-ex="fedb-Hack_Squat"]');
  await expect(card).toContainText("Extra");
  await expect(card).toContainText("no target");
  await expect(card.locator(".setrow")).toHaveCount(3);
  await card.getByTestId("w-fedb-Hack_Squat-0").locator("input").fill("90");
  await card.getByTestId("r-fedb-Hack_Squat-0").locator("input").fill("10");
  await page.getByTestId("check-fedb-Hack_Squat-0").click();
  await expect(card.getByRole("button", { name: "Remove exercise" })).toHaveCount(0);

  // A second extra exercise, removed before any set is done.
  await page.getByTestId("add-exercise").click();
  await picker.getByRole("searchbox").fill("leg extensions");
  await picker.getByTestId("library-row").first().click();
  await page.getByTestId("remove-fedb-Leg_Extensions").click();
  await expect(page.locator('[data-ex="fedb-Leg_Extensions"]')).toHaveCount(0);
  expect(sql("SELECT COUNT(*) AS n FROM set_entries WHERE is_extra = 1")).toEqual([{ n: 0 }]);

  await setOffline(context, page, false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForSynced(page);
  await page.getByTestId("sync-chip").click();
  await page.reload();
  await waitForSynced(page);
  expect(sql("SELECT exercise_id, COUNT(*) AS n, SUM(done) AS done, MIN(position) AS pos FROM set_entries WHERE is_extra = 1 GROUP BY exercise_id")).toEqual([
    { exercise_id: "fedb-Hack_Squat", n: 3, done: 1, pos: 0 },
  ]);
  expect(sql("SELECT weight, reps FROM set_entries WHERE exercise_id = 'fedb-Hack_Squat' AND done = 1")).toEqual([{ weight: 90, reps: 10 }]);
  // The program did not change.
  expect(sql("SELECT COUNT(*) AS n FROM day_exercises WHERE exercise_id = 'fedb-Hack_Squat'")).toEqual([{ n: 0 }]);
});

test("custom exercise: create with secondary muscles, find it in the picker, archive it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Library" }).click();
  await page.getByTestId("new-custom").click();
  const form = page.getByTestId("custom-form");
  await form.getByLabel("Name").fill("Machine Chest-Supported Row");
  await form.getByLabel("Primary muscle").selectOption("back_upper");
  await form.getByLabel("Biceps").check();
  await form.getByLabel("Rear delts").check();
  await form.getByLabel("Equipment").selectOption("machine");
  await form.getByLabel("Pattern").selectOption("h_pull");
  await form.getByRole("button", { name: "Save" }).click();
  const detail = page.getByTestId("exercise-detail");
  await expect(detail.getByRole("heading", { name: "Machine Chest-Supported Row" })).toBeVisible();
  await expect(detail).toContainText("Your exercise");
  await expect(detail).toContainText("Biceps, Rear delts");
  await expect(detail.getByTestId("media-placeholder")).toBeVisible();
  expect(sql("SELECT source, muscle_primary, muscles_secondary, equipment, pattern, archived_at FROM exercises WHERE name_en = 'Machine Chest-Supported Row'")).toEqual([
    { source: "custom", muscle_primary: "back_upper", muscles_secondary: '["biceps","rear_delts"]', equipment: "machine", pattern: "h_pull", archived_at: null },
  ]);
  await detail.getByTestId("archive").click();
  await expect(detail.getByTestId("archive")).toHaveText("Restore");
  await detail.getByRole("button", { name: "← Back to the library" }).click();
  await page.getByTestId("library").getByRole("searchbox").fill("chest-supported row");
  await expect(page.getByTestId("library").getByTestId("library-row").filter({ hasText: "Machine Chest-Supported Row" })).toHaveCount(0);
  expect((sql("SELECT archived_at IS NOT NULL AS a FROM exercises WHERE name_en = 'Machine Chest-Supported Row'") as { a: number }[])[0].a).toBe(1);
});

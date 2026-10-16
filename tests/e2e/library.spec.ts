import { expect, test } from "./fixtures";
import { resetWorkouts, setOffline, signIn, sql, waitForSynced, goTo, enterSet, openMore, closeMore } from "./helpers";

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
  await goTo(page, "Library");
  const list = page.getByTestId("library");
  // The header carries the total; the line under the chips names the chip (mockup 05).
  await expect(page.getByTestId("library-tab").locator(".page-head__sub")).toHaveText(/^\d+ exercises$/);
  await expect(list.getByTestId("library-count")).toHaveText("All exercises");
  await list.getByTestId("group-chest").click();
  await expect(list.getByTestId("library-count")).toHaveText(/^Chest, \d+ exercises$/);
  // A logged exercise's icon is violet (data); one never logged is grey; no other accent (Payam, 2026-10-15).
  const icon = (id: string) => list.locator(`[data-testid="library-row"][data-id="${id}"] .icon-well`);
  await expect(icon("bench")).toHaveClass(/(^| )t-violet( |$)/);
  await expect(icon("incline_bb")).toHaveClass(/(^| )icon-well--off( |$)/);
  await expect(list.locator('[data-testid="library-row"] .icon-well:is(.t-pink, .t-orange)')).toHaveCount(0);
  await list.getByTestId("group-all").click();
  // Every word must be in the name: Trap Bar Deadlift and Liftosaur's Trap Bar Deficit Deadlift.
  await list.getByRole("searchbox", { name: "Search exercises" }).fill("trap bar deficit");
  await expect(list.getByTestId("library-row")).toHaveCount(1);
  await expect(list.getByTestId("library-count")).toHaveText("1 exercise");
  await list.getByRole("searchbox", { name: "Search exercises" }).fill("trap bar");
  await expect(list.getByTestId("library-count")).toHaveText("2 exercises");
  await list
    .getByTestId("library-row")
    .filter({ has: page.locator("b", { hasText: /^Trap Bar Deadlift$/ }) })
    .click();
  const detail = page.getByTestId("exercise-detail");
  await expect(detail.getByRole("heading", { name: "Trap Bar Deadlift" })).toBeVisible();
  await expect(detail).toContainText("Barbell");
  await expect(detail).toContainText("Hinge");
  await expect(detail.getByTestId("media-placeholder")).toBeVisible();
  await expect(detail.getByRole("link", { name: "Watch form video ↗" })).toHaveAttribute("href", "https://www.youtube.com/results?search_query=Trap%20Bar%20Deadlift%20form");
  await expect(detail.locator("ol li").first()).toBeVisible();
  await expect(detail.getByTestId("exercise-history")).toContainText("No sets logged");
  await expect(detail.getByTestId("category")).toHaveText("Strength");
  await expect(detail.getByTestId("not-counted")).toHaveCount(0);
  await detail.getByRole("button", { name: "Back to the library" }).click();

  // Stretching stays in the library and can be logged, but counts 0 sets (SPEC-v2 §7.4).
  await list.getByRole("searchbox", { name: "Search exercises" }).fill("hamstring stretch");
  await list
    .getByTestId("library-row")
    .filter({ has: page.locator("b", { hasText: /^Hamstring Stretch$/ }) })
    .click();
  await expect(detail.getByTestId("category")).toHaveText("Stretching");
  await expect(detail.getByTestId("not-counted")).toContainText("Not counted in volume");
  await detail.getByRole("button", { name: "Back to the library" }).click();

  // Filters (behind "Filters"): muscle + equipment + pattern.
  await list.getByRole("searchbox").fill("");
  await list.getByTestId("library-filters").click();
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
  const imgs = detail.locator(".media-frame img");
  await expect(imgs).toHaveCount(2);
  await expect(imgs.first()).toHaveAttribute("src", "/api/library/media/library/free-exercise-db/images/Barbell_Bench_Press_-_Medium_Grip/0.jpg");
  await expect.poll(() => imgs.first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  await expect(detail).toContainText("Front delts, Triceps");
  await expect(detail.getByTestId("best-e1rm")).toContainText("163.3 lb (140×5");
});

test("regions (SPEC-v11 M14): chips under a muscle group, regions and licence on the detail, New to me", async ({ page }) => {
  // Bench logged months ago (older than the 60 days the app keeps): "New to me" must load the older history to hide it.
  const day = "2026-03-02";
  sql(
    `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
     VALUES ('01LIBR', 'D1', '${day}', '${day}T17:00:00.000Z', '${day}T17:55:00.000Z', 'done', 'lb', '', '${day}T17:00:00.000Z', '${day}T17:55:00.000Z', 'app')`
  );
  sql(`INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, updated_at) VALUES ('01LR0', '01LIBR', 'bench', 0, 135, 5, NULL, 1, '${day}T17:10:00.000Z')`);
  await page.goto("/");
  await goTo(page, "Library");
  const list = page.getByTestId("library");
  const rows = list.getByTestId("library-row");
  const row = (name: string) => rows.filter({ has: page.locator("b", { hasText: new RegExp(`^${name}$`) }) });
  // No region chips on "All"; a group shows its regions, and picking one filters to its main focus.
  await expect(list.getByTestId("region-chips")).toHaveCount(0);
  await list.getByTestId("group-chest").click();
  const chips = list.getByTestId("region-chips");
  await expect(chips.getByRole("button")).toHaveText(["Upper", "Middle", "Lower"]);
  await chips.getByTestId("region-chest_upper").click();
  await expect(chips.getByTestId("region-chest_upper")).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByTestId("library-count")).toHaveText(/^Chest \(upper\), \d+ exercises$/);
  await expect(row("Incline Barbell Bench Press")).toHaveCount(1);
  await expect(row("Barbell Bench Press")).toHaveCount(0);
  await chips.getByTestId("region-chest_upper").click();
  await expect(list.getByTestId("library-count")).toHaveText(/^Chest, \d+ exercises$/);
  await expect(row("Barbell Bench Press")).toHaveCount(1);
  // Another group: its own regions, the chest pick is gone.
  await chips.getByTestId("region-chest_lower").click();
  await list.getByTestId("group-back").click();
  await expect(chips.getByTestId("region-back_lats")).toHaveAttribute("aria-pressed", "false");
  await expect(chips.getByTestId("region-chest_lower")).toHaveCount(0);
  await expect(list.getByTestId("library-count")).toHaveText(/^Back, \d+ exercises$/);

  // Detail: the regions with emphasis and evidence, main focus first.
  await list.getByTestId("group-chest").click();
  await row("Incline Barbell Bench Press").click();
  const detail = page.getByTestId("exercise-detail");
  const regions = detail.getByTestId("exercise-regions");
  await expect(regions.locator(".list-row").first()).toHaveAttribute("data-region", "chest_upper");
  await expect(regions.locator(".list-row").first()).toHaveAttribute("data-emphasis", "primary");
  await expect(regions.locator(".list-row").first()).toContainText("Upper chest");
  await expect(regions.locator(".list-row").first()).toContainText("Main focus · moderate evidence");
  await expect(regions.locator('[data-region="chest_mid"]')).toContainText("Also trained · moderate evidence");
  await expect(detail.getByTestId("evidence-note")).toBeVisible();
  await expect(detail.getByTestId("source")).toContainText("Program");
  await expect(detail.getByTestId("licence")).toHaveCount(0);
  await detail.getByRole("button", { name: "Back to the library" }).click();

  // A wger row: its licence and author, a link to the licence; images that cannot load are not shown.
  await list.getByTestId("group-all").click();
  await list.getByRole("searchbox", { name: "Search exercises" }).fill("dumbbell goblet squat");
  await row("Dumbbell Goblet Squat").click();
  await expect(detail.getByTestId("source")).toContainText("wger");
  await expect(detail.getByTestId("licence")).toContainText("CC BY-SA 4.0 · ataraxie67");
  await expect(detail.getByTestId("licence").getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by-sa/4.0/");
  await expect(detail.getByTestId("media-placeholder")).toBeVisible();
  await expect(detail.getByTestId("image-credit")).toHaveCount(0);
  await expect(detail.getByTestId("exercise-regions").locator('[data-emphasis="primary"]')).toHaveAttribute("data-region", "quads_squat");
  await expect(detail.locator("ol li")).toHaveCount(3);
  await detail.getByRole("button", { name: "Back to the library" }).click();
  // Facts-only source: no licence row; stretching from a new source: no regions.
  await list.getByRole("searchbox", { name: "Search exercises" }).fill("front neck stretch");
  await row("Front Neck Stretch").click();
  await expect(detail.getByTestId("category")).toHaveText("Stretching");
  await expect(detail.getByTestId("exercise-regions")).toHaveCount(0);
  await detail.getByRole("button", { name: "Back to the library" }).click();

  // New to me: hides exercises with a done set, from all of history.
  await list.getByRole("searchbox", { name: "Search exercises" }).fill("");
  await list.getByTestId("group-chest").click();
  await list.getByTestId("library-filters").click();
  await list.getByTestId("new-to-me").click();
  await expect(list.getByTestId("new-to-me")).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByTestId("new-to-me-note")).toHaveText("Exercises you have never logged.");
  await expect(list.getByTestId("library-filters")).toHaveText("Filters (1)");
  await expect(row("Barbell Bench Press")).toHaveCount(0);
  await expect(row("Incline Barbell Bench Press")).toHaveCount(1);
  await list.getByTestId("new-to-me").click();
  await expect(row("Barbell Bench Press")).toHaveCount(1);
});

test("filters: every option of the three dropdowns shows in full at iPhone width", async ({ page }) => {
  await page.goto("/");
  await goTo(page, "Library");
  const list = page.getByTestId("library");
  await list.getByTestId("library-filters").click();
  for (const name of ["Muscle", "Equipment", "Pattern"]) {
    const select = list.getByRole("combobox", { name });
    await expect(select).toBeVisible();
    // The widest option, in the dropdown's own font, against the room left of the chevron.
    const { widest, room } = await select.evaluate((el: HTMLSelectElement) => {
      const cs = getComputedStyle(el);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const widest = Math.max(...[...el.options].map((o) => ctx.measureText(o.text).width));
      return { widest, room: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
    });
    expect(widest, name).toBeLessThanOrEqual(room);
  }
});

test("adding an extra exercise offline syncs exactly once; it can be removed while no set is done", async ({ page, context }) => {
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null || !("serviceWorker" in navigator), null, { timeout: 15_000 }).catch(() => undefined);
  // Load the library once online so the picker works offline from the cached copy.
  await goTo(page, "Library");
  await expect(page.getByTestId("library-count")).toBeVisible();
  await goTo(page, "Train");
  await page.getByTestId("start").click();
  await setOffline(context, page, true);

  await (await openMore(page)).getByTestId("add-exercise").click();
  const picker = page.getByTestId("exercise-picker");
  // The picker opens on the body map (SPEC-v3 M9b); search is its second tab.
  await picker.getByTestId("picker-tab-search").click();
  await picker.getByRole("searchbox").fill("hack squat");
  await picker.locator('[data-testid="library-row"][data-id="fedb-Hack_Squat"]').click();
  const card = page.locator('[data-ex="fedb-Hack_Squat"]');
  await expect(card).toContainText("Added today");
  await expect(card).toContainText("no target");
  await expect(card.locator(".set-row")).toHaveCount(3);
  await enterSet(page, "fedb-Hack_Squat", 0, "w", "90");
  await enterSet(page, "fedb-Hack_Squat", 0, "r", "10");
  await page.getByTestId("check-fedb-Hack_Squat-0").click();
  await expect(card.getByRole("button", { name: "Remove exercise" })).toHaveCount(0);

  // A second extra exercise, removed before any set is done.
  await (await openMore(page)).getByTestId("add-exercise").click();
  // The picker remembers the tab it was left on in this session.
  await expect(picker.getByTestId("picker-tab-search")).toHaveAttribute("aria-selected", "true");
  await picker.getByRole("searchbox").fill("leg extensions");
  await picker.getByTestId("library-row").first().click();
  await page.getByTestId("remove-fedb-Leg_Extensions").click();
  await expect(page.locator('[data-ex="fedb-Leg_Extensions"]')).toHaveCount(0);
  expect(sql("SELECT COUNT(*) AS n FROM set_entries WHERE is_extra = 1")).toEqual([{ n: 0 }]);

  await setOffline(context, page, false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForSynced(page);
  // Sync again by hand (the session's sync status is in its More sheet): nothing is duplicated.
  await (await openMore(page)).getByTestId("sync-chip").click();
  await closeMore(page);
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
  await goTo(page, "Library");
  await page.getByTestId("new-custom").click();
  const form = page.getByTestId("custom-form");
  await form.getByLabel("Name").fill("Lodge Chest-Supported Row");
  await form.getByLabel("Primary muscle").selectOption("back_upper");
  await form.getByLabel("Biceps").check();
  await form.getByLabel("Rear delts").check();
  await form.getByLabel("Equipment").selectOption("machine");
  await form.getByLabel("Pattern").selectOption("h_pull");
  await form.getByRole("button", { name: "Save" }).click();
  const detail = page.getByTestId("exercise-detail");
  await expect(detail.getByRole("heading", { name: "Lodge Chest-Supported Row" })).toBeVisible();
  await expect(detail).toContainText("Your exercise");
  await expect(detail).toContainText("Biceps, Rear delts");
  await expect(detail.getByTestId("media-placeholder")).toBeVisible();
  await expect(detail.getByTestId("category")).toHaveText("Strength");
  await expect(detail.getByTestId("not-counted")).toHaveCount(0);
  expect(sql("SELECT source, muscle_primary, muscles_secondary, equipment, pattern, category, archived_at FROM exercises WHERE name_en = 'Lodge Chest-Supported Row'")).toEqual([
    { source: "custom", muscle_primary: "back_upper", muscles_secondary: '["biceps","rear_delts"]', equipment: "machine", pattern: "h_pull", category: "strength", archived_at: null },
  ]);

  // Category select (SPEC-v2 §7.4): a non-strength category is logged but not counted in volume.
  await detail.getByRole("button", { name: "Edit" }).click();
  await form.getByLabel("Category").selectOption("plyometrics");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(detail.getByTestId("category")).toHaveText("Plyometrics");
  await expect(detail.getByTestId("not-counted")).toContainText("Not counted in volume");
  expect(sql("SELECT category FROM exercises WHERE name_en = 'Lodge Chest-Supported Row'")).toEqual([{ category: "plyometrics" }]);
  await detail.getByTestId("archive").click();
  await expect(detail.getByTestId("archive")).toHaveText("Restore");
  await detail.getByRole("button", { name: "Back to the library" }).click();
  await page.getByTestId("library").getByRole("searchbox").fill("lodge chest-supported row");
  await expect(page.getByTestId("library").getByTestId("library-row").filter({ hasText: "Lodge Chest-Supported Row" })).toHaveCount(0);
  expect((sql("SELECT archived_at IS NOT NULL AS a FROM exercises WHERE name_en = 'Lodge Chest-Supported Row'") as { a: number }[])[0].a).toBe(1);
});

import { expect, test, type Locator, type Page } from "./fixtures";
import { resetPrograms, resetWorkouts, setOffline, signIn, sql, waitForSynced } from "./helpers";

// SPEC-v3 M9c: the session planner (no AI). Plan Day 1 offline, save, reopen and start it; reorder and delete during
// the session (blocked once a set is done); supersets and tri-sets with the rest timer after the round only; discard
// and Apply to program.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  resetPrograms();
  await signIn(context, baseURL!);
});
test.afterAll(() => {
  resetWorkouts();
  resetPrograms();
});

/** Exercise ids of the plan list (planner or session panel), in order. */
const planOrder = (page: Page) =>
  page
    .getByTestId("plan-list")
    .locator("[data-testid^='pitem-']")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice("pitem-".length)));
/** Exercise ids of the session's cards, in order. */
const cardOrder = (page: Page) => page.locator("article.ex").evaluateAll((els) => els.map((e) => e.getAttribute("data-ex")!));
const item = (page: Page, id: string) => page.getByTestId(`pitem-${id}`);
/** Opens an item's actions (tap on its name). */
const openItem = (page: Page, id: string) => item(page, id).locator(".pname").click();

/** Drags a handle past the middle of another element, in small steps like a finger. */
async function dragTo(page: Page, handle: Locator, target: Locator) {
  await handle.scrollIntoViewIfNeeded();
  const h = (await handle.boundingBox())!;
  const t = (await target.boundingBox())!;
  const x = h.x + h.width / 2;
  const y0 = h.y + h.height / 2;
  // Past the target's middle: its upper quarter when moving up, its lower quarter when moving down.
  const y1 = t.y + t.height * (t.y < h.y ? 0.25 : 0.75);
  await page.mouse.move(x, y0);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, y0 + ((y1 - y0) * i) / steps);
  await page.mouse.up();
}

async function pickBySearch(page: Page, query: string, name: RegExp) {
  const picker = page.getByTestId("exercise-picker");
  await picker.getByTestId("picker-tab-search").click();
  await picker.getByRole("searchbox").fill(query);
  await picker.getByTestId("library-row").filter({ has: page.locator("b", { hasText: name }) }).first().click();
  await expect(picker).toHaveCount(0);
}

test("plan Day 1 offline (replace, delete, reorder), save, start it; reorder in the session; a done exercise can't be deleted", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toContainText("Next session: Day 1 · Chest");
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null || !("serviceWorker" in navigator), null, { timeout: 15_000 }).catch(() => undefined);
  // The phone has opened the exercise library online before, so it is cached for offline search.
  await page.getByRole("navigation").getByRole("button", { name: "Library" }).click();
  await expect(page.getByTestId("library-count")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation").getByRole("button", { name: "Train" }).click();
  await setOffline(context, page, true);

  await page.getByTestId("plan-session").click();
  await expect(page.getByTestId("planner")).toContainText("Day 1 · Chest");
  await expect(page.getByTestId("plan-state")).toHaveText("Not saved");
  // An unedited plan shows its day's estimate.
  await expect(page.getByTestId("plan-estimate")).toHaveText("6 exercises · about 60 min");
  expect(await planOrder(page)).toEqual(["bench", "incline_db", "rdl", "cable_row", "lateral", "facepull"]);
  await expect(page.getByTestId("pgroup-A")).toContainText("Superset A");

  // Replace the incline press (search tab); the slot keeps 3 × 10 and 120 s.
  await openItem(page, "incline_db");
  await page.getByTestId("pedit-incline_db").getByRole("button", { name: "Replace" }).click();
  await expect(page.getByTestId("exercise-picker")).toContainText("Replace Incline Dumbbell Press");
  await pickBySearch(page, "incline barbell", /^Incline Barbell Bench Press/);
  await expect(item(page, "incline_bb")).toContainText("3 × 10 · rest 120 s");
  await expect(item(page, "incline_bb")).toContainText("instead of Incline Dumbbell Press");

  // Delete one exercise.
  await openItem(page, "rdl");
  await page.getByTestId("pedit-rdl").getByRole("button", { name: "Remove" }).click();
  await expect(item(page, "rdl")).toHaveCount(0);

  // Reorder two ways: the arrow button, and dragging the superset by its handle above the incline press.
  await item(page, "cable_row").getByRole("button", { name: "Move Seated Cable Row up" }).click();
  expect(await planOrder(page)).toEqual(["bench", "cable_row", "incline_bb", "lateral", "facepull"]);
  await dragTo(page, page.getByTestId("handle-gA"), item(page, "incline_bb"));
  expect(await planOrder(page)).toEqual(["bench", "cable_row", "lateral", "facepull", "incline_bb"]);

  // Edit sets of one exercise.
  await openItem(page, "cable_row");
  await page.getByRole("button", { name: "Increase Sets, Seated Cable Row" }).click();
  await expect(item(page, "cable_row")).toContainText("4 × 10");

  // The estimate follows the edits: − RDL 3 × (150 + 40) s, + 1 cable-row set (90 + 40) s: 60 min − 7⅓ ≈ 53.
  await expect(page.getByTestId("plan-estimate")).toHaveText("5 exercises · about 53 min");
  await page.getByTestId("plan-save").click();
  await expect(page.getByTestId("planned-label")).toHaveText("Planned: Day 1 · Chest (edited)");
  await expect(page.getByTestId("next-card")).toContainText("5 exercises · about 53 min");
  await expect(page.getByTestId("sync-chip")).toContainText("Offline");

  await setOffline(context, page, false);
  await waitForSynced(page);
  await expect
    .poll(() => sql("SELECT program_day_id, status, started_at FROM planned_sessions"), { timeout: 20_000 })
    .toEqual([{ program_day_id: "D1", status: "planned", started_at: null }]);
  await expect.poll(() => sql("SELECT exercise_id, sets, origin FROM session_plan_items WHERE removed_at IS NULL ORDER BY position"), { timeout: 20_000 }).toEqual([
    { exercise_id: "bench", sets: 4, origin: "program" },
    { exercise_id: "cable_row", sets: 4, origin: "program" },
    { exercise_id: "lateral", sets: 3, origin: "program" },
    { exercise_id: "facepull", sets: 3, origin: "program" },
    { exercise_id: "incline_bb", sets: 3, origin: "replaced" },
  ]);
  expect(sql("SELECT exercise_id FROM session_plan_items WHERE removed_at IS NOT NULL")).toEqual([{ exercise_id: "rdl" }]);
  // Planning is not training: no session yet.
  expect(sql("SELECT COUNT(*) AS n FROM workout_sessions")).toEqual([{ n: 0 }]);

  // Reopen after a reload, then start at the gym.
  await page.reload();
  await page.getByTestId("open-plan").click();
  await expect(page.getByTestId("plan-state")).toHaveText("Planned · edited");
  expect(await planOrder(page)).toEqual(["bench", "cable_row", "lateral", "facepull", "incline_bb"]);
  await page.getByTestId("plan-start").click();
  await expect(page.getByTestId("elapsed")).toBeVisible();
  expect(await cardOrder(page)).toEqual(["bench", "cable_row", "lateral", "facepull", "incline_bb"]);
  await expect(page.locator('[data-ex="cable_row"] .setrow')).toHaveCount(4);
  await expect(page.getByTestId("sgroup-A")).toContainText("Superset A");

  // Log a set.
  await page.getByTestId("w-bench-0").locator("input").fill("135");
  await page.getByTestId("check-bench-0").click();
  await expect(page.getByTestId("rest-timer")).toContainText("Rest after Barbell Bench Press");
  await page.getByTestId("rest-timer").getByRole("button", { name: "Close" }).click();

  // Reorder during the session.
  await page.getByTestId("arrange").click();
  await item(page, "incline_bb").getByRole("button", { name: "Move Incline Barbell Bench Press up" }).click();
  expect(await planOrder(page)).toEqual(["bench", "cable_row", "incline_bb", "lateral", "facepull"]);
  await expect(item(page, "bench")).toContainText("1 of 4 sets done");

  // Deleting an exercise with a done set is blocked; one without done sets goes.
  await openItem(page, "bench");
  await item(page, "bench").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("status")).toContainText("Barbell Bench Press has done sets. Uncheck them first");
  await expect(item(page, "bench")).toHaveCount(1);
  await openItem(page, "cable_row");
  await item(page, "cable_row").getByRole("button", { name: "Remove" }).click();
  await expect(item(page, "cable_row")).toHaveCount(0);
  await page.getByTestId("arrange-panel").getByRole("button", { name: "Done", exact: true }).click();
  expect(await cardOrder(page)).toEqual(["bench", "incline_bb", "lateral", "facepull"]);

  // "− Remove set" removes only undone sets.
  const bench = page.locator('[data-ex="bench"]');
  for (let i = 0; i < 3; i++) await bench.getByRole("button", { name: "− Remove set" }).click();
  await expect(bench.locator(".setrow")).toHaveCount(1);
  await expect(bench.getByRole("button", { name: "− Remove set" })).toHaveCount(0);

  await waitForSynced(page);
  const planId = (sql("SELECT id FROM planned_sessions") as { id: string }[])[0].id;
  await expect.poll(() => sql("SELECT id, status FROM workout_sessions"), { timeout: 20_000 }).toEqual([{ id: planId, status: "active" }]);
  await expect.poll(() => sql("SELECT status FROM planned_sessions"), { timeout: 20_000 }).toEqual([{ status: "started" }]);
  await expect
    .poll(() => sql("SELECT exercise_id FROM session_plan_items WHERE removed_at IS NULL ORDER BY position"), { timeout: 20_000 })
    .toEqual(["bench", "incline_bb", "lateral", "facepull"].map((exercise_id) => ({ exercise_id })));
  expect(sql("SELECT COUNT(*) AS n FROM set_entries WHERE exercise_id = 'cable_row'")).toEqual([{ n: 0 }]);
  expect(sql("SELECT done, weight FROM set_entries WHERE exercise_id = 'bench'")).toEqual([{ done: 1, weight: 135 }]);
});

test("tri-set of three chest exercises (no warning): A1 → A2 → A3, rest only after A3; ungroup restores normal rest", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  // The day's own superset (A1/A2) already rests after the round only.
  await page.getByTestId("check-lateral-0").click();
  await expect(page.getByTestId("rest-timer")).toHaveCount(0);
  await page.getByTestId("check-facepull-0").click();
  await expect(page.getByTestId("rest-timer")).toContainText("Rest after Superset A");
  await page.getByTestId("rest-timer").getByRole("button", { name: "Close" }).click();

  // A third chest exercise, added during the session.
  await page.getByTestId("add-exercise").click();
  await pickBySearch(page, "cable chest fly", /^Cable Chest Fly/);

  await page.getByTestId("arrange").click();
  for (const id of ["bench", "incline_db", "fly"]) await item(page, id).getByRole("checkbox").check();
  await expect(page.getByTestId("groupbar")).toContainText("3 selected");
  await page.getByTestId("groupbar").getByRole("button", { name: "Group as tri-set" }).click();
  // No warning of any kind for a same-muscle group.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/warning|same muscle|compet/i)).toHaveCount(0);
  await expect(page.getByTestId("pgroup-A")).toContainText("Tri-set A");
  expect(await planOrder(page)).toEqual(["bench", "incline_db", "fly", "rdl", "cable_row", "lateral", "facepull"]);
  await expect(page.getByTestId("pgroup-B")).toContainText("Superset B");
  await page.getByTestId("arrange-panel").getByRole("button", { name: "Done", exact: true }).click();

  const tri = page.getByTestId("sgroup-A");
  await expect(tri).toContainText("Tri-set A");
  await expect(tri.locator(".tag")).toHaveText(["A1", "A2", "A3"]);
  await expect(tri).toContainText("rest 180 s after each round");

  // Round 1: A1, A2, A3; the timer starts only after A3.
  await page.getByTestId("check-bench-0").click();
  await expect(page.getByTestId("rest-timer")).toHaveCount(0);
  await expect(page.locator('[data-set="incline_db-0"]')).toBeInViewport();
  await page.getByTestId("check-incline_db-0").click();
  await expect(page.getByTestId("rest-timer")).toHaveCount(0);
  await page.getByTestId("check-fly-0").click();
  await expect(page.getByTestId("rest-timer")).toContainText("Rest after Tri-set A");
  await page.getByTestId("rest-timer").getByRole("button", { name: "Close" }).click();

  // Ungroup: the order stays and each set rests on its own again.
  await page.getByTestId("arrange").click();
  await page.getByTestId("pgroup-A").getByRole("button", { name: "Ungroup" }).click();
  await page.getByTestId("arrange-panel").getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByTestId("sgroup-A")).toContainText("Superset A");
  expect(await cardOrder(page)).toEqual(["bench", "incline_db", "fly", "rdl", "cable_row", "lateral", "facepull"]);
  await page.getByTestId("check-bench-1").click();
  await expect(page.getByTestId("rest-timer")).toContainText("Rest after Barbell Bench Press");

  // The session got a started plan with its own id (approved default 7); the sets are unchanged.
  await waitForSynced(page);
  const sid = (sql("SELECT id FROM workout_sessions") as { id: string }[])[0].id;
  await expect.poll(() => sql("SELECT id, status, program_day_id FROM planned_sessions"), { timeout: 20_000 }).toEqual([{ id: sid, status: "started", program_day_id: "D1" }]);
  await expect
    .poll(() => sql("SELECT exercise_id, group_tag FROM session_plan_items WHERE removed_at IS NULL ORDER BY position"), { timeout: 20_000 })
    .toEqual([
      { exercise_id: "bench", group_tag: null },
      { exercise_id: "incline_db", group_tag: null },
      { exercise_id: "fly", group_tag: null },
      { exercise_id: "rdl", group_tag: null },
      { exercise_id: "cable_row", group_tag: null },
      { exercise_id: "lateral", group_tag: "A" },
      { exercise_id: "facepull", group_tag: "A" },
    ]);
  expect(sql("SELECT COUNT(*) AS n FROM set_entries WHERE done = 1")).toEqual([{ n: 6 }]);
});

test("discard plan returns the day to the program; Apply to program makes a new active version after a confirm", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("plan-session").click();
  await openItem(page, "rdl");
  await page.getByTestId("pedit-rdl").getByRole("button", { name: "Remove" }).click();
  await page.getByTestId("plan-save").click();
  await expect(page.getByTestId("planned-label")).toHaveText("Planned: Day 1 · Chest (edited)");
  await waitForSynced(page);

  await page.getByTestId("open-plan").click();
  await page.getByTestId("plan-discard").click();
  await page.getByTestId("discard-confirm").getByRole("button", { name: "Yes, discard" }).click();
  await expect(page.getByTestId("next-card")).toContainText("Next session: Day 1 · Chest");
  await waitForSynced(page);
  await expect.poll(() => sql("SELECT status FROM planned_sessions"), { timeout: 20_000 }).toEqual([{ status: "discarded" }]);

  // A new plan for the same day; replace the incline press and group two exercises, then apply.
  await page.getByTestId("plan-session").click();
  await expect(page.getByTestId("plan-apply")).toBeDisabled();
  await openItem(page, "incline_db");
  await page.getByTestId("pedit-incline_db").getByRole("button", { name: "Replace" }).click();
  await pickBySearch(page, "incline barbell", /^Incline Barbell Bench Press/);
  for (const id of ["rdl", "cable_row"]) await item(page, id).getByRole("checkbox").check();
  await page.getByTestId("groupbar").getByRole("button", { name: "Group as superset" }).click();
  await page.getByTestId("plan-apply").click();
  await expect(page.getByTestId("apply-confirm")).toContainText("A new program version becomes active; the current one is archived, not deleted.");
  await page.getByTestId("apply-confirm").getByRole("button", { name: "Yes, apply" }).click();
  await expect(page.getByRole("status")).toContainText("Program updated");
  // The plan now matches the new version's Day 1.
  await expect(page.getByTestId("planned-label")).toHaveText("Planned: Day 1 · Chest");

  const active = sql("SELECT id, generated_by FROM programs WHERE active = 1") as { id: string; generated_by: string }[];
  expect(active).toEqual([{ id: expect.any(String), generated_by: "session" }]);
  expect(sql("SELECT archived_at IS NOT NULL AS archived FROM programs WHERE id = 'fullbody4'")).toEqual([{ archived: 1 }]);
  expect(sql(`SELECT de.exercise_id, de.superset_tag FROM day_exercises de JOIN program_days d ON d.id = de.day_id WHERE d.program_id = '${active[0].id}' AND d.position = 1 ORDER BY de.position`)).toEqual([
    { exercise_id: "bench", superset_tag: null },
    { exercise_id: "incline_bb", superset_tag: null },
    { exercise_id: "rdl", superset_tag: "A1" },
    { exercise_id: "cable_row", superset_tag: "A2" },
    { exercise_id: "lateral", superset_tag: "B1" },
    { exercise_id: "facepull", superset_tag: "B2" },
  ]);
  // The old Day 1 is still there for history.
  expect(sql("SELECT COUNT(*) AS n FROM day_exercises WHERE day_id = 'D1'")).toEqual([{ n: 6 }]);
});

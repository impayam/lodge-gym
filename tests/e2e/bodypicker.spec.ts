import { expect, test } from "./fixtures";
import { resetWorkouts, signIn, sql, waitForSynced } from "./helpers";

// SPEC-v3 M9b E2E: + Add exercise opens on the body map; Arms, then Triceps lists triceps-primary exercises first;
// picking one adds it to the session as an extra (synced with is_extra = 1, the data the session report reads).
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  await signIn(context, baseURL!);
});
test.afterAll(() => resetWorkouts());

test("body map: Arms → Triceps → add a triceps exercise as an extra", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByTestId("add-exercise").click();
  const picker = page.getByTestId("exercise-picker");
  await expect(picker.getByTestId("picker-tab-body")).toHaveAttribute("aria-selected", "true");
  await expect(picker.getByTestId("body-step")).toBeVisible();

  // Step 1: tap the arm on the front figure (the biceps drawing opens the Arms area).
  await picker.locator('[data-testid="body-step"] figure').first().locator('path[data-muscle="biceps"]').first().click();
  const area = picker.getByTestId("area-step");
  await expect(area).toHaveAttribute("data-area", "arms");
  await expect(area.getByRole("heading", { name: "Arms" })).toBeVisible();
  // Step 2: the triceps are on the back; the chips work from either side.
  await area.getByTestId("view-back").click();
  await expect(area.locator('path[data-muscle="triceps"]')).toHaveCount(1);
  for (const m of ["biceps", "triceps", "forearms"]) {
    const box = (await area.getByTestId(`muscle-${m}`).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  // The enlarged triceps is a large tap target.
  const tri = (await area.locator('path[data-muscle="triceps"]').boundingBox())!;
  expect(Math.min(tri.width, tri.height)).toBeGreaterThanOrEqual(44);
  await area.locator('path[data-muscle="triceps"]').click();

  // Step 3: triceps-primary exercises first, the ones done before or in the program at the top.
  const list = picker.getByTestId("muscle-step");
  await expect(list).toHaveAttribute("data-muscle", "triceps");
  const ids = await list.getByTestId("pick-primary").getByTestId("pick-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-id")!));
  expect(ids.length).toBeGreaterThan(0);
  const primary = sql(`SELECT id, muscle_primary FROM exercises WHERE id IN (${ids.map((i) => `'${i}'`).join(",")})`) as { id: string; muscle_primary: string }[];
  expect(primary.every((r) => r.muscle_primary === "triceps")).toBe(true);
  // Nothing logged yet in this test, so the program's triceps exercise leads.
  expect(ids[0]).toBe("oh_tri");
  await expect(list.getByTestId("pick-secondary")).toContainText("Also works this muscle");
  await expect(list.getByTestId("pick-row").first().getByRole("link", { name: "Watch form video ↗" })).toBeVisible();

  // Back goes list → area → body, and the place is remembered when the picker opens again.
  await list.getByTestId("pick-back").click();
  await expect(area).toBeVisible();
  await area.getByTestId("muscle-triceps").click();

  // Step 4: pick it (Day 1 has no triceps exercise); it is added as an extra with 3 empty sets.
  const choice = ids[0];
  await list.locator(`[data-testid="pick-row"][data-id="${choice}"] .pickmain`).click();
  await expect(picker).toHaveCount(0);
  const card = page.locator(`article.ex[data-ex="${choice}"]`);
  await expect(card).toContainText("Extra");
  await expect(card.locator(".setrow")).toHaveCount(3);
  await waitForSynced(page);
  await expect
    .poll(() => sql(`SELECT COUNT(*) AS n, SUM(is_extra) AS extra FROM set_entries WHERE exercise_id = '${choice}'`), { timeout: 20_000 })
    .toEqual([{ n: 3, extra: 3 }]);

  // Reopening the picker in the same session returns to the triceps list.
  await page.getByTestId("add-exercise").click();
  await expect(page.getByTestId("muscle-step")).toHaveAttribute("data-muscle", "triceps");
  await page.getByTestId("pick-back").click();
  await page.getByTestId("pick-back").click();
  await expect(page.getByTestId("body-step")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

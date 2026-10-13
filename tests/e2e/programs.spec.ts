import { expect, test, type Page } from "./fixtures";
import { resetWorkouts, signIn, sql, waitForSynced } from "./helpers";

// SPEC-v2 §8.8 E2E: generate a program, swap an exercise, approve it; old sessions still show under the archived
// program; bench press progression continues from the old weights. Then switch back to the seed program.
test.describe.configure({ mode: "serial" });

/** Back to the seed state: the seed program active with its seed activation, no generated programs. */
function resetPrograms() {
  sql(
    "DELETE FROM day_exercises WHERE day_id IN (SELECT d.id FROM program_days d JOIN programs p ON p.id = d.program_id WHERE p.generated_by = 'generator')"
  );
  sql("DELETE FROM program_days WHERE program_id IN (SELECT id FROM programs WHERE generated_by = 'generator')");
  sql("DELETE FROM program_activations WHERE id <> 'act-fullbody4-seed'");
  sql("DELETE FROM programs WHERE generated_by = 'generator'");
  sql("UPDATE program_activations SET ended_at = NULL");
  sql("UPDATE programs SET active = CASE id WHEN 'fullbody4' THEN 1 ELSE 0 END, archived_at = CASE id WHEN 'fullbody4' THEN NULL ELSE created_at END");
}

const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
};

const tab = (page: Page, name: string) => page.getByRole("navigation").getByRole("button", { name }).click();

test.beforeAll(() => {
  resetPrograms();
});
test.afterAll(() => {
  resetPrograms();
  resetWorkouts();
});

test.beforeEach(async ({ context, baseURL }) => {
  await signIn(context, baseURL!);
});

test("generate, swap an exercise, change sets, approve (SPEC-v2 §8.8 E2E 1)", async ({ page }) => {
  resetWorkouts();
  // A finished Day 1 session on the seed program ten days ago: bench 4 × 5 at 135 lb.
  const day = daysAgo(10);
  sql(
    `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
     VALUES ('01PROGOLD', 'D1', '${day}', '${day}T23:00:00.000Z', '${day}T23:55:00.000Z', 'done', 'lb', '', '${day}T23:00:00.000Z', '${day}T23:55:00.000Z', 'app')`
  );
  sql(`INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, rir, updated_at) VALUES
       ('01PB0', '01PROGOLD', 'bench', 0, 135, 5, NULL, 1, 2, '${day}T23:10:00.000Z'), ('01PB1', '01PROGOLD', 'bench', 1, 135, 5, NULL, 1, 2, '${day}T23:12:00.000Z'),
       ('01PB2', '01PROGOLD', 'bench', 2, 135, 5, NULL, 1, 2, '${day}T23:14:00.000Z'), ('01PB3', '01PROGOLD', 'bench', 3, 135, 5, NULL, 1, 2, '${day}T23:16:00.000Z')`);

  await page.goto("/");
  await tab(page, "Settings");
  await expect(page.getByTestId("program-settings")).toContainText("Full body (original program)");
  await page.getByTestId("new-program").click();

  // Inputs: 3 days, auto style (full body), 60 minutes, chest priority by default.
  await page.getByTestId("np-days-3").click();
  await expect(page.getByText("Auto picks Full body for 3 days.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Chest" })).toBeChecked();
  await page.getByTestId("np-generate").click();

  await expect(page.getByTestId("np-name")).toContainText("Full body · 3 days");
  for (const i of [0, 1, 2]) await expect(page.getByTestId(`np-day-${i}`)).toBeVisible();
  await expect(page.getByTestId("np-violations")).toHaveCount(0);
  await expect(page.getByTestId("np-volume").locator("tr[data-group]")).toHaveCount(10);
  await expect(page.getByTestId("np-day-1").locator(".np-item").first()).toHaveAttribute("data-ex", "bench");
  await expect(page.getByTestId("np-day-1").locator(".np-item").first()).toContainText("RIR 1–3");

  // Swap: a secondary for another exercise with the same movement and main muscle.
  const day0 = page.getByTestId("np-day-0");
  const items = day0.locator(".np-item");
  let swapped: { index: number; from: string; to: string } | null = null;
  for (let k = 1; k < (await items.count()) && !swapped; k++) {
    await page.getByTestId(`np-swap-0-${k}`).click();
    const options = page.getByTestId("np-swap-option");
    if ((await options.count()) > 0) {
      const from = (await items.nth(k).getAttribute("data-ex"))!;
      const to = (await options.first().getAttribute("data-id"))!;
      await options.first().click();
      swapped = { index: k, from, to };
    } else await page.getByTestId(`np-swap-0-${k}`).click();
  }
  expect(swapped).not.toBeNull();
  await expect(items.nth(swapped!.index)).toHaveAttribute("data-ex", swapped!.to);

  // Sets change within the slot's range; the check re-runs.
  const plusId = (await page.locator('[data-testid^="np-plus-"]:not([disabled])').first().getAttribute("data-testid"))!;
  const row = page.locator(".np-item", { has: page.getByTestId(plusId) });
  const before = (await row.locator("small").first().textContent())!;
  const sets = Number(before.split(" ")[0]);
  await page.getByTestId(plusId).click();
  await expect(row.locator("small").first()).toHaveText(before.replace(/^\d+/, String(sets + 1)));

  await page.getByTestId("np-approve").click();
  await expect(page.getByTestId("np-confirm")).toContainText("“Full body · 4 days” is archived");
  await page.getByTestId("np-confirm-yes").click();

  // The Program tab shows the new program with its target RIR; the week goal follows its days.
  await expect(page.getByTestId("program-name")).toContainText("Full body · 3 days");
  await expect(page.getByTestId("program-rules")).toContainText("3 sessions a week");
  await expect(page.getByTestId("program-rules")).not.toContainText("light week");
  await expect(page.locator(".prog-item").filter({ has: page.locator("b", { hasText: /^(Main)?Barbell Bench Press$/ }) })).toContainText("RIR 1–3");
  await tab(page, "Train");
  await expect(page.getByTestId("week-strip")).toContainText("of 3");
  await expect(page.getByTestId("next-card")).toContainText("The program changed: start with Day 1 of the new program.");
  const active = sql("SELECT id, style, days_per_week, generated_by FROM programs WHERE active = 1") as { style: string; days_per_week: number; generated_by: string }[];
  expect(active).toEqual([expect.objectContaining({ style: "full_body", days_per_week: 3, generated_by: "generator" })]);
});

test("old sessions still show under the archived program (SPEC-v2 §8.8 E2E 2)", async ({ page }) => {
  await page.goto("/");
  await tab(page, "History");
  const timeline = page.getByTestId("program-timeline");
  await expect(timeline.locator('[data-program="fullbody4"]')).toContainText("Full body (original program)");
  await expect(timeline.locator('[data-program="fullbody4"]')).toContainText("Switch back");
  await expect(timeline.locator(".tl-item").first()).toContainText("active");
  const old = page.locator('[data-testid="history-group"][data-program="fullbody4"]');
  await expect(old).toContainText("Full body · 4 days");
  await expect(old.locator(".hist")).toHaveCount(1);
  await expect(old.locator(".hist")).toContainText("Day 1 · Chest");
});

test("bench press progression continues from the old weights (SPEC-v2 §8.8 E2E 3)", async ({ page }) => {
  await page.goto("/");
  // Bench is the main lift of the new program's chest day.
  const day = page.locator(".dayopt", { hasText: "Barbell Bench Press" });
  await day.click();
  const bench = page.locator('article.ex[data-ex="bench"]');
  await expect(bench).toBeVisible();
  await expect(bench.getByTestId("last-perf")).toContainText("135");
  await expect(bench.locator(".target")).toContainText("RIR 1–3");
  // 4 × 5 at 135 lb is below the new 5–8 range's top, so the same weight is suggested: no reset, no 90 % cut.
  await expect(bench.getByTestId("w-bench-0").locator("input")).toHaveAttribute("placeholder", "135");
  await page.getByRole("button", { name: "Delete session" }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await waitForSynced(page);
});

test("switch back to the archived program from History, with the switch notice", async ({ page }) => {
  await page.goto("/");
  await tab(page, "History");
  const item = page.getByTestId("program-timeline").locator('[data-program="fullbody4"]');
  await item.getByTestId("reactivate").click();
  await expect(item.getByTestId("switch-notice")).toContainText("Switching more than once in 3 weeks");
  await item.getByTestId("reactivate-yes").click();
  await tab(page, "Program");
  await expect(page.getByTestId("program-name")).toContainText("Full body · 4 days");
  await expect(page.getByTestId("program-rules")).toContainText("No more than two training days in a row.");
  const acts = sql("SELECT program_id, ended_at FROM program_activations ORDER BY started_at") as { program_id: string; ended_at: string | null }[];
  expect(acts.map((a) => [a.program_id, a.ended_at === null])).toEqual([
    ["fullbody4", false],
    [expect.any(String), false],
    ["fullbody4", true],
  ]);
});

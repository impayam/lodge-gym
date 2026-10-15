import { expect, test } from "./fixtures";
import { resetWorkouts, signIn, sql } from "./helpers";

// SPEC-v8 §6.01 (Pulse step 3): the Train tab. Numbers come from the app's own rules: Last is the last top set, Today
// the progression target, the 1RM chart the Epley best set per session of the big three.

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  await signIn(context, baseURL!);
});
test.afterEach(() => resetWorkouts());

test("hero: day of program, Last and Today from the progression, Start; 1RM of the big three with a crosshair and a table", async ({ page }) => {
  // Day 1 done twice: bench 130×5 (Sep) then 135×5 ×3 last week (every set hit: +5 lb next time).
  const stmts = [
    "INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source) VALUES ('01HOME1', 'D1', date('now', '-14 days'), datetime('now', '-14 days'), datetime('now', '-14 days', '+55 minutes'), 'done', 'lb', '', datetime('now'), datetime('now'), 'app')",
    "INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source) VALUES ('01HOME2', 'D1', date('now', '-6 days'), datetime('now', '-6 days'), datetime('now', '-6 days', '+58 minutes'), 'done', 'lb', '', datetime('now'), datetime('now'), 'app')",
    "INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, rir, updated_at) VALUES ('h1a', '01HOME1', 'bench', 0, 130, 5, NULL, 1, 1, datetime('now')), ('h1b', '01HOME1', 'bench', 1, 130, 5, NULL, 1, 1, datetime('now')), ('h1c', '01HOME1', 'bench', 2, 130, 5, NULL, 1, 1, datetime('now')), ('h1d', '01HOME1', 'bench', 3, 130, 5, NULL, 1, 1, datetime('now'))",
    "INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, rir, updated_at) VALUES ('h2a', '01HOME2', 'bench', 0, 135, 5, NULL, 1, 1, datetime('now')), ('h2b', '01HOME2', 'bench', 1, 135, 5, NULL, 1, 1, datetime('now')), ('h2c', '01HOME2', 'bench', 2, 135, 5, NULL, 1, 1, datetime('now')), ('h2d', '01HOME2', 'bench', 3, 135, 5, NULL, 1, 1, datetime('now'))",
  ];
  sql(stmts.join("; "));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  await expect(page.getByTestId("sync-chip")).toHaveAttribute("data-state", "synced");

  // After Day 1 comes Day 2.
  const hero = page.getByTestId("next-card");
  await expect(hero).toHaveAttribute("data-day", "Day 2 · Legs");
  await expect(hero.getByText(/^Day 2 of /)).toBeVisible();
  await expect(page.getByTestId("start")).toHaveText("Start Legs");

  // The 1RM card: Bench by default, the last value (Epley 135×5 = 157.5), the change since the first point.
  const card = page.getByTestId("e1rm-card");
  await expect(card.getByRole("tab", { name: "Bench" })).toHaveAttribute("aria-selected", "true");
  await expect(card.getByTestId("e1rm-value")).toHaveText(/^157\.5\s*lb$/);
  await expect(card.getByText("+3.8% since")).toBeVisible();
  await expect(card.getByRole("img", { name: /^Bench estimated 1RM rose from 151\.7 to 157\.5 lb since / })).toBeVisible();
  // Tap the first point: the value and date follow the crosshair.
  const chart = card.locator(".chart");
  const box = (await chart.boundingBox())!;
  await chart.click({ position: { x: 16, y: box.height / 2 } });
  await expect(card.getByTestId("e1rm-value")).toHaveText(/^151\.7\s*lb$/);
  await card.getByTestId("chart-table-toggle").click();
  await expect(card.getByTestId("chart-table").locator("tbody tr")).toHaveCount(2);
  // Squat has no sets: the empty state.
  await card.getByRole("tab", { name: "Squat" }).click();
  await expect(card.getByText("No squat sets in the last 8 weeks.")).toBeVisible();

  // Day 1 from the tiles: its Last / Today rows (bench 135×5 → 140×5).
  await page.getByTestId("day-option").filter({ hasText: "Day 1 · Chest" }).click();
  await expect(page.getByTestId("finish")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(hero).toHaveAttribute("data-day", "Day 1 · Chest");
  await expect(page.getByTestId("continue")).toHaveText("Continue Chest");
});

test("Last / Today table: the bench row of Day 1, three rows and the rest counted", async ({ page }) => {
  sql(
    [
      "INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source) VALUES ('01HOME3', 'D4', date('now', '-2 days'), datetime('now', '-2 days'), datetime('now', '-2 days', '+50 minutes'), 'done', 'lb', '', datetime('now'), datetime('now'), 'app')",
      "INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source) VALUES ('01HOME4', 'D1', date('now', '-9 days'), datetime('now', '-9 days'), datetime('now', '-9 days', '+50 minutes'), 'done', 'lb', '', datetime('now'), datetime('now'), 'app')",
      "INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, rir, updated_at) VALUES ('h4a', '01HOME4', 'bench', 0, 135, 5, NULL, 1, 1, datetime('now')), ('h4b', '01HOME4', 'bench', 1, 135, 5, NULL, 1, 1, datetime('now')), ('h4c', '01HOME4', 'bench', 2, 135, 5, NULL, 1, 1, datetime('now')), ('h4d', '01HOME4', 'bench', 3, 135, 5, NULL, 1, 1, datetime('now'))",
    ].join("; ")
  );
  await page.goto("/");
  const hero = page.getByTestId("next-card");
  await expect(hero).toHaveAttribute("data-day", "Day 1 · Chest");
  const table = page.getByTestId("next-table");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator('tbody tr[data-row="bench"] td')).toHaveText(["Barbell Bench Press", "135 × 5", "140 × 5"]);
  await expect(table.locator("tfoot")).toHaveText(/^and \d+ more exercises?$/);
  // Recent sessions as cards; the second bench session is not a record (no earlier bench).
  await expect(page.getByTestId("session-card")).toHaveCount(2);
});

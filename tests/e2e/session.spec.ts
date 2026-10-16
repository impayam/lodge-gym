import { effortColor } from "../../web/src/lib/effort";
import { expect, test, type Page } from "./fixtures";
import { checkSet, closeMore, openMore, resetWorkouts, settled, signIn, sql } from "./helpers";
import { tokenValue } from "./tokens";

// SPEC-v8 §6.02 (Pulse step 4): the active session on its own background, one exercise at a time with Prev / Next and
// a swipe, set values in a sheet, RIR under the current set, effort in the chip, bar and colours, the rest pill with
// +30 s and Skip; a finished session lists all its exercises; reduced motion.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  await signIn(context, baseURL!);
});
test.afterAll(() => resetWorkouts());

const STOPS = [tokenValue("--effort-1"), tokenValue("--effort-2"), tokenValue("--effort-3")] as const;
const card = (page: Page) => page.getByTestId("ex-card");
const effortVar = (page: Page) => page.getByTestId("session").evaluate((el) => (el as HTMLElement).style.getPropertyValue("--effort"));

/** A mouse drag (pointer events, like a finger), one step per frame. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/** Drags the card's title sideways by `dx`. */
async function swipeCard(page: Page, dx: number, steps = 8) {
  const b = (await card(page).locator("h2").boundingBox())!;
  const y = b.y + b.height / 2;
  const x = dx < 0 ? 300 : 60;
  await drag(page, { x, y }, { x: x + dx, y }, steps);
}

async function startDay1(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toHaveAttribute("data-day", "Day 1 · Chest");
  await page.getByTestId("start").click();
  await expect(card(page)).toHaveAttribute("data-ex", "bench");
}

test("active session: effort chip, bar and colour; one card with Prev / Next and a swipe; set sheet; rest pill with Skip", async ({ page }) => {
  await startDay1(page);
  // Full screen: no tab bar, no Coach button.
  await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0);
  await expect(page.getByTestId("coach-button")).toHaveCount(0);
  await expect(page.getByTestId("effort-chip")).toHaveText("Warming up");
  await expect(page.getByTestId("effort-bar")).toHaveAttribute("aria-valuenow", "0");
  await expect(page.getByTestId("effort-bar")).toHaveAttribute("aria-valuetext", "0 of 19 sets done");
  expect(await effortVar(page)).toBe(effortColor(0, STOPS));
  await expect(card(page)).toContainText("Exercise 1 of 6");
  await expect(page.getByTestId("prev")).toBeDisabled();
  await expect(page.getByTestId("next")).toHaveText("Next: Incline Dumbbell Press");
  // RIR chips sit under the current set only.
  await expect(page.locator("[data-testid^=rir-bench-]")).toHaveCount(1);
  await expect(page.getByTestId("rir-bench-0")).toBeVisible();

  // Done: the check sinks in, the rest pill slides up with the ring, +30 s and Skip.
  const rest = page.getByTestId("rest-timer");
  await expect(rest).toBeHidden();
  await page.getByTestId("check-bench-0").click();
  await expect(page.getByTestId("check-bench-0")).toHaveAttribute("aria-pressed", "true");
  await expect(rest).toHaveAttribute("data-active", "true");
  // Between sets of one exercise: 30 s by default, and the label says what is next (Payam, 2026-10-16).
  await expect(rest).toContainText("Rest · next: set 2 of 4");
  await expect(rest).toContainText(/0:(30|29|28)/);
  await expect(rest.locator(".rest__arc")).toHaveCount(1);
  await expect(page.getByTestId("rir-bench-1")).toBeVisible();
  await expect(page.getByTestId("rir-bench-0")).toHaveCount(0);
  await expect(page.getByTestId("effort-bar")).toHaveAttribute("aria-valuenow", "5");
  expect(await effortVar(page)).toBe(effortColor(1 / 19, STOPS));
  await rest.getByRole("button", { name: "Skip" }).click();
  await expect(rest).toHaveAttribute("data-active", "false");
  await expect(rest).toBeHidden();

  // Next / Prev, then the swipe: left is the next exercise, right the previous; a short slow drag springs back.
  await page.getByTestId("next").click();
  await expect(card(page)).toHaveAttribute("data-ex", "incline_db");
  await expect(card(page)).toContainText("Exercise 2 of 6");
  await page.getByTestId("prev").click();
  await expect(card(page)).toHaveAttribute("data-ex", "bench");
  await swipeCard(page, -220);
  await expect(card(page)).toHaveAttribute("data-ex", "incline_db");
  await swipeCard(page, 220);
  await expect(card(page)).toHaveAttribute("data-ex", "bench");
  await swipeCard(page, -50, 12);
  await expect(card(page)).toHaveAttribute("data-ex", "bench");
  await expect(page.getByTestId("swipe-card")).toHaveAttribute("style", /transform:\s*;|^$/);
  // Swiping right on the first exercise does nothing.
  await swipeCard(page, 220);
  await expect(card(page)).toHaveAttribute("data-ex", "bench");

  // The set sheet: a tap on a value opens it; a swipe down on its head closes it; so does a tap on the scrim.
  const sheet = page.getByTestId("set-sheet");
  await page.getByTestId("r-bench-1").click();
  await expect(sheet).toHaveAttribute("open", "");
  await settled(page.getByTestId("set-sheet"));
  await expect(sheet).toContainText("Set 2 of 4");
  await expect(sheet.getByRole("heading", { name: "Barbell Bench Press" })).toBeFocused();
  await expect(page.getByTestId("session")).toHaveAttribute("inert", "");
  const head = (await sheet.locator(".sheet__head").boundingBox())!;
  await drag(page, { x: head.x + head.width / 2, y: head.y + 10 }, { x: head.x + head.width / 2, y: head.y + 400 }, 12);
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("r-bench-1")).toBeFocused();
  await page.getByTestId("r-bench-1").click();
  await expect(sheet).toHaveAttribute("open", "");
  await settled(sheet);
  await sheet.getByTestId("sheet-r").getByRole("button", { name: /Increase/ }).click();
  await expect(sheet.getByTestId("sheet-r").locator("input")).toHaveValue("6");
  await page.locator(".scrim").click({ position: { x: 20, y: 20 } });
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("r-bench-1")).toHaveText("6");
  await expect(page.getByTestId("r-bench-1")).toHaveAttribute("data-suggested", "false");

  // Effort past a third of the sets: Working (7 of 19).
  for (let i = 1; i < 4; i++) await checkSet(page, "bench", i);
  for (let i = 0; i < 3; i++) await checkSet(page, "incline_db", i);
  await expect(page.getByTestId("effort-chip")).toHaveText("Working");
  expect(await effortVar(page)).toBe(effortColor(7 / 19, STOPS));

  // The More sheet has the session's tools; Escape closes it.
  const more = await openMore(page);
  await expect(more.getByTestId("add-exercise")).toBeVisible();
  await expect(more.getByTestId("arrange")).toBeVisible();
  await expect(more.getByTestId("body-weight")).toBeVisible();
  await expect(more.getByRole("button", { name: "Delete session" })).toBeVisible();
  await closeMore(page);

  // Finish → the report's status (Step 3); the finished session opens as a list of all its exercises.
  await page.getByTestId("rest-timer").getByRole("button", { name: "Skip" }).click();
  await page.getByTestId("finish").click();
  await expect(page.getByTestId("report-status")).toBeVisible();
  await page.getByTestId("report-session").click();
  // Four exercises alone and Superset A on one card.
  await expect(card(page)).toHaveCount(4);
  await expect(page.getByTestId("group-card")).toHaveCount(1);
  await expect(page.getByTestId("effort-chip")).toHaveCount(0);
  await expect(page.getByTestId("next")).toHaveCount(0);
  await expect(page.getByTestId("open-report")).toBeVisible();
  await expect(page.locator("[data-testid^=rir-]")).toHaveCount(0);
  await expect(page.getByTestId("suggestion")).toHaveCount(0);
  await expect(page.locator('[data-ex="bench"] .set-row--done')).toHaveCount(4);
  await expect.poll(() => sql("SELECT reps FROM set_entries WHERE exercise_id = 'bench' AND set_index = 1"), { timeout: 20_000 }).toEqual([{ reps: 6 }]);
});

test("reduced motion: no slide or pop in the session; the swipe and the sheet act at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await startDay1(page);
  const dur = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(await dur("[data-testid=rest-timer]")).toBe("0s");
  expect(await dur("[data-testid=swipe-card]")).toBe("0s");
  await page.getByTestId("check-bench-0").click();
  expect(await page.getByTestId("check-bench-0").locator("svg").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.getByTestId("rest-timer").getByRole("button", { name: "Skip" }).click();
  await swipeCard(page, -220);
  await expect(card(page)).toHaveAttribute("data-ex", "incline_db");
  await page.getByTestId("w-incline_db-0").click();
  await expect(page.getByTestId("set-sheet")).toHaveAttribute("open", "");
  expect(await dur("[data-testid=set-sheet]")).toBe("0s");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("set-sheet")).toHaveCount(0);
});

import { expect, test, type Page } from "./fixtures";
import { goTo, resetWorkouts, signIn, sql } from "./helpers";

// SPEC-v8 §5 (Pulse step 2): five icon tabs with a sliding indicator, Me holding the old tabs, the Coach button and
// screen, pushed screens with edge-swipe back, full-screen session, reduced motion.

const tabs = (page: Page) => page.getByRole("navigation", { name: "Sections" });
const indicator = (page: Page) => tabs(page).evaluate((nav) => getComputedStyle(nav).getPropertyValue("--i").trim());

/**
 * A mouse drag that starts `x0` px from the left edge (pointer events, like a finger), one step per frame, along the
 * header (y 150) so it never starts on a form control.
 */
async function edgeDrag(page: Page, x0: number, x1: number, steps: number) {
  await page.mouse.move(x0, 150);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, 150 + i / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

test.beforeEach(async ({ context, baseURL }) => {
  sql("DELETE FROM body_metrics WHERE source = 'e2e-shell'");
  await signIn(context, baseURL!);
});

test("five icon tabs: labels for VoiceOver, the indicator follows the tab, the Coach button on tab screens only", async ({ page }) => {
  await page.goto("/");
  const links = tabs(page).getByRole("link");
  await expect(links).toHaveCount(5);
  expect(await links.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(["Train", "History", "Library", "Reports", "Me"]);
  await expect(tabs(page).getByRole("link", { name: "Train" })).toHaveAttribute("aria-current", "page");
  expect(await indicator(page)).toBe("0");
  // Icons only: no visible text in the bar.
  expect((await tabs(page).innerText()).trim()).toBe("");

  for (const [name, i] of [["History", "1"], ["Library", "2"], ["Reports", "3"], ["Me", "4"]] as const) {
    await goTo(page, name);
    await expect(tabs(page).getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    expect(await indicator(page)).toBe(i);
    await expect(page.getByTestId("coach-button")).toBeVisible();
  }

  // A screen pushed from Me keeps the Me tab selected and has no Coach button.
  await page.getByTestId("me-settings").click();
  await expect(tabs(page).getByRole("link", { name: "Me" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("coach-button")).toHaveCount(0);

  // Each tab target is at least 44 × 44 pt.
  for (const box of await links.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test("Me holds Program, Planner, AI reports, Backup, Settings and the photos; each opens and comes back", async ({ page }) => {
  // Body weight from this test only (other tests log body weight at the end of their sessions).
  sql("DELETE FROM body_metrics");
  sql(`INSERT INTO body_metrics (id, local_date, kind, value, unit, source, received_at) VALUES
    ('e2e-shell-1', date('now', '-20 days'), 'body_mass', 181.5, 'lb', 'e2e-shell', '${new Date().toISOString()}'),
    ('e2e-shell-2', date('now', '-6 days'), 'body_mass', 180.2, 'lb', 'e2e-shell', '${new Date().toISOString()}')`);
  await page.goto("/");
  await goTo(page, "Me");
  await expect(page.getByRole("heading", { name: "Me" })).toBeVisible();
  await expect(page.getByText(/^Training since [A-Z][a-z]{2} \d{1,2}$/)).toBeVisible();

  // Body: the last logged weight and the trend chart with its table view.
  const body = page.getByTestId("me-body");
  await expect(body.getByTestId("body-weight")).toHaveText(/^180\.2\s*lb$/);
  await expect(body.getByRole("img", { name: /^Body weight from 181\.5 lb on .+ to 180\.2 lb on .+, 2 days logged$/ })).toBeVisible();
  await body.getByTestId("chart-table-toggle").click();
  await expect(body.getByTestId("chart-table").locator("tbody tr")).toHaveCount(2);
  await body.getByTestId("chart-table-toggle").click();

  for (const [row, check] of [
    ["me-program", () => expect(page.getByTestId("program-name")).toBeVisible()],
    ["me-ai", () => expect(page.getByTestId("ai-settings")).toBeVisible()],
    ["me-backup", () => expect(page.getByTestId("backups")).toBeVisible()],
    ["me-settings", () => expect(page.getByTestId("open-watch")).toBeVisible()],
    ["me-add-photo", () => expect(page.getByRole("group", { name: "Photo pose" })).toBeVisible()],
  ] as const) {
    await page.getByTestId(row).click();
    await check();
    await expect(page.getByTestId("me")).toHaveCount(0);
    await goTo(page, "Me");
    await expect(page.getByTestId("me")).toBeVisible();
  }
  // AI reports and Backup left Settings for their own screens.
  await page.getByTestId("me-settings").click();
  await expect(page.getByTestId("ai-settings")).toHaveCount(0);
  await expect(page.getByTestId("backups")).toHaveCount(0);
  // The planner opens the next program day's plan.
  await goTo(page, "Me");
  await page.getByTestId("me-planner").click();
  await expect(page.getByTestId("plan-estimate")).toBeVisible();
  sql("DELETE FROM body_metrics WHERE source = 'e2e-shell'");
});

test("edge swipe back: past 35% goes back, a short slow drag springs back, a drag away from the edge does nothing", async ({ page }) => {
  await page.goto("/");
  await goTo(page, "Settings");
  await expect(page.getByTestId("open-watch")).toBeVisible();
  const width = page.viewportSize()!.width;

  // Short and slow: springs back.
  await edgeDrag(page, 6, 6 + width * 0.2, 25);
  await expect(page.getByTestId("open-watch")).toBeVisible();
  await expect.poll(() => page.getByTestId("pushed").evaluate((el) => (el as HTMLElement).style.transform)).toBe("");

  // Starting away from the edge: not a back swipe.
  await edgeDrag(page, 80, 80 + width * 0.6, 20);
  await expect(page.getByTestId("open-watch")).toBeVisible();

  // Past 35% of the width: back to Me.
  await edgeDrag(page, 6, 6 + width * 0.5, 20);
  await expect(page.getByTestId("me")).toBeVisible();

  // The visible Back still works (Apple Watch → Settings → Me).
  await page.getByTestId("me-settings").click();
  await page.getByTestId("open-watch").click();
  await edgeDrag(page, 4, 4 + width * 0.6, 12);
  await expect(page.getByTestId("open-watch")).toBeVisible();
});

test("Coach: full screen from the Coach button, the shell until M12, back with the button or an edge swipe", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("coach-button").click();
  const coach = page.getByTestId("coach");
  await expect(coach.getByRole("heading", { name: "Coach" })).toBeVisible();
  await expect(coach.getByText(/^Knows your \d+ sessions?( since [A-Z][a-z]{2} \d{1,2})?$/)).toBeVisible();
  await expect(coach.getByTestId("coach-empty")).toHaveText("The coach comes with M12.");
  await expect(tabs(page)).toHaveCount(0);
  await expect(coach.getByRole("textbox", { name: "Message the coach" })).toBeDisabled();
  await expect(coach.getByRole("button", { name: "Send" })).toBeDisabled();
  for (const chip of await coach.getByLabel("Suggested questions").getByRole("button").all()) {
    await expect(chip).toHaveAttribute("dir", "rtl");
    await expect(chip).toBeDisabled();
  }
  await coach.getByRole("button", { name: "Back" }).click();
  await expect(tabs(page).getByRole("link", { name: "Train" })).toHaveAttribute("aria-current", "page");

  await goTo(page, "Library");
  await page.getByTestId("coach-button").click();
  await edgeDrag(page, 5, 5 + page.viewportSize()!.width * 0.5, 15);
  await expect(tabs(page).getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page");
});

test("the active session is full screen: no tab bar, no Coach button", async ({ page }) => {
  // Every workout row, reports and plans included (they reference the sessions): another spec may have left some.
  resetWorkouts();
  await page.goto("/");
  await page.getByTestId("start").click();
  await expect(page.getByTestId("finish")).toBeVisible();
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByTestId("coach-button")).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(tabs(page)).toBeVisible();
  resetWorkouts();
});

test("reduced motion: no slide on the tab indicator or the pushed screen; the edge swipe goes back at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await goTo(page, "Me");
  const dur = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(await dur(".tabbar__indicator")).toBe("0s");
  await page.getByTestId("me-settings").click();
  expect(await dur("[data-testid=pushed]")).toBe("0s");
  await edgeDrag(page, 6, 6 + page.viewportSize()!.width * 0.5, 10);
  await expect(page.getByTestId("me")).toBeVisible();
});

import { expect, test, type Page } from "./fixtures";
import { goTo, resetWorkouts, settled, signIn, sql } from "./helpers";

// SPEC-v8 §5 (Pulse step 2), SPEC-v12 M15 §3.0: four icon tabs with a sliding indicator, Profile's gear holding Program,
// Planner, Photos and Settings, the Coach button and screen, pushed screens with edge-swipe back, full-screen session,
// reduced motion.

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

test("four icon tabs: labels for VoiceOver, the indicator follows the tab, the Coach button on tab screens only", async ({ page }) => {
  await page.goto("/");
  const links = tabs(page).getByRole("link");
  await expect(links).toHaveCount(4);
  expect(await links.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(["Train", "History", "Library", "Profile"]);
  await expect(tabs(page).getByRole("link", { name: "Train" })).toHaveAttribute("aria-current", "page");
  expect(await indicator(page)).toBe("0");
  // Icons only: no visible text in the bar.
  expect((await tabs(page).innerText()).trim()).toBe("");

  for (const [name, i] of [["History", "1"], ["Library", "2"], ["Profile", "3"]] as const) {
    await goTo(page, name);
    await expect(tabs(page).getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    expect(await indicator(page)).toBe(i);
    await expect(page.getByTestId("coach-button")).toBeVisible();
  }

  // A screen pushed from Profile keeps the Profile tab selected and has no Coach button: the tab bar takes the whole width.
  await goTo(page, "Settings");
  await expect(tabs(page).getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("coach-button")).toHaveCount(0);
  expect(await tabs(page).evaluate((el) => Math.round(window.innerWidth - el.getBoundingClientRect().right))).toBe(16);

  // Each tab target is at least 44 × 44 pt.
  for (const box of await links.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test("Profile's gear holds Program, Planner, My training, Photos and Settings; Settings opens AI reports and Backup; each comes back", async ({ page }) => {
  // Body weight from this test only (other tests log body weight at the end of their sessions).
  sql("DELETE FROM body_metrics");
  sql(`INSERT INTO body_metrics (id, local_date, kind, value, unit, source, received_at) VALUES
    ('e2e-shell-1', date('now', '-20 days'), 'body_mass', 181.5, 'lb', 'e2e-shell', '${new Date().toISOString()}'),
    ('e2e-shell-2', date('now', '-6 days'), 'body_mass', 180.2, 'lb', 'e2e-shell', '${new Date().toISOString()}')`);
  await page.goto("/");
  await goTo(page, "Profile");
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  await expect(page.getByText(/^Training since [A-Z][a-z]{2} \d{1,2}$/)).toBeVisible();

  // Body weight: the last logged weight and the trend chart with its table view.
  const body = page.getByTestId("body-weight-card");
  await expect(body.getByTestId("body-weight")).toHaveText(/^180\.2\s*lb$/);
  await expect(body.getByRole("img", { name: /^Body weight from 181\.5 lb on .+ to 180\.2 lb on .+, 2 days logged$/ })).toBeVisible();
  await body.getByTestId("chart-table-toggle").click();
  await expect(body.getByTestId("chart-table").locator("tbody tr")).toHaveCount(2);
  await body.getByTestId("chart-table-toggle").click();

  for (const [place, check] of [
    ["Program", () => expect(page.getByTestId("program-name")).toBeVisible()],
    ["My training", () => expect(page.getByTestId("calendar-settings")).toBeVisible()],
    ["Settings", () => expect(page.getByTestId("open-watch")).toBeVisible()],
    ["Photos", () => expect(page.getByRole("group", { name: "Photo pose" })).toBeVisible()],
    ["AI reports", () => expect(page.getByTestId("ai-settings")).toBeVisible()],
    ["Backup", () => expect(page.getByTestId("backups")).toBeVisible()],
  ] as const) {
    await goTo(page, place);
    await check();
    await expect(page.getByTestId("profile")).toHaveCount(0);
    await goTo(page, "Profile");
    await expect(page.getByTestId("profile")).toBeVisible();
  }
  // AI reports and Backup are their own screens, opened from Settings.
  await goTo(page, "Settings");
  await expect(page.getByTestId("ai-settings")).toHaveCount(0);
  await expect(page.getByTestId("backups")).toHaveCount(0);
  // Settings keeps only the app; the rest timer and the calendar are on My training (Payam, 2026-10-17).
  await expect(page.getByTestId("training-settings")).toHaveCount(0);
  await expect(page.getByTestId("calendar-settings")).toHaveCount(0);
  await expect(page.getByTestId("settings").locator(".section-label")).toHaveText(["Program", "Connections", "AI and data", "Devices", "Rest-timer notification", "Sync", "About"]);
  await goTo(page, "My training");
  await expect(page.getByRole("heading", { name: "My training", level: 1 })).toBeVisible();
  await expect(page.getByTestId("my-training").locator(".section-label")).toHaveText(["Training", "Calendar"]);
  await expect(page.getByTestId("training-settings").locator("#s-rest-sets")).toBeVisible();
  await page.getByTestId("back").click();
  await expect(page.getByTestId("profile")).toBeVisible();
  // The planner opens the next program day's plan.
  await goTo(page, "Profile");
  await page.getByTestId("profile-gear").click();
  await settled(page.getByTestId("gear-sheet"));
  await page.getByTestId("gear-planner").click();
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

  // Past 35% of the width: back to Profile.
  await edgeDrag(page, 6, 6 + width * 0.5, 20);
  await expect(page.getByTestId("profile")).toBeVisible();

  // The edge swipe also goes back from Apple Watch to Settings.
  await goTo(page, "Settings");
  await page.getByTestId("open-watch").click();
  await edgeDrag(page, 4, 4 + width * 0.6, 12);
  await expect(page.getByTestId("open-watch")).toBeVisible();
});

test("Coach: full screen from the Coach button, an empty chat with the suggested questions, back with the button or an edge swipe", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("coach-button").click();
  const coach = page.getByTestId("coach");
  await expect(coach.getByRole("heading", { name: "Coach" })).toBeVisible();
  await expect(coach.getByText(/^Knows your \d+ sessions?( since [A-Z][a-z]{2} \d{1,2})?$/)).toBeVisible();
  await expect(coach.getByTestId("coach-empty")).toBeVisible();
  await expect(tabs(page)).toHaveCount(0);
  // Online: the composer works; Send waits for a question (SPEC-v9 M12).
  await expect(coach.getByRole("textbox", { name: "Message the coach" })).toBeEnabled();
  await expect(coach.getByRole("button", { name: "Send" })).toBeDisabled();
  const chips = coach.getByLabel("Suggested questions").getByRole("button");
  await expect(chips).toHaveText(["این هفته چطور بودم؟", "برنامه‌ی سینه‌ام را بهتر کن", "چرا پرس سینه‌ام ثابت مانده؟", "این عکس را تحلیل کن"]);
  for (const chip of await chips.all()) {
    await expect(chip).toHaveAttribute("dir", "rtl");
    await expect(chip).toBeEnabled();
  }
  await coach.getByRole("button", { name: "Back" }).click();
  await expect(tabs(page).getByRole("link", { name: "Train" })).toHaveAttribute("aria-current", "page");

  await goTo(page, "Library");
  await page.getByTestId("coach-button").click();
  await edgeDrag(page, 5, 5 + page.viewportSize()!.width * 0.5, 15);
  await expect(tabs(page).getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page");
});

test("the active session is full screen: no tab bar, no Coach button; a rest left running keeps both clear of its pill", async ({ page }) => {
  // Every workout row, reports and plans included (they reference the sessions): another spec may have left some.
  resetWorkouts();
  await page.goto("/");
  await page.getByTestId("start").click();
  await expect(page.getByTestId("finish")).toBeVisible();
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByTestId("coach-button")).toHaveCount(0);
  // A rest running when he leaves the session: its pill sits above the tab bar, the Coach button stays beside the bar.
  await page.getByTestId("check-bench-0").click();
  await expect(page.getByTestId("rest-timer")).toHaveAttribute("data-active", "true");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(tabs(page)).toBeVisible();
  await expect(page.getByTestId("rest-timer")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("coach-button")).toBeVisible();
  const [pill, fab, bar] = await Promise.all(["rest-timer", "coach-button"].map((id) => page.getByTestId(id).boundingBox()).concat(tabs(page).boundingBox()));
  expect(pill!.y + pill!.height).toBeLessThanOrEqual(fab!.y);
  expect(pill!.y + pill!.height).toBeLessThanOrEqual(bar!.y);
  resetWorkouts();
});

test("reduced motion: no slide on the tab indicator or the pushed screen; the edge swipe goes back at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await goTo(page, "Profile");
  const dur = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(await dur(".tabbar__indicator")).toBe("0s");
  await goTo(page, "Settings");
  expect(await dur("[data-testid=pushed]")).toBe("0s");
  await edgeDrag(page, 6, 6 + page.viewportSize()!.width * 0.5, 10);
  await expect(page.getByTestId("profile")).toBeVisible();
});

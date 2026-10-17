import { expect, test, type Page } from "./fixtures";
import { resetWorkouts, signIn, sql, goTo, type Place } from "./helpers";

// SPEC-v2 M6 acceptance: no Persian UI text remains, except stored user notes, the weekly review card and the AI's
// Persian prose (session report, training overview), which renders in lang="fa" containers.
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Visible text of the page outside the weekly review card and the Persian AI prose, plus attribute text a screen reader reads. */
async function uiText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.body.cloneNode(true) as HTMLElement;
    root.querySelectorAll('[data-testid="weekly-review"], [lang="fa"]').forEach((n) => n.remove());
    const attrs = [...root.querySelectorAll("[aria-label],[placeholder],[title],[alt]")].flatMap((n) =>
      ["aria-label", "placeholder", "title", "alt"].map((a) => n.getAttribute(a) ?? "")
    );
    return [root.innerText, ...attrs].join("\n");
  });
}

test("every screen is English, left-to-right, with Latin digits and Gregorian dates", async ({ page, context, baseURL }) => {
  // Every screen, Set goal and All sizes included, one by one: up to 90 s in WebKit on a busy machine.
  test.setTimeout(150_000);
  resetWorkouts();
  sql("DELETE FROM weekly_reviews");
  sql(`INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES ('rv', '2026-09-21', '2026-09-28T08:00:00Z', 'هفته‌ی خوبی بود', '[]', '[]')`);
  await signIn(context, baseURL!);
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe("ltr");
  // SPEC-v8 §4: Instrument Sans for the UI and Barlow Condensed for big numbers, self-hosted (no font from another
  // origin); Persian text keeps the system font.
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Instrument Sans"?,/);
  expect(await page.evaluate(() => [...new Set([...document.fonts].map((f) => f.family.replace(/"/g, "")))].sort())).toEqual(["Barlow Condensed", "Instrument Sans"]);
  expect(await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => new URL(e.name).origin !== location.origin).map((e) => e.name))).toEqual([]);
  // The Home date is Gregorian, e.g. "Wednesday, October 14".
  await expect(page.getByTestId("today-date")).toHaveText(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/);

  const check = async (label: string) => {
    const text = await uiText(page);
    const bad = text.split("\n").filter((l) => ARABIC_SCRIPT.test(l));
    expect(bad, `${label} has Persian text`).toEqual([]);
  };
  await check("home");
  await page.getByTestId("start").click();
  await expect(page.locator('[data-ex="bench"]')).toBeVisible();
  await expect(page.locator('[data-ex="bench"]').getByTestId("cue")).toBeVisible();
  await check("session");
  // The active session is full screen (SPEC-v8 §5): leave it before using the tab bar.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  for (const tab of ["History", "Library", "Photos", "Reports", "Profile", "Program", "My training", "Settings", "AI reports", "Backup"]) {
    await goTo(page, tab as Place);
    await page.waitForLoadState("networkidle");
    await check(tab);
  }
  await goTo(page, "Reports");
  await page.getByTestId("report-details").click();
  await check("Reports details");
  await page.getByTestId("set-goal-open").click();
  await check("Set goal");
  await page.getByTestId("back").click();
  await page.getByTestId("sizes-all").click();
  await check("All sizes");
  await page.getByTestId("back").click();
  await page.getByTestId("all-reports").click();
  await expect(page.getByTestId("rt-col")).toHaveCount(1);
  await page.getByTestId("rt-mode-list").click();
  await check("Reports timeline (list)");
  await page.getByTestId("rt-list").getByTestId("rt-item").first().click();
  await expect(page.getByTestId("weekly-review")).toBeVisible();
  await check("Saved weekly review");
  await goTo(page, "Reports");
  for (const tab of ["Month", "All"]) {
    await page.getByRole("tab", { name: tab }).click();
    await page.waitForLoadState("networkidle");
    await check(tab);
  }
  await goTo(page, "Settings");
  await page.getByTestId("open-watch").click();
  await expect(page.getByRole("heading", { name: "Apple Watch" })).toBeVisible();
  await check("Apple Watch");
});

import { expect, test, type Page } from "./fixtures";
import { resetWorkouts, signIn, sql } from "./helpers";

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
  resetWorkouts();
  sql("DELETE FROM weekly_reviews");
  sql(`INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES ('rv', '2026-09-21', '2026-09-28T08:00:00Z', 'هفته‌ی خوبی بود', '[]', '[]')`);
  await signIn(context, baseURL!);
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe("ltr");
  // The system font stack: no bundled web font.
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^-apple-system/);
  expect(await page.evaluate(() => [...document.fonts].length)).toBe(0);
  // Header date is Gregorian, e.g. "Mon, Oct 12, 2026".
  await expect(page.locator(".brand small")).toHaveText(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4}$/);

  const check = async (label: string) => {
    const text = await uiText(page);
    const bad = text.split("\n").filter((l) => ARABIC_SCRIPT.test(l));
    expect(bad, `${label} has Persian text`).toEqual([]);
  };
  await check("home");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator('[data-ex="bench"]')).toBeVisible();
  await expect(page.locator('[data-ex="bench"] .cue')).toBeVisible();
  await check("session");
  for (const tab of ["History", "Library", "Photos", "Reports", "Program", "Settings"]) {
    await page.getByRole("navigation").getByRole("button", { name: tab }).click();
    await page.waitForLoadState("networkidle");
    await check(tab);
  }
  await page.getByRole("navigation").getByRole("button", { name: "History" }).click();
  await expect(page.getByTestId("rt-col")).toHaveCount(1);
  await page.getByTestId("rt-mode-list").click();
  await check("Reports timeline (list)");
  await page.getByTestId("rt-list").getByTestId("rt-item").first().click();
  await expect(page.getByTestId("weekly-review")).toBeVisible();
  await check("Saved weekly review");
  await page.getByRole("button", { name: "Reports" }).click();
  for (const tab of ["Monthly", "Progress"]) {
    await page.getByRole("tab", { name: tab }).click();
    await page.waitForLoadState("networkidle");
    await check(tab);
  }
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("open-watch").click();
  await expect(page.getByRole("heading", { name: "Apple Watch" })).toBeVisible();
  await check("Apple Watch");
});

import { expect, test } from "./fixtures";
import { resetWorkouts, signIn, sql, goTo } from "./helpers";

// SPEC-v7 M9d: the training overview replaced the weekly review card on Home and Reports (approved 2026-10-13). The
// weekly_reviews rows are kept; each review sits in History → Reports timeline on the last day of the week it covers
// and opens read-only, in Persian, right-to-left.
test("weekly reviews sit in the History timeline on the last day of their week and open read-only; Home and Reports no longer show the card", async ({ page, context, baseURL }) => {
  resetWorkouts();
  sql("DELETE FROM weekly_reviews");
  await signIn(context, baseURL!);
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toBeVisible();
  await goTo(page, "History");
  await expect(page.getByTestId("reports-timeline")).toContainText("No saved reports yet.");

  const summary = "هفته‌ی خوبی بود: چهار جلسه کامل و پرس سینه بالاتر رفت. ".repeat(6).trim();
  // Monday–Sunday weeks like the production rows, and one Wednesday–Tuesday week (Sep 30 – Oct 6).
  sql(
    `INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES
     ('old', '2026-09-14', '2026-09-21T08:00:00Z', 'قدیمی', '[]', '[]'),
     ('new', '2026-09-21', '2026-09-28T08:00:00Z', '${summary}', '["چهار جلسه از چهار","رکورد تازه در اسکوات"]', '["برای پشت ران یک ست اضافه کن","خواب را به ۷ ساعت برسان"]'),
     ('wed', '2026-09-30', '2026-10-07T08:00:00Z', 'هفته‌ی چهارشنبه تا سه‌شنبه', '[]', '[]')`
  );
  await page.reload();
  await expect(page.getByTestId("next-card")).toBeVisible();
  await expect(page.getByTestId("weekly-review")).toHaveCount(0);
  await goTo(page, "Reports");
  await expect(page.getByTestId("training-overview")).toBeVisible();
  await expect(page.getByTestId("weekly-review")).toHaveCount(0);

  await goTo(page, "History");
  const cols = page.getByTestId("rt-col");
  await expect(cols).toHaveCount(3);
  // Oldest on the left; each on the last day of its week.
  expect(await cols.evaluateAll((els) => els.map((e) => e.getAttribute("data-date")))).toEqual(["2026-09-20", "2026-09-27", "2026-10-06"]);
  await expect(cols.nth(1)).toHaveAttribute("aria-label", "Sun, Sep 27: weekly review");
  await expect(cols.nth(2).locator(".marker--review")).toBeVisible();
  await expect(cols.nth(2).locator(".marker--session")).toHaveCount(0);

  // One report on the date: it opens at once, read-only.
  await cols.nth(1).click();
  await expect(page.getByTestId("saved-report")).toHaveAttribute("data-kind", "review");
  await expect(page.getByTestId("saved-report")).toContainText("Weekly review · read-only");
  const card = page.getByTestId("weekly-review");
  await expect(page.getByTestId("saved-report").getByRole("heading", { level: 1 })).toHaveText("Week of Sep 21 – Sep 27");
  await expect(card).toContainText("هفته‌ی خوبی بود");
  await expect(card.locator("p.prose-fa")).toHaveAttribute("dir", "rtl");
  await expect(card.locator("p.prose-fa")).toHaveAttribute("lang", "fa");
  await expect(card).not.toContainText("رکورد تازه در اسکوات");
  await card.getByRole("button", { name: "Show more" }).click();
  await expect(card.locator("ul.prose-fa").first()).toHaveAttribute("dir", "rtl");
  await expect(card).toContainText("خواب را به ۷ ساعت برسان");
  await expect(page.getByRole("button", { name: /Regenerate|Retry/ })).toHaveCount(0);
  // The tab bar keeps History selected; the back link returns to it.
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "History" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("main").getByRole("button", { name: "Back to History" }).click();

  // The List view: newest first, marker plus label.
  await page.getByTestId("rt-mode-list").click();
  const items = page.getByTestId("rt-list").getByTestId("rt-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("Weekly review");
  await expect(items.nth(0)).toContainText("Week of Sep 30 – Oct 6");
  await expect(items.nth(2)).toContainText("Week of Sep 14 – Sep 20");
  await items.nth(0).click();
  await expect(page.getByTestId("weekly-review")).toContainText("هفته‌ی چهارشنبه تا سه‌شنبه");
});

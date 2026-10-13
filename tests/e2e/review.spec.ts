import { expect, test } from "./fixtures";
import { resetWorkouts, signIn, sql } from "./helpers";

// SPEC-v7 M9d: the training overview replaced the weekly review card on Home and Reports (approved 2026-10-13). The
// weekly_reviews rows are kept and every review stays readable under History → Weekly reviews, in Persian, right-to-left.
test("History → Weekly reviews lists every review, newest week first, in Persian, right-to-left; Home and Reports no longer show the card", async ({ page, context, baseURL }) => {
  resetWorkouts();
  sql("DELETE FROM weekly_reviews");
  await signIn(context, baseURL!);
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "History" }).click();
  await page.getByTestId("open-reviews").click();
  await expect(page.getByText("No weekly reviews yet.")).toBeVisible();

  const summary = "هفته‌ی خوبی بود: چهار جلسه کامل و پرس سینه بالاتر رفت. ".repeat(6).trim();
  sql(
    `INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES
     ('old', '2026-09-14', '2026-09-21T08:00:00Z', 'قدیمی', '[]', '[]'),
     ('new', '2026-09-21', '2026-09-28T08:00:00Z', '${summary}', '["چهار جلسه از چهار","رکورد تازه در اسکوات"]', '["برای پشت ران یک ست اضافه کن","خواب را به ۷ ساعت برسان"]')`
  );
  await page.reload();
  await expect(page.getByTestId("next-card")).toBeVisible();
  await expect(page.getByTestId("weekly-review")).toHaveCount(0);
  await page.getByRole("button", { name: "Reports" }).click();
  await expect(page.getByTestId("training-overview")).toBeVisible();
  await expect(page.getByTestId("weekly-review")).toHaveCount(0);

  await page.getByRole("navigation").getByRole("button", { name: "History" }).click();
  await page.getByTestId("open-reviews").click();
  const cards = page.getByTestId("weekly-review");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute("data-review", "new");
  await expect(cards.nth(1)).toHaveAttribute("data-review", "old");
  const card = cards.nth(0);
  await expect(card).toContainText("Weekly review");
  await expect(card).toContainText("Week of Sep 21 – Sep 27");
  await expect(card).toContainText("هفته‌ی خوبی بود");
  await expect(card.locator("p.summary")).toHaveAttribute("dir", "rtl");
  await expect(card.locator("p.summary")).toHaveAttribute("lang", "fa");
  await expect(card).not.toContainText("رکورد تازه در اسکوات");
  await card.getByRole("button", { name: "Show more" }).click();
  await expect(card.locator("ul.rv-list").first()).toHaveAttribute("dir", "rtl");
  await expect(card).toContainText("رکورد تازه در اسکوات");
  await expect(card).toContainText("خواب را به ۷ ساعت برسان");
  await expect(cards.nth(1)).toContainText("Week of Sep 14 – Sep 20");
  // The tab bar keeps History selected; the back link returns to it.
  await expect(page.getByRole("navigation").getByRole("button", { name: "History" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("main").getByRole("button", { name: "← History" }).click();
  await expect(page.getByTestId("open-reviews")).toBeVisible();
});

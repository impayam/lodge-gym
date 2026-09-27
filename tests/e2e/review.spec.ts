import { expect, test } from "@playwright/test";
import { resetWorkouts, signIn, sql } from "./helpers";

test("«مرور هفتگی» card on home and reports shows the latest review", async ({ page, context, baseURL }) => {
  resetWorkouts();
  sql("DELETE FROM weekly_reviews");
  await signIn(context, baseURL!);
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toBeVisible();
  await expect(page.getByTestId("weekly-review")).toHaveCount(0);

  const summary = "هفته‌ی خوبی بود: چهار جلسه کامل و پرس سینه بالاتر رفت. ".repeat(6).trim();
  sql(
    `INSERT INTO weekly_reviews (id, week_start, created_at, summary_fa, highlights, suggestions) VALUES
     ('old', '2026-09-14', '2026-09-21T08:00:00Z', 'قدیمی', '[]', '[]'),
     ('new', '2026-09-21', '2026-09-28T08:00:00Z', '${summary}', '["چهار جلسه از چهار","رکورد تازه در اسکوات"]', '["برای پشت ران یک ست اضافه کن","خواب را به ۷ ساعت برسان"]')`
  );
  await page.reload();
  const card = page.getByTestId("weekly-review");
  await expect(card).toContainText("مرور هفتگی");
  await expect(card).toContainText("هفته‌ی ۳۰ شهریور تا ۵ مهر");
  await expect(card).toContainText("هفته‌ی خوبی بود");
  await expect(card).not.toContainText("رکورد تازه در اسکوات");
  await card.getByRole("button", { name: "ادامه" }).click();
  await expect(card).toContainText("رکورد تازه در اسکوات");
  await expect(card).toContainText("خواب را به ۷ ساعت برسان");

  await page.getByRole("button", { name: "گزارش" }).click();
  await expect(page.getByTestId("weekly-review")).toContainText("هفته‌ی خوبی بود");
});

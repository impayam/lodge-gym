import { expect, test } from "@playwright/test";
import { resetWorkouts, signIn, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const denver = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d);

test("weekly, monthly and progress reports with muscle map, CSV and PNG export", async ({ page, context, baseURL }) => {
  resetWorkouts();
  sql("DELETE FROM body_metrics");
  sql("DELETE FROM health_workouts");
  await signIn(context, baseURL!);

  // Last week's bench at 130 and this week's at 135 (Monday week start, this week = today's week).
  const now = new Date();
  const put = async (id: string, date: Date, day: string, sets: [string, number, number, number][]) => {
    const local = denver(date);
    const iso = date.toISOString();
    const list = sets.flatMap(([ex, n, w, r], k) =>
      Array.from({ length: n }, (_, i) => ({ id: `${id}${k}${i}`, exercise_id: ex, set_index: i, weight: w, reps: r, seconds: null, done: true, rir: null, updated_at: iso }))
    );
    const res = await page.request.put(`${baseURL}/api/sessions/${id}`, {
      headers: { Origin: baseURL! },
      data: { id, program_day_id: day, local_date: local, started_at: iso, ended_at: new Date(date.getTime() + 3600_000).toISOString(), status: "done", unit: "lb", note: id === "01R2" ? "عالی" : "", created_at: iso, updated_at: iso, source: "app", sets: list },
    });
    expect(res.status()).toBe(200);
  };
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000 - 2 * 3600_000);
  await page.goto("/");
  await put("01R1", days(7), "D1", [["bench", 4, 130, 5]]);
  await put("01R2", days(0), "D1", [["bench", 4, 135, 5], ["incline_db", 3, 40, 10], ["rdl", 3, 155, 8], ["cable_row", 3, 100, 10], ["lateral", 3, 15, 12], ["facepull", 3, 40, 15]]);
  await page.request.put(`${baseURL}/api/body-mass/${denver(days(0))}`, { headers: { Origin: baseURL! }, data: { value: 180, unit: "lb" } });

  await page.getByRole("button", { name: "گزارش" }).click();
  await expect(page.getByTestId("week-stats")).toContainText("۱ از ۴");
  await expect(page.getByTestId("week-stats")).toContainText("۶۰");
  const lifts = page.getByTestId("week-lifts");
  await expect(lifts).toContainText("۱۳۵×۵ · 1RM ۱۵۷٫۵");
  await expect(lifts).toContainText("+۳٫۸٪");
  await expect(page.getByTestId("week-prs")).toContainText("پرس سینه هالتر");
  await page.getByText("جدول").first().click();
  await expect(page.locator(".tableview table").first()).toContainText("سینه");
  await expect(page.getByText("عالی")).toBeVisible();

  // Readout on tap.
  await page.locator(".chart .row").first().click();
  await expect(page.locator(".chart .readout").first()).toContainText("سینه: ۷ ست از هدف ۱۳");

  // CSV and PNG downloads (headless Chromium has no share sheet, so both download).
  const csvDownload = page.waitForEvent("download");
  await page.getByTestId("export-csv").click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toMatch(/^lodge-gym-week-\d{4}-\d{2}-\d{2}\.csv$/);
  const csvText = await (await csv.createReadStream()).toArray().then((b) => Buffer.concat(b).toString("utf8"));
  expect(csvText.split("\r\n")[0]).toBe("﻿date,day,exercise,exercise_fa,set,weight,unit,reps,seconds,rir,done");
  const pngDownload = page.waitForEvent("download");
  await page.getByTestId("share-png").click();
  expect((await pngDownload).suggestedFilename()).toBe("lodge-gym-report.png");

  // Previous week.
  await page.getByRole("button", { name: "→ هفته‌ی قبل" }).click();
  await expect(page.getByTestId("week-lifts")).toContainText("۱۳۰×۵");

  // Monthly.
  await page.getByRole("tab", { name: "ماهانه" }).click();
  await expect(page.getByTestId("month-stats")).toContainText("پایبندی");
  await expect(page.getByText("روند 1RM تخمینی")).toBeVisible();
  await expect(page.getByText("وزن بدن").first()).toBeVisible();

  // Progress with the muscle map.
  await page.getByRole("tab", { name: "پیشرفت" }).click();
  await expect(page.getByTestId("progress-lifts")).toContainText("پرس سینه هالتر");
  await expect(page.getByTestId("progress-lifts")).toContainText("+۳٫۸٪");
  const map = page.getByTestId("muscle-map");
  await expect(map.locator('path[data-muscle="chest"]').first()).toHaveAttribute("data-status", "under");
  await expect(map.locator('path[data-muscle="quads"]').first()).toHaveAttribute("data-status", "none");
  await expect(page.getByTestId("muscle-chest")).toContainText("۷ / ۱۳");
  await expect(page.getByTestId("muscle-chest")).toContainText("کمتر از هدف");
  await map.locator('path[data-muscle="rear_delts"]').first().click();
  await expect(map.locator(".readout")).toContainText("سرشانه‌ی پشتی: ۳ از ۶ ست");
  await page.getByRole("button", { name: "۴ هفته‌ی اخیر" }).click();
  await expect(page.getByTestId("progress-stats")).toContainText("۲");
});

import { STAGE_STATUS_COLOR } from "../../web/src/lib/anatomy-status";
import { expect, test } from "./fixtures";
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
  await put("01R2", days(0), "D1", [["bench", 4, 135, 5], ["incline_db", 3, 40, 10], ["rdl", 3, 155, 8], ["cable_row", 3, 100, 10], ["lateral", 3, 15, 12], ["facepull", 3, 40, 15], ["fedb-Hamstring_Stretch", 2, 0, 1]]);
  await page.request.put(`${baseURL}/api/body-mass/${denver(days(0))}`, { headers: { Origin: baseURL! }, data: { value: 180, unit: "lb" } });

  await page.getByRole("button", { name: "Reports" }).click();
  await expect(page.getByTestId("week-stats")).toContainText("1 of 4");
  await expect(page.getByTestId("week-stats")).toContainText("60");
  const lifts = page.getByTestId("week-lifts");
  await expect(lifts).toContainText("135×5 · 1RM 157.5");
  await expect(lifts).toContainText("+3.8%");
  await expect(page.getByTestId("week-prs")).toContainText("Barbell Bench Press");
  await page.getByText("Table", { exact: true }).first().click();
  await expect(page.locator(".tableview table").first()).toContainText("Chest");
  // A stored note stays as written.
  await expect(page.getByText("عالی")).toBeVisible();

  // Readout on tap.
  await page.locator(".chart .row").first().click();
  await expect(page.locator(".chart .readout").first()).toContainText("Chest: 7 fractional sets of target 13 (direct 7)");

  // CSV and PNG downloads (headless Chromium has no share sheet, so both download).
  const csvDownload = page.waitForEvent("download");
  await page.getByTestId("export-csv").click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toMatch(/^gym-time-week-\d{4}-\d{2}-\d{2}\.csv$/);
  const csvText = await (await csv.createReadStream()).toArray().then((b) => Buffer.concat(b).toString("utf8"));
  expect(csvText.split("\r\n")[0]).toBe("﻿date,day,exercise,exercise_fa,set,weight,unit,reps,seconds,rir,done");
  const pngDownload = page.waitForEvent("download");
  await page.getByTestId("share-png").click();
  expect((await pngDownload).suggestedFilename()).toBe("gym-time-report.png");

  // Previous week.
  await page.getByRole("button", { name: "← Previous week" }).click();
  await expect(page.getByTestId("week-lifts")).toContainText("130×5");

  // Monthly (Gregorian month).
  await page.getByRole("tab", { name: "Monthly" }).click();
  await expect(page.getByTestId("month-stats")).toContainText("adherence");
  await expect(page.locator(".navrow b")).toHaveText(new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "America/Denver" }).format(now));
  await expect(page.getByText("Estimated 1RM trend")).toBeVisible();
  await expect(page.getByText("Body weight").first()).toBeVisible();

  // Progress with the muscle map.
  await page.getByRole("tab", { name: "Progress" }).click();
  await expect(page.getByTestId("progress-lifts")).toContainText("Barbell Bench Press");
  await expect(page.getByTestId("progress-lifts")).toContainText("+3.8%");
  // The 3D muscle map (SPEC-v6 §8) colours chest by its status; the list holds the numbers.
  await expect(page.getByTestId("balance-stage")).toHaveAttribute("data-mode", "3d", { timeout: 30_000 });
  const colorOf = (m: string) => page.evaluate((k) => (window as unknown as { __anatomy: { view: { colorOf(m: string): string } } }).__anatomy.view.colorOf(k), m);
  expect(await colorOf("chest")).toBe(STAGE_STATUS_COLOR.under);
  expect(await colorOf("quads")).toBe(STAGE_STATUS_COLOR.none);
  await expect(page.getByTestId("muscle-chest")).toContainText("7 · 7 / 13");
  await expect(page.getByTestId("muscle-chest")).toContainText("Under target");
  // Fractional (SPEC-v2 §7.4): face pull 3 sets (primary) + seated cable row 3 sets × 0.5 (secondary) = 4.5, against the
  // program's own fractional rear-delt volume of 11 (face pulls 6 + rows and lat pulldown as secondary 5).
  await expect(page.getByTestId("muscle-rear_delts")).toContainText("3 · 4.5 / 11");
  await expect(page.getByTestId("muscle-rear_delts")).toContainText("Under target");
  await expect(page.getByTestId("muscle-lower_back")).toContainText("0 · 1.5 / –");
  await expect(page.getByTestId("muscle-lower_back")).toContainText("No target");
  // Stretching is logged but counts 0 sets (SPEC-v2 §7.4): only the 3 RDL sets count for hamstrings and glutes.
  await expect(page.getByTestId("muscle-hamstrings_glutes")).toContainText("3 · 3 / 14");
  await page.getByRole("button", { name: "Last 4 weeks" }).click();
  await expect(page.getByTestId("progress-stats")).toContainText("2");
});

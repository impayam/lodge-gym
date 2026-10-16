import { STAGE_STATUS_COLOR } from "./tokens";
import { expect, test } from "./fixtures";
import { resetWorkouts, signIn, sql, goTo } from "./helpers";

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

  // The 1RM chart and the calendar read the sessions on the phone: load them.
  await page.reload();
  await goTo(page, "Reports");
  // Week (the default, shorter layout approved 2026-10-16): tiles without lift numbers, one Main lifts card, sets vs
  // target (chest first), the period's details folded.
  const tiles = page.getByTestId("week-stats").locator(".card--tile");
  await expect(tiles.nth(0)).toHaveText(/^1\/4\s*Sessions$/);
  // Bench 135 × 5 beats last week's 130 × 5: one record (the other exercises are new).
  await expect(tiles.nth(1)).toHaveText(/^1\s*New records/);
  await expect(tiles.nth(2)).toHaveText(/^\d+\/10\s*Groups on target/);
  await expect(page.getByTestId("week-stats")).not.toContainText("%");
  // Main lifts: the big three's chart (bench 157.5 this week), then every main lift's 1RM this week vs last week.
  const lifts = page.getByTestId("main-lifts");
  await expect(lifts.getByTestId("chart-legend")).toHaveCount(0);
  await expect(lifts.getByRole("img")).toHaveAttribute("aria-label", /latest Bench 157\.5$/);
  await expect(lifts.locator("th").nth(2)).toHaveText("vs last week");
  await expect(lifts.locator('tr[data-lift="bench"] td')).toHaveText(["Barbell Bench Press", "157.5", "+3.8%"]);
  await expect(lifts.locator('tr[data-lift="squat"] td')).toHaveText(["Barbell Back Squat", "–", "–"]);
  // 1RM shows nowhere else on the page.
  await expect(page.getByTestId("week-lifts")).toHaveCount(0);
  // The details are folded until asked for.
  await expect(page.getByTestId("week-body")).toHaveCount(0);
  await expect(page.getByTestId("report-details")).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("report-details").click();
  await expect(page.getByTestId("report-details")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("week-body")).toContainText("60 min");
  await expect(page.getByTestId("week-prs")).toContainText("Barbell Bench Press");
  const sets = page.getByTestId("week-sets");
  await expect(sets.locator(".bar-row").first()).toHaveAttribute("data-row", "chest");
  await expect(sets.locator('.bar-row[data-row="chest"]')).toContainText("7 / 13");
  await expect(sets.locator('.bar-row[data-row="chest"]')).toContainText("under target");
  await sets.getByTestId("chart-table-toggle").click();
  await expect(sets.locator('tr[data-row="chest"]')).toHaveText(/Chest\s*7\s*7\s*13/);
  // Consistency: today's session in this week's row.
  await expect(page.getByTestId("consistency").locator(`.calendar__cell[data-date="${denver(days(0))}"]`)).toHaveAttribute("data-trained", "true");
  // A stored note stays as written.
  await expect(page.getByText("عالی")).toBeVisible();

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

  // Previous week: 130 × 5, Epley 151.7.
  await page.getByRole("button", { name: "Previous week" }).click();
  await expect(page.getByTestId("main-lifts").locator('tr[data-lift="bench"] td').nth(1)).toHaveText("151.7");

  // Monthly (Gregorian month): the same layout; the change runs from the month's first session to its last.
  await page.getByRole("tab", { name: "Month" }).click();
  await expect(page.getByTestId("period-label")).toHaveText(new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "America/Denver" }).format(now));
  await expect(page.getByTestId("month-stats").locator(".card--tile").nth(2)).toHaveText(/^\d+\/10\s*Groups on target/);
  await expect(page.getByTestId("main-lifts").locator("th").nth(2)).toHaveText("this month");
  await expect(page.getByTestId("main-lifts").locator('tr[data-lift="bench"] td').nth(1)).toHaveText("157.5");
  await expect(page.getByTestId("month-numbers")).toHaveCount(0);
  await page.getByTestId("report-details").click();
  await expect(page.getByTestId("month-numbers")).toContainText("Adherence");
  await expect(page.getByTestId("month-body")).toContainText("Body weight");

  // All (since the first session) with the muscle map.
  await page.getByRole("tab", { name: "All" }).click();
  await expect(page.getByTestId("main-lifts").locator("th").nth(2)).toHaveText("since start");
  await expect(page.getByTestId("main-lifts").locator('tr[data-lift="bench"] td')).toHaveText(["Barbell Bench Press", "157.5", "+3.8%"]);
  // One record moment since the first session (this week's bench).
  await expect(page.getByTestId("all-stats").locator(".card--tile").nth(1)).toHaveText(/^1\s*New records/);
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
  await page.getByTestId("report-details").click();
  await page.getByRole("button", { name: "Last 4 weeks" }).click();
  await expect(page.getByTestId("progress-stats")).toContainText("2");
});

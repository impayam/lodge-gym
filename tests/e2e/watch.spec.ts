import { expect, test } from "@playwright/test";
import { resetWorkouts, signIn, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const denverDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d);

test("Apple Watch page: token, shortcut payload, match status, manual attach, session card", async ({ page, context, baseURL }) => {
  resetWorkouts();
  sql("DELETE FROM health_workouts");
  sql("DELETE FROM api_tokens");
  sql("DELETE FROM settings WHERE key LIKE 'health_%'");
  await signIn(context, baseURL!);

  // A finished session that started two hours ago, and an older one without watch data.
  const start = new Date(Date.now() - 2 * 3600_000);
  const end = new Date(start.getTime() + 3600_000);
  const old = new Date(Date.now() - 3 * 86_400_000);
  const rows: [string, string, Date, Date][] = [
    ["01WNOW", "D2", start, end],
    ["01WOLD", "D1", old, new Date(old.getTime() + 3600_000)],
  ];
  for (const [id, day, a, b] of rows)
    sql(
      `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
       VALUES ('${id}', '${day}', '${denverDate(a)}', '${a.toISOString()}', '${b.toISOString()}', 'done', 'lb', '', '${a.toISOString()}', '${a.toISOString()}', 'app')`
    );

  await page.goto("/");
  await page.getByRole("button", { name: "تنظیمات" }).click();
  await page.getByTestId("open-watch").click();
  await expect(page.getByRole("heading", { name: "Apple Watch" })).toBeVisible();
  await expect(page.getByText("Find Health Samples").first()).toBeVisible();
  await expect(page.getByText("Get Contents of URL").first()).toBeVisible();
  await expect(page.getByText("Apple Watch Workout")).toBeVisible();
  await expect(page.getByText("Run Immediately")).toBeVisible();
  await expect(page.getByTestId("health-url")).toHaveValue(`${baseURL}/api/health/raw`);
  await expect(page.getByTestId("last-received")).toHaveText("هنوز چیزی نرسیده");

  await page.getByRole("button", { name: "ساختن توکن تازه" }).click();
  const token = await page.getByTestId("fresh-token").inputValue();
  expect(token).toMatch(/^lgt_/);
  await expect(page.getByTestId("token-row")).toHaveCount(1);

  // What the shortcut sends: no Origin, no cookie, bearer token, Shortcuts-style text.
  const ws = new Date(start.getTime() + 5 * 60_000);
  const we = new Date(start.getTime() + 55 * 60_000);
  const hrTimes = [10, 20, 30, 40].map((m) => new Date(start.getTime() + m * 60_000).toISOString());
  const post = (data: unknown, t = token) =>
    context.request.fetch(`${baseURL}/api/health/raw`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Cookie: "" },
      data: JSON.stringify(data),
    });
  const res = await post({
    workouts: "Traditional Strength Training",
    workout_start: ws.toISOString(),
    workout_end: we.toISOString(),
    workout_energy: "312 kcal",
    hr: "110 count/min\n130 count/min\n150 count/min\n170 count/min",
    hr_time: hrTimes.join("\n"),
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ stored: 1, matched: 1 });

  // An unmatched walk from yesterday.
  const walk = new Date(Date.now() - 26 * 3600_000);
  await post({ workouts: "Walking", workout_start: walk.toISOString(), workout_end: new Date(walk.getTime() + 1800_000).toISOString() });

  await page.getByRole("button", { name: "بررسی دوباره" }).click();
  await expect(page.getByTestId("last-received")).not.toHaveText("هنوز چیزی نرسیده");
  const rowsList = page.getByTestId("watch-row");
  await expect(rowsList).toHaveCount(2);
  const strength = rowsList.filter({ hasText: "تمرین قدرتی" });
  await expect(strength).toContainText("وصل به جلسه");
  await expect(strength).toContainText("۵۰ دقیقه");
  await expect(strength).toContainText("۳۱۲ کیلوکالری فعال");
  await expect(strength).toContainText("ضربان میانگین ۱۴۰ · بیشینه ۱۷۰");

  const walkRow = rowsList.filter({ hasText: "پیاده‌روی" });
  await expect(walkRow).toContainText("تمرین ساعت بدون جلسه");
  await walkRow.getByRole("combobox").selectOption("01WOLD");
  await walkRow.getByRole("button", { name: "وصل کن" }).click();
  await expect(walkRow).toContainText("وصل به جلسه");
  expect(sql("SELECT matched_session_id AS m FROM health_workouts WHERE activity_type = 'Walking'")).toEqual([{ m: "01WOLD" }]);

  // The session screen shows the matched watch data.
  await strength.getByRole("button", { name: /روز ۲ – پا/ }).click();
  const card = page.getByTestId("session-watch");
  await expect(card).toContainText("Apple Watch");
  await expect(card).toContainText("۳۱۲ کیلوکالری فعال");
  await expect(card).toContainText("بیشینه ۱۷۰");

  // Revoking the token blocks the shortcut.
  await page.getByRole("button", { name: "تنظیمات" }).click();
  await page.getByTestId("open-watch").click();
  await page.getByRole("button", { name: "باطل کردن" }).click();
  await page.getByRole("button", { name: "مطمئنی؟ باطل کن" }).click();
  await expect(page.getByTestId("token-row")).toHaveCount(0);
  expect((await post({ workouts: "Walking" })).status()).toBe(401);
});

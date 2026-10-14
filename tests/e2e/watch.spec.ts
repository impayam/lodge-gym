import { expect, test } from "./fixtures";
import { resetWorkouts, signIn, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const denverDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d);

test("legacy workout fields: match status, manual attach, session card, revoke", async ({ page, context, baseURL }) => {
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
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("open-watch").click();
  await expect(page.getByRole("heading", { name: "Apple Watch" })).toBeVisible();
  await expect(page.getByText("Find Health Samples").first()).toBeVisible();
  await expect(page.getByText("Get Contents of URL").first()).toBeVisible();
  await expect(page.getByText("Apple Watch Workout")).toBeVisible();
  await expect(page.getByText("Run Immediately")).toBeVisible();
  await expect(page.getByTestId("health-url")).toHaveValue(`${baseURL}/api/health/raw`);
  await expect(page.getByTestId("last-received")).toHaveText("Nothing yet");

  await page.getByRole("button", { name: "Create new token" }).click();
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

  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByTestId("last-received")).not.toHaveText("Nothing yet");
  const rowsList = page.getByTestId("watch-row");
  // The strength workout, the walk, and the per-session row computed from the heart-rate samples.
  await expect(rowsList).toHaveCount(3);
  const strength = rowsList.filter({ hasText: "Traditional Strength Training" });
  await expect(strength).toContainText("Matched to a session");
  await expect(strength).toContainText("50 min");
  await expect(strength).toContainText("312 active kcal");
  await expect(strength).toContainText("avg HR 140 · max 170");

  const walkRow = rowsList.filter({ hasText: "Walking" });
  await expect(walkRow).toContainText("Watch workout without a session");
  await walkRow.getByRole("combobox").selectOption("01WOLD");
  await walkRow.getByRole("button", { name: "Attach" }).click();
  await expect(walkRow).toContainText("Matched to a session");
  expect(sql("SELECT matched_session_id AS m FROM health_workouts WHERE activity_type = 'Walking'")).toEqual([{ m: "01WOLD" }]);

  // The session screen shows the matched watch data.
  await strength.getByRole("button", { name: /Day 2 · Legs/ }).click();
  const card = page.getByTestId("session-watch");
  await expect(card).toContainText("Apple Watch");
  await expect(card).toContainText("312 active kcal");
  await expect(card).toContainText("max 170");

  // Revoking the token blocks the shortcut.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("open-watch").click();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Sure? Revoke" }).click();
  await expect(page.getByTestId("token-row")).toHaveCount(0);
  expect((await post({ workouts: "Walking" })).status()).toBe(401);
});

test("Heart Rate + Active Energy samples: per-session stats on the Apple Watch page and in the session", async ({ page, context, baseURL }) => {
  resetWorkouts();
  sql("DELETE FROM health_workouts");
  sql("DELETE FROM api_tokens");
  sql("DELETE FROM settings WHERE key LIKE 'health_%'");
  await signIn(context, baseURL!);

  const start = new Date(Date.now() - 90 * 60_000);
  const end = new Date(start.getTime() + 60 * 60_000);
  sql(
    `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
     VALUES ('01SAMP', 'D3', '${denverDate(start)}', '${start.toISOString()}', '${end.toISOString()}', 'done', 'lb', '', '${start.toISOString()}', '${start.toISOString()}', 'app')`
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("open-watch").click();
  await expect(page.getByText("Active Energy").first()).toBeVisible();
  await expect(page.getByText("energy_time").first()).toBeVisible();
  await expect(page.getByText("Workouts", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create new token" }).click();
  const token = await page.getByTestId("fresh-token").inputValue();

  const at = (min: number) => new Date(start.getTime() + min * 60_000).toISOString();
  const payload = {
    hr: ["95 count/min", "120 count/min", "140 count/min", "160 count/min", "100 count/min"].join("\n"),
    hr_time: [at(-10), at(10), at(30), at(50), at(70)].join("\n"),
    energy: ["4 kcal", "100 kcal", "120,4 kcal", "6 kcal"].join("\n"),
    energy_time: [at(-5), at(20), at(40), at(65)].join("\n"),
  };
  for (let i = 0; i < 2; i++) {
    const res = await context.request.fetch(`${baseURL}/api/health/raw`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Cookie: "" },
      data: JSON.stringify(payload),
    });
    expect(await res.json()).toMatchObject({ sessions: 1, hr_samples: 5, energy_samples: 4, message: "GYM time: watch data saved for 1 session." });
  }
  expect(sql("SELECT COUNT(*) AS n FROM health_workouts")).toEqual([{ n: 1 }]);

  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByTestId("watch-status")).toContainText("5 heart-rate samples, 4 energy samples, data for 1 session");
  const row = page.getByTestId("watch-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Day 3 · Back");
  await expect(row).toContainText("60 min · 220 active kcal · avg HR 140 · max 160");

  await row.getByRole("button", { name: /Day 3 · Back/ }).click();
  const card = page.getByTestId("session-watch");
  await expect(card).toContainText("During the session");
  await expect(card).toContainText("60 min · 220 active kcal · avg HR 140 · max 160");
});

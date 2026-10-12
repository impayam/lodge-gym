import { expect, test } from "./fixtures";
import { resetWorkouts, setOffline, signIn, sql, waitForSynced } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  sql("DELETE FROM body_metrics");
  await signIn(context, baseURL!);
});

test("logs a full session in airplane mode; after reconnecting it is in D1 exactly once", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toContainText("Next session: Day 1 · Chest");
  await expect(page.getByText("Your first session: start with Day 1.")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  // Let the service worker take control so the shell also loads offline.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null || !("serviceWorker" in navigator), null, { timeout: 15_000 }).catch(() => undefined);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator('[data-ex="bench"]').getByText("Barbell Bench Press")).toBeVisible();
  await expect(page.getByText("پرس سینه هالتر")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Watch form video ↗" }).first()).toHaveAttribute("href", "https://www.youtube.com/results?search_query=Barbell%20Bench%20Press%20form");

  // Persian digits are still accepted in the weight field; then one tap per set.
  await page.getByTestId("w-bench-0").locator("input").fill("۱۳۵");
  await page.getByTestId("check-bench-0").click();
  await expect(page.getByTestId("rest-timer")).toBeVisible();
  await expect(page.getByTestId("rest-timer")).toContainText("Rest after Barbell Bench Press");
  await expect(page.getByTestId("r-bench-0").locator("input")).toHaveValue("5");

  await setOffline(context, page, true);
  await expect(page.getByTestId("sync-chip")).toContainText("Offline");

  for (let i = 1; i < 4; i++) {
    await page.getByTestId(`w-bench-${i}`).locator("input").fill("135");
    await page.getByTestId(`check-bench-${i}`).click();
  }
  // Stepper: + on an empty weight starts from 0 for a first-time exercise, by the dumbbell increment (5 lb).
  await page.getByTestId("w-incline_db-0").getByRole("button", { name: /Increase/ }).click();
  await expect(page.getByTestId("w-incline_db-0").locator("input")).toHaveValue("5");
  for (const ex of ["incline_db", "rdl", "cable_row", "lateral", "facepull"]) {
    for (let i = 0; i < 3; i++) await page.getByTestId(`check-${ex}-${i}`).click();
  }
  await page.locator("#f-note").fill("Offline session");
  await page.locator("#f-note").blur();
  await page.getByTestId("finish").click();
  await expect(page.getByText("Session saved.")).toBeVisible();
  await expect(page.getByTestId("sync-chip")).toContainText("pending");

  // Still offline: reload works from the service worker and data survives in IndexedDB.
  await page.reload();
  await expect(page.getByTestId("next-card")).toContainText("Next session: Day 2 · Legs");
  expect(sql("SELECT COUNT(*) AS n FROM workout_sessions")).toEqual([{ n: 0 }]);

  await setOffline(context, page, false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForSynced(page);

  const sessions = sql("SELECT id, program_day_id, status, unit, note, ended_at IS NOT NULL AS ended FROM workout_sessions") as Record<string, unknown>[];
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ program_day_id: "D1", status: "done", unit: "lb", note: "Offline session", ended: 1 });
  expect(sql("SELECT COUNT(*) AS n FROM set_entries")).toEqual([{ n: 19 }]);
  expect(sql("SELECT COUNT(*) AS n FROM set_entries WHERE done = 1")).toEqual([{ n: 19 }]);
  expect(sql("SELECT weight, reps FROM set_entries WHERE exercise_id = 'bench' ORDER BY set_index")).toEqual([
    { weight: 135, reps: 5 },
    { weight: 135, reps: 5 },
    { weight: 135, reps: 5 },
    { weight: 135, reps: 5 },
  ]);

  // Syncing again (e.g. a retried outbox) never duplicates.
  await page.getByTestId("sync-chip").click();
  await page.reload();
  await waitForSynced(page);
  expect(sql("SELECT COUNT(*) AS n FROM workout_sessions")).toEqual([{ n: 1 }]);
  expect(sql("SELECT COUNT(*) AS n FROM set_entries")).toEqual([{ n: 19 }]);
});

test("suggestion and last performance follow SPEC §7", async ({ page }) => {
  // Previous D1: bench 4×5 @ 135 all done; incline 3×10 @ 40 with a short set.
  const day = "2026-09-20";
  sql(
    `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
     VALUES ('01PREV', 'D1', '${day}', '${day}T23:00:00.000Z', '${day}T23:55:00.000Z', 'done', 'lb', '', '${day}T23:00:00.000Z', '${day}T23:55:00.000Z', 'app')`
  );
  const rows = [
    ...[0, 1, 2, 3].map((i) => `('01PB${i}', '01PREV', 'bench', ${i}, 135, 5, NULL, 1, '${day}T23:10:00.000Z')`),
    ...[0, 1, 2].map((i) => `('01PI${i}', '01PREV', 'incline_db', ${i}, 40, ${i === 2 ? 8 : 10}, NULL, 1, '${day}T23:20:00.000Z')`),
  ];
  sql(`INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, updated_at) VALUES ${rows.join(", ")}`);

  await page.goto("/");
  await expect(page.getByTestId("next-card")).toContainText("Next session: Day 2 · Legs");
  await page.locator(".dayopt", { hasText: "Day 1 · Chest" }).click();

  const bench = page.locator('[data-ex="bench"]');
  await expect(bench.getByTestId("last-perf")).toContainText("135×5");
  await expect(bench.getByTestId("suggestion")).toHaveText("Suggested: 140 lb");
  await expect(bench.getByTestId("w-bench-0").locator("input")).toHaveAttribute("placeholder", "140");
  await expect(bench.getByTestId("r-bench-0").locator("input")).toHaveAttribute("placeholder", "5");

  const incline = page.locator('[data-ex="incline_db"]');
  await expect(incline.getByTestId("suggestion")).toHaveText("Stay at 40 lb until every set is complete");

  // One tap: commits the prefilled weight and the target reps.
  await page.getByTestId("check-bench-0").click();
  await expect(bench.getByTestId("w-bench-0").locator("input")).toHaveValue("140");
  await expect(bench.getByTestId("r-bench-0").locator("input")).toHaveValue("5");

  // "Same as last time" copies last session's sets.
  await incline.getByRole("button", { name: "Same as last time" }).click();
  await expect(incline.getByTestId("r-incline_db-2").locator("input")).toHaveValue("8");
  await expect(incline.getByTestId("w-incline_db-2").locator("input")).toHaveValue("40");

  // RIR chip (tap again clears) and the manual body weight.
  await page.getByTestId("rir-bench-0").getByRole("button", { name: "3+" }).click();
  await expect(page.getByTestId("rir-bench-0").getByRole("button", { name: "3+" })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("rir-bench-1").getByRole("button", { name: "1", exact: true }).click();
  await page.getByTestId("rir-bench-1").getByRole("button", { name: "1", exact: true }).click();
  await expect(page.getByTestId("rir-bench-1").getByRole("button", { name: "1", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("body-weight").locator("input").fill("180.4");
  await page.getByTestId("body-weight").locator("input").blur();

  // Add / remove set.
  await incline.getByRole("button", { name: "+ Add set" }).click();
  await expect(incline.getByTestId("w-incline_db-3")).toBeVisible();
  await incline.getByRole("button", { name: "− Remove set" }).click();
  await expect(incline.getByTestId("w-incline_db-3")).toHaveCount(0);

  // Timed rest bar: +30 s and dismiss.
  await page.getByRole("button", { name: "+30 s" }).click();
  await page.getByTestId("rest-timer").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("rest-timer")).toHaveCount(0);
  await waitForSynced(page);
  expect(sql("SELECT rir FROM set_entries se JOIN workout_sessions ws ON ws.id = se.session_id WHERE ws.id <> '01PREV' AND exercise_id = 'bench' ORDER BY set_index LIMIT 2")).toEqual([{ rir: 3 }, { rir: null }]);
  expect(sql("SELECT value, unit, source FROM body_metrics WHERE kind = 'body_mass'")).toEqual([{ value: 180.4, unit: "lb", source: "manual" }]);
});

test("RIR 3+ on every set doubles the next increment", async ({ page }) => {
  const day = "2026-09-20";
  sql(
    `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
     VALUES ('01EASY', 'D1', '${day}', '${day}T23:00:00.000Z', '${day}T23:55:00.000Z', 'done', 'lb', '', '${day}T23:00:00.000Z', '${day}T23:55:00.000Z', 'app')`
  );
  sql(
    `INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, rir, updated_at) VALUES ${[0, 1, 2, 3]
      .map((i) => `('01EB${i}', '01EASY', 'bench', ${i}, 135, 5, NULL, 1, 3, '${day}T23:10:00.000Z')`)
      .join(", ")}`
  );
  await page.goto("/");
  await page.locator(".dayopt", { hasText: "Day 1 · Chest" }).click();
  await expect(page.locator('[data-ex="bench"]').getByTestId("suggestion")).toHaveText("Suggested: 145 lb (two steps: every set had 3+ reps in reserve)");
  await expect(page.getByTestId("w-bench-0").locator("input")).toHaveAttribute("placeholder", "145");
});

test("home shows the rest advice after two training days in a row", async ({ page }) => {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d);
  const y1 = fmt(new Date(Date.now() - 86_400_000));
  const y2 = fmt(new Date(Date.now() - 2 * 86_400_000));
  for (const [id, day, date] of [
    ["01R1", "D1", y2],
    ["01R2", "D2", y1],
  ])
    sql(
      `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
       VALUES ('${id}', '${day}', '${date}', '${date}T18:00:00.000Z', '${date}T19:00:00.000Z', 'done', 'lb', '', '${date}T18:00:00.000Z', '${date}T19:00:00.000Z', 'app')`
    );
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toContainText("Next session: Day 3 · Back");
  await expect(page.getByText("Rest is better today", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
});

test("security headers are present on the app shell", async ({ page, baseURL }) => {
  const res = await page.request.get(`${baseURL}/`);
  expect(res.headers()["content-security-policy"]).toBe("default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'");
  const manifest = await (await page.request.get(`${baseURL}/manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ lang: "en", dir: "ltr", display: "standalone", start_url: "/", scope: "/" });
});

import { expect, test, type Locator, type Page } from "./fixtures";
import { aiCalls, aiMode, checkSet, goTo, openMore, resetWorkouts, setOffline, showExercise, signIn, sql, waitForSynced } from "./helpers";
import { addDays, localDate } from "../../worker/lib/time";

// The session screen (Payam, 2026-10-16): the rest timer says what comes next and rests 30 s between sets and 2 min
// before the next exercise (Settings → Training); a superset is one card done round by round with its own rest after
// each round; Ask Coach opens over the session and knows where he is; the body weight after Finish.
test.describe.configure({ mode: "serial" });

const TZ = "America/Denver";
const clearCoach = () => sql("DELETE FROM coach_attachments; DELETE FROM coach_messages; DELETE FROM coach_threads");
const clearRest = () => sql("DELETE FROM settings WHERE key IN ('rest_between_sets_sec', 'rest_next_exercise_sec')");

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  clearCoach();
  clearRest();
  sql("DELETE FROM body_metrics");
  await aiMode({ coach: "ok" });
  await signIn(context, baseURL!);
});
test.afterAll(() => {
  resetWorkouts();
  clearCoach();
  clearRest();
  sql("DELETE FROM body_metrics");
});

async function startDay1(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("next-card")).toHaveAttribute("data-day", "Day 1 · Chest");
  await page.getByTestId("start").click();
  await expect(page.getByTestId("ex-card")).toHaveAttribute("data-ex", "bench");
}

/** The timer's seconds left, from its clock ("1:15"). */
async function secondsLeft(rest: Locator) {
  const [m, s] = ((await rest.locator(".big-num").textContent()) ?? "").split(":").map(Number);
  return m * 60 + s;
}

/** The timer runs with this label and about this many seconds (a few may have passed). */
async function resting(page: Page, label: string, seconds: number) {
  const rest = page.getByTestId("rest-timer");
  await expect(rest).toHaveAttribute("data-active", "true");
  await expect(rest.locator(".rest__label")).toHaveText(label);
  const left = await secondsLeft(rest);
  expect(left).toBeLessThanOrEqual(seconds);
  expect(left).toBeGreaterThanOrEqual(seconds - 5);
}

async function skipRest(page: Page) {
  await page.getByTestId("rest-timer").getByRole("button", { name: "Skip" }).click();
  await expect(page.getByTestId("rest-timer")).toHaveAttribute("data-active", "false");
}

const noRest = (page: Page) => expect(page.getByTestId("rest-timer")).toHaveAttribute("data-active", "false");
const current = (page: Page, row: string) => expect(page.locator(`[data-set="${row}"]`)).toHaveClass(/set-row--current/);

test("rest: 30 s between sets and 2 min before the next exercise; the superset is one card, round by round, with its own rest after each round", async ({ page }) => {
  test.setTimeout(90_000);
  await startDay1(page);
  // Between sets of one exercise.
  await page.getByTestId("check-bench-0").click();
  await resting(page, "Rest · next: set 2 of 4", 30);
  await skipRest(page);
  // Out of order: the next set is the first one not done.
  await page.getByTestId("check-bench-2").click();
  await resting(page, "Rest · next: set 2 of 4", 30);
  await page.getByTestId("check-bench-1").click();
  await resting(page, "Rest · next: set 4 of 4", 30);
  // After the last set: 2 min, then the next exercise.
  await page.getByTestId("check-bench-3").click();
  await resting(page, "Rest · next: Incline Dumbbell Press", 120);
  await skipRest(page);

  // Superset A (Dumbbell Lateral Raise + Face Pull) is one card; Next / Prev move between cards.
  await showExercise(page, "lateral");
  const group = page.getByTestId("group-card");
  await expect(group).toHaveAttribute("data-ex", "lateral facepull");
  await expect(group.getByRole("heading", { level: 2 })).toHaveText("Superset A");
  await expect(group).toContainText("Exercises 5–6 of 6");
  await expect(group).toContainText("rest 75 s after each round");
  await expect(page.getByTestId("ex-card")).toHaveCount(0);
  await expect(page.getByTestId("prev")).toBeEnabled();
  await expect(page.getByTestId("next")).toHaveText("Last exercise");
  // Each member keeps its own name, target and guidance.
  for (const [id, mark, name] of [
    ["lateral", "A1", "Dumbbell Lateral Raise"],
    ["facepull", "A2", "Face Pull"],
  ]) {
    const member = group.locator(`[data-testid="group-member"][data-ex="${id}"]`);
    await expect(member).toContainText(mark);
    await expect(member.getByRole("heading", { level: 3 })).toHaveText(name);
  }
  // The sets are interleaved round by round.
  const rows = () => group.locator("[data-set]").evaluateAll((els) => els.map((e) => e.getAttribute("data-set")));
  expect(await rows()).toEqual(["lateral-0", "facepull-0", "lateral-1", "facepull-1", "lateral-2", "facepull-2"]);
  await expect(group.getByTestId("round-1")).toContainText("Round 1");
  await current(page, "lateral-0");

  // No timer inside a round; the group's rest after it.
  await page.getByTestId("check-lateral-0").click();
  await noRest(page);
  await current(page, "facepull-0");
  await page.getByTestId("check-facepull-0").click();
  await resting(page, "Rest · next: round 2 of 3", 75);
  await skipRest(page);
  await current(page, "lateral-1");

  // An extra set is a round of its own at the end.
  await page.getByTestId("add-set-lateral").click();
  expect(await rows()).toEqual(["lateral-0", "facepull-0", "lateral-1", "facepull-1", "lateral-2", "facepull-2", "lateral-3"]);
  await expect(group.getByTestId("round-4")).toContainText("Round 4");
  for (const r of ["lateral-1", "facepull-1", "lateral-2"]) {
    await page.getByTestId(`check-${r}`).click();
    if (r !== "facepull-1") await noRest(page);
    else {
      await resting(page, "Rest · next: round 3 of 4", 75);
      await skipRest(page);
    }
  }
  await page.getByTestId("check-facepull-2").click();
  await resting(page, "Rest · next: round 4 of 4", 75);
  await skipRest(page);
  await current(page, "lateral-3");
  // The last round: 2 min, then the next card with a set left (round to Incline Dumbbell Press).
  await page.getByTestId("check-lateral-3").click();
  await resting(page, "Rest · next: Incline Dumbbell Press", 120);

  // Logged as before: each member's own sets, the extra one included.
  await waitForSynced(page);
  expect(sql("SELECT exercise_id, COUNT(*) AS n, SUM(done) AS done FROM set_entries WHERE exercise_id IN ('lateral', 'facepull') GROUP BY exercise_id ORDER BY exercise_id")).toEqual([
    { exercise_id: "facepull", n: 3, done: 3 },
    { exercise_id: "lateral", n: 4, done: 4 },
  ]);
});

test("Settings → Training: his rest between sets and before the next exercise; a superset keeps its program rest", async ({ page }) => {
  await page.goto("/");
  await goTo(page, "Settings");
  const training = page.getByTestId("training-settings");
  await expect(training.locator("#s-rest-sets")).toHaveValue("30");
  await expect(training.locator("#s-rest-next")).toHaveValue("120");
  // Both in the same moment: two changes queued at once must both reach the server (one once overwrote the other).
  await page.evaluate(() => {
    for (const [id, value] of [
      ["s-rest-sets", "60"],
      ["s-rest-next", "180"],
    ]) {
      const select = document.getElementById(id) as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await expect(training.locator("#s-rest-sets")).toHaveValue("60");
  await expect(training.locator("#s-rest-next")).toHaveValue("180");
  await expect
    .poll(() => sql("SELECT key, value FROM settings WHERE key IN ('rest_between_sets_sec', 'rest_next_exercise_sec') ORDER BY key"), { timeout: 20_000 })
    .toEqual([
      { key: "rest_between_sets_sec", value: "60" },
      { key: "rest_next_exercise_sec", value: "180" },
    ]);

  await startDay1(page);
  await page.getByTestId("check-bench-0").click();
  await resting(page, "Rest · next: set 2 of 4", 60);
  for (const i of [1, 2, 3]) await page.getByTestId(`check-bench-${i}`).click();
  await resting(page, "Rest · next: Incline Dumbbell Press", 180);
  await skipRest(page);
  await checkSet(page, "lateral", 0);
  await page.getByTestId("check-facepull-0").click();
  await resting(page, "Rest · next: round 2 of 3", 75);
});

test("Ask Coach over the session: the session and its timer keep running; the message says where he is; closing returns to the same card; offline it needs a connection", async ({ page, context }) => {
  test.setTimeout(90_000);
  await startDay1(page);
  await page.getByTestId("check-bench-0").click();
  await resting(page, "Rest · next: set 2 of 4", 30);
  // More time, so the rest outlasts the chat.
  await page.getByRole("button", { name: "+30 s" }).click();
  await page.getByRole("button", { name: "+30 s" }).click();
  const before = await secondsLeft(page.getByTestId("rest-timer"));

  // The top row of the More sheet, above Add exercise.
  const more = await openMore(page);
  const row = more.getByTestId("ask-coach");
  await expect(more.locator(".list-row").first()).toHaveAttribute("data-testid", "ask-coach");
  await expect(row).toBeEnabled();
  await expect(more.getByTestId("ask-coach-note")).toHaveText("About this session; the timer keeps running");
  await row.click();

  const sheet = page.getByTestId("coach-sheet");
  await expect(sheet).toHaveAttribute("open", "");
  await expect(sheet).toContainText("Chest · the session keeps running");
  // The session is still behind the sheet, with its timer.
  await expect(page.getByTestId("session")).toBeAttached();
  await expect(page.getByTestId("rest-timer")).toHaveAttribute("data-active", "true");
  await sheet.getByTestId("coach-input").fill("Is the same weight right for my next set?");
  await sheet.getByTestId("coach-send").click();
  await expect(sheet.getByTestId("coach-cost")).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByTestId("coach-answer").first()).toBeVisible();

  // The app wrote where he is into the message's CONTEXT block.
  const call = (await aiCalls()).by_kind.coach!;
  expect(call.question).toBe("Is the same weight right for my next set?");
  expect(call.context).toContain("He is training now (the session open today): Day 1 · Chest, started ");
  expect(call.context).toContain("On his screen: Barbell Bench Press, set 2 of 4.");
  expect(call.context).toMatch(/Done so far \(lb\): Barbell Bench Press [\d.]*×\d+\./);

  // Closing returns to the same card; the timer kept running.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("ex-card")).toHaveAttribute("data-ex", "bench");
  const rest = page.getByTestId("rest-timer");
  await expect(rest).toHaveAttribute("data-active", "true");
  await expect(rest.locator(".rest__label")).toHaveText("Rest · next: set 2 of 4");
  expect(await secondsLeft(rest)).toBeLessThan(before);
  await expect(page.getByTestId("check-bench-0")).toHaveAttribute("aria-pressed", "true");

  // Opening it again shows this session's chat.
  await (await openMore(page)).getByTestId("ask-coach").click();
  await expect(sheet.getByText("Is the same weight right for my next set?")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Offline: the row says it needs a connection.
  await setOffline(context, page, true);
  const offline = await openMore(page);
  await expect(offline.getByTestId("ask-coach")).toBeDisabled();
  await expect(offline.getByTestId("ask-coach-note")).toHaveText("Needs connection");
  await page.keyboard.press("Escape");
  await setOffline(context, page, false);
  const back = await openMore(page);
  await expect(back.getByTestId("ask-coach")).toBeEnabled();
});

test("after Finish: body weight today, shown from his last entry; − / + save one value for the day; skipping it never blocks", async ({ page }) => {
  test.setTimeout(90_000);
  const today = localDate(TZ);
  sql(`INSERT INTO body_metrics (id, local_date, kind, value, unit, source, received_at) VALUES ('01E2EBODYLAST', '${addDays(today, -3)}', 'body_mass', 181.2, 'lb', 'manual', '2026-10-01T12:00:00.000Z')`);
  await startDay1(page);
  await page.getByTestId("check-bench-0").click();
  await page.getByTestId("finish").click();
  await expect(page.getByTestId("report-screen")).toBeVisible();
  // Nothing waits for it: the report is written without it.
  await expect(page.getByTestId("report-summary")).toBeVisible({ timeout: 30_000 });

  const field = page.getByTestId("finish-weight");
  await expect(field).toContainText("Body weight today (lb)");
  await expect(field).toContainText("Optional.");
  const input = field.getByTestId("finish-body-weight").locator("input");
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", "181.2");
  // + starts from the last entry.
  await field.getByRole("button", { name: "Increase Body weight (lb)" }).click();
  await expect(input).toHaveValue("181.3");
  await waitForSynced(page);
  const todays = () => sql(`SELECT value, unit, source FROM body_metrics WHERE kind = 'body_mass' AND local_date = '${today}'`);
  await expect.poll(todays).toEqual([{ value: 181.3, unit: "lb", source: "manual" }]);
  // Again: still one value for the day.
  await field.getByRole("button", { name: "Decrease Body weight (lb)" }).click();
  await field.getByRole("button", { name: "Decrease Body weight (lb)" }).click();
  await expect(input).toHaveValue("181.1");
  await waitForSynced(page);
  await expect.poll(todays).toEqual([{ value: 181.1, unit: "lb", source: "manual" }]);

  // The next session's More sheet shows the same value.
  await page.goto("/");
  await page.getByTestId("start").click();
  const more = await openMore(page);
  await expect(more.getByTestId("body-weight").locator("input")).toHaveValue("181.1");
});

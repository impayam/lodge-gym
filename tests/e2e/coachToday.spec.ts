import { expect, test, type Page } from "./fixtures";
import { aiJobsIdle, aiMode, resetCalendar, resetWorkouts, signIn, sql } from "./helpers";
import { addDays, localDate, zonedToUtcISO } from "../../worker/lib/time";
import { ulid } from "../../worker/lib/ulid";

// Coach: exercises for a session (Payam, 2026-10-16), with the model mocked. The card names the session by date (open
// today, today's day, the next planned session); Add puts them there; the program never changes. Sessions left open
// from an earlier day close by themselves: finished at the last done set, or deleted when nothing was done.
test.describe.configure({ mode: "serial" });

const TZ = "America/Denver";
const today = () => localDate(TZ);
const dateShort = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const count = (q: string) => (sql(q)[0] as { n: number }).n;
const program = () => JSON.stringify(sql("SELECT day_id, exercise_id, position, sets, reps_min, reps_max FROM day_exercises ORDER BY day_id, position"));
const ASK_TODAY = "امروز پشت دارم، جلوبازو و ساعد هم اضافه کن";

/** A session through the API, as the app saves it: status, and sets [weight, reps, done, at]. */
async function putSession(page: Page, baseURL: string, o: { id: string; day: string; date: string; status: "active" | "done"; sets: [number, number, boolean, string][] }) {
  const started = zonedToUtcISO(o.date, "17:00", TZ);
  const sets = o.sets.map(([weight, reps, done, at], i) => ({ id: `${o.id}-${i}`, exercise_id: "bench", set_index: i, weight, reps, seconds: null, done, rir: null, updated_at: at }));
  const res = await page.request.put(`${baseURL}/api/sessions/${o.id}`, {
    headers: { Origin: baseURL },
    data: { id: o.id, program_day_id: o.day, local_date: o.date, started_at: started, ended_at: null, status: o.status, unit: "lb", note: "", created_at: started, updated_at: started, source: "app", sets },
  });
  expect(res.status()).toBe(200);
}

async function askCoach(page: Page, text: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Ask the coach" }).click();
  await page.getByTestId("coach-input").fill(text);
  await page.getByTestId("coach-send").click();
  const card = page.getByTestId("coach-additions");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("coach-cost")).toBeVisible();
  const ids = await card.getByTestId("coach-addition-row").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.ex!));
  expect(ids.length).toBeGreaterThan(0);
  return { card, ids };
}

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  resetCalendar();
  sql("DELETE FROM coach_attachments; DELETE FROM coach_messages; DELETE FROM coach_threads");
  await aiMode({ coach: "ok", report: "ok", overview: "ok" });
  await signIn(context, baseURL!);
});
test.afterAll(() => {
  resetWorkouts();
  resetCalendar();
  sql("DELETE FROM coach_attachments; DELETE FROM coach_messages; DELETE FROM coach_threads");
});

test("a session open today: the card asks to add to it; Add appends the exercises as extras; the program is unchanged", async ({ page, baseURL }) => {
  const before = program();
  const id = ulid();
  await putSession(page, baseURL!, { id, day: "D1", date: today(), status: "active", sets: [[135, 5, true, new Date().toISOString()]] });
  const { card, ids } = await askCoach(page, ASK_TODAY);
  // He said "back", but a session is open today: that session.
  await expect(card.getByTestId("coach-additions-target")).toHaveText("Add to today's session: Day 1 · Chest?");
  await expect(card).toHaveAttribute("data-target", "open_session");
  await card.getByTestId("coach-add-additions").click();
  await expect(page.getByTestId("toast")).toHaveText(`Added ${ids.length} exercises to today's session: Day 1 · Chest.`);
  await expect(card.getByTestId("coach-additions-added")).toContainText("In today's session.");
  await expect
    .poll(() => sql(`SELECT DISTINCT exercise_id FROM set_entries WHERE session_id = '${id}' AND is_extra = 1 ORDER BY exercise_id`), { timeout: 20_000 })
    .toEqual([...ids].sort().map((exercise_id) => ({ exercise_id })));
  expect(count("SELECT COUNT(*) AS n FROM workout_sessions")).toBe(1);
  expect(program()).toBe(before);
});

test("no session today: today's named day; Change lists the other choices; Add starts the day with the exercises", async ({ page }) => {
  const before = program();
  const { card, ids } = await askCoach(page, ASK_TODAY);
  await expect(card.getByTestId("coach-additions-target")).toHaveText("Add to today's Day 3 · Back");
  // Change: every day started today (no plans ahead), the default first; another choice changes the heading.
  await card.getByTestId("coach-change-additions").click();
  const where = card.locator("#coach-additions-where");
  await expect(where.locator("option")).toHaveText(["Today's Day 3 · Back", "Today's Day 1 · Chest", "Today's Day 2 · Legs", "Today's Day 4 · Deadlift"]);
  await where.selectOption({ label: "Today's Day 1 · Chest" });
  await expect(card.getByTestId("coach-additions-target")).toHaveText("Add to today's Day 1 · Chest");
  await where.selectOption({ label: "Today's Day 3 · Back" });
  expect(count("SELECT COUNT(*) AS n FROM workout_sessions")).toBe(0);

  await card.getByTestId("coach-add-additions").click();
  await expect(page.getByTestId("toast")).toHaveText(`Added ${ids.length} exercises to today's Day 3 · Back.`);
  await expect(card.getByTestId("coach-additions-added")).toContainText("In today's session.");
  await expect.poll(() => sql(`SELECT program_day_id, local_date, status FROM workout_sessions`), { timeout: 20_000 }).toEqual([{ program_day_id: "D3", local_date: today(), status: "active" }]);
  // The day's own exercises, then the coach's as extras (prefilled, not checked).
  await expect
    .poll(() => sql("SELECT DISTINCT exercise_id FROM set_entries WHERE is_extra = 1 ORDER BY exercise_id"), { timeout: 20_000 })
    .toEqual([...ids].sort().map((exercise_id) => ({ exercise_id })));
  expect(count("SELECT COUNT(*) AS n FROM set_entries WHERE is_extra = 1 AND done = 1")).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM set_entries WHERE is_extra = 0")).toBeGreaterThan(0);
  expect(program()).toBe(before);
});

test("tomorrow's planned session: the exercises go into that day's plan and are in the session when it starts", async ({ page }) => {
  const before = program();
  const tomorrow = addDays(today(), 1);
  const now = new Date().toISOString();
  sql(`INSERT INTO gym_plans (id, date, start_min, end_min, program_day_id, source, status, created_at, updated_at) VALUES ('g-tom', '${tomorrow}', 480, 535, 'D4', 'manual', 'planned', '${now}', '${now}')`);
  const { card, ids } = await askCoach(page, "Add biceps and forearms to my next session");
  await expect(card.getByTestId("coach-additions-target")).toHaveText("Add to tomorrow 08:00 · Day 4 · Deadlift");
  await card.getByTestId("coach-add-additions").click();
  await expect(page.getByTestId("toast")).toHaveText(`Added ${ids.length} exercises to tomorrow 08:00 · Day 4 · Deadlift.`);
  await expect(card.getByTestId("coach-additions-added")).toContainText("In that day's plan");
  // Saved as Day 4's plan in the planner; no session yet.
  await expect
    .poll(() => sql("SELECT i.exercise_id FROM session_plan_items i JOIN planned_sessions p ON p.id = i.session_id WHERE p.program_day_id = 'D4' AND p.status = 'planned' AND i.origin = 'added' ORDER BY i.exercise_id"), { timeout: 20_000 })
    .toEqual([...ids].sort().map((exercise_id) => ({ exercise_id })));
  expect(count("SELECT COUNT(*) AS n FROM workout_sessions")).toBe(0);

  // Open → the plan → Start session: the session has the day's exercises and the coach's.
  await card.getByRole("button", { name: "Open" }).click();
  await page.getByTestId("plan-start").click();
  await expect(page.getByTestId("finish")).toBeVisible();
  await expect
    .poll(() => sql("SELECT DISTINCT s.program_day_id, e.exercise_id FROM set_entries e JOIN workout_sessions s ON s.id = e.session_id ORDER BY e.exercise_id").map((r) => (r as { exercise_id: string }).exercise_id), { timeout: 20_000 })
    .toEqual(expect.arrayContaining(ids));
  expect(program()).toBe(before);
});

test("yesterday's open session closes by itself: finished at its last done set, its report written, a one-time note on Home", async ({ page, context, baseURL }) => {
  const y = addDays(today(), -1);
  const id = ulid();
  const lastDone = zonedToUtcISO(y, "18:20", TZ);
  await putSession(page, baseURL!, {
    id,
    day: "D1",
    date: y,
    status: "active",
    sets: [
      [135, 5, true, zonedToUtcISO(y, "18:05", TZ)],
      [135, 5, true, lastDone],
      [135, 0, false, zonedToUtcISO(y, "18:25", TZ)],
    ],
  });
  await page.goto("/");
  await expect(page.getByTestId("auto-closed")).toHaveText(`Your session from ${dateShort(y)} was closed automatically.`);
  await expect.poll(() => sql(`SELECT status, ended_at FROM workout_sessions WHERE id = '${id}'`), { timeout: 20_000 }).toEqual([{ status: "done", ended_at: lastDone }]);
  // As a normal Finish: the server writes the session report.
  await expect.poll(() => count(`SELECT COUNT(*) AS n FROM session_reports WHERE session_id = '${id}' AND status = 'ok'`), { timeout: 30_000 }).toBe(1);
  await aiJobsIdle(context, baseURL!);
  // One time only.
  await page.reload();
  await expect(page.getByTestId("today-date")).toBeVisible();
  await expect(page.getByTestId("auto-closed")).toHaveCount(0);
});

test("yesterday's open session with nothing done is deleted, not saved empty", async ({ page, baseURL }) => {
  const y = addDays(today(), -1);
  const id = ulid();
  await putSession(page, baseURL!, { id, day: "D2", date: y, status: "active", sets: [[185, 0, false, zonedToUtcISO(y, "17:10", TZ)], [185, 0, false, zonedToUtcISO(y, "17:12", TZ)]] });
  await page.goto("/");
  await expect(page.getByTestId("auto-closed")).toHaveText(`Your session from ${dateShort(y)} was closed automatically.`);
  await expect.poll(() => count(`SELECT COUNT(*) AS n FROM workout_sessions WHERE id = '${id}'`), { timeout: 20_000 }).toBe(0);
  expect(count(`SELECT COUNT(*) AS n FROM set_entries WHERE session_id = '${id}'`)).toBe(0);
  expect(count(`SELECT COUNT(*) AS n FROM session_reports WHERE session_id = '${id}'`)).toBe(0);
});

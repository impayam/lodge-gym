import { expect, test, type Page } from "./fixtures";
import { aiMode, resetCalendar, resetWorkouts, signIn, sql } from "./helpers";
import { localDate, zonedToUtcISO } from "../../worker/lib/time";
import { ulid } from "../../worker/lib/ulid";

// Coach: one more exercise for a day (Payam, 2026-10-16), with the model mocked. One card with only the change and
// two buttons, the one he asked for first: Only this session (the open session, or that day's plan, in the same place)
// and Whole program (a draft of his program with that exercise, under Me → Program → Drafts). The program, library and
// recovery cards are shown only when he asks to see them; Sets vs target is one card with the weeks as columns.
test.describe.configure({ mode: "serial" });

const TZ = "America/Denver";
const today = () => localDate(TZ);
const count = (q: string) => (sql(q)[0] as { n: number }).n;
/** The seed program's days and exercises (drafts have their own days). */
const program = () => JSON.stringify(sql("SELECT x.day_id, x.exercise_id, x.position, x.sets, x.reps_min, x.reps_max, x.superset_tag FROM day_exercises x JOIN program_days d ON d.id = x.day_id WHERE d.program_id = 'fullbody4' ORDER BY x.day_id, x.position"));
const D1 = ["bench", "incline_db", "rdl", "cable_row", "lateral", "facepull"];
const clearCoach = () =>
  sql(
    [
      "DELETE FROM coach_attachments; DELETE FROM coach_messages; DELETE FROM coach_threads",
      "DELETE FROM program_activations WHERE program_id IN (SELECT id FROM programs WHERE generated_by = 'coach')",
      "DELETE FROM day_exercises WHERE day_id IN (SELECT id FROM program_days WHERE program_id IN (SELECT id FROM programs WHERE generated_by = 'coach'))",
      "DELETE FROM program_days WHERE program_id IN (SELECT id FROM programs WHERE generated_by = 'coach')",
      "DELETE FROM programs WHERE generated_by = 'coach'",
    ].join("; ")
  );

async function askCoach(page: Page, text: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Ask the coach" }).click();
  await page.getByTestId("coach-input").fill(text);
  await page.getByTestId("coach-send").click();
  await expect(page.getByTestId("coach-cost")).toBeVisible({ timeout: 30_000 });
  return page.getByTestId("coach-answer");
}

/** The exercise card, the exercise it proposes and that exercise's name. */
async function exerciseCard(page: Page) {
  const card = page.getByTestId("coach-exercise-change");
  await expect(card).toBeVisible();
  const id = (await card.getByTestId("coach-exercise-row").getAttribute("data-ex"))!;
  const name = (sql(`SELECT name_en FROM exercises WHERE id = '${id}'`)[0] as { name_en: string }).name_en;
  return { card, id, name };
}

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  resetCalendar();
  clearCoach();
  await aiMode({ coach: "ok" });
  await signIn(context, baseURL!);
});
test.afterAll(() => {
  resetWorkouts();
  resetCalendar();
  clearCoach();
});

test("one more exercise on the chest day: one card with only the change; no program or library card; Only this session puts it in Day 1's plan after Seated Cable Row", async ({ page }) => {
  const before = program();
  const answer = await askCoach(page, "میخوام روزی که تمرین سینه دارم فوکوس بیشتری رو سینه داشته باشم و ۱ حرکت به سینه اضافه کن");
  const { card, id, name } = await exerciseCard(page);
  expect(D1).not.toContain(id);
  await expect(card.getByRole("heading").first()).toHaveText(`Day 1 · Chest: + ${name}`);
  await expect(card.getByTestId("coach-exercise-row")).toContainText(/\d+ × [\d–]+ · after Seated Cable Row/);
  // The reason once: in the coach's text, not in the card. No explanation under the buttons.
  await expect(answer).toContainText("یک حرکت ایزوله بعد از Seated Cable Row");
  await expect(card.locator('[dir="rtl"]')).toHaveCount(0);
  await expect(card.locator(".caption")).toHaveCount(1); // the progression rule only
  // Read by the coach, not shown: his program and the exercise list.
  await expect(answer.locator('[data-card="get_program"]')).toHaveCount(0);
  await expect(answer.locator('[data-card="get_library"]')).toHaveCount(0);
  await expect(answer.getByTestId("coach-card")).toHaveCount(0);
  // Worth knowing: only what this change causes.
  const notes = card.getByTestId("coach-exercise-notes");
  await expect(notes.locator("li").first()).toHaveText(/^Chest: [\d.]+ sets a week with this change \(now [\d.]+; target [\d.]+\)\.$/);
  await expect(notes).toContainText(/Day 1 gets about \d+ min longer \(about \d+ min\)\./);
  // He did not say which: Only this session first.
  await expect(card).toHaveAttribute("data-prefer", "none");
  await expect(card.getByRole("button")).toHaveText(["Only this session", "Whole program"]);

  await card.getByTestId("coach-exercise-session").click();
  await expect(page.getByTestId("toast")).toHaveText(`Added ${name} to today's Day 1 · Chest.`);
  await expect(card.getByTestId("coach-exercise-session-added")).toContainText("In the plan: it is there when you tap Start.");
  // Day 1's plan: right after Seated Cable Row, before his A superset; nothing started.
  await expect
    .poll(() => sql("SELECT i.exercise_id FROM session_plan_items i JOIN planned_sessions p ON p.id = i.session_id WHERE p.program_day_id = 'D1' AND p.status = 'planned' AND i.removed_at IS NULL ORDER BY i.position").map((r) => (r as { exercise_id: string }).exercise_id), { timeout: 20_000 })
    .toEqual(["bench", "incline_db", "rdl", "cable_row", id, "lateral", "facepull"]);
  expect(count("SELECT COUNT(*) AS n FROM workout_sessions")).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM programs WHERE generated_by = 'coach'")).toBe(0);
  expect(program()).toBe(before);
  // Whole program stays available.
  await expect(card.getByRole("button", { name: "Whole program" })).toBeVisible();

  // At the gym: Open → the plan → Start: the session has it after Seated Cable Row.
  await card.getByTestId("coach-exercise-session-added").getByRole("button", { name: "Open" }).click();
  await page.getByTestId("plan-start").click();
  await expect(page.getByTestId("finish")).toBeVisible();
  await expect.poll(() => sql("SELECT DISTINCT exercise_id FROM set_entries").map((r) => (r as { exercise_id: string }).exercise_id), { timeout: 20_000 }).toEqual(expect.arrayContaining([...D1, id]));
  expect(program()).toBe(before);
});

test("from now on: Whole program first; it saves his program with that exercise as a draft under Me → Program → Drafts; the active program stays", async ({ page }) => {
  const before = program();
  await askCoach(page, "From now on add one more chest exercise on my chest day");
  const { card, id, name } = await exerciseCard(page);
  await expect(card).toHaveAttribute("data-prefer", "program");
  await expect(card.getByRole("button")).toHaveText(["Whole program", "Only this session"]);

  await card.getByTestId("coach-exercise-program").click();
  await expect(card.getByTestId("coach-exercise-program-added")).toContainText("Added to Me → Program → Drafts.");
  const drafts = sql("SELECT id, name, active FROM programs WHERE generated_by = 'coach'") as { id: string; name: string; active: number }[];
  expect(drafts).toEqual([{ id: expect.any(String), name: `Full body · 4 days + ${name}`, active: 0 }]);
  // The draft: Day 1 with the exercise after Seated Cable Row, his superset kept; the other days as they are.
  const day = (programId: string, position: number) => sql(`SELECT x.exercise_id, x.superset_tag FROM day_exercises x JOIN program_days d ON d.id = x.day_id WHERE d.program_id = '${programId}' AND d.position = ${position} ORDER BY x.position`);
  expect(day(drafts[0].id, 1)).toEqual([
    { exercise_id: "bench", superset_tag: null },
    { exercise_id: "incline_db", superset_tag: null },
    { exercise_id: "rdl", superset_tag: null },
    { exercise_id: "cable_row", superset_tag: null },
    { exercise_id: id, superset_tag: null },
    { exercise_id: "lateral", superset_tag: "A1" },
    { exercise_id: "facepull", superset_tag: "A2" },
  ]);
  for (const p of [2, 3, 4]) expect(day(drafts[0].id, p)).toEqual(day("fullbody4", p));
  expect(sql("SELECT id FROM programs WHERE active = 1")).toEqual([{ id: "fullbody4" }]);
  expect(program()).toBe(before);
  expect(count("SELECT COUNT(*) AS n FROM planned_sessions")).toBe(0);

  // Open: Me → Program, where it waits for his approval with the other drafts.
  await card.getByTestId("coach-exercise-program-added").getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("program-screen-drafts")).toContainText(`Full body · 4 days + ${name}`);
});

test("just today, with a session open: Only this session first; it goes into that session as an extra; the program is unchanged", async ({ page, baseURL }) => {
  const before = program();
  const id = ulid();
  const started = zonedToUtcISO(today(), "17:00", TZ);
  const res = await page.request.put(`${baseURL}/api/sessions/${id}`, {
    headers: { Origin: baseURL! },
    data: {
      id,
      program_day_id: "D1",
      local_date: today(),
      started_at: started,
      ended_at: null,
      status: "active",
      unit: "lb",
      note: "",
      created_at: started,
      updated_at: started,
      source: "app",
      sets: [{ id: `${id}-0`, exercise_id: "bench", set_index: 0, weight: 135, reps: 5, seconds: null, done: true, rir: null, updated_at: new Date().toISOString() }],
    },
  });
  expect(res.status()).toBe(200);
  await askCoach(page, "Just today add one chest exercise on my chest day");
  const { card, id: ex, name } = await exerciseCard(page);
  await expect(card).toHaveAttribute("data-prefer", "session");
  await expect(card.getByRole("button")).toHaveText(["Only this session", "Whole program"]);
  await card.getByTestId("coach-exercise-session").click();
  await expect(page.getByTestId("toast")).toHaveText(`Added ${name} to today's session: Day 1 · Chest.`);
  await expect(card.getByTestId("coach-exercise-session-added")).toContainText("In today's session.");
  await expect.poll(() => sql(`SELECT DISTINCT exercise_id FROM set_entries WHERE session_id = '${id}' AND is_extra = 1`), { timeout: 20_000 }).toEqual([{ exercise_id: ex }]);
  expect(count("SELECT COUNT(*) AS n FROM programs WHERE generated_by = 'coach'")).toBe(0);
  expect(program()).toBe(before);
});

test("Sets vs target over three weeks is one card: muscles as rows, the weeks as columns (this week marked), and the target", async ({ page }) => {
  const answer = await askCoach(page, "Sets for the last 3 weeks?");
  const cards = answer.locator('[data-card="get_volume"]');
  await expect(cards).toHaveCount(1);
  const head = cards.locator("thead th");
  await expect(head).toHaveCount(5);
  await expect(head.first()).toHaveText("Muscle");
  await expect(head.nth(3)).toHaveText(/\*$/);
  await expect(head.last()).toHaveText("Target");
  const chest = cards.locator('tr[data-row="chest"] td');
  await expect(chest).toHaveCount(5);
  await expect(chest.first()).toHaveText("Chest");
  await expect(cards).toContainText("* this week so far. Sets: direct 1, secondary 0.5, as on Reports.");
  await expect(cards).toContainText("Numbers calculated by the app from your logs");
});

test("show me my program: the program card is shown because he asked to see it", async ({ page }) => {
  const answer = await askCoach(page, "Show me my program");
  const card = answer.locator('[data-card="get_program"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("Day 1 · Chest");
  await expect(card).toContainText("Seated Cable Row");
});

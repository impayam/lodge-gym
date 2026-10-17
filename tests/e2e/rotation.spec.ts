import { expect, test } from "./fixtures";
import { aiCalls, aiMode, goTo, resetPrograms, resetWorkouts, signIn, sql } from "./helpers";
import { addDays, localDate } from "../../worker/lib/time";

// SPEC-v11 Phase B (Payam, 2026-10-17), with the model mocked: four training weeks on the seed program make its
// accessory and isolation work due. The Program screen lists it (at most 3 lines, nothing changes on its own); Ask Coach
// on a line opens the Coach with that exercise, which offers replacements as replace cards; "Only this session" puts the
// pick in that day's plan in the old one's place and the program stays as it was. New program starts block B, covers
// all 30 regions with the forearm and neck direct sets, and says which due exercises it replaces.
test.describe.configure({ mode: "serial" });

const TZ = "America/Denver";
const SEED_START = "2026-09-27T06:00:00.000Z";
const program = () => JSON.stringify(sql("SELECT x.day_id, x.exercise_id, x.position, x.sets FROM day_exercises x JOIN program_days d ON d.id = x.day_id WHERE d.program_id = 'fullbody4' ORDER BY x.day_id, x.position"));
const nameOf = (id: string) => (sql(`SELECT name_en FROM exercises WHERE id = '${id}'`)[0] as { name_en: string }).name_en;
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

/** The seed program active since 40 days ago, with one done session in each of the last four weeks (7 days apart). */
function fourTrainingWeeks() {
  const t = localDate(TZ);
  sql(`UPDATE program_activations SET started_at = '${addDays(t, -40)}T06:00:00.000Z' WHERE id = 'act-fullbody4-seed'`);
  ["D1", "D2", "D3", "D4"].forEach((day, i) => {
    const date = addDays(t, -2 - 7 * i);
    const id = `01ROTATION${i}`;
    sql(
      `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source)
       VALUES ('${id}', '${day}', '${date}', '${date}T23:00:00.000Z', '${date}T23:55:00.000Z', 'done', 'lb', '', '${date}T23:00:00.000Z', '${date}T23:55:00.000Z', 'app')`
    );
    sql(`INSERT INTO set_entries (id, session_id, exercise_id, set_index, weight, reps, seconds, done, rir, updated_at) VALUES ('${id}S', '${id}', 'bench', 0, 135, 5, NULL, 1, 2, '${date}T23:10:00.000Z')`);
  });
}

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  resetPrograms();
  clearCoach();
  fourTrainingWeeks();
  await aiMode({ coach: "ok" });
  await signIn(context, baseURL!);
});
test.afterAll(() => {
  resetWorkouts();
  resetPrograms();
  clearCoach();
  sql(`UPDATE program_activations SET started_at = '${SEED_START}' WHERE id = 'act-fullbody4-seed'`);
});

test("a due line asks the Coach about that exercise: replacements as replace cards; Only this session puts the pick in the day's plan; the program is unchanged", async ({ page }) => {
  const before = program();
  await page.goto("/");
  await goTo(page, "Program");
  const due = page.getByTestId("program-due");
  await expect(due).toContainText("Due for a change");
  await expect(due).toContainText("Nothing changes until you pick a replacement.");
  const lines = due.getByTestId("program-due-line");
  await expect(lines).toHaveCount(3);
  // Main and secondary lifts are not due at 4 weeks; the first accessory of Day 1 is.
  const id = (await lines.first().getAttribute("data-ex"))!;
  const name = nameOf(id);
  expect(["bench", "incline_db", "rdl", "cable_row", "squat", "deadlift", "ohp"]).not.toContain(id);
  await expect(lines.first().locator(".t-title")).toHaveText(name);
  await expect(lines.first().locator(".caption")).toHaveText("4 weeks in the program");

  await lines.first().getByRole("button", { name: `Ask Coach about ${name}` }).click();
  await expect(page.getByTestId("coach-cost")).toBeVisible({ timeout: 30_000 });
  // The app wrote the question and the CONTEXT names the exercise with its rotation.
  const call = (await aiCalls()).by_kind.coach!;
  expect(call.question).toContain(`${name} برای تعویض آماده است.`);
  expect(call.context).toContain(`He tapped Ask Coach on the due line of the Program screen for ${name} (${id}, `);
  expect(call.context).toContain("Rotation: accessory, isolation or core work (the 3–4 week rule); 4 training weeks in his program");
  expect(call.tools).toContain("suggest_replacements");

  const answer = page.getByTestId("coach-answer").last();
  await expect(answer).toContainText("این چند هفته روی");
  const cards = page.getByTestId("coach-exercise-change");
  const n = await cards.count();
  expect(n).toBeGreaterThanOrEqual(2);
  expect(n).toBeLessThanOrEqual(3);
  for (let i = 0; i < n; i++) await expect(cards.nth(i)).toHaveAttribute("data-replaces", id);
  const card = cards.first();
  const pick = (await card.getByTestId("coach-exercise-row").getAttribute("data-ex"))!;
  const pickName = nameOf(pick);
  await expect(card.getByRole("heading").first()).toHaveText(new RegExp(`: ${name.replace(/[()]/g, "\\$&")} → ${pickName.replace(/[()]/g, "\\$&")}$`));
  await expect(card.getByTestId("coach-exercise-place")).toContainText(`In place of ${name}`);
  // The card says first what happens to the replaced exercise's region (PR #25 review): kept by the new exercise.
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(card.getByTestId("coach-exercise-notes").locator("li").first()).toHaveText(new RegExp(`^.+ \\(main focus of ${esc(name)}\\): ${esc(pickName)} keeps it as its main focus\\.$`));

  await card.getByTestId("coach-exercise-session").click();
  await expect(page.getByTestId("toast")).toContainText(`${pickName} replaces ${name} in `);
  // That day's plan has the pick in the due exercise's place; nothing started.
  await expect
    .poll(
      () => sql(`SELECT i.exercise_id, i.origin, i.replaced_exercise_id FROM session_plan_items i JOIN planned_sessions p ON p.id = i.session_id WHERE p.status = 'planned' AND i.removed_at IS NULL AND i.exercise_id IN ('${pick}', '${id}')`),
      { timeout: 20_000 }
    )
    .toEqual([{ exercise_id: pick, origin: "replaced", replaced_exercise_id: id }]);
  expect((sql("SELECT COUNT(*) AS n FROM workout_sessions WHERE status = 'active'")[0] as { n: number }).n).toBe(0);
  // Only the plan changed: the program, and the drafts list, did not.
  expect(program()).toBe(before);
  expect((sql("SELECT COUNT(*) AS n FROM programs WHERE generated_by = 'coach'")[0] as { n: number }).n).toBe(0);
});

test("New program: no session length (the goal's schemes, nothing cut for time), block B covers all 30 regions with the forearm and neck direct sets, and names the due exercises it replaces", async ({ page }) => {
  await page.goto("/");
  await goTo(page, "Settings");
  await page.getByTestId("new-program").click();
  await expect(page.getByRole("group", { name: "Session length" })).toHaveCount(0);
  await expect(page.getByTestId("np-goal-input")).toHaveText("No goal set: the Growth schemes. Set it on Profile; session length never limits a program.");
  await page.getByTestId("np-generate").click();
  await expect(page.getByTestId("np-goal")).toHaveText("No goal set: the Growth schemes");
  await expect(page.getByRole("region", { name: "Suggested week" })).toContainText("Nothing is cut for time.");
  const block = page.getByTestId("np-block");
  await expect(block.getByRole("heading")).toHaveText("Block B");
  await expect(block.getByTestId("np-coverage")).toHaveText("All 30 regions have a main-focus exercise. Forearms 4 of 4 direct sets, Neck 2 of 2 direct sets.");
  const rotation = block.getByTestId("np-rotation").locator("li");
  await expect(rotation.filter({ hasText: / replaces .+: 4 weeks in the program\.$/ }).first()).toBeVisible();
  // Main lifts are not due yet: each day keeps its main lift.
  for (const main of ["bench", "squat", "deadlift"]) await expect(block.getByTestId("np-rotation").locator(`li[data-ex="${main}"]`)).toHaveCount(0);
});

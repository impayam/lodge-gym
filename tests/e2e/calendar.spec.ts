import { expect, test, type Page } from "./fixtures";
import { resetCalendar, resetWorkouts, signIn, sql } from "./helpers";
import { addDays, daysBetween, localDate, localHM, weekday, zonedToUtcISO } from "../../worker/lib/time";
import { monthDates, weekLabel } from "../../web/src/lib/calendarView";

// SPEC-v10 M13: the week strip at the top of Home and the Calendar it opens: the month strip, the week grid with work
// shifts and planned / done / missed gym sessions, free times from the shared finder, and the List view.
test.describe.configure({ mode: "serial" });

const TZ = "America/Denver";
const today = () => localDate(TZ);
/** Monday of the week holding `date` (Settings: weeks start on Monday). */
const monday = (date: string) => addDays(date, -((weekday(date) + 6) % 7));
const at = (date: string) => new Date(`${date}T12:00:00Z`);
const weekdayLong = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(at(date));
const weekdayShort = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(at(date));
const dateShort = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(at(date));
const min = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

const NOW = new Date().toISOString();
function shift(id: string, date: string, from: string, to: string, note = "") {
  sql(`INSERT INTO work_shifts (id, date, start_min, end_min, note, created_at, updated_at) VALUES ('${id}', '${date}', ${min(from)}, ${min(to)}, '${note}', '${NOW}', '${NOW}')`);
}
function plan(id: string, date: string, from: string, to: string, day: string) {
  sql(
    `INSERT INTO gym_plans (id, date, start_min, end_min, program_day_id, source, status, created_at, updated_at) VALUES ('${id}', '${date}', ${min(from)}, ${min(to)}, '${day}', 'manual', 'planned', '${NOW}', '${NOW}')`
  );
}
function session(id: string, date: string, from: string, to: string, day: string) {
  sql(
    `INSERT INTO workout_sessions (id, program_day_id, local_date, started_at, ended_at, status, unit, note, created_at, updated_at, source) VALUES ('${id}', '${day}', '${date}', '${zonedToUtcISO(date, from, TZ)}', '${zonedToUtcISO(date, to, TZ)}', 'done', 'lb', '', '${NOW}', '${NOW}', 'app')`
  );
}

/** Steps the Calendar from this week to the week holding `date`. */
async function showWeekOf(page: Page, date: string) {
  const weeks = daysBetween(monday(today()), monday(date)) / 7;
  for (let i = 0; i < Math.abs(weeks); i++) await page.getByTestId(weeks > 0 ? "cal-next-week" : "cal-prev").click();
  await expect(page.getByTestId("cal-week-label")).toHaveText(weekLabel(monday(date), today()));
}

/** Back to this week (the button shows only on another week). */
async function toThisWeek(page: Page) {
  const button = page.getByTestId("cal-today");
  if (await button.count()) await button.click();
  await expect(page.getByTestId("cal-week-label")).toHaveText(weekLabel(monday(today()), today()));
}

async function openCalendar(page: Page) {
  await page.goto("/");
  await page.getByTestId("cal-open").click();
  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
}

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  resetCalendar();
  await signIn(context, baseURL!);
});
test.afterAll(() => {
  resetWorkouts();
  resetCalendar();
});

test("Home: the week strip above the hero card marks shifts and training, names the next plan and opens the Calendar", async ({ page }) => {
  const t = today();
  const yesterday = addDays(t, -1);
  const tomorrow = addDays(t, 1);
  shift("w1", t, "07:00", "15:30");
  session("01CALS1", yesterday, "12:00", "13:00", "D1");
  plan("p1", tomorrow, "17:30", "18:30", "D3");
  await page.goto("/");

  const strip = page.getByTestId("cal-strip");
  await expect(strip).toBeVisible();
  // At the top of Home, above the next-session hero card.
  expect((await strip.boundingBox())!.y).toBeLessThan((await page.getByTestId("next-card").boundingBox())!.y);
  const chip = (date: string) => strip.locator(`.cal-day[data-date="${date}"]`);
  await expect(strip.locator(".cal-day")).toHaveCount(7);
  await expect(chip(t)).toHaveAttribute("data-today", "true");
  await expect(chip(t)).toHaveAttribute("data-shift", "true");
  if (monday(yesterday) === monday(t)) await expect(chip(yesterday)).toHaveAttribute("data-mark", "done");
  if (monday(tomorrow) === monday(t)) await expect(chip(tomorrow)).toHaveAttribute("data-mark", "planned");
  await expect(page.getByTestId("cal-next")).toHaveText(`Next: ${weekdayShort(tomorrow)} 17:30 · Day 3 · Back`);
  await expect(page.getByTestId("cal-find")).toHaveCount(0);

  // The whole strip is one button with a spoken summary.
  await expect(page.getByTestId("cal-open")).toHaveAccessibleName(new RegExp(`^Calendar\\. This week: .*${dateShort(t)}, today, work.*Next: ${weekdayShort(tomorrow)} 17:30 · Day 3 · Back\\.$`));
  await page.getByTestId("cal-open").click();
  await expect(page.getByTestId("calendar")).toBeVisible();
  // A pushed screen: Back returns to Train, the tab bar stays.
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  await page.getByTestId("back").click();
  await expect(page.getByTestId("home")).toBeVisible();
});

test("Home: with nothing planned the strip offers Find times; a plan later today shows its time on the hero card", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("cal-next")).toHaveText("No gym time planned this week");
  await page.getByTestId("cal-find").click();
  await expect(page.getByTestId("cal-free")).toBeChecked();
  await page.getByTestId("back").click();

  // 23:00–24:00 today has not ended yet at any time of the day.
  plan("p2", today(), "23:00", "24:00", "D2");
  await page.reload();
  await expect(page.getByTestId("cal-next")).toHaveText("Next: Today 23:00 · Day 2 · Legs");
  await expect(page.getByTestId("hero-gym-time")).toHaveText("Planned today at 23:00 · Day 2 · Legs");
});

test("week grid: work, done, missed and planned blocks with their names; 44 px hours; opens at the current time; List view", async ({ page }) => {
  const t = today();
  const yesterday = addDays(t, -1);
  const before = addDays(t, -2);
  const tomorrow = addDays(t, 1);
  shift("w1", t, "07:00", "15:30", "Store");
  session("01CALS2", yesterday, "12:00", "13:00", "D1");
  plan("p3", before, "17:00", "18:00", "D2");
  plan("p4", tomorrow, "17:30", "18:30", "D3");
  await openCalendar(page);

  await expect(page.getByTestId("cal-week-label")).toHaveText(weekLabel(monday(t), t));
  await expect(page.locator(".cal-week__head[data-today='true']")).toHaveCount(1);
  const grid = page.getByTestId("cal-week");
  await expect(grid.getByRole("img", { name: `Work, ${weekdayLong(t)} 07:00–15:30, Store` })).toBeVisible();
  const cell = (await grid.locator(".cal-cell").first().boundingBox())!;
  expect(cell.height).toBe(44);
  // An hour of context above the current time (both read within the same minute or so: one row of slack).
  const nowMin = min(localHM(TZ, new Date().toISOString()));
  const top = await page.locator(".cal-scroll").evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  expect(Math.abs(top.top - Math.min(top.max, Math.max(0, ((nowMin - 240) / 60 - 1) * 44)))).toBeLessThanOrEqual(44);

  await showWeekOf(page, yesterday);
  await expect(grid.getByRole("img", { name: `Done: Day 1 · Chest, ${weekdayLong(yesterday)} 12:00–13:00` })).toHaveAttribute("data-kind", "done");
  await showWeekOf(page, before);
  await expect(grid.getByRole("img", { name: `Missed: Day 2 · Legs, ${weekdayLong(before)} 17:00–18:00` })).toHaveAttribute("data-kind", "missed");
  await toThisWeek(page);
  await showWeekOf(page, tomorrow);
  await expect(grid.getByRole("img", { name: `Planned: Day 3 · Back, ${weekdayLong(tomorrow)} 17:30–18:30` })).toHaveAttribute("data-kind", "plan");

  // The List view: the same week day by day.
  await toThisWeek(page);
  await page.getByTestId("cal-view-toggle").click();
  const list = page.getByTestId("cal-list");
  await expect(list.locator("h3")).toHaveCount(7);
  const day = list.locator(`[data-date="${t}"]`);
  await expect(day.locator("h3")).toHaveText(`${dateShort(t)} · Today`);
  await expect(day.getByTestId("cal-row").first()).toContainText("Work");
  await expect(day.getByTestId("cal-row").first()).toContainText("Store");
  await expect(day.getByTestId("cal-row").first()).toContainText("07:00–15:30");
  await page.getByTestId("cal-view-toggle").click();
  await expect(page.getByTestId("cal-week")).toBeVisible();
});

test("free times: the shared finder's slots on a free week (gym hours by weekday), off again with the switch", async ({ page }) => {
  await openCalendar(page);
  const next = addDays(monday(today()), 7);
  await showWeekOf(page, next);
  const grid = page.getByTestId("cal-week");
  await expect(grid.locator(".cal-block--free")).toHaveCount(0);
  await page.getByTestId("cal-free").check();
  // Day 1 is next (60 min); the earliest time of each day: Mon–Fri 04:00, Sat 05:00, Sun 07:00.
  const expected = [0, 1, 2, 3, 4].map((i) => `Free time, ${weekdayLong(addDays(next, i))} 04:00–05:00`);
  expected.push(`Free time, ${weekdayLong(addDays(next, 5))} 05:00–06:00`, `Free time, ${weekdayLong(addDays(next, 6))} 07:00–08:00`);
  await expect(grid.locator(".cal-block--free")).toHaveCount(7);
  for (const name of expected) await expect(grid.getByRole("img", { name })).toBeVisible();
  await expect(page.locator(".chart-legend")).toContainText("Free");
  await page.getByTestId("cal-free").uncheck();
  await expect(grid.locator(".cal-block--free")).toHaveCount(0);
});

test("month strip: dots for training, the days of the week shown pressed in; a day opens its list and its week", async ({ page }) => {
  const thu = addDays(monday(today()), 3);
  shift("w2", thu, "12:00", "20:00", "Late");
  await openCalendar(page);
  const strip = page.getByTestId("cal-month");
  const dates = monthDates(thu);
  await expect(strip.locator(".cal-day")).toHaveCount(dates.length);
  await expect(strip.locator(`.cal-day[data-date="${thu}"]`)).toHaveAttribute("aria-pressed", "true");

  await strip.locator(`.cal-day[data-date="${thu}"]`).click();
  const sheet = page.getByTestId("cal-day-sheet");
  await expect(sheet).toHaveAttribute("open", "");
  await expect(sheet.getByRole("heading", { name: dateShort(thu) })).toBeVisible();
  await expect(sheet.getByTestId("cal-row")).toHaveCount(1);
  await expect(sheet.getByTestId("cal-row")).toContainText("Work");
  await expect(sheet.getByTestId("cal-row")).toContainText("Late");
  await expect(sheet.getByTestId("cal-row")).toContainText("12:00–20:00");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // A day of another week opens that week.
  const other = dates.find((d) => monday(d) !== monday(thu))!;
  await strip.locator(`.cal-day[data-date="${other}"]`).click();
  await expect(page.getByTestId("cal-day-sheet").getByText("Nothing on this day.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cal-week-label")).toHaveText(weekLabel(monday(other), today()));
});

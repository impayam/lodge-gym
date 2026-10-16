import { expect, test, type Page } from "./fixtures";
import { aiMode, goTo, resetCalendar, resetWorkouts, setOffline, signIn, sql } from "./helpers";
import { hm } from "../../worker/lib/calendar";
import { addDays, daysBetween, localDate, localHM, weekday, zonedToUtcISO } from "../../worker/lib/time";
import { monthDates, weekLabel } from "../../web/src/lib/calendarView";

// SPEC-v10 M13 (with Payam's change of 2026-10-15: he enters his shifts, the app suggests the time, nothing blocks): the
// week strip at the top of Home and the Calendar it opens: the month strip, the week grid with work shifts and planned /
// done / missed gym sessions, free times from the shared finder, the List view; adding shifts (Copy last week), Find
// times (Add all), plan by tap, drag and edit, reminders, a session marking its plan done, offline, Settings, the Coach.
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

/** A block on the grid by the start of its accessible name (plans and shifts are buttons, done sessions images). */
const block = (page: Page, name: string) => page.getByTestId("cal-week").locator(`[aria-label^="${name}"]`);
const count = (q: string) => (sql(q)[0] as { n: number }).n;

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
  await expect(page.getByTestId("cal-find-sheet")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cal-find-sheet")).toHaveCount(0);
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
  await expect(block(page, `Work, ${weekdayLong(t)} 07:00–15:30, Store`)).toHaveCount(1);
  const cell = (await grid.locator(".cal-cell").first().boundingBox())!;
  expect(cell.height).toBe(44);
  // An hour of context above the current time (both read within the same minute or so: one row of slack).
  const nowMin = min(localHM(TZ, new Date().toISOString()));
  const top = await page.locator(".cal-scroll").evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  expect(Math.abs(top.top - Math.min(top.max, Math.max(0, ((nowMin - 240) / 60 - 1) * 44)))).toBeLessThanOrEqual(44);

  await showWeekOf(page, yesterday);
  await expect(grid.getByRole("img", { name: `Done: Day 1 · Chest, ${weekdayLong(yesterday)} 12:00–13:00` })).toHaveAttribute("data-kind", "done");
  await showWeekOf(page, before);
  await expect(block(page, `Missed: Day 2 · Legs, ${weekdayLong(before)} 17:00–18:00`)).toHaveAttribute("data-kind", "missed");
  await toThisWeek(page);
  await showWeekOf(page, tomorrow);
  await expect(block(page, `Planned: Day 3 · Back, ${weekdayLong(tomorrow)} 17:30–18:30`)).toHaveAttribute("data-kind", "plan");

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

test("week grid: a block's label rides under the day heads while it scrolls and hides once the rest is too short, never cut", async ({ page }) => {
  const t = today();
  shift("w1", t, "07:00", "15:30");
  shift("w2", addDays(t, monday(t) === t ? 1 : -1), "07:00", "15:20");
  await openCalendar(page);
  const work = block(page, `Work, ${weekdayLong(t)} 07:00–15:30`);
  await expect(work).toHaveCount(1);

  // Every scroll position from the top to the bottom, 6 px at a time: a label that shows sits wholly below the heads.
  const sweep = await page.locator(".cal-scroll").evaluate(async (el) => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
    const head = (el.querySelector(".cal-week__head") as HTMLElement).offsetHeight;
    const out = { cutShown: [] as number[], hidden: 0, shownUnder: 0 };
    for (let y = 0; y <= el.scrollHeight - el.clientHeight; y += 6) {
      el.scrollTop = y;
      await frames();
      const edge = el.getBoundingClientRect().top + head;
      for (const label of el.querySelectorAll<HTMLElement>(".cal-block__label")) {
        const box = label.getBoundingClientRect();
        const block = (label.parentElement as HTMLElement).getBoundingClientRect();
        if (block.bottom <= edge) continue; // scrolled away entirely
        if (getComputedStyle(label).visibility === "hidden") out.hidden++;
        else if (box.top < edge - 0.5) out.cutShown.push(y);
        else if (block.top < edge) out.shownUnder++;
      }
    }
    return out;
  });
  expect(sweep.cutShown).toEqual([]);
  expect(sweep.hidden).toBeGreaterThan(0); // the short rest of a block hides its label
  expect(sweep.shownUnder).toBeGreaterThan(0); // and a long block keeps it in view under the heads

  // Back up: the label shows again.
  await page.locator(".cal-scroll").evaluate((el) => (el.scrollTop = 0));
  await expect(work.locator(".cal-block__label")).not.toHaveAttribute("data-cut", "");
  await expect(work.locator(".cal-block__label")).toBeVisible();
});

test("free times: the shared finder's suggestion for each day of a free week (08:00, the earliest start), off again with the switch", async ({ page }) => {
  await openCalendar(page);
  const next = addDays(monday(today()), 7);
  await showWeekOf(page, next);
  const grid = page.getByTestId("cal-week");
  await expect(grid.locator(".cal-block--free")).toHaveCount(0);
  await page.getByTestId("cal-free").check();
  // Day 1 is next (60 min); no shifts: every day's suggestion is the earliest start, 08:00 (the gym opens earlier).
  await expect(grid.locator(".cal-block--free")).toHaveCount(7);
  for (let i = 0; i < 7; i++) await expect(grid.getByRole("button", { name: `Free time, ${weekdayLong(addDays(next, i))} 08:00–09:00. Plan gym here` })).toHaveCount(1);
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

test("§8: add shifts, Copy last week, Find times → Add all with reminders; a session that day marks its plan done", async ({ page }) => {
  test.setTimeout(180_000);
  const t = today();
  const w1 = addDays(monday(t), 7);
  const w2 = addDays(w1, 7);
  await openCalendar(page);
  await page.getByTestId("cal-next-week").click();
  await expect(page.getByTestId("cal-week-label")).toHaveText(weekLabel(w1, t));
  // Empty week: Add shift; nothing to copy (this week has no shifts).
  await expect(page.getByTestId("cal-empty")).toContainText("No shifts this week.");
  await expect(page.getByTestId("cal-copy")).toHaveCount(0);
  await page.getByTestId("cal-empty-add").click();
  const shiftSheet = page.getByTestId("cal-shift-sheet");
  await expect(shiftSheet).toHaveAttribute("open", "");
  await shiftSheet.locator(`.cal-day[data-date="${w1}"]`).click();
  await shiftSheet.locator(`.cal-day[data-date="${addDays(w1, 1)}"]`).click();
  await shiftSheet.locator("#shift-start").fill("12:00");
  await shiftSheet.locator("#shift-end").fill("20:00");
  await expect(shiftSheet.getByTestId("shift-save")).toHaveText("Add 2 shifts");
  await shiftSheet.getByTestId("shift-save").click();
  await expect(page.getByTestId("toast")).toHaveText("2 shifts added.");
  await expect(block(page, `Work, ${weekdayLong(w1)} 12:00–20:00`)).toHaveCount(1);
  await expect(block(page, `Work, ${weekdayLong(addDays(w1, 1))} 12:00–20:00`)).toHaveCount(1);

  // The week after: Copy last week.
  await page.getByTestId("cal-next-week").click();
  await expect(page.getByTestId("cal-week-label")).toHaveText(weekLabel(w2, t));
  await page.getByTestId("cal-copy").click();
  await expect(page.getByTestId("toast")).toHaveText("Copied 2 shifts from last week.");
  await expect(page.getByTestId("cal-week").locator(".cal-block--work")).toHaveCount(2);
  await expect(page.getByTestId("cal-empty")).toHaveCount(0);

  // Find times: one suggestion a day in date order, the best four ticked; Monday's 12:00–20:00 shift → 08:00 before it.
  await page.getByTestId("cal-find-times").click();
  const find = page.getByTestId("cal-find-sheet");
  await expect(find).toHaveAttribute("open", "");
  await expect(find.getByTestId("find-row")).toHaveCount(7);
  expect(await find.getByTestId("find-row").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.date))).toEqual(
    Array.from({ length: 7 }, (_, i) => addDays(w2, i))
  );
  const mon = find.locator(`[data-testid="find-row"][data-date="${w2}"]`);
  await expect(mon).toHaveAttribute("data-start", "08:00");
  await expect(mon).toContainText("Before your 12:00 shift");
  await expect(find.getByTestId("find-need")).toHaveText("0 of 4 sessions this week are done or planned; the best 4 times are ticked.");
  await expect(find.locator('input[type="checkbox"]:checked')).toHaveCount(4);
  await expect(find.getByTestId("find-add-all")).toHaveText("Add all (4)");
  await find.getByTestId("find-add-all").click();
  await expect(page.getByTestId("toast")).toHaveText("Added 4 gym sessions.");
  await expect(page.getByTestId("cal-week").locator(".cal-block--plan")).toHaveCount(4);

  // On the server, each with its reminder an hour before (the push is queued at that time).
  await expect.poll(() => count("SELECT COUNT(*) AS n FROM gym_plans WHERE source = 'finder' AND reminder_at IS NOT NULL"), { timeout: 20_000 }).toBe(4);
  for (const r of sql("SELECT date, start_min, reminder_at FROM gym_plans") as { date: string; start_min: number; reminder_at: string }[])
    expect(Date.parse(r.reminder_at)).toBe(Date.parse(zonedToUtcISO(r.date, hm(r.start_min), TZ)) - 3_600_000);

  // A plan today (any time: nothing blocks), then the session: the plan is done.
  await page.getByTestId("cal-today").click();
  await page.getByTestId("cal-plan").click();
  const planSheet = page.getByTestId("cal-plan-sheet");
  await expect(planSheet).toHaveAttribute("open", "");
  await planSheet.locator(`.cal-day[data-date="${t}"]`).click();
  await planSheet.locator("#plan-start").fill("23:00");
  await planSheet.getByTestId("plan-save").click();
  await expect(page.getByTestId("toast")).toContainText(`Planned ${weekdayShort(t)} 23:00`);
  await expect(page.locator(`.cal-col[data-date="${t}"] .cal-block--plan`)).toHaveCount(1);
  await page.getByTestId("back").click();
  await expect(page.getByTestId("hero-gym-time")).toContainText("Planned today at 23:00");
  await page.getByTestId("start").click();
  await expect(page.getByTestId("finish")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByTestId("cal-open").click();
  await expect(page.locator(`.cal-col[data-date="${t}"] .cal-block--plan`)).toHaveCount(0);
  await expect(page.locator(`.cal-col[data-date="${t}"] .cal-block--done`)).toHaveCount(1);
  await expect.poll(() => sql(`SELECT status, session_id IS NOT NULL AS linked FROM gym_plans WHERE date = '${t}'`)[0], { timeout: 20_000 }).toEqual({ status: "done", linked: 1 });
});

test("offline: a shift added offline shows at once and reaches the server when back online", async ({ page, context }) => {
  await openCalendar(page);
  await setOffline(context, page, true);
  await page.getByTestId("cal-add-shift").click();
  const sheet = page.getByTestId("cal-shift-sheet");
  await sheet.locator(`.cal-day[data-date="${today()}"]`).click();
  await sheet.locator("#shift-start").fill("06:00");
  await sheet.locator("#shift-end").fill("07:00");
  await sheet.getByTestId("shift-save").click();
  await expect(page.getByTestId("cal-week").locator(".cal-block--work")).toHaveCount(1);
  expect(count("SELECT COUNT(*) AS n FROM work_shifts")).toBe(0);
  await setOffline(context, page, false);
  await expect.poll(() => sql("SELECT start_min, end_min FROM work_shifts")[0], { timeout: 20_000 }).toEqual({ start_min: 360, end_min: 420 });
});

test("plan by tap on an empty time; drag the plan to another day and time; edit it; delete it", async ({ page }) => {
  const wed = addDays(monday(today()), 9);
  await openCalendar(page);
  await page.getByTestId("cal-next-week").click();
  // Tap Wednesday at 08:00, with the grid at its top (04:00) and its card at the top of the screen (clear of the tab bar).
  await page.locator(".cal-scroll").evaluate((el) => (el.scrollTop = 0));
  await page.getByTestId("cal-week").evaluate((el) => el.scrollIntoView({ block: "start" }));
  const col = page.locator(`.cal-col[data-date="${wed}"]`);
  const box = (await col.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 4 * 44 + 10);
  const tap = page.getByTestId("cal-tap-sheet");
  await expect(tap).toHaveAttribute("open", "");
  await expect(tap.getByRole("heading")).toHaveText(`${dateShort(wed)} · 08:00`);
  await tap.getByTestId("cal-plan-here").click();
  const onWed = page.locator(`.cal-col[data-date="${wed}"] .cal-block--plan`);
  await expect(onWed).toHaveAttribute("data-start", "08:00");
  await expect(tap).toHaveCount(0);

  // Drag one column right and one hour down: Thursday 09:00.
  const b = (await onWed.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 12, b.y + 20, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2 + box.width, b.y + 8 + 44, { steps: 6 });
  await page.mouse.up();
  const thu = addDays(wed, 1);
  await expect(page.getByTestId("toast")).toHaveText(`Moved to ${weekdayShort(thu)} 09:00.`);
  const onThu = page.locator(`.cal-col[data-date="${thu}"] .cal-block--plan`);
  await expect(onThu).toHaveAttribute("data-start", "09:00");
  await expect(onWed).toHaveCount(0);
  await expect.poll(() => sql("SELECT date, start_min FROM gym_plans")[0], { timeout: 20_000 }).toEqual({ date: thu, start_min: 540 });

  // Edit: 18:00. Delete, with its confirm.
  await onThu.click();
  const sheet = page.getByTestId("cal-plan-sheet");
  await expect(sheet).toHaveAttribute("open", "");
  await sheet.locator("#plan-start").fill("18:00");
  await sheet.getByTestId("plan-save").click();
  await expect(onThu).toHaveAttribute("data-start", "18:00");
  await onThu.click();
  await expect(sheet).toHaveAttribute("open", "");
  await sheet.getByTestId("plan-delete").click();
  await sheet.getByTestId("plan-delete-confirm").click();
  await expect(page.locator(".cal-block--plan")).toHaveCount(0);
  await expect.poll(() => count("SELECT COUNT(*) AS n FROM gym_plans"), { timeout: 20_000 }).toBe(0);
});

test("Settings: the defaults work untouched; a changed reminder time and a closed day are saved and synced", async ({ page }) => {
  await page.goto("/");
  await goTo(page, "Settings");
  const card = page.getByTestId("calendar-settings");
  await expect(card.locator("#cal-wake")).toHaveValue("07:00");
  await expect(card.locator("#cal-earliest")).toHaveValue("08:00");
  await expect(card.locator("#cal-before")).toHaveValue("60");
  await expect(card.locator("#cal-after")).toHaveValue("30");
  await expect(card.locator("#cal-after-long")).toHaveValue("90");
  await expect(card.locator("#cal-reminder")).toHaveValue("60");
  await card.locator("#cal-reminder").selectOption("30");
  await expect.poll(() => sql("SELECT value FROM settings WHERE key = 'reminder_minutes'")[0], { timeout: 20_000 }).toEqual({ value: "30" });
  await card.getByTestId("hours-sun").getByRole("checkbox", { name: "Closed" }).check();
  await expect.poll(() => JSON.parse((sql("SELECT value FROM settings WHERE key = 'gym_hours'")[0] as { value?: string } | undefined)?.value ?? "{}").sun, { timeout: 20_000 }).toBeNull();
});

test("Coach: 'when should I go' → a schedule of the finder's times → Add to calendar", async ({ page }) => {
  await aiMode({ coach: "ok" });
  sql("DELETE FROM coach_attachments; DELETE FROM coach_messages; DELETE FROM coach_threads");
  const next = addDays(monday(today()), 7);
  shift("cw1", next, "12:00", "20:00");
  await page.goto("/");
  await page.getByRole("button", { name: "Ask the coach" }).click();
  await page.getByTestId("coach-input").fill("When should I go to the gym next week?");
  await page.getByTestId("coach-send").click();
  const card = page.getByTestId("coach-schedule");
  await expect(card).toBeVisible({ timeout: 30_000 });
  const rows = card.getByTestId("coach-schedule-row");
  await expect(rows).toHaveCount(3);
  await expect(card.locator(`[data-date="${next}"]`)).toContainText("08:00");
  await expect(card.locator(`[data-date="${next}"] [lang="fa"]`)).toContainText("قبل از شیفت ساعت 12:00");
  // Nothing on the calendar before the tap.
  expect(count("SELECT COUNT(*) AS n FROM gym_plans")).toBe(0);
  await card.getByTestId("coach-add-schedule").click();
  await expect(page.getByTestId("toast")).toHaveText("Added 3 gym sessions to the calendar.");
  await expect(card.getByTestId("coach-schedule-added")).toBeVisible();
  await expect.poll(() => count("SELECT COUNT(*) AS n FROM gym_plans WHERE source = 'coach'"), { timeout: 20_000 }).toBe(3);
  sql("DELETE FROM coach_attachments; DELETE FROM coach_messages; DELETE FROM coach_threads");
});

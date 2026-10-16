import { expect, test, type Page } from "./fixtures";
import { aiMode, resetWorkouts, signIn, sql } from "./helpers";

// The Coach always fits the screen's width (Payam's iPhone, 2026-10-16: the header's "+" was cut off and his message
// ran past the right edge). Two causes are checked at iPhone width, on the full Coach page and in the Coach sheet
// inside a session, with every kind of card:
//   - nothing lays out past the right edge, and the page cannot scroll sideways;
//   - every text field is at least 16 px: iOS Safari zooms the whole page into a smaller one when it is tapped and
//     stays zoomed, which is what cut the screen off (the message field was 15 px). Playwright's WebKit does not
//     zoom on focus, so the size itself is checked.
test.describe.configure({ mode: "serial" });

const clearCoach = () => sql("DELETE FROM coach_attachments; DELETE FROM coach_messages; DELETE FROM coach_threads");

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  clearCoach();
  await aiMode({ coach: "ok" });
  await signIn(context, baseURL!);
});
test.afterAll(() => {
  resetWorkouts();
  clearCoach();
});

/** Nothing past the right edge (a row that scrolls sideways inside itself, like the suggestions, clips its own), and no sideways scroll. */
async function fitsWidth(page: Page, where: string) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const past: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || b.right <= vw + 0.5) continue;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement)
        if (getComputedStyle(p).overflowX !== "visible" && p.getBoundingClientRect().right <= vw + 0.5) {
          clipped = true;
          break;
        }
      if (!clipped) past.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}.${[...el.classList].join(".")} ends at ${Math.round(b.right)}`);
    }
    window.scrollTo(200, window.scrollY);
    const scrolledX = window.scrollX;
    window.scrollTo(0, window.scrollY);
    return { vw, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, scrolledX, past };
  });
  expect(r.past, `${where}: past the right edge of ${r.vw}`).toEqual([]);
  expect(r.scrollWidth, `${where}: page width`).toBeLessThanOrEqual(r.vw);
  expect(r.bodyWidth, `${where}: body width`).toBeLessThanOrEqual(r.vw);
  expect(r.scrolledX, `${where}: sideways scroll`).toBe(0);
}

/** Every text field at least 16 px, so iOS never zooms the page when it is tapped. */
async function noZoomOnFocus(page: Page, where: string) {
  const small = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLInputElement>("input, textarea, select"))
      .filter((e) => !["file", "checkbox", "radio", "range", "hidden"].includes(e.type))
      .map((e) => ({ field: e.dataset.testid ?? e.id ?? e.name, px: parseFloat(getComputedStyle(e).fontSize) }))
      .filter((f) => f.px < 16)
  );
  expect(small, `${where}: text fields under 16 px`).toEqual([]);
}

async function ask(page: Page, scope: ReturnType<Page["getByTestId"]>, text: string, n: number) {
  await scope.getByTestId("coach-input").fill(text);
  await scope.getByTestId("coach-send").click();
  await expect(scope.getByTestId("coach-cost")).toHaveCount(n, { timeout: 30_000 });
}

// One question per kind of card, plus a long message, a long unbroken link and Persian.
const QUESTIONS = [
  "How was my week? I trained four days, slept badly twice and my shoulders felt tight on the second bench day, so tell me straight what to change",
  "میخوام روزی که تمرین سینه دارم فوکوس بیشتری رو سینه داشته باشم و ۱ حرکت به سینه اضافه کن",
  "Sets for the last 3 weeks?",
  "https://example.com/a-very-long-link-without-any-spaces-at-all-that-keeps-going-and-going-and-going",
  "show me my program",
  "make me a new program with more chest",
  "امروز پشت دارم، جلوبازو و ساعد هم اضافه کن",
  "When should I go to the gym next week?",
  "Which days do I train?",
];

test("the Coach page fits an iPhone's width: header, messages, every card and the message field; no sideways scroll", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Ask the coach" }).click();
  const coach = page.getByTestId("coach");
  await expect(coach).toBeVisible();
  await fitsWidth(page, "empty chat");
  await noZoomOnFocus(page, "Coach page");
  for (const [i, q] of QUESTIONS.entries()) {
    await ask(page, coach, q, i + 1);
    await fitsWidth(page, `after "${q.slice(0, 30)}"`);
  }
  // The header's buttons, the last message and the message field are all inside the screen.
  const vw = page.viewportSize()!.width;
  for (const el of [page.getByTestId("coach-new"), page.getByTestId("coach-chats"), page.getByTestId("coach-send"), coach.getByTestId("coach-input")]) {
    const b = (await el.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vw);
  }
  // The saved chats list too.
  await page.getByTestId("coach-chats").click();
  await expect(page.getByTestId("coach-thread")).toHaveCount(1);
  await fitsWidth(page, "chats list");
});

test("the Coach sheet inside a session fits an iPhone's width too", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByTestId("start").click();
  await page.getByTestId("more").click();
  await page.getByTestId("ask-coach").click();
  const sheet = page.getByTestId("coach-sheet");
  await expect(sheet).toHaveAttribute("open", "");
  await fitsWidth(page, "empty sheet");
  await noZoomOnFocus(page, "Coach sheet");
  for (const [i, q] of [QUESTIONS[0], QUESTIONS[1], QUESTIONS[3], QUESTIONS[5]].entries()) {
    await ask(page, sheet, q, i + 1);
    await fitsWidth(page, `sheet, after "${q.slice(0, 30)}"`);
  }
  // The exercise card's place line (a session is open) wraps instead of being cut off.
  const place = sheet.getByTestId("coach-exercise-place");
  await expect(place).toHaveText(/^At the end of this session; in the program after .+\.$/);
  expect(await place.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

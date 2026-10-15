import { expect, test, type Page } from "./fixtures";
import { goTo, resetWorkouts, signIn, type Place } from "./helpers";

// SPEC-v8 §5: the tab bar and the Coach button stay fixed at the bottom of the screen, and every screen's content ends
// above them. Headless WebKit draws no rubber-band, so the iOS bounce itself is guarded by the root element's
// overscroll-behavior (WebKit reads the viewport's value from the root element only; on iOS fixed elements ride the
// bounce with the page).
test.describe.configure({ mode: "serial" });

/** .tabbar bottom and .fab bottom above the screen's bottom edge (the emulated profile has no safe area). */
const BAR_BOTTOM = 10;
const FAB_BOTTOM = 96;

const TABS = ["Train", "History", "Library", "Reports", "Me"] as const;

const denver = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d);

/** Four weeks of sessions, so History and Reports are long enough to scroll. */
async function seedSessions(page: Page, baseURL: string) {
  const now = Date.now();
  for (let w = 3; w >= 0; w--) {
    for (const [k, day, ex, weight] of [
      [5, "D1", "bench", 135],
      [3, "D2", "squat", 155],
      [1, "D3", "deadlift", 225],
    ] as const) {
      const id = `01LAYOUT${w}${day}`;
      const date = new Date(now - (w * 7 + k) * 86_400_000 - 3 * 3600_000);
      const iso = date.toISOString();
      const sets = Array.from({ length: 4 }, (_, i) => ({ id: `${id}${i}`, exercise_id: ex, set_index: i, weight: weight + 5 * (3 - w), reps: 5, seconds: null, done: true, rir: 2, updated_at: iso }));
      const res = await page.request.put(`${baseURL}/api/sessions/${id}`, {
        headers: { Origin: baseURL },
        data: { id, program_day_id: day, local_date: denver(date), started_at: iso, ended_at: new Date(date.getTime() + 3300_000).toISOString(), status: "done", unit: "lb", note: "", created_at: iso, updated_at: iso, source: "app", sets },
      });
      expect(res.status()).toBe(200);
    }
  }
}

interface Sample {
  y: number;
  max: number;
  vh: number;
  bar: number | null;
  fab: number | null;
}

const sample = (page: Page): Promise<Sample> =>
  page.evaluate(() => {
    const bottom = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().bottom) : null;
    };
    return { y: Math.round(window.scrollY), max: document.documentElement.scrollHeight - window.innerHeight, vh: window.innerHeight, bar: bottom(".tabbar"), fab: bottom(".fab") };
  });

/**
 * Scrolls to one end of the page with the browser's own scrolling (Page Down / Page Up; Playwright has no wheel or touch
 * drag in mobile WebKit), then keeps pushing past that end; returns a sample after every step.
 */
async function scrollToEnd(page: Page, dir: 1 | -1): Promise<Sample[]> {
  const out: Sample[] = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press(dir > 0 ? "PageDown" : "PageUp");
    await page.waitForTimeout(120);
    const s = await sample(page);
    out.push(s);
    if (dir > 0 ? s.y >= s.max : s.y <= 0) break;
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press(dir > 0 ? "End" : "Home");
    await page.evaluate((d) => window.scrollBy(0, d * 2000), dir);
    await page.waitForTimeout(120);
    out.push(await sample(page));
  }
  return out;
}

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  await signIn(context, baseURL!);
});
test.afterAll(() => resetWorkouts());

test("the tab bar and the Coach button stay at the bottom while each tab scrolls to its end and back, past both ends", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await seedSessions(page, baseURL!);
  await page.reload();
  await expect(page.getByTestId("next-card")).toBeVisible();
  // The guard for the iOS bounce: the viewport takes overscroll-behavior from the root element only.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY)).toBe("none");

  for (const tab of TABS) {
    await goTo(page, tab);
    await page.waitForTimeout(800);
    // Keys go to the page, not to a field.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const down = await scrollToEnd(page, 1);
    const up = await scrollToEnd(page, -1);
    const all = [...down, ...up];
    expect(down.at(-1)!.y, `${tab}: reached the end`).toBe(down.at(-1)!.max);
    expect(down.at(-1)!.max, `${tab}: long enough to scroll`).toBeGreaterThan(0);
    expect(up.at(-1)!.y, `${tab}: back at the top`).toBe(0);
    for (const s of all) {
      expect(s.bar, `${tab}: tab bar at y=${s.y}`).toBe(s.vh - BAR_BOTTOM);
      expect(s.fab, `${tab}: Coach button at y=${s.y}`).toBe(s.vh - FAB_BOTTOM);
    }
  }
});

/** Opens a screen; the ones not in the tab bar or Me are reached through their parent screen. */
async function open(page: Page, screen: Place | "Planner" | "Apple Watch" | "New program") {
  if (screen === "Planner") {
    await goTo(page, "Train");
    await page.getByTestId("plan-session").click();
    await expect(page.getByTestId("planner")).toBeVisible();
  } else if (screen === "Apple Watch") {
    await goTo(page, "Settings");
    await page.getByTestId("open-watch").click();
    await expect(page.getByTestId("watch")).toBeVisible();
  } else if (screen === "New program") {
    await goTo(page, "Program");
    await page.getByTestId("program-new").click();
    await expect(page.getByTestId("np-generate")).toBeVisible();
  } else await goTo(page, screen);
}

test("every long screen ends with its last control fully above the tab bar and clear of the Coach button", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await seedSessions(page, baseURL!);
  await page.reload();
  await expect(page.getByTestId("next-card")).toBeVisible();
  const screens = [...TABS, "Settings", "Program", "Photos", "AI reports", "Backup", "Planner", "Apple Watch", "New program"] as const;
  for (const screen of screens) {
    await open(page, screen);
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const box = (el: Element | null) => (el ? el.getBoundingClientRect().toJSON() : null);
      const controls = [...document.querySelectorAll("main button, main a[href], main input, main select, main textarea")].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 1 && b.height > 1 && getComputedStyle(el).visibility !== "hidden";
      });
      const last = controls.reduce<Element | null>((a, el) => (!a || el.getBoundingClientRect().bottom >= a.getBoundingClientRect().bottom ? el : a), null);
      return {
        y: Math.round(window.scrollY),
        max: document.documentElement.scrollHeight - window.innerHeight,
        bar: box(document.querySelector(".tabbar")),
        fab: box(document.querySelector(".fab")),
        last: box(last),
        label: last ? (last.getAttribute("aria-label") ?? last.textContent ?? "").trim().slice(0, 40) : "",
      };
    });
    expect(r.y, `${screen}: scrolled to the real end`).toBe(r.max);
    expect(r.last, `${screen}: has a control`).not.toBeNull();
    expect(r.last!.bottom, `${screen}: "${r.label}" ends above the tab bar`).toBeLessThanOrEqual(r.bar!.top - 8);
    if (r.fab) {
      const overlaps = r.last!.right > r.fab.left && r.last!.left < r.fab.right && r.last!.bottom > r.fab.top && r.last!.top < r.fab.bottom;
      expect(overlaps, `${screen}: "${r.label}" is clear of the Coach button`).toBe(false);
    }
  }
});

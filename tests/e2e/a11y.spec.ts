import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import { goTo, openMore, resetCalendar, resetWorkouts, signIn, sql } from "./helpers";

// SPEC-v8 §10: an axe contrast check on all screens. Axe cannot judge text drawn over the library's gradients (card,
// clay and page fills) and reports it as "incomplete", so every screen is also measured as drawn: each run of text
// against the pixels behind it (text hidden), scrolled through the whole page. Every run must reach 4.5:1, apart from
// the two cases Payam accepted below. Disabled controls and text passing under the fixed tab bar or Coach button are
// left out (they are measured where nothing covers them).
test.describe.configure({ mode: "default" });

const NEED = 4.5;

/**
 * Known cases kept as designed (Payam, 2026-10-15), each with the lowest contrast allowed and what was measured.
 * Anything else below 4.5:1 fails.
 */
const KNOWN: { name: string; floor: number; measured: string; match: (r: Run) => boolean }[] = [
  {
    name: "--ink-3 (#8F8F99) text drawn straight on the page background",
    // The page gradient is lightest at its top (--bg-top #2B2C31); 4.35:1 is #8F8F99 on #2B2C31 itself.
    floor: 4.35,
    measured: "4.47–4.48:1 (Apple Watch section labels, the Library count line; WebKit and Chromium)",
    match: (r) => r.color === "rgb(143, 143, 153)" && r.onPage,
  },
  {
    name: "pink .badge on the page background (the Planner's Not saved / Unsaved changes)",
    floor: 4.0,
    measured: "4.02–4.06:1 (on cards the same badge measures 4.8–5.25:1)",
    match: (r) => r.color === "rgb(255, 79, 160)" && r.badgeOnPage,
  },
];

const denver = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d);

/**
 * The training calendar (SPEC-v10 M13) around the current hour, so the week grid opens on a shift, a planned and a missed
 * session (it opens an hour before now; the hour is kept inside 05:00–20:00 so the blocks stay on the 04:00–24:00 axis).
 */
function seedCalendar() {
  resetCalendar();
  const now = new Date();
  const today = denver(now);
  const day = (n: number) => denver(new Date(now.getTime() + n * 86_400_000));
  const hour = Math.min(20, Math.max(5, Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "numeric", hourCycle: "h23" }).format(now))));
  const at = new Date().toISOString();
  sql(
    [
      `INSERT INTO work_shifts (id, date, start_min, end_min, note, created_at, updated_at) VALUES ('a11y-w', '${today}', ${hour * 60}, ${(hour + 2) * 60}, 'Store', '${at}', '${at}')`,
      `INSERT INTO gym_plans (id, date, start_min, end_min, program_day_id, source, status, created_at, updated_at) VALUES ('a11y-p', '${day(1)}', ${hour * 60}, ${hour * 60 + 60}, 'D1', 'manual', 'planned', '${at}', '${at}')`,
      `INSERT INTO gym_plans (id, date, start_min, end_min, program_day_id, source, status, created_at, updated_at) VALUES ('a11y-m', '${day(-1)}', ${hour * 60}, ${hour * 60 + 60}, 'D2', 'manual', 'planned', '${at}', '${at}')`,
    ].join("; ")
  );
}

/** Four weeks of sessions, so lists, charts and calendars have content. */
async function seed(page: Page, baseURL: string) {
  seedCalendar();
  const now = Date.now();
  for (let w = 3; w >= 0; w--) {
    for (const [k, day, ex, weight] of [
      [5, "D1", "bench", 135],
      [3, "D2", "squat", 155],
      [1, "D3", "deadlift", 225],
    ] as const) {
      const id = `01A11Y${w}${day}`;
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

interface Run {
  text: string;
  color: string;
  size: number;
  weight: number;
  x: number;
  y: number;
  w: number;
  h: number;
  path: string;
  /** Drawn straight on the page: no card, clay or other fill between the text and the page background. */
  onPage: boolean;
  /** Inside a .badge that sits straight on the page background. */
  badgeOnPage: boolean;
}

/** The runs of text fully on screen and not under a fixed layer: colour, size and box. */
const runs = (page: Page) =>
  page.evaluate(() => {
    const out: Run[] = [];
    const layers = [...document.querySelectorAll<HTMLElement>("body *")].filter((e) => {
      const p = getComputedStyle(e).position;
      return (p === "fixed" || p === "sticky") && e.getBoundingClientRect().height > 0;
    });
    // The nearest element that paints a background (a fill or an image), from `e` up; null when only the page does.
    const filled = (e: Element | null): Element | null => {
      for (; e && !e.matches("main.page, body, html"); e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage !== "none" || !/^rgba\(.*, 0\)$|^transparent$/.test(cs.backgroundColor)) return e;
      }
      return null;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent!.trim();
      if (!t) continue;
      const el = n.parentElement!;
      if (el.closest("[disabled], [aria-disabled='true'], .l-sr, script, style")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") continue;
      let op = 1;
      for (let e: Element | null = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      if (op < 0.99) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(el.contains(hit) || hit.contains(el))) continue;
      // Text scrolled out of an inner scroller (the Calendar's week grid) is clipped, not drawn; the hit test above can
      // still land on an ancestor such as the page.
      let clipped = false;
      for (let e = el.parentElement; e && !clipped; e = e.parentElement) {
        const ec = getComputedStyle(e);
        if (ec.overflowX === "visible" && ec.overflowY === "visible") continue;
        const b = e.getBoundingClientRect();
        clipped = r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5 || r.left < b.left - 0.5 || r.right > b.right + 0.5;
      }
      if (clipped) continue;
      const under = layers.some((l) => {
        if (l.contains(el)) return false;
        const b = l.getBoundingClientRect();
        if (!(r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom)) return false;
        // Only a layer painted over the text covers it (a sheet's scrim lies under the sheet's own text).
        const top = document.elementFromPoint((Math.max(r.left, b.left) + Math.min(r.right, b.right)) / 2, (Math.max(r.top, b.top) + Math.min(r.bottom, b.bottom)) / 2);
        return top !== null && l.contains(top) && !el.contains(top);
      });
      if (under) continue;
      const badge = el.closest(".badge");
      out.push({
        text: t.slice(0, 40),
        color: cs.color,
        size: parseFloat(cs.fontSize),
        weight: Number(cs.fontWeight),
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        path: [el.tagName.toLowerCase(), ...el.classList].join("."),
        onPage: filled(el) === null,
        badgeOnPage: badge !== null && filled(badge.parentElement) === null,
      });
    }
    return out;
  });

/** Each run's lowest contrast against the pixels drawn behind it, at this scroll position. */
async function measure(page: Page) {
  const list = await runs(page);
  // The app's CSP allows no injected style sheet and no style attribute writes: hide and restore the text through
  // each element's CSSOM, property by property.
  await page.evaluate(() => {
    const w = window as unknown as { __a11y: [ElementCSSInlineStyle, string, string, string][] };
    w.__a11y = [];
    for (const el of document.querySelectorAll<HTMLElement | SVGElement>("body *"))
      for (const [prop, value] of [
        ["color", "transparent"],
        ["-webkit-text-fill-color", "transparent"],
        ["text-shadow", "none"],
        ["caret-color", "transparent"],
      ]) {
        w.__a11y.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
        el.style.setProperty(prop, value, "important");
      }
  });
  await page.waitForTimeout(60);
  const png = (await page.screenshot()).toString("base64");
  await page.evaluate(() => {
    const w = window as unknown as { __a11y: [ElementCSSInlineStyle, string, string, string][] };
    for (const [el, prop, value, priority] of w.__a11y) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
    w.__a11y = [];
  });
  return page.evaluate(
    async ({ png, list }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const scale = img.width / innerWidth;
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const lum = (r: number, g: number, b: number) => {
        const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      return list.map((r) => {
        const [fr, fg, fb, fa = 1] = r.color.match(/[\d.]+/g)!.map(Number);
        let min = Infinity;
        let bg = "";
        for (let i = 0; i < 7; i++)
          for (let j = 0; j < 3; j++) {
            const px = Math.min(img.width - 1, Math.round((r.x + (r.w * (i + 0.5)) / 7) * scale));
            const py = Math.min(img.height - 1, Math.round((r.y + (r.h * (j + 0.5)) / 3) * scale));
            const o = (py * img.width + px) * 4;
            const a = lum(fr * fa + data[o] * (1 - fa), fg * fa + data[o + 1] * (1 - fa), fb * fa + data[o + 2] * (1 - fa));
            const b = lum(data[o], data[o + 1], data[o + 2]);
            const c = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (c < min) {
              min = c;
              bg = `rgb(${data[o]}, ${data[o + 1]}, ${data[o + 2]})`;
            }
          }
        return { ...r, contrast: Math.round(min * 100) / 100, bg };
      });
    },
    { png, list }
  );
}

/**
 * Axe's contrast rule, then the drawn contrast of every run of text from the top of the page to its end. Returns what
 * fails, so a test reports every screen it visits.
 */
async function contrast(page: Page, screen: string): Promise<string[]> {
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  const failed = axe.violations.flatMap((v) => v.nodes.map((n) => `${screen} (axe): ${n.target.join(" ")}: ${n.any.map((a) => a.message).join("; ")}`));
  const low = new Map<string, string>();
  let measured = 0;
  const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  for (let y = 0; ; y = Math.min(max, y + 480)) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await page.waitForTimeout(120);
    for (const r of await measure(page)) {
      measured++;
      const floor = KNOWN.find((k) => k.match(r))?.floor ?? NEED;
      if (r.contrast < floor) low.set(`${r.path} "${r.text}"`, `${screen}: ${r.contrast} < ${floor}: ${r.color} on ${r.bg}, ${r.size}px/${r.weight}, ${r.path} "${r.text}"`);
    }
    if (y >= max) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(measured, `${screen}: text measured`).toBeGreaterThan(0);
  return [...failed, ...low.values()];
}

test.beforeEach(async ({ page, context, baseURL }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  resetWorkouts();
  await signIn(context, baseURL!);
  await page.goto("/");
  await seed(page, baseURL!);
  await page.reload();
  await expect(page.getByTestId("next-card")).toBeVisible();
});
test.afterAll(() => {
  resetWorkouts();
  resetCalendar();
});

test("contrast: the five tabs", async ({ page }) => {
  test.setTimeout(300_000);
  const failed = await contrast(page, "Train");
  for (const tab of ["History", "Library", "Reports", "Me"] as const) {
    await goTo(page, tab);
    failed.push(...(await contrast(page, tab)));
  }
  expect(failed).toEqual([]);
});

test("contrast: the screens in Me", async ({ page }) => {
  test.setTimeout(300_000);
  const failed: string[] = [];
  for (const place of ["Settings", "Program", "Photos", "AI reports", "Backup"] as const) {
    await goTo(page, place);
    failed.push(...(await contrast(page, place)));
  }
  await goTo(page, "Settings");
  await page.getByTestId("open-watch").click();
  failed.push(...(await contrast(page, "Apple Watch")));
  await goTo(page, "Program");
  await page.getByTestId("program-new").click();
  failed.push(...(await contrast(page, "New program")));
  expect(failed).toEqual([]);
});

test("contrast: pushed screens, the session and the coach", async ({ page }) => {
  test.setTimeout(300_000);
  const failed: string[] = [];
  await goTo(page, "Library");
  await page.getByTestId("library-row").first().click();
  failed.push(...(await contrast(page, "Exercise detail")));
  await goTo(page, "History");
  await page.getByTestId("session-card").first().click();
  failed.push(...(await contrast(page, "Finished session")));
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await goTo(page, "Train");
  await page.getByTestId("plan-session").click();
  failed.push(...(await contrast(page, "Planner")));
  await page.getByTestId("back").click();
  await page.getByTestId("cal-open").click();
  failed.push(...(await contrast(page, "Calendar")));
  await page.getByTestId("cal-free").check();
  failed.push(...(await contrast(page, "Calendar, free times")));
  await page.getByTestId("cal-view-toggle").click();
  failed.push(...(await contrast(page, "Calendar, List view")));
  await page.getByTestId("cal-find-times").click();
  await expect(page.getByTestId("cal-find-sheet")).toHaveAttribute("open", "");
  failed.push(...(await contrast(page, "Calendar, Find times")));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cal-find-sheet")).toHaveCount(0);
  await page.getByTestId("back").click();
  await page.getByRole("button", { name: "Ask the coach" }).click();
  failed.push(...(await contrast(page, "Coach")));
  await page.getByTestId("coach").getByRole("button", { name: "Back" }).click();
  await page.getByTestId("start").click();
  await expect(page.getByTestId("ex-card")).toBeVisible();
  failed.push(...(await contrast(page, "Active session")));
  await (await openMore(page)).getByTestId("add-exercise").click();
  failed.push(...(await contrast(page, "Body picker")));
  expect(failed).toEqual([]);
});

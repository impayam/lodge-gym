import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "./fixtures";
import { resetWorkouts, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

// Payam's region list: one region per canonical key on the figures (abductors and neck are listed, not drawn).
const KEYS = ["chest", "back_lats", "back_upper", "traps", "lower_back", "shoulders_front", "shoulders_side", "rear_delts", "biceps", "triceps", "forearms", "core", "quads", "hamstrings", "glutes", "adductors", "calves"];
const GROUP: Record<string, string> = { back_lats: "back", back_upper: "back", shoulders_front: "shoulders", shoulders_side: "shoulders", hamstrings: "hamstrings_glutes", glutes: "hamstrings_glutes" };

const denver = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d);

async function openProgress(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Reports" }).click();
  await page.getByRole("tab", { name: "Progress" }).click();
  await expect(page.getByTestId("muscle-map")).toBeVisible();
}

/**
 * Screenshots of the map for review, light and dark: test-results/musclemap/<project>-<name>-<scheme>.png. The crop
 * runs from the readout to the legend; the sticky header and the tab bar are hidden so they do not cover it.
 */
async function shoot(page: Page, name: string) {
  const dir = "test-results/musclemap";
  mkdirSync(dir, { recursive: true });
  // The app's CSP refuses injected stylesheets, so hide the bars through the DOM.
  const bars = (hidden: boolean) =>
    page.evaluate((h) => {
      for (const el of document.querySelectorAll<HTMLElement>("header.top, nav.tabbar")) el.style.visibility = h ? "hidden" : "";
    }, hidden);
  await bars(true);
  const map = page.getByTestId("muscle-map");
  await map.locator(".figures").scrollIntoViewIfNeeded();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const box = await map.evaluate((el) => {
      const top = el.querySelector(".readout")!.getBoundingClientRect();
      const bottom = el.querySelector(".legend")!.getBoundingClientRect();
      const card = el.closest(".card")!.getBoundingClientRect();
      return { x: card.left + window.scrollX, y: top.top + window.scrollY - 8, width: card.width, height: bottom.bottom - top.top + 16 };
    });
    await page.screenshot({ path: `${dir}/${test.info().project.name}-${name}-${colorScheme}.png`, clip: box, fullPage: true, animations: "disabled" });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await bars(false);
}

test("anatomical figures: every region, mirror-symmetric, inside one silhouette, fits the iPhone width", async ({ page, context, baseURL }) => {
  resetWorkouts();
  await signIn(context, baseURL!);
  await openProgress(page);
  const map = page.getByTestId("muscle-map");

  const shape = await map.evaluate((root) =>
    [...root.querySelectorAll<SVGSVGElement>(".figure svg")].map((svg) => {
      const body = svg.querySelectorAll("path.body");
      const sil = body[0] as SVGPathElement;
      // A point lies on the body when it is inside the silhouette or on its 1-unit outline.
      const onBody = (x: number, y: number) => sil.isPointInFill(new DOMPoint(x, y)) || sil.isPointInStroke(new DOMPoint(x, y));
      const regions = [...svg.querySelectorAll<SVGPathElement>("path.muscle")].map((p) => {
        const b = p.getBBox();
        const len = p.getTotalLength();
        const outside = Array.from({ length: 48 }, (_, i) => p.getPointAtLength((len * i) / 48)).filter((pt) => !onBody(pt.x, pt.y)).length;
        return { key: p.dataset.muscle!, group: p.dataset.group!, x: b.x, y: b.y, w: b.width, h: b.height, outside };
      });
      const kinds = [...svg.children].map((c) => `${c.tagName.toLowerCase()}.${c.getAttribute("class") ?? ""}`);
      const sb = sil.getBBox();
      return { viewBox: svg.getAttribute("viewBox"), bodies: body.length, regions, kinds, silhouette: { x: sb.x, width: sb.width } };
    })
  );
  expect(shape).toHaveLength(2);
  expect(new Set(shape.flatMap((f) => f.regions.map((r) => r.key)))).toEqual(new Set(KEYS));
  for (const f of shape) {
    expect(f.viewBox).toBe("0 0 200 460");
    // One silhouette and nothing else under the muscles: no second, offset body layer.
    expect(f.bodies).toBe(1);
    expect(f.kinds.every((k) => /^path\.(body|muscle .*|detail)$/.test(k))).toBe(true);
    // Left/right pairs are exact mirror images across x = 100.
    expect(f.regions.length % 2).toBe(0);
    for (let i = 0; i < f.regions.length; i += 2) {
      const [l, r] = [f.regions[i], f.regions[i + 1]];
      expect(r.key).toBe(l.key);
      expect(Math.abs(l.x + l.w - (200 - r.x))).toBeLessThan(0.05);
      expect(Math.abs(l.y - r.y) + Math.abs(l.h - r.h) + Math.abs(l.w - r.w)).toBeLessThan(0.05);
    }
    for (const r of f.regions) {
      expect(r.group).toBe(GROUP[r.key] ?? r.key);
      expect(r.outside, `${r.key}: outline points off the body`).toBe(0);
    }
    expect(Math.abs(f.silhouette.x + f.silhouette.width / 2 - 100)).toBeLessThan(0.05);
  }
  // Both figures fit the phone's width; the page never scrolls sideways.
  const fit = await page.evaluate(() => {
    const figs = [...document.querySelectorAll(".figure svg")].map((s) => s.getBoundingClientRect());
    return { right: Math.max(...figs.map((r) => r.right)), left: Math.min(...figs.map((r) => r.left)), vw: window.innerWidth, scroll: document.documentElement.scrollWidth };
  });
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(fit.vw);
  expect(fit.scroll).toBeLessThanOrEqual(fit.vw);

  // Empty week: every region shows "no sets".
  await expect(map.locator("path.muscle:not([data-status='none'])")).toHaveCount(0);
  await shoot(page, "empty-week");
});

test("mixed week: regions take their group's status; a tap fills the whole group with a highlight and a thick outline", async ({ page, context, baseURL }) => {
  resetWorkouts();
  await signIn(context, baseURL!);
  await page.goto("/");
  const now = new Date(Date.now() - 2 * 3600_000);
  const iso = now.toISOString();
  // Against the program's fractional targets: chest 12/13, quads 10/11.5 and rear delts 10/11 on; shoulders 12/15.5,
  // triceps 6/9.5, hamstrings & glutes 5/14 and back 5/17.5 under; biceps 12/9.5, calves 9/6 and core 8/6 over.
  const plan: [string, number, number, number][] = [
    ["bench", 12, 135, 5],
    ["lateral", 6, 15, 12],
    ["curl", 12, 30, 10],
    ["calf_stand", 9, 90, 12],
    ["squat", 10, 185, 5],
    ["facepull", 10, 40, 15],
    ["plank", 8, 0, 1],
  ];
  const sets = plan.flatMap(([ex, n, w, r], k) => Array.from({ length: n }, (_, i) => ({ id: `01MM${k}${String(i).padStart(2, "0")}`, exercise_id: ex, set_index: i, weight: w, reps: r, seconds: null, done: true, rir: null, updated_at: iso })));
  const res = await page.request.put(`${baseURL}/api/sessions/01MMIX`, {
    headers: { Origin: baseURL! },
    data: { id: "01MMIX", program_day_id: "D1", local_date: denver(now), started_at: iso, ended_at: new Date(now.getTime() + 3600_000).toISOString(), status: "done", unit: "lb", note: "", created_at: iso, updated_at: iso, source: "app", sets },
  });
  expect(res.status()).toBe(200);
  await openProgress(page);
  const map = page.getByTestId("muscle-map");

  const expected: Record<string, string> = {
    chest: "on", quads: "on", rear_delts: "on",
    shoulders_front: "under", shoulders_side: "under", triceps: "under", hamstrings: "under", glutes: "under", back_lats: "under", back_upper: "under",
    biceps: "over", calves: "over", core: "over",
    forearms: "untracked", lower_back: "untracked",
    traps: "none", adductors: "none",
  };
  for (const [key, status] of Object.entries(expected)) {
    const regions = map.locator(`path.muscle[data-muscle="${key}"]`);
    expect(await regions.count(), key).toBeGreaterThan(0);
    for (const s of await regions.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))) expect(s, key).toBe(status);
  }
  await shoot(page, "mixed-week");

  // Tap a front delt: every shoulders region on both figures (front and side delts) is filled and outlined.
  await map.locator('path.muscle[data-muscle="shoulders_front"]').first().click();
  await expect(map.locator(".readout")).toContainText("Front delts (Shoulders): 6 direct · 12 fractional of 15.5 sets · Under target");
  const sel = map.locator("path.sel");
  await expect(sel).toHaveCount(6);
  expect(new Set(await sel.evaluateAll((els) => els.map((e) => e.getAttribute("data-selected"))))).toEqual(new Set(["shoulders_front", "shoulders_side"]));
  const look = await sel.first().evaluate((e) => {
    const cs = getComputedStyle(e);
    return { width: parseFloat(cs.strokeWidth), fillOpacity: parseFloat(cs.fillOpacity), events: cs.pointerEvents };
  });
  expect(look.width).toBeGreaterThanOrEqual(2.5);
  expect(look.fillOpacity).toBeGreaterThan(0.2);
  expect(look.events).toBe("none");
  await shoot(page, "mixed-week-selected");

  // Another group replaces the selection.
  await map.locator('path.muscle[data-muscle="back_lats"]').first().click();
  await expect(map.locator(".readout")).toContainText("Lats (Back): 0 direct · 5 fractional of 17.5 sets · Under target");
  await expect(sel).toHaveCount(4);
});

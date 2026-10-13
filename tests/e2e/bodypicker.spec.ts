import { expect, test, type Page } from "./fixtures";
import { resetWorkouts, setOffline, signIn, sql, waitForSynced } from "./helpers";

// SPEC-v3 M9b with the SPEC-v6 3D model. "+ Add exercise" opens on the 3D body; the area and muscle chips do the same
// as the model; a pick adds the exercise to the session as an extra. Both projects render WebGL 2 (WebKit and
// Chromium's SwiftShader), so the 3D path is asserted in both; the fallback is forced by taking WebGL away.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  await signIn(context, baseURL!);
});
test.afterAll(() => resetWorkouts());

/** window.__anatomy, the 3D view's test hook (web/src/lib/anatomy3d.ts). */
interface Hook {
  live: number;
  contexts: number;
  stats: { loadMs: number; interactiveMs: number; warm: boolean; fps: number | null } | null;
  view: {
    pointOn(name: string, pickable?: boolean): { x: number; y: number } | null;
    pickAt(x: number, y: number, radius?: number): string | null;
    lit(): string[];
    yaw(): number;
    memory(): { geometries: number; textures: number; programs: number };
  } | null;
}
const hook = <T,>(page: Page, fn: (h: Hook) => T) => page.evaluate(`(${fn.toString()})(window.__anatomy)`) as Promise<T>;
/** Waits for a Front / Back turn to end: cos(yaw) is 1 facing the front, -1 facing the back. */
const facing = (page: Page, cos: 1 | -1) => expect.poll(() => hook(page, (h) => Math.cos(h.view!.yaw())), { timeout: 5_000 }).toBeCloseTo(cos, 3);

const AREAS = ["chest", "shoulders", "arms", "back", "core", "glutes_hips", "thighs", "calves"];

/** All eight area chips are on screen at once: inside the width, above the tab bar, in at most two rows. */
async function allAreasVisible(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const width = page.viewportSize()!.width;
  const navTop = (await page.getByRole("navigation").boundingBox())!.y;
  const rows = new Set<number>();
  for (const a of AREAS) {
    const b = (await page.getByTestId(`area-${a}`).boundingBox())!;
    expect(b.height, a).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width, a).toBeLessThanOrEqual(width);
    expect(b.y + b.height, a).toBeLessThanOrEqual(navTop);
    rows.add(Math.round(b.y));
  }
  expect(rows.size).toBeLessThanOrEqual(2);
}

async function startSession(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start", exact: true }).click();
}

async function openPicker(page: Page, mode: "3d" | "fallback" = "3d") {
  await page.getByTestId("add-exercise").click();
  const step = page.getByTestId("body-step");
  await expect(step).toHaveAttribute("data-mode", mode, { timeout: 30_000 });
  return step;
}

test("chips: Arms → Triceps lists triceps-primary exercises first; picking one adds it as an extra", async ({ page }) => {
  await startSession(page);
  const step = await openPicker(page);
  await expect(page.getByTestId("exercise-picker").getByTestId("picker-tab-body")).toHaveAttribute("aria-selected", "true");
  await expect(step.getByTestId("anatomy-canvas")).toBeVisible();
  await allAreasVisible(page);
  // The hint sits beside the body, never over it, front or back.
  const hint = step.getByTestId("anatomy-hint");
  await expect(hint).toBeVisible();
  const covered = async () => page.evaluate((r) => (window as unknown as { __anatomy: { view: { modelPixels(r: object): number } } }).__anatomy.view.modelPixels(r), (await hint.boundingBox())!);
  expect(await covered()).toBe(0);
  await step.getByTestId("view-back").click();
  await facing(page, -1);
  expect(await covered()).toBe(0);
  await step.getByTestId("view-front").click();
  await facing(page, 1);

  await step.getByTestId("area-arms").click();
  await expect(step).toHaveAttribute("data-area", "arms");
  await expect(step.getByTestId("area-arms")).toHaveAttribute("aria-pressed", "true");
  for (const m of ["biceps", "triceps", "forearms"]) expect((await step.getByTestId(`muscle-${m}`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const a of ["chest", "arms", "calves"]) expect((await step.getByTestId(`area-${a}`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await step.getByTestId("muscle-triceps").click();

  const list = page.getByTestId("muscle-step");
  await expect(list).toHaveAttribute("data-muscle", "triceps");
  const ids = await list.getByTestId("pick-primary").getByTestId("pick-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-id")!));
  expect(ids.length).toBeGreaterThan(0);
  const primary = sql(`SELECT id, muscle_primary FROM exercises WHERE id IN (${ids.map((i) => `'${i}'`).join(",")})`) as { id: string; muscle_primary: string }[];
  expect(primary.every((r) => r.muscle_primary === "triceps")).toBe(true);
  // Nothing logged yet, so the program's triceps exercise leads.
  expect(ids[0]).toBe("oh_tri");
  await expect(list.getByTestId("pick-secondary")).toContainText("Also works this muscle");

  // Back returns to the Arms close-up; the place is kept.
  await list.getByTestId("pick-back").click();
  await expect(step).toHaveAttribute("data-area", "arms");
  await step.getByTestId("muscle-triceps").click();
  await list.locator(`[data-testid="pick-row"][data-id="oh_tri"] .pickmain`).click();
  await expect(page.getByTestId("exercise-picker")).toHaveCount(0);
  const card = page.locator(`article.ex[data-ex="oh_tri"]`);
  await expect(card).toContainText("Extra");
  await expect(card.locator(".setrow")).toHaveCount(3);
  await waitForSynced(page);
  await expect
    .poll(() => sql("SELECT COUNT(*) AS n, SUM(is_extra) AS extra FROM set_entries WHERE exercise_id = 'oh_tri'"), { timeout: 20_000 })
    .toEqual([{ n: 3, extra: 3 }]);

  // Reopening the picker in the same session returns to the triceps list.
  await page.getByTestId("add-exercise").click();
  await expect(page.getByTestId("muscle-step")).toHaveAttribute("data-muscle", "triceps");
  await page.getByTestId("pick-back").click();
  await expect(page.getByTestId("body-step")).toHaveAttribute("data-mode", "3d", { timeout: 30_000 });
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("3D: a tap on the triceps lights the group on both sides; near misses count, empty space and unmapped muscles clear it", async ({ page }) => {
  await startSession(page);
  const step = await openPicker(page);

  // Back turns the body round (in under 400 ms, unit-tested) and ends facing its back.
  await step.getByTestId("view-back").click();
  await expect(step.getByTestId("view-back")).toHaveAttribute("aria-pressed", "true");
  await facing(page, -1);

  const tri = (await hook(page, (h) => h.view!.pointOn("Long head of triceps brachii")))!;
  expect(tri).not.toBeNull();
  await expect(step.getByTestId("anatomy-hint")).not.toHaveClass(/gone/);
  await page.touchscreen.tap(tri.x, tri.y);
  const chip = step.getByTestId("anatomy-selection");
  await expect(chip).toHaveAttribute("data-muscle", "triceps");
  await expect(chip).toContainText("Triceps");
  // The tap stays on the model: WebKit's touch adjustment must not hand it to the Front button nearby.
  await expect(step.getByTestId("view-back")).toHaveAttribute("aria-pressed", "true");
  await facing(page, -1);
  // Every triceps mesh lights up, left and right.
  const lit = await hook(page, (h) => h.view!.lit());
  for (const name of ["Long head of triceps brachii", "Lateral head of triceps brachii", "Medial head of triceps brachii", "Anconeus muscle"])
    expect(lit.filter((n) => n === name), name).toHaveLength(2);
  expect(lit).toHaveLength(8);

  // Empty space (the left edge of the stage, beside the body) clears it.
  const box = (await step.getByTestId("anatomy-canvas").boundingBox())!;
  await page.touchscreen.tap(box.x + 10, box.y + box.height / 2);
  await expect(chip).toHaveCount(0);
  // The hint faded out at the first touch and stays out.
  await expect(step.getByTestId("anatomy-hint")).toHaveClass(/gone/);

  // A tap just off the body's outline still finds the nearest muscle (within 24 px).
  const miss = await hook(page, (h) => {
    const p = h.view!.pointOn("Long head of triceps brachii")!;
    for (let dx = 1; dx < 160; dx++) {
      const x = p.x + dx;
      if (h.view!.pickAt(x, p.y, 0) === null && h.view!.pickAt(x + 8, p.y, 0) === null) return { x: x + 8, y: p.y, near: h.view!.pickAt(x + 8, p.y) };
    }
    return null;
  });
  expect(miss?.near).toBeTruthy();
  await page.touchscreen.tap(miss!.x, miss!.y);
  await expect(chip).toHaveAttribute("data-muscle", miss!.near!);

  // A muscle that is not mapped (the forehead) is not tappable and nothing mapped is within 24 px: the selection clears.
  await step.getByTestId("view-front").click();
  await facing(page, 1);
  const brow = (await hook(page, (h) => h.view!.pointOn("Frontalis muscle", false)))!;
  await page.touchscreen.tap(brow.x, brow.y);
  await expect(chip).toHaveCount(0);

  // Show exercises opens the list of the lit muscle.
  const bi = (await hook(page, (h) => h.view!.pointOn("Long head of biceps brachii")))!;
  await page.touchscreen.tap(bi.x, bi.y);
  await expect(chip).toHaveAttribute("data-muscle", "biceps");
  await chip.getByTestId("show-exercises").click();
  await expect(page.getByTestId("muscle-step")).toHaveAttribute("data-muscle", "biceps");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("3D: an area close-up keeps only its own muscles tappable", async ({ page }) => {
  await startSession(page);
  const step = await openPicker(page);
  await step.getByTestId("area-arms").click();
  await expect(step).toHaveAttribute("data-area", "arms");
  await step.getByTestId("view-back").click();
  await facing(page, -1);
  // The middle of the back is not an arm muscle.
  const back = (await hook(page, (h) => h.view!.pointOn("Rhomboid major muscle", false)))!;
  await page.touchscreen.tap(back.x, back.y);
  await expect(step.getByTestId("anatomy-selection")).toHaveCount(0);
  const tri = (await hook(page, (h) => h.view!.pointOn("Lateral head of triceps brachii")))!;
  await page.touchscreen.tap(tri.x, tri.y);
  await expect(step.getByTestId("anatomy-selection")).toHaveAttribute("data-muscle", "triceps");
  // ← Body goes back to the whole body; the selection stays.
  await step.getByTestId("pick-back").click();
  await expect(step).toHaveAttribute("data-area", "");
  await expect(step.getByTestId("anatomy-selection")).toHaveAttribute("data-muscle", "triceps");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("fallback: without WebGL the chips alone pick the exercise, with a 3D unavailable note", async ({ page }) => {
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return /webgl/.test(type) ? null : (get as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof get;
  });
  await startSession(page);
  const step = await openPicker(page, "fallback");
  await expect(step.getByTestId("anatomy-fallback")).toContainText("3D unavailable");
  await expect(step.locator("canvas")).toHaveCount(0);
  await allAreasVisible(page);
  await step.getByTestId("area-arms").click();
  await step.getByTestId("muscle-triceps").click();
  await expect(page.getByTestId("muscle-step")).toHaveAttribute("data-muscle", "triceps");
  await page.getByTestId("pick-back").click();
  await expect(step.getByTestId("pick-back")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("offline: after one online open the 3D picker loads from the service worker's cache", async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20_000 });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await openPicker(page);
  await page.getByRole("button", { name: "Cancel" }).click();
  const cached = await page.evaluate(async () => {
    const name = (await caches.keys()).find((k) => k.startsWith("anatomy-"))!;
    return (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
  });
  expect(cached).toContain("/models/body.glb");
  expect(cached.some((p) => /^\/assets\/draco_decoder-[\w-]+\.wasm$/.test(p))).toBe(true);
  expect(cached.some((p) => /^\/assets\/anatomy3d-[\w-]+\.js$/.test(p))).toBe(true);

  await setOffline(context, page, true);
  await page.reload();
  await page.getByRole("button", { name: "Continue session" }).click();
  const step = await openPicker(page);
  await expect(step.getByTestId("anatomy-canvas")).toBeVisible();
  await setOffline(context, page, false);
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("memory: opening and closing the picker 20 times leaves no renderer, context or growing heap behind", async ({ page, browserName }) => {
  test.setTimeout(240_000);
  await startSession(page);
  const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
  const heap = async () => {
    await cdp!.send("HeapProfiler.collectGarbage");
    return ((await cdp!.send("Runtime.getHeapUsage")) as { usedSize: number }).usedSize;
  };
  let first = 0;
  for (let i = 0; i < 20; i++) {
    await openPicker(page);
    expect(await hook(page, (h) => [h.live, h.contexts])).toEqual([1, 1]);
    expect((await hook(page, (h) => h.view!.memory())).geometries).toBe(826);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("exercise-picker")).toHaveCount(0);
    expect(await hook(page, (h) => [h.live, h.contexts, h.view])).toEqual([0, 0, null]);
    if (cdp && i === 0) first = await heap();
  }
  if (cdp) expect((await heap()) - first).toBeLessThan(8 * 1024 * 1024);
  // The second and later opens reuse the decoded model.
  expect(await hook(page, (h) => h.stats!.warm)).toBe(true);
});

test("Settings → About credits the 3D model (CC BY-SA 4.0)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const about = page.getByTestId("about");
  await expect(about).toHaveText("3D anatomy model: Body Anatomy 3D Viewer by hpfrei, based on Z-Anatomy, CC BY-SA 4.0.");
  await expect(about.getByRole("link", { name: "Body Anatomy 3D Viewer" })).toHaveAttribute("href", "https://github.com/hpfrei/body-anatomy-3d-viewer");
  await expect(about.getByRole("link", { name: "Z-Anatomy" })).toHaveAttribute("href", "https://www.z-anatomy.com/");
  await expect(about.getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by-sa/4.0/");
});

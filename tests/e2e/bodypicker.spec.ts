import { BODY_AREAS } from "../../worker/lib/bodyAreas";
import { expect, test, type Page } from "./fixtures";
import { resetWorkouts, setOffline, signIn, sql, waitForSynced, goTo, openMore } from "./helpers";

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
    moving(): boolean;
    memory(): { geometries: number; textures: number; programs: number };
  } | null;
}
const hook = <T,>(page: Page, fn: (h: Hook) => T) => page.evaluate(`(${fn.toString()})(window.__anatomy)`) as Promise<T>;
/** Waits for a Front / Back turn or an area move to end; cos(yaw) is 1 facing the front, -1 facing the back. */
async function facing(page: Page, cos: 1 | -1) {
  await expect.poll(() => hook(page, (h) => !h.view!.moving() && Math.cos(h.view!.yaw())), { timeout: 5_000 }).toBeCloseTo(cos, 3);
}

/**
 * Chips fully on screen as the page stands (no scrolling): inside the width, below the top, above the tab bar, at
 * least 44 px tall; returns how many rows they take.
 */
async function chipsVisible(page: Page, testIds: string[]) {
  const width = page.viewportSize()!.width;
  // The active session is full screen (SPEC-v8 §5): no tab bar there, so the chips may reach the bottom.
  const nav = page.getByRole("navigation", { name: "Sections" });
  const navTop = (await nav.count()) ? (await nav.boundingBox())!.y : page.viewportSize()!.height;
  const rows = new Set<number>();
  for (const id of testIds) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.height, id).toBeGreaterThanOrEqual(44);
    expect(b.x, id).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, id).toBeLessThanOrEqual(width);
    expect(b.y, id).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height, id).toBeLessThanOrEqual(navTop);
    rows.add(Math.round(b.y));
  }
  return rows.size;
}
/** All eight area chips on screen at once, in at most two rows. */
const allAreasVisible = async (page: Page) => expect(await chipsVisible(page, BODY_AREAS.map((a) => `area-${a.key}`))).toBeLessThanOrEqual(2);

async function startSession(page: Page) {
  await page.goto("/");
  await page.getByTestId("start").click();
}

async function openPicker(page: Page, mode: "3d" | "fallback" = "3d") {
  await (await openMore(page)).getByTestId("add-exercise").click();
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
  // In the close-up the area's muscle chips replace the area chips.
  await expect(step.getByTestId("area-chips")).toHaveCount(0);
  await chipsVisible(page, ["muscle-biceps", "muscle-triceps", "muscle-forearms"]);
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
  await list.locator(`[data-testid="pick-row"][data-id="oh_tri"] .ex-row__main`).click();
  await expect(page.getByTestId("exercise-picker")).toHaveCount(0);
  const card = page.locator(`[data-testid="ex-card"][data-ex="oh_tri"]`);
  await expect(card).toContainText("Added today");
  await expect(card.locator(".set-row")).toHaveCount(3);
  await waitForSynced(page);
  await expect
    .poll(() => sql("SELECT COUNT(*) AS n, SUM(is_extra) AS extra FROM set_entries WHERE exercise_id = 'oh_tri'"), { timeout: 20_000 })
    .toEqual([{ n: 3, extra: 3 }]);

  // Reopening the picker in the same session returns to the triceps list.
  await (await openMore(page)).getByTestId("add-exercise").click();
  await expect(page.getByTestId("muscle-step")).toHaveAttribute("data-muscle", "triceps");
  await page.getByTestId("pick-back").click();
  await expect(page.getByTestId("body-step")).toHaveAttribute("data-mode", "3d", { timeout: 30_000 });
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("3D: a tap on the body zooms to its area; in the close-up a tap lights the muscle on both sides", async ({ page }) => {
  await startSession(page);
  const step = await openPicker(page);
  const chip = step.getByTestId("anatomy-selection");
  const hint = step.getByTestId("anatomy-hint");

  // A muscle that is not mapped (the forehead), with nothing mapped within 24 px: the tap does nothing.
  const brow = (await hook(page, (h) => h.view!.pointOn("Frontalis muscle", false)))!;
  await expect(hint).toHaveAttribute("data-gone", "false");
  await page.touchscreen.tap(brow.x, brow.y);
  await expect(step).toHaveAttribute("data-area", "");
  await expect(chip).toHaveCount(0);
  // The first touch on the model hides the hint.
  await expect(hint).toHaveAttribute("data-gone", "true");

  // Whole body seen from the back: a tap on the triceps opens the Arms close-up on the same side, nothing chosen yet.
  await step.getByTestId("view-back").click();
  await expect(step.getByTestId("view-back")).toHaveAttribute("aria-pressed", "true");
  await facing(page, -1);
  const far = (await hook(page, (h) => h.view!.pointOn("Long head of triceps brachii")))!;
  expect(far).not.toBeNull();
  await page.touchscreen.tap(far.x, far.y);
  await expect(step).toHaveAttribute("data-area", "arms");
  await facing(page, -1);
  await expect(chip).toHaveCount(0);
  await expect(step.getByTestId("area-chips")).toHaveCount(0);
  await expect(step.getByTestId("muscle-triceps")).toBeVisible();

  // In the close-up a tap on the triceps lights the whole group, left and right.
  const tri = (await hook(page, (h) => h.view!.pointOn("Long head of triceps brachii")))!;
  await page.touchscreen.tap(tri.x, tri.y);
  await expect(chip).toHaveAttribute("data-muscle", "triceps");
  await expect(chip).toContainText("Triceps");
  // The tap stays on the model: WebKit's touch adjustment must not hand it to the Front button nearby.
  await expect(step.getByTestId("view-back")).toHaveAttribute("aria-pressed", "true");
  await facing(page, -1);
  const lit = await hook(page, (h) => h.view!.lit());
  for (const name of ["Long head of triceps brachii", "Lateral head of triceps brachii", "Medial head of triceps brachii", "Anconeus muscle"])
    expect(lit.filter((n) => n === name), name).toHaveLength(2);
  expect(lit).toHaveLength(8);

  // Empty space (the left edge of the stage) clears it.
  const box = (await step.getByTestId("anatomy-canvas").boundingBox())!;
  await page.touchscreen.tap(box.x + 10, box.y + box.height / 2);
  await expect(chip).toHaveCount(0);
  await expect(step).toHaveAttribute("data-area", "arms");

  // A tap just off a muscle's outline still finds the nearest muscle (within 24 px).
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

  // Show exercises opens the list of the lit muscle.
  await page.touchscreen.tap(tri.x, tri.y);
  await expect(chip).toHaveAttribute("data-muscle", "triceps");
  await chip.getByTestId("show-exercises").click();
  await expect(page.getByTestId("muscle-step")).toHaveAttribute("data-muscle", "triceps");
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
  // ← Body goes back to the whole body and its area chips; the muscle is only chosen in a close-up.
  await step.getByTestId("pick-back").click();
  await expect(step).toHaveAttribute("data-area", "");
  await expect(step.getByTestId("anatomy-selection")).toHaveCount(0);
  await allAreasVisible(page);
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("close-up: every area's muscle chips are fully visible above the tab bar, in place of the area chips", async ({ page }) => {
  await startSession(page);
  const step = await openPicker(page);
  for (const a of BODY_AREAS) {
    await step.getByTestId(`area-${a.key}`).click();
    await expect(step).toHaveAttribute("data-area", a.key);
    await expect(step.getByTestId("area-chips")).toHaveCount(0);
    await chipsVisible(page, a.muscles.map((m) => `muscle-${m}`));
    await step.getByTestId("pick-back").click();
    await expect(step).toHaveAttribute("data-area", "");
  }
  await page.getByRole("button", { name: "Cancel" }).click();
});

/**
 * Taps Front or Back and samples the view in every frame drawn over the next 700 ms (a turn takes TURN_MS = 380):
 * whether a turn is running and cos(yaw). Software WebGL draws few frames, so `moving` is the reliable sign of a turn.
 */
const turnFrames = (page: Page, testId: "view-front" | "view-back") =>
  page.evaluate(async (id) => {
    const h = (window as unknown as { __anatomy: Hook }).__anatomy;
    (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).click();
    const seen: { moving: boolean; cos: number }[] = [];
    const end = performance.now() + 700;
    while (performance.now() < end) {
      await new Promise((r) => requestAnimationFrame(r));
      seen.push({ moving: h.view!.moving(), cos: Math.cos(h.view!.yaw()) });
    }
    return seen;
  }, testId);
const between = (frames: { moving: boolean; cos: number }[]) => frames.filter((f) => f.moving || Math.abs(f.cos) < 0.99).length;

test("reduced motion: Front / Back turn the body at once, with no animated turn", async ({ page }) => {
  await startSession(page);
  const step = await openPicker(page);
  await expect(step.getByTestId("anatomy-canvas")).toBeVisible();
  // Control: with motion on, a turn passes through the angles in between.
  expect(between(await turnFrames(page, "view-back"))).toBeGreaterThan(0);
  await facing(page, -1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const frames = await turnFrames(page, "view-front");
  expect(between(frames)).toBe(0);
  expect(frames.at(-1)!.cos).toBeCloseTo(1, 3);
  expect(await hook(page, (h) => h.view!.moving())).toBe(false);
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
  await page.getByTestId("start").click();
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
  await page.getByTestId("continue").click();
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
  await goTo(page, "Settings");
  const about = page.getByTestId("about");
  await expect(about).toHaveText("3D anatomy model: Body Anatomy 3D Viewer by hpfrei, based on Z-Anatomy, CC BY-SA 4.0.");
  await expect(about.getByRole("link", { name: "Body Anatomy 3D Viewer" })).toHaveAttribute("href", "https://github.com/hpfrei/body-anatomy-3d-viewer");
  await expect(about.getByRole("link", { name: "Z-Anatomy" })).toHaveAttribute("href", "https://www.z-anatomy.com/");
  await expect(about.getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by-sa/4.0/");
});

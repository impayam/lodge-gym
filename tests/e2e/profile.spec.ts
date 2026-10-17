import { mkdirSync } from "node:fs";
import { BODY_COLOR } from "./tokens";
import { expect, test, type Page } from "./fixtures";
import { goTo, resetWorkouts, setOffline, settled, signIn, sql } from "./helpers";

// SPEC-v12 M15 (Payam's decisions 2026-10-17): the Profile tab, the shared 3D body, Set goal, body sizes, the Living
// Diamond and the in-app guide camera (SPEC-v10.1).
test.describe.configure({ mode: "serial" });

const denver = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(d);
const SHOTS = "test-results/m15";

/** Goals, sizes and photos back to none. */
function resetProfile() {
  sql("DELETE FROM settings WHERE key IN ('goal_training', 'goal_body', 'goal_set_at', 'week_start'); DELETE FROM body_measurements; DELETE FROM photos");
}

/** A week start that keeps yesterday in this week (Denver time), so a session yesterday is "this week". */
function weekStartWithYesterday() {
  const dow = new Date(`${denver(new Date())}T12:00:00Z`).getUTCDay();
  return dow === 6 ? "mon" : "sat";
}

async function putSession(page: Page, baseURL: string, id: string, date: string, plan: [string, number, number, number][]) {
  const iso = new Date(`${date}T18:00:00Z`).toISOString();
  const sets = plan.flatMap(([ex, n, w, r], k) => Array.from({ length: n }, (_, i) => ({ id: `${id}${k}${String(i).padStart(2, "0")}`, exercise_id: ex, set_index: i, weight: w, reps: r, seconds: null, done: true, rir: null, updated_at: iso })));
  const res = await page.request.put(`${baseURL}/api/sessions/${id}`, {
    headers: { Origin: baseURL },
    data: { id, program_day_id: "D1", local_date: date, started_at: iso, ended_at: new Date(Date.parse(iso) + 3600_000).toISOString(), status: "done", unit: "lb", note: "", created_at: iso, updated_at: iso, source: "app", sets },
  });
  expect(res.status()).toBe(200);
}

/** Today chest and triceps; yesterday squats (quads, and glutes as a secondary). */
async function twoDays(page: Page, baseURL: string) {
  const now = new Date();
  const today = denver(now);
  const yesterday = denver(new Date(now.getTime() - 86_400_000));
  await putSession(page, baseURL, "01PFTODAY", today, [
    ["bench", 4, 135, 8],
    ["rope_pushdown", 3, 40, 12],
  ]);
  await putSession(page, baseURL, "01PFYEST", yesterday, [["squat", 4, 185, 5]]);
}

/** Hides the fixed tab bar and Coach button so a full-page screenshot does not print them mid-page. */
const bars = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    for (const el of document.querySelectorAll<HTMLElement>("nav.tabbar, .fab")) el.style.visibility = h ? "hidden" : "";
  }, hidden);

async function shoot(page: Page, name: string, full = true) {
  mkdirSync(SHOTS, { recursive: true });
  if (full) await bars(page, true);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: full, animations: "disabled" });
  if (full) await bars(page, false);
}

const view = <T,>(page: Page, fn: string) => page.evaluate(`(${fn})(window.__anatomy.view)`) as Promise<T>;

/** Takes WebGL away, so the body falls back to the drawn figures. */
const noWebGL = (page: Page) =>
  page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return /webgl/.test(type) ? null : (get as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof get;
  });

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  resetProfile();
  await signIn(context, baseURL!);
});

test("four tabs; Profile in order; the gear lists Program, Planner, Photos and Settings; Settings opens AI reports and Backup", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav.getByRole("link")).toHaveText(["", "", "", ""]);
  expect(await nav.getByRole("link").evaluateAll((a) => a.map((x) => x.getAttribute("aria-label")))).toEqual(["Train", "History", "Library", "Profile"]);
  await expect(nav).toHaveAttribute("data-tabs", "4");
  await goTo(page, "Profile");
  await expect(nav.getByRole("link", { name: "Profile" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("week-stats")).toBeVisible();
  const ids = await page
    .getByTestId("profile")
    .locator(":scope > section, :scope > [data-testid]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? e.getAttribute("aria-label")));
  expect(ids).toEqual(["after-session", "my-body", "body-weight-card", "my-goal", "week-stats", "session-reports", "before-after", "Details"]);
  await expect(page.getByTestId("after-session")).toContainText("Your first session lights up the body.");

  await page.getByTestId("profile-gear").click();
  const sheet = page.getByTestId("gear-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".list-row .t-title")).toHaveText(["Program", "Planner", "Photos", "Settings"]);
  await settled(sheet);
  await shoot(page, "gear", false);
  await page.getByTestId("gear-program").click();
  await expect(page.getByTestId("program-name")).toBeVisible();
  await page.getByTestId("back").click();
  await goTo(page, "Settings");
  await page.getByTestId("open-ai").click();
  await expect(page.getByTestId("ai-screen")).toBeVisible();
  await page.getByTestId("back").click();
  await page.getByTestId("open-backup").click();
  await expect(page.getByTestId("backup-screen")).toBeVisible();
  await page.getByTestId("back").click();
  await page.getByTestId("back").click();
  await expect(page.getByTestId("profile")).toBeVisible();
});

test("My body: the shared 3D body, today pink, this week violet, the rest dark; the card says this week and today", async ({ page, baseURL }) => {
  sql(`INSERT INTO settings (key, value) VALUES ('week_start', '${weekStartWithYesterday()}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  await page.goto("/");
  await twoDays(page, baseURL!);
  await page.reload();
  await goTo(page, "Profile");
  const stage = page.getByTestId("body3d");
  await expect(stage).toHaveAttribute("data-mode", "3d", { timeout: 30_000 });
  const color = (m: string) => view<string | null>(page, `(v) => v.colorOf(${JSON.stringify(m)})`);
  expect(await color("chest")).toBe(BODY_COLOR.today);
  expect(await color("triceps")).toBe(BODY_COLOR.today);
  expect(await color("quads")).toBe(BODY_COLOR.week);
  expect(await color("calves")).toBe(BODY_COLOR.rest);
  expect(await color("unmapped")).toBe("#3b2725");
  await expect(page.getByTestId("body-legend")).toContainText("Today");
  await expect(page.getByTestId("after-session")).toContainText("After today: Chest and triceps lit up.");

  // A tap zooms to the area; in the close-up the card has the group's sets this week and today.
  await stage.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70));
  const settle = () => expect.poll(() => view<boolean>(page, "(v) => v.moving()"), { timeout: 5_000 }).toBe(false);
  await settle();
  const at = () => view<{ x: number; y: number } | null>(page, `(v) => v.pointOn("Sternocostal head of pectoralis major muscle")`);
  const p1 = (await at())!;
  await page.touchscreen.tap(p1.x, p1.y);
  await expect(stage).toHaveAttribute("data-area", "chest");
  await settle();
  const p2 = (await at())!;
  await page.touchscreen.tap(p2.x, p2.y);
  const card = page.getByTestId("body3d-card");
  await expect(card).toHaveAttribute("data-state", "today");
  await expect(card).toContainText("Chest");
  await expect(card).toContainText("4 sets this week, 4 today");
  await shoot(page, "my-body", false);
});

test("My body without WebGL: the drawn figures in the same tints", async ({ page, baseURL }) => {
  sql(`INSERT INTO settings (key, value) VALUES ('week_start', '${weekStartWithYesterday()}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  await noWebGL(page);
  await page.goto("/");
  await twoDays(page, baseURL!);
  await page.reload();
  await goTo(page, "Profile");
  await expect(page.getByTestId("anatomy-fallback")).toContainText("3D unavailable");
  const fig = page.getByTestId("body-figures");
  await expect(fig.locator('path.body-region[data-muscle="chest"]').first()).toHaveAttribute("data-tint", "--pink");
  await expect(fig.locator('path.body-region[data-muscle="quads"]').first()).toHaveAttribute("data-tint", "--violet");
  await expect(fig.locator('path.body-region[data-muscle="calves"]').first()).toHaveAttribute("data-tint", "--model-none");
  await fig.locator('path.body-region[data-muscle="quads"]').first().click();
  await expect(page.getByTestId("body3d-card")).toContainText("4 sets this week, 0 today");
});

test("Set goal: the empty diamond first; corners and chips choose up to two; Save changes nothing in the program; Ask Coach asks for a program", async ({ page, baseURL }) => {
  await page.goto("/");
  await goTo(page, "Profile");
  await expect(page.getByTestId("set-goal-open")).toHaveText("Set goal");
  await expect(page.getByTestId("living-diamond").getByTestId("diamond-now")).toHaveCount(0);
  await page.getByTestId("my-goal").scrollIntoViewIfNeeded();
  await shoot(page, "goal-empty", false);
  const programs = sql("SELECT COUNT(*) AS n FROM programs") as { n: number }[];

  await page.getByTestId("set-goal-open").click();
  await expect(page.getByTestId("set-goal")).toBeVisible();
  await expect(page.getByTestId("goal-save")).toBeDisabled();
  await page.getByTestId("corner-growth").click();
  await page.getByTestId("goal-chip-strength").click();
  await expect(page.getByTestId("corner-growth")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("goal-chip-strength")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("goal-meaning")).toHaveText("Main lifts 3–5 heavy reps, accessories 8–15 near failure.");
  // A third pick replaces the oldest.
  await page.getByTestId("corner-endurance").click();
  await expect(page.getByTestId("goal-chip-growth")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("goal-chip-growth").click();
  await expect(page.getByTestId("goal-chip-strength")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("goal-chip-endurance").click();
  await page.getByTestId("goal-chip-strength").click();
  await expect(page.getByTestId("goal-meaning")).toHaveText("Main lifts 3–5 heavy reps, accessories 8–15 near failure.");
  await page.getByTestId("goal-body-gain").click();
  await shoot(page, "set-goal");
  await page.getByTestId("goal-save").click();
  await expect(page.getByTestId("goal-saved")).toContainText("Your program stays as it is.");
  await expect.poll(() => sql("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'goal_%'"), { timeout: 15_000 }).toEqual([{ n: 3 }]);
  const rows = Object.fromEntries((sql("SELECT key, value FROM settings WHERE key LIKE 'goal_%'") as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  expect(JSON.parse(rows.goal_training)).toEqual(["growth", "strength"]);
  expect(rows.goal_body).toBe("gain");
  expect(rows.goal_set_at).toMatch(/T/);
  expect(sql("SELECT COUNT(*) AS n FROM programs")).toEqual(programs);

  // Ask Coach: the message carries the goal-program flag (the CONTEXT block then says he asked for a program).
  const sent = page.waitForRequest((r) => /\/api\/coach\/threads\/[^/]+\/messages$/.test(r.url()) && r.method() === "POST");
  await page.getByTestId("goal-ask-coach").click();
  const body = (await sent).postDataJSON() as { text: string; goal_program?: boolean };
  expect(body.goal_program).toBe(true);
  expect(body.text).toContain("Growth + Strength, Gain");
  void baseURL;
});

test("Living Diamond: four corners with numbers (Power 0, no data), the dashed ghost, panels open and close", async ({ page, baseURL }) => {
  sql(
    `INSERT INTO settings (key, value) VALUES ('goal_training', '["growth","strength"]'), ('goal_body', 'gain'), ('goal_set_at', '${new Date().toISOString()}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`
  );
  await page.goto("/");
  await twoDays(page, baseURL!);
  await page.reload();
  await goTo(page, "Profile");
  const d = page.getByTestId("living-diamond");
  await expect(d.getByTestId("diamond-now")).toBeVisible();
  await expect(d.getByTestId("diamond-ghost")).toBeVisible();
  for (const g of ["growth", "strength", "endurance", "power"]) await expect(d.getByTestId(`corner-value-${g}`)).not.toBeEmpty();
  await expect(d.getByTestId("corner-value-power")).toHaveText("0 · No data");
  await expect(d.getByTestId("diamond-center")).toHaveText("GAIN");
  await expect(page.getByTestId("goal-caption")).toContainText("Growth + Strength · Gain");
  await expect(page.getByTestId("body-goal").locator(".badge")).toHaveText("GAIN");

  await d.getByTestId("corner-strength").click();
  await expect(page.getByTestId("panel-strength")).toContainText("Bench");
  await expect(page.getByTestId("main-lifts-table")).toBeVisible();
  await page.getByTestId("my-goal").scrollIntoViewIfNeeded();
  await shoot(page, "diamond-strength", false);
  await d.getByTestId("corner-power").click();
  await expect(page.getByTestId("panel-power")).toContainText("no data");
  await expect(page.getByTestId("panel-strength")).toHaveCount(0);
  await d.getByTestId("corner-power").click();
  await expect(page.getByTestId("panel-power")).toHaveCount(0);
  await d.getByTestId("corner-growth").click();
  await expect(page.getByTestId("panel-growth")).toContainText("of 30 regions trained this week");
  await shoot(page, "profile-full");
});

test("Sizes: Log sizes saves any fields offline, tiles show the latest and the change, All sizes deletes", async ({ page, context }) => {
  await page.goto("/");
  await goTo(page, "Profile");
  await setOffline(context, page, true);
  const log = async (date: string, values: Record<string, string>) => {
    await page.getByTestId("my-body").getByTestId("sizes-log").click();
    const sheet = page.getByTestId("sizes-sheet");
    await expect(sheet).toBeVisible();
    await settled(sheet);
    await sheet.locator("#size-date").fill(date);
    for (const [f, v] of Object.entries(values)) await sheet.getByTestId(`size-${f}`).fill(v);
    await sheet.getByTestId("sizes-save").click();
    await expect(sheet).toHaveCount(0);
  };
  const today = denver(new Date());
  const earlier = denver(new Date(Date.now() - 14 * 86_400_000));
  await log(earlier, { arm: "38", chest: "101" });
  // Persian digits are accepted.
  await log(today, { arm: "۳۸٫۵", waist: "84" });
  const tiles = page.getByTestId("size-tiles");
  await expect(tiles.locator('[data-size="arm"]')).toContainText("38.5");
  await expect(tiles.locator('[data-size="arm"]')).toContainText("▲0.5");
  await expect(tiles.locator('[data-size="chest"]')).toContainText("101");
  await expect(tiles.locator('[data-size="waist"]')).toContainText("84");
  await page.getByTestId("my-body").scrollIntoViewIfNeeded();
  await shoot(page, "sizes", false);
  expect(sql("SELECT COUNT(*) AS n FROM body_measurements")).toEqual([{ n: 0 }]);
  await setOffline(context, page, false);
  await expect.poll(() => sql("SELECT local_date, arm_cm, waist_cm FROM body_measurements ORDER BY local_date"), { timeout: 15_000 }).toEqual([
    { local_date: earlier, arm_cm: 38, waist_cm: null },
    { local_date: today, arm_cm: 38.5, waist_cm: 84 },
  ]);

  // A wrong value is refused with the field named.
  await page.getByTestId("my-body").getByTestId("sizes-log").click();
  await page.getByTestId("size-calf").fill("4");
  await page.getByTestId("sizes-save").click();
  await expect(page.getByTestId("sizes-sheet")).toContainText("Calf: enter 10–300 cm.");
  await page.keyboard.press("Escape");

  await page.getByTestId("sizes-all").click();
  await expect(page.getByTestId("size-row")).toHaveCount(2);
  const del = page.getByTestId("size-row").first().getByTestId("size-delete");
  await del.click();
  await expect(del).toHaveText("Sure? Delete");
  await del.click();
  await expect(page.getByTestId("size-row")).toHaveCount(1);
  await expect.poll(() => sql("SELECT COUNT(*) AS n FROM body_measurements WHERE deleted_at IS NULL"), { timeout: 15_000 }).toEqual([{ n: 1 }]);
});

/** A fake camera (a moving canvas) and a motion sensor the test can tilt. */
const fakeCamera = (page: Page) =>
  page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 640;
    const ctx = canvas.getContext("2d")!;
    let t = 0;
    setInterval(() => {
      t++;
      ctx.fillStyle = `rgb(${(t * 3) % 255}, 90, 140)`;
      ctx.fillRect(0, 0, 480, 640);
      ctx.fillStyle = "rgb(240, 240, 240)";
      ctx.fillRect(200, 80 + (t % 10), 80, 480);
    }, 50);
    const w = window as unknown as { __cameraCalls: unknown[]; DeviceOrientationEvent: unknown };
    w.__cameraCalls = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (c: unknown) => {
          w.__cameraCalls.push(c);
          return (canvas as unknown as { captureStream(fps: number): MediaStream }).captureStream(20);
        },
      },
    });
    w.DeviceOrientationEvent = class {
      static requestPermission = async () => "granted";
    };
  });

const tiltTo = (page: Page, beta: number) =>
  page.evaluate((b) => {
    const e = new Event("deviceorientation");
    Object.defineProperty(e, "beta", { value: b });
    window.dispatchEvent(e);
  }, beta);

test("guide camera: outline with head and feet lines, level, timer, burst of 3, keep one; settings remembered per pose", async ({ page }) => {
  await fakeCamera(page);
  await page.goto("/");
  await goTo(page, "Profile");
  await page.getByTestId("profile-take-photo").click();
  const cam = page.getByTestId("guide-camera");
  await expect(cam).toBeVisible();
  await expect(cam.getByTestId("camera-tips")).toBeVisible();
  await cam.getByTestId("camera-tips-ok").click();
  await expect(cam.getByTestId("camera-live")).toHaveAttribute("data-phase", "live");
  for (const p of ["front", "side", "back"]) {
    await cam.getByTestId(`camera-pose-${p}`).click();
    await expect(cam.getByTestId("camera-live")).toHaveAttribute("data-pose", p);
    // A horizontal line has no height, so Playwright never calls it visible: its place is checked instead.
    const head = Number(await cam.getByTestId("camera-head-line").getAttribute("y1"));
    const feet = Number(await cam.getByTestId("camera-feet-line").getAttribute("y1"));
    expect(head).toBeGreaterThan(0);
    expect(feet).toBeGreaterThan(head + 250);
    expect(feet).toBeLessThan(400);
    await expect(cam.getByTestId("camera-outline")).toBeVisible();
    await settled(cam);
    await shoot(page, `camera-${p}`, false);
  }
  // No earlier photo: no ghost.
  await expect(cam.getByTestId("camera-ghost-toggle")).toBeDisabled();

  // The level: violet when upright, a warning past 3°.
  await cam.getByTestId("camera-level-on").click();
  await expect(cam.getByTestId("camera-level")).toHaveAttribute("data-level", "none");
  await tiltTo(page, 89);
  await expect(cam.getByTestId("camera-level")).toHaveAttribute("data-level", "level");
  await tiltTo(page, 84);
  await expect(cam.getByTestId("camera-level")).toHaveAttribute("data-level", "tilted");
  await expect(cam.getByTestId("camera-tilt-warning")).toContainText("6°");
  await tiltTo(page, 90);

  // Side pose: 3 s timer, then a burst of 3; keep the second.
  await cam.getByTestId("camera-pose-side").click();
  await cam.getByTestId("camera-timer-3").click();
  await cam.getByTestId("camera-shutter").click();
  await expect(cam.getByTestId("camera-count")).toHaveText("3");
  await expect(cam.getByTestId("camera-pick").getByTestId("camera-shot")).toHaveCount(3, { timeout: 10_000 });
  await shoot(page, "camera-pick", false);
  await cam.getByTestId("camera-shot").nth(1).click();
  await expect(cam).toHaveCount(0);
  await expect.poll(() => sql("SELECT pose FROM photos"), { timeout: 20_000 }).toEqual([{ pose: "side" }]);

  // Opening again: the side pose with its 3 s timer and, now, its ghost.
  await page.getByTestId("profile-take-photo").click();
  await expect(cam.getByTestId("camera-live")).toHaveAttribute("data-pose", "side");
  await expect(cam.getByTestId("camera-timer-3")).toHaveAttribute("aria-pressed", "true");
  await expect(cam.getByTestId("camera-ghost")).toBeVisible();
  await cam.getByTestId("camera-pose-front").click();
  await expect(cam.getByTestId("camera-timer-5")).toHaveAttribute("aria-pressed", "true");
});

test("guide camera: without camera access, a clear note and the iPhone camera instead", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => Promise.reject(new DOMException("no", "NotAllowedError")) } });
  });
  await page.goto("/");
  await goTo(page, "Profile");
  await page.getByTestId("profile-take-photo").click();
  await expect(page.getByTestId("camera-error")).toContainText("Camera access is off");
  await expect(page.getByTestId("camera-native")).toBeAttached();
});

test("Details: closed by default; Week, Month and All hold the old Reports; the current week's tiles are This week", async ({ page }) => {
  await page.goto("/");
  await goTo(page, "Profile");
  await expect(page.getByTestId("profile-details")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("reports")).toHaveCount(0);
  await goTo(page, "Reports");
  await expect(page.getByTestId("main-lifts")).toBeVisible();
  await expect(page.getByTestId("reports").getByTestId("week-stats")).toHaveCount(0);
  await expect(page.getByTestId("profile").getByTestId("week-stats")).toHaveCount(1);
  await page.getByRole("button", { name: "Previous week" }).click();
  await expect(page.getByTestId("reports").getByTestId("week-stats")).toBeVisible();
  await page.getByRole("tab", { name: "All" }).click();
  await expect(page.getByTestId("muscle-map")).toBeVisible();
  await expect(page.getByTestId("muscle-map").locator("canvas")).toHaveCount(0);
});

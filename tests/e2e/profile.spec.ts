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

/** Takes WebGL away (until `window.__giveWebGL = true`), so the body falls back to the note and Retry. */
const noWebGL = (page: Page) =>
  page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      const off = /webgl/.test(type) && !(window as { __giveWebGL?: boolean }).__giveWebGL;
      return off ? null : (get as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
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
  await expect(sheet.locator(".list-row .t-title")).toHaveText(["Program", "Planner", "My training", "Photos", "Settings"]);
  await expect(page.getByTestId("profile-gear")).toHaveAccessibleName("More: Program, Planner, My training, Photos, Settings");
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

test("My body without WebGL: only the 3D unavailable note and Retry, no drawn figure; Retry loads the 3D body", async ({ page, baseURL }) => {
  sql(`INSERT INTO settings (key, value) VALUES ('week_start', '${weekStartWithYesterday()}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  await noWebGL(page);
  await page.goto("/");
  await twoDays(page, baseURL!);
  await page.reload();
  await goTo(page, "Profile");
  const body = page.getByTestId("my-body");
  await expect(body.getByTestId("anatomy-fallback")).toContainText("3D unavailable.");
  await expect(body.getByTestId("anatomy-retry")).toBeVisible();
  // No drawn front / back figure anywhere, no legend of a body that is not shown.
  await expect(page.locator("svg path.body-region, .body-figure, [data-testid='body-figures']")).toHaveCount(0);
  await expect(body.getByTestId("body-legend")).toHaveCount(0);
  await expect(body.locator("canvas")).toHaveCount(0);
  await body.scrollIntoViewIfNeeded();
  await shoot(page, "my-body-fallback", false);
  // Retry with WebGL back: the 3D body loads in place.
  await page.evaluate(() => ((window as { __giveWebGL?: boolean }).__giveWebGL = true));
  await body.getByTestId("anatomy-retry").click();
  await expect(body.getByTestId("body3d")).toHaveAttribute("data-mode", "3d", { timeout: 20_000 });
  await expect(body.getByTestId("anatomy-fallback")).toHaveCount(0);
  await expect(body.getByTestId("body-legend")).toBeVisible();
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

/**
 * A stand-in for the pose model (the fake camera shows no real body): 33 landmarks of a body standing on the default
 * guide lines, full body (head 0.07, soles 0.93) or upper body (head 0.10, waist 0.90, ankles out of view), or too
 * close, or off centre; "none" finds nobody. Switched with `window.__poseMode`.
 */
const fakePose = (page: Page, mode: "full" | "upper" | "near" | "right" | "none" = "full") =>
  page.addInitScript((start) => {
    const w = window as unknown as { __poseMode: string; __poseFake: (c: HTMLCanvasElement) => { x: number; y: number; visibility: number }[] | null };
    w.__poseMode = start;
    w.__poseFake = () => {
      const m = w.__poseMode;
      if (m === "none") return null;
      const upper = m === "upper";
      const top = upper ? 0.1 : m === "near" ? 0.02 : 0.07;
      const h = upper ? 0.8 / 0.42 : m === "near" ? 0.98 : 0.86;
      const cx = m === "right" ? 0.64 : 0.5;
      const lms = Array.from({ length: 33 }, () => ({ x: cx, y: top + 0.5 * h, visibility: 0.9 }));
      const at = (i: number, dx: number, y: number, v = 0.9) => (lms[i] = { x: cx + dx, y: top + y * h, visibility: v });
      at(0, 0, 0.075);
      at(11, 0.06, 0.185);
      at(12, -0.06, 0.185);
      at(23, 0.04, 0.5);
      at(24, -0.04, 0.5);
      for (const [i, dx, y] of [
        [27, 0.03, 0.96],
        [28, -0.03, 0.96],
        [29, 0.03, 0.985],
        [30, -0.03, 0.985],
        [31, 0.04, 1],
        [32, -0.04, 1],
      ])
        at(i, dx, y, upper ? 0.1 : 0.9);
      return lms;
    };
  }, mode);

const poseMode = (page: Page, mode: "full" | "upper" | "near" | "right" | "none") => page.evaluate((m) => ((window as unknown as { __poseMode: string }).__poseMode = m), mode);

const tiltTo = (page: Page, beta: number) =>
  page.evaluate((b) => {
    const e = new Event("deviceorientation");
    Object.defineProperty(e, "beta", { value: b });
    window.dispatchEvent(e);
  }, beta);

test("guide camera: outline with head and feet lines, level, timer, burst of 3, keep one; settings remembered per pose", async ({ page }) => {
  await fakeCamera(page);
  await fakePose(page, "full");
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
    await expect(cam.getByTestId("camera-hint")).toHaveAttribute("data-hint", "ok");
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
  // Each shot says how it sits on the lines.
  await expect(cam.getByTestId("camera-shot").nth(1)).toHaveAttribute("data-hint", "ok");
  await expect(cam.getByTestId("camera-shot").nth(1)).toHaveAttribute("data-framing", "full");
  await expect(cam.getByTestId("camera-shot-hint").nth(1)).toHaveText("On the lines.");
  await cam.getByTestId("camera-shot").nth(1).click();
  await expect(cam).toHaveCount(0);
  await expect.poll(() => sql("SELECT pose, framing FROM photos"), { timeout: 20_000 }).toEqual([{ pose: "side", framing: "full" }]);

  // Opening again: the side pose with its 3 s timer and, now, its ghost.
  await page.getByTestId("profile-take-photo").click();
  await expect(cam.getByTestId("camera-live")).toHaveAttribute("data-pose", "side");
  await expect(cam.getByTestId("camera-timer-3")).toHaveAttribute("aria-pressed", "true");
  await expect(cam.getByTestId("camera-ghost")).toBeVisible();
  await cam.getByTestId("camera-pose-front").click();
  await expect(cam.getByTestId("camera-timer-5")).toHaveAttribute("aria-pressed", "true");
});

test("guide camera: the pose check finds the framing (ankles in frame: full body, else upper body) and switches the lines, outline, ghost and saved framing; hints before keeping", async ({ page }) => {
  sql("DELETE FROM photos");
  await page.addInitScript(() => localStorage.setItem("camera:tips", "1"));
  await fakeCamera(page);
  await fakePose(page, "full");
  await page.goto("/");
  await goTo(page, "Profile");
  await page.getByTestId("profile-take-photo").click();
  const cam = page.getByTestId("guide-camera");
  const live = cam.getByTestId("camera-live");
  await expect(live).toHaveAttribute("data-phase", "live");
  await cam.getByTestId("camera-pose-front").click();
  await expect(live).toHaveAttribute("data-check", "ready");
  await expect(live).toHaveAttribute("data-framing", "full");
  await expect(cam.getByTestId("camera-framing")).toHaveText("Full body");
  await expect(cam.getByTestId("camera-feet-line")).toHaveCount(1);
  await expect(cam.getByTestId("camera-waist-line")).toHaveCount(0);
  const fullOutline = await cam.getByTestId("camera-outline").locator("path").getAttribute("d");
  await expect(cam.getByTestId("camera-hint")).toHaveText("On the lines.");
  await settled(cam);
  await shoot(page, "camera-full-body", false);

  // Too close, then off centre: one hint at a time.
  await poseMode(page, "near");
  await expect(cam.getByTestId("camera-hint")).toHaveAttribute("data-hint", "back");
  await expect(cam.getByTestId("camera-hint")).toHaveText("Step back a bit: head and feet on the lines.");
  await poseMode(page, "right");
  await expect(cam.getByTestId("camera-hint")).toHaveAttribute("data-hint", "left");

  // A mirror shot (ankles out of view): after three readings in a row the guide becomes head and waist.
  await poseMode(page, "upper");
  await expect(live).toHaveAttribute("data-framing", "upper", { timeout: 5_000 });
  await expect(cam.getByTestId("camera-framing")).toHaveText("Upper body");
  await expect(cam.getByTestId("camera-waist-line")).toHaveCount(1);
  await expect(cam.getByTestId("camera-feet-line")).toHaveCount(0);
  expect(await cam.getByTestId("camera-outline").locator("path").getAttribute("d")).not.toBe(fullOutline);
  await expect(cam.getByTestId("camera-hint")).toHaveText("On the lines.");
  // Each framing keeps its own line size: the upper guide's starts at 80 %.
  await expect(cam.getByTestId("camera-scale")).toHaveValue("80");
  await settled(cam);
  await shoot(page, "camera-upper-body", false);

  // Keep an upper-body front photo: saved with its framing.
  await cam.getByTestId("camera-timer-0").click();
  await cam.getByTestId("camera-shutter").click();
  await expect(cam.getByTestId("camera-shot")).toHaveCount(3, { timeout: 10_000 });
  await expect(cam.getByTestId("camera-shot").first()).toHaveAttribute("data-framing", "upper");
  await cam.getByTestId("camera-shot").first().click();
  await expect(cam).toHaveCount(0);
  await expect.poll(() => sql("SELECT pose, framing FROM photos"), { timeout: 20_000 }).toEqual([{ pose: "front", framing: "upper" }]);

  // Next time the front pose opens in upper body (its saved framing) with that photo as the ghost; a full-body
  // reading switches the guide back, and the upper-body photo is no ghost for a full-body one.
  await poseMode(page, "upper");
  await page.getByTestId("profile-take-photo").click();
  await expect(live).toHaveAttribute("data-framing", "upper");
  await expect(cam.getByTestId("camera-ghost")).toBeVisible();
  await poseMode(page, "full");
  await expect(live).toHaveAttribute("data-framing", "full", { timeout: 5_000 });
  await expect(cam.getByTestId("camera-ghost")).toHaveCount(0);
  await expect(cam.getByTestId("camera-ghost-toggle")).toBeDisabled();

  // Nobody in the frame: the hint says so and the framing stays.
  await poseMode(page, "none");
  await expect(cam.getByTestId("camera-hint")).toHaveText("No one in the frame yet.");
  await expect(live).toHaveAttribute("data-framing", "full");
  // A shot without a body is kept with the framing the check held.
  await cam.getByTestId("camera-timer-0").click();
  await cam.getByTestId("camera-shutter").click();
  await expect(cam.getByTestId("camera-shot")).toHaveCount(3, { timeout: 10_000 });
  await expect(cam.getByTestId("camera-shot").first()).toHaveAttribute("data-framing", "full");
  await expect(cam.getByTestId("camera-shot-hint")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Before · After pairs only photos of the same pose and the same framing", async ({ page }) => {
  const add = (id: string, daysAgo: number, pose: string, framing: string | null) =>
    sql(
      `INSERT INTO photos (id, session_id, local_date, pose, framing, r2_key, thumb_r2_key, width, height, bytes, created_at) VALUES ('${id}', NULL, date('now', '-${daysAgo} days'), '${pose}', ${framing ? `'${framing}'` : "NULL"}, 'photos/${id}/full.jpg', 'photos/${id}/thumb.jpg', 1200, 1600, 1, '${new Date().toISOString()}')`
    );
  sql("DELETE FROM photos");
  add("01BAFULL0000000000000000A1", 30, "front", "full");
  add("01BAUPPR0000000000000000A2", 20, "front", "upper");
  add("01BALIBR0000000000000000A3", 10, "front", null);
  await page.goto("/");
  await goTo(page, "Profile");
  const card = page.getByTestId("before-after");
  // Three front photos, each framed differently: nothing to compare.
  await expect(card).toContainText("Two photos of the same pose and framing show here side by side.");
  add("01BAUPPR0000000000000000A4", 2, "front", "upper");
  await page.reload();
  await goTo(page, "Profile");
  await expect(card.locator(".card__head .caption")).toHaveText("Front · Upper body · 18 days apart");
  await expect(card.getByRole("img", { name: /^Before: Front/ })).toHaveCount(1);
  sql("DELETE FROM photos");
});

test("guide camera with the real pose model: loads from the app's own files under the CSP, finds a full body, then an upper body", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  // A human figure for the camera: the app's own 3D body, rendered whole (front) and captured.
  await page.goto("/");
  await goTo(page, "Profile");
  const stage = page.getByTestId("body3d");
  await expect(stage).toHaveAttribute("data-mode", "3d", { timeout: 60_000 });
  await expect.poll(() => view<boolean>(page, "(v) => v.moving()"), { timeout: 10_000 }).toBe(false);
  const figure = `data:image/png;base64,${(await stage.locator("canvas").screenshot()).toString("base64")}`;

  // Anything the CSP refuses (scripts, WebAssembly, fetches). Playwright's screenshots add a style element of their own
  // (to hide the caret), which the CSP refuses too: that one is not the app's.
  const blocked: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()) && !/Refused to apply a stylesheet/.test(m.text())) blocked.push(m.text());
  });
  // Every file comes from the app itself (no CDN): the model, the WebAssembly runtime and its loader.
  const origin = new URL(baseURL!).origin;
  const outside: string[] = [];
  const pose: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:")) outside.push(u);
    if (/\/pose\/|vision_wasm|poseModel/.test(u)) pose.push(new URL(u).pathname);
  });
  // The camera films the figure: whole, as when someone else takes the photo, or from the head to below the waist,
  // as in a mirror (`window.__camMode`).
  await page.addInitScript((src) => {
    localStorage.setItem("camera:tips", "1");
    const w = window as unknown as { __camMode: "full" | "upper" };
    w.__camMode = "full";
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 640;
    const ctx = canvas.getContext("2d")!;
    const img = new Image();
    img.src = src;
    setInterval(() => {
      ctx.fillStyle = "rgb(30, 30, 30)";
      ctx.fillRect(0, 0, 480, 640);
      if (!img.complete || !img.height) return;
      const k = (w.__camMode === "full" ? 600 : 1400) / img.height;
      ctx.drawImage(img, (480 - img.width * k) / 2, w.__camMode === "full" ? 20 : 40, img.width * k, img.height * k);
    }, 50);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => (canvas as unknown as { captureStream(fps: number): MediaStream }).captureStream(20) } });
  }, figure);
  await page.goto("/");
  await goTo(page, "Profile");
  await page.getByTestId("profile-take-photo").click();
  const cam = page.getByTestId("guide-camera");
  const live = cam.getByTestId("camera-live");
  await expect(live).toHaveAttribute("data-phase", "live");
  await expect(live).toHaveAttribute("data-check", "ready", { timeout: 90_000 });
  expect(await page.evaluate(() => (window as unknown as { __pose: { model: boolean } }).__pose.model)).toBe(true);
  await expect(live).toHaveAttribute("data-framing", "full", { timeout: 10_000 });
  await expect(cam.getByTestId("camera-feet-line")).toHaveCount(1);
  await expect(cam.getByTestId("camera-hint")).not.toHaveAttribute("data-hint", "none", { timeout: 10_000 });
  await settled(cam);
  await shoot(page, "camera-real-full-body", false);

  await page.evaluate(() => ((window as unknown as { __camMode: string }).__camMode = "upper"));
  await expect(live).toHaveAttribute("data-framing", "upper", { timeout: 15_000 });
  await expect(cam.getByTestId("camera-waist-line")).toHaveCount(1);
  await expect(cam.getByTestId("camera-framing")).toHaveText("Upper body");
  await expect(cam.getByTestId("camera-hint")).not.toHaveAttribute("data-hint", "none");
  await shoot(page, "camera-real-upper-body", false);
  expect(await page.evaluate(() => (window as unknown as { __pose: { runs: number } }).__pose.runs)).toBeGreaterThan(5);

  expect(blocked).toEqual([]);
  expect(outside).toEqual([]);
  expect(pose).toEqual(expect.arrayContaining(["/pose/pose_landmarker_lite.task", expect.stringMatching(/^\/assets\/vision_wasm_internal-[\w-]+\.wasm$/), expect.stringMatching(/^\/assets\/vision_wasm_internal-[\w-]+\.js$/)]));
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

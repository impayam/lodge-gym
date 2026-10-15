import { expect, test, type Page } from "./fixtures";
import { goTo, resetWorkouts, signIn, sql } from "./helpers";

// SPEC-v8 §7: every list and chart has a loading state (skeleton in card shape), an empty state (one line + action) and
// an error state (what failed + Retry). Requests are held or failed with page.route, so the service worker is blocked
// in this file (it would answer them before the route sees them).
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

const SERVER_ERROR = { status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message_fa: "Something went wrong on the server." } }) };

test.beforeEach(async ({ context, baseURL }) => {
  resetWorkouts();
  await signIn(context, baseURL!);
});
test.afterAll(() => resetWorkouts());

/** Holds every matching request until the returned function is called. */
async function hold(page: Page, url: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(url, async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

test("library: card-shaped skeletons while the first load runs, then the rows", async ({ page }) => {
  const release = await hold(page, "**/api/exercises");
  await page.goto("/");
  await goTo(page, "Library");
  const loading = page.getByRole("status", { name: "Loading the library" });
  await expect(loading).toBeVisible();
  expect(await loading.locator(".skeleton").count()).toBeGreaterThan(0);
  release();
  await expect(page.getByTestId("library-row").first()).toBeVisible();
  await expect(loading).toHaveCount(0);
});

test("library: a failed first load says what failed and why; Retry loads it", async ({ page }) => {
  await page.route("**/api/exercises", (r) => r.fulfill(SERVER_ERROR));
  await page.goto("/");
  await goTo(page, "Library");
  const err = page.getByTestId("load-error");
  await expect(err).toContainText("Couldn't load the exercise library.");
  await expect(err).toContainText("Something went wrong on the server.");
  await page.unroute("**/api/exercises");
  await err.getByTestId("retry").click();
  await expect(page.getByTestId("library-row").first()).toBeVisible();
  await expect(page.getByTestId("load-error")).toHaveCount(0);
});

test("library: no match offers to clear the search and filters", async ({ page }) => {
  await page.goto("/");
  await goTo(page, "Library");
  await expect(page.getByTestId("library-row").first()).toBeVisible();
  await page.getByPlaceholder("Search exercises").fill("zzzz qqqq");
  await expect(page.getByText("No exercise matches.")).toBeVisible();
  await expect(page.getByTestId("library-row")).toHaveCount(0);
  await page.getByTestId("library-clear").click();
  await expect(page.getByPlaceholder("Search exercises")).toHaveValue("");
  await expect(page.getByTestId("library-row").first()).toBeVisible();
});

test("reports: an offline report load says so; Retry loads the week", async ({ page }) => {
  await page.route("**/api/reports/week*", (r) => r.abort("internetdisconnected"));
  await page.goto("/");
  await goTo(page, "Reports");
  const err = page.getByTestId("load-error").filter({ hasText: "Couldn't load this week's report." });
  await expect(err).toContainText("No internet connection.");
  await page.unroute("**/api/reports/week*");
  await err.getByTestId("retry").click();
  await expect(page.getByTestId("week-stats")).toBeVisible();
  await expect(page.getByTestId("load-error").filter({ hasText: "this week's report" })).toHaveCount(0);
});

test("history: with no sessions the empty line leads to Train; a failed full-history load shows Retry", async ({ page }) => {
  await page.route("**/api/sessions", (r) => (r.request().method() === "GET" ? r.fulfill(SERVER_ERROR) : r.continue()));
  await page.goto("/");
  await goTo(page, "History");
  const err = page.getByTestId("load-error").filter({ hasText: "Couldn't load your sessions." });
  await expect(err).toContainText("Something went wrong on the server.");
  await page.unroute("**/api/sessions");
  await err.getByTestId("retry").click();
  await expect(page.getByText("No sessions yet. Finished sessions show up here.")).toBeVisible();
  await page.getByTestId("history-empty-train").click();
  await expect(page.getByTestId("next-card")).toBeVisible();
});

test("photos and backups: failed loads say what failed; Retry loads them", async ({ page }) => {
  // Other specs leave photos behind; after Retry this one expects the empty line.
  sql("DELETE FROM photos");
  let photoLoads = 0;
  await page.route("**/api/photos", (r) => {
    photoLoads++;
    return r.abort("internetdisconnected");
  });
  await page.route("**/api/backups", (r) => r.fulfill(SERVER_ERROR));
  await page.goto("/");

  await goTo(page, "Photos");
  // Me's photo card loads them on the way, then the Photos screen loads them again: wait for that second failure.
  await expect.poll(() => photoLoads).toBe(2);
  const photos = page.getByTestId("photos").getByTestId("load-error").filter({ hasText: "Couldn't load your photos." });
  await expect(photos).toContainText("No internet connection.");
  await page.unroute("**/api/photos");
  await photos.getByTestId("retry").click();
  await expect(page.getByText("No photos yet. After each session you can take a front, side and back photo.")).toBeVisible();

  await goTo(page, "Backup");
  const backups = page.getByTestId("backup-screen").getByTestId("load-error").filter({ hasText: "Couldn't load your backups." });
  await expect(backups).toContainText("Something went wrong on the server.");
  await page.unroute("**/api/backups");
  await backups.getByTestId("retry").click();
  await expect(page.getByTestId("last-backup")).toBeVisible();
});

import { expect, test } from "@playwright/test";
import { resetWorkouts, sql } from "./helpers";

// Passkey ceremonies need a virtual authenticator (CDP), so this runs on Chromium only.
test.describe.configure({ mode: "serial" });

test("first-run setup, recovery codes, /setup closes, logout and Face ID login", async ({ page, context, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "virtual WebAuthn authenticator is Chromium-only");
  sql("DELETE FROM credentials");
  sql("DELETE FROM recovery_codes");
  sql("DELETE FROM rate_limits");
  resetWorkouts();

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "راه‌اندازی Lodge Gym" })).toBeVisible();
  await page.getByPlaceholder("کد راه‌اندازی").fill("wrong-token");
  await page.getByRole("button", { name: "ثبت Face ID" }).click();
  await expect(page.getByRole("alert")).toContainText("کد راه‌اندازی درست نیست");

  await page.getByPlaceholder("کد راه‌اندازی").fill("e2e-setup-token-0123456789");
  await page.getByRole("button", { name: "ثبت Face ID" }).click();
  const codes = page.getByTestId("recovery-codes").locator("span");
  await expect(codes).toHaveCount(10);
  await page.getByRole("button", { name: "کدها را ذخیره کردم، ادامه" }).click();
  await expect(page.getByTestId("next-card")).toContainText("جلسه‌ی بعدی: روز ۱ – سینه");

  const setup = await page.request.get(`${baseURL}/setup`);
  expect(setup.status()).toBe(404);

  await page.getByRole("button", { name: "تنظیمات" }).click();
  await page.getByRole("button", { name: "خروج" }).click();
  await expect(page.getByTestId("login")).toBeVisible();
  await page.getByTestId("login").click();
  await expect(page.getByTestId("next-card")).toBeVisible();
  expect((await page.request.get(`${baseURL}/api/bootstrap`)).status()).toBe(200);
});

import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("settings: download a full export now and the latest automatic backup", async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!);
  await page.goto("/");
  await page.getByRole("button", { name: "تنظیمات" }).click();
  const card = page.getByTestId("backups");
  await expect(card).toContainText("۱۲ نسخه‌ی آخر");
  const dl = page.waitForEvent("download");
  await card.getByTestId("export-now").click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^lodge-gym-export-\d{4}-\d{2}-\d{2}\.json$/);
  const text = Buffer.concat(await (await file.createReadStream()).toArray()).toString("utf8");
  expect(JSON.parse(text).app).toBe("lodge-gym");
  // No cron run in local dev yet: the latest-backup button stays disabled.
  await expect(card.getByTestId("last-backup")).toHaveText("هنوز ساخته نشده");
  await expect(card.getByRole("button", { name: "دانلود آخرین پشتیبان" })).toBeDisabled();
});

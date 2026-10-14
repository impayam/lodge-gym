import { expect, test } from "./fixtures";
import { signIn, goTo } from "./helpers";

test("settings: download a full export now and the latest automatic backup", async ({ page, context, baseURL }) => {
  await signIn(context, baseURL!);
  await page.goto("/");
  await goTo(page, "Backup");
  const card = page.getByTestId("backups");
  await expect(card).toContainText("the last 12 copies");
  const dl = page.waitForEvent("download");
  await card.getByTestId("export-now").click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^gym-time-export-\d{4}-\d{2}-\d{2}\.json$/);
  const text = Buffer.concat(await (await file.createReadStream()).toArray()).toString("utf8");
  expect(JSON.parse(text).app).toBe("lodge-gym");
  // No cron run in local dev yet: the latest-backup button stays disabled.
  await expect(card.getByTestId("last-backup")).toHaveText("None yet");
  await expect(card.getByRole("button", { name: "Download latest backup" })).toBeDisabled();
});

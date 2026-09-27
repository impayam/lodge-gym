import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetWorkouts, signIn, sql, waitForSynced } from "./helpers";

test.describe.configure({ mode: "serial" });

/** APP1 EXIF with Orientation = 6 (rotate 90° CW) and a GPS IFD. */
function exifSegment(): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 24 + 4 + 2 + 12 + 4);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  let o = 8;
  tiff.writeUInt16BE(2, o);
  o += 2;
  tiff.writeUInt16BE(0x0112, o); // Orientation
  tiff.writeUInt16BE(3, o + 2);
  tiff.writeUInt32BE(1, o + 4);
  tiff.writeUInt16BE(6, o + 8);
  o += 12;
  tiff.writeUInt16BE(0x8825, o); // GPS IFD pointer
  tiff.writeUInt16BE(4, o + 2);
  tiff.writeUInt32BE(1, o + 4);
  tiff.writeUInt32BE(38, o + 8);
  o += 12;
  tiff.writeUInt32BE(0, o);
  o += 4;
  tiff.writeUInt16BE(1, o); // GPS IFD: GPSLatitudeRef = "N"
  o += 2;
  tiff.writeUInt16BE(0x0001, o);
  tiff.writeUInt16BE(2, o + 2);
  tiff.writeUInt32BE(2, o + 4);
  tiff.write("N\0", o + 8, "latin1");
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 255]), payload]);
}

async function makeJpeg(page: Page, color: string): Promise<string> {
  const b64 = await page.evaluate((c) => {
    const cv = document.createElement("canvas");
    cv.width = 200;
    cv.height = 100;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = "#222";
    ctx.fillRect(100, 0, 100, 100);
    return cv.toDataURL("image/jpeg", 0.9).split(",")[1];
  }, color);
  const jpeg = Buffer.from(b64, "base64");
  const withExif = Buffer.concat([jpeg.subarray(0, 2), exifSegment(), jpeg.subarray(2)]);
  const file = join(mkdtempSync(join(tmpdir(), "lg-")), `${color.replace("#", "")}.jpg`);
  writeFileSync(file, withExif);
  return file;
}

test("post-session photos offline: EXIF orientation applied, metadata stripped, queued then uploaded; compare, overlay, delete", async ({ page, context, baseURL }) => {
  resetWorkouts();
  sql("DELETE FROM photos");
  await signIn(context, baseURL!);
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15_000 }).catch(() => undefined);
  const files = { front: await makeJpeg(page, "#c00"), side: await makeJpeg(page, "#0a0"), back: await makeJpeg(page, "#00c") };

  await page.getByRole("button", { name: "شروع", exact: true }).click();
  await context.setOffline(true);
  await page.getByTestId("finish").click();
  const prompt = page.getByTestId("photo-prompt");
  await expect(prompt).toBeVisible();
  for (const pose of ["front", "side", "back"] as const) {
    await prompt.getByTestId(`camera-${pose}`).setInputFiles(files[pose]);
    await expect(prompt.getByRole("status").first()).toContainText("در صف آپلود");
  }
  await expect(page.getByTestId("session-photos").locator("img")).toHaveCount(3);
  await expect(page.getByTestId("sync-chip")).toContainText("آفلاین");
  expect(sql("SELECT COUNT(*) AS n FROM photos")).toEqual([{ n: 0 }]);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForSynced(page);

  const rows = sql("SELECT id, pose, width, height, session_id IS NOT NULL AS linked FROM photos ORDER BY pose") as { id: string; pose: string; width: number; height: number; linked: number }[];
  expect(rows.map((r) => [r.pose, r.width, r.height, r.linked])).toEqual([
    ["back", 100, 200, 1],
    ["front", 100, 200, 1],
    ["side", 100, 200, 1],
  ]);
  for (const r of rows) {
    const full = await page.request.get(`${baseURL}/api/photos/${r.id}?size=full`);
    expect(full.status()).toBe(200);
    expect(full.headers()["cache-control"]).toBe("private, max-age=31536000, immutable");
    const bytes = await full.body();
    expect(bytes.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    expect((await page.request.get(`${baseURL}/api/photos/${r.id}?size=thumb`)).status()).toBe(200);
  }

  // Gallery, pose filter, compare with day gap and overlay slider.
  await page.getByRole("button", { name: "عکس‌ها" }).click();
  await expect(page.getByTestId("photo")).toHaveCount(3);
  await page.getByRole("group", { name: "فیلتر زاویه" }).getByRole("button", { name: "بغل" }).click();
  await expect(page.getByTestId("photo")).toHaveCount(1);
  await page.getByRole("group", { name: "فیلتر زاویه" }).getByRole("button", { name: "همه" }).click();
  await page.getByRole("button", { name: "انتخاب دو عکس برای مقایسه" }).click();
  await page.getByTestId("photo").nth(0).click();
  await page.getByTestId("photo").nth(1).click();
  await expect(page.getByTestId("compare")).toBeVisible();
  await expect(page.getByTestId("gap")).toHaveText("فاصله: ۰ روز");
  await page.getByRole("button", { name: "روی هم (اسلایدر)" }).click();
  await expect(page.getByRole("slider", { name: "جابه‌جا کردن مرز دو عکس" })).toBeVisible();
  await page.getByRole("button", { name: "پایان مقایسه" }).click();

  // Two-step delete removes the row and the R2 objects.
  const victim = rows[0].id;
  await page.getByRole("img", { name: /عکس پشت/ }).first().click();
  await page.getByTestId("viewer").getByRole("button", { name: "حذف عکس" }).click();
  await page.getByTestId("viewer").getByRole("button", { name: "مطمئنی؟ حذف کن" }).click();
  await expect(page.getByTestId("photo")).toHaveCount(2);
  await waitForSynced(page);
  await expect.poll(() => sql("SELECT COUNT(*) AS n FROM photos")).toEqual([{ n: 2 }]);
  expect((await page.request.get(`${baseURL}/api/photos/${victim}?size=full`)).status()).toBe(404);
});

test("library picker adds several photos with the chosen pose", async ({ page, context, baseURL }) => {
  sql("DELETE FROM photos");
  await signIn(context, baseURL!);
  await page.goto("/");
  const a = await makeJpeg(page, "#aa0");
  const b = await makeJpeg(page, "#0aa");
  await page.getByRole("button", { name: "عکس‌ها" }).click();
  await page.getByRole("group", { name: "زاویه‌ی عکس" }).getByRole("button", { name: "بغل" }).click();
  await page.getByTestId("library-side").setInputFiles([a, b]);
  await expect(page.getByRole("status")).toContainText("۲ عکس ذخیره شد");
  await waitForSynced(page);
  expect(sql("SELECT pose, session_id FROM photos")).toEqual([
    { pose: "side", session_id: null },
    { pose: "side", session_id: null },
  ]);
});

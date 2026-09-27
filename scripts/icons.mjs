// Renders the app icons (PNG) from web/public/icons/icon.svg with the pre-installed Chromium.
// Usage: node scripts/icons.mjs
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../web/public/icons/icon.svg", import.meta.url), "utf8");
const out = (f) => new URL(`../web/public/icons/${f}`, import.meta.url).pathname;
const executablePath = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
async function render(size, file, { maskable = false } = {}) {
  // Maskable: full-bleed background with the glyph inside the 80% safe zone; others keep the rounded square.
  const inner = maskable
    ? svg.replace('rx="112"', 'rx="0"').replace("<g ", '<g transform="translate(51.2 51.2) scale(0.8)" ')
    : svg;
  const bg = maskable || file.startsWith("apple") ? "#0f6e5f" : "transparent";
  const body = file.startsWith("apple") ? inner.replace('rx="112"', 'rx="0"') : inner;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:${bg}"><div style="width:${size}px;height:${size}px">${body.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div></body></html>`
  );
  await page.screenshot({ path: out(file), omitBackground: bg === "transparent" });
}
await render(192, "icon-192.png");
await render(512, "icon-512.png");
await render(512, "icon-maskable-512.png", { maskable: true });
await render(180, "apple-touch-icon.png");
await browser.close();
console.log("icons written");

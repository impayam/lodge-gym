import { test as base, type BrowserContextOptions } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentSlot } from "./slot";

export { expect } from "@playwright/test";
export type { BrowserContext, Page } from "@playwright/test";

const CONTEXT_KEYS = [
  "viewport",
  "screen",
  "userAgent",
  "deviceScaleFactor",
  "isMobile",
  "hasTouch",
  "locale",
  "timezoneId",
  "ignoreHTTPSErrors",
  "colorScheme",
  "serviceWorkers",
] as const;

/**
 * WebKit runs in a persistent context. Playwright's default WebKit context is ephemeral, like Private Browsing, where
 * WebKit refuses to store Blobs in IndexedDB; the installed PWA on the iPhone is not private and the photo outbox
 * stores Blobs. Chromium keeps the default context.
 */
export const test = base.extend({
  // Every worker talks to its own servers (scripts/e2e-slots.mjs).
  baseURL: async ({}, use, testInfo) => use(currentSlot(testInfo).baseURL),
  context: async ({ browserName, context: _unused, playwright, baseURL }, use, testInfo) => {
    void _unused;
    if (browserName !== "webkit") return use(_unused);
    const use_ = testInfo.project.use as Record<string, unknown>;
    const options: BrowserContextOptions = Object.fromEntries(CONTEXT_KEYS.filter((k) => use_[k] !== undefined).map((k) => [k, use_[k]]));
    // WebKit reaches the server through the slot's proxy, which tests switch off for airplane mode (helpers.setOffline).
    Object.assign(options, { baseURL, proxy: { server: currentSlot(testInfo).proxy, bypass: "" } });
    const dir = mkdtempSync(join(tmpdir(), "lg-webkit-"));
    const ctx = await playwright.webkit.launchPersistentContext(dir, { ...options, acceptDownloads: true });
    await use(ctx);
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

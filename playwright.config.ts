import { defineConfig, devices } from "@playwright/test";
import { WORKERS } from "./scripts/e2e-slots.mjs";

// The suite runs in parallel: E2E_WORKERS workers (default 4), each with its own servers and local D1/R2
// (scripts/e2e-slots.mjs, started by scripts/e2e-server.mjs), so no two workers share data. A spec file runs whole, in
// order, on one worker. Every worker has two Workers: Chromium uses the HTTP one, WebKit the HTTPS one with wrangler's
// self-signed certificate. WebKit does not send Secure / __Host- cookies over http://localhost, and Chromium does not
// run service workers on an origin with certificate errors. The real app is always served over HTTPS.
// The fixtures in tests/e2e/fixtures.ts point each test's baseURL (and WebKit's proxy) at its worker's servers.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: WORKERS,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { trace: "retain-on-failure", locale: "en-US", timezoneId: "America/Denver" },
  webServer: {
    command: "npm run build && node scripts/e2e-server.mjs",
    env: { E2E_WORKERS: String(WORKERS) },
    wait: { stdout: /e2e servers ready/ },
    timeout: 300_000,
  },
  projects: [
    // SPEC §2: WebKit with an iPhone 15 profile.
    { name: "webkit-iphone", use: { ...devices["iPhone 15"], ignoreHTTPSErrors: true } },
    // Same iPhone profile on the pre-installed Chromium; also covers the passkey flow via the CDP virtual authenticator.
    {
      name: "chromium-iphone",
      use: {
        ...devices["iPhone 15"],
        browserName: "chromium",
        launchOptions: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
      },
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

// Two local servers (see scripts/e2e-server.mjs): Chromium over HTTP, WebKit over HTTPS with wrangler's
// self-signed certificate. WebKit does not send Secure / __Host- cookies over http://localhost, and Chromium does
// not run service workers on an origin with certificate errors. The real app is always served over HTTPS.
const HTTP = `http://localhost:${process.env.E2E_HTTP_PORT ?? "8788"}`;
const HTTPS = `https://localhost:${process.env.E2E_HTTPS_PORT ?? "8789"}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { trace: "retain-on-failure", locale: "fa-IR", timezoneId: "America/Denver" },
  webServer: {
    command: "npm run build && node scripts/e2e-server.mjs",
    url: `${HTTPS}/manifest.webmanifest`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 240_000,
  },
  projects: [
    // SPEC §2: WebKit with an iPhone 15 profile.
    { name: "webkit-iphone", use: { ...devices["iPhone 15"], baseURL: HTTPS, ignoreHTTPSErrors: true } },
    // Same iPhone profile on the pre-installed Chromium; also covers the passkey flow via the CDP virtual authenticator.
    {
      name: "chromium-iphone",
      use: {
        ...devices["iPhone 15"],
        baseURL: HTTP,
        browserName: "chromium",
        launchOptions: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
      },
    },
  ],
});

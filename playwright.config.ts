import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "8788";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", locale: "fa-IR", timezoneId: "America/Denver" },
  webServer: {
    command: "npm run build && node scripts/e2e-server.mjs",
    url: `http://localhost:${PORT}/manifest.webmanifest`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { E2E_PORT: PORT },
  },
  projects: [
    // SPEC §2: WebKit with an iPhone 15 profile.
    { name: "webkit-iphone", use: { ...devices["iPhone 15"] } },
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

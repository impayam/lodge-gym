// Starts the Worker twice for Playwright, each with a fresh local D1 (migrated + seeded):
//   http://localhost:8788  (.wrangler/e2e)        for Chromium (service workers need a trusted origin; localhost over
//                                                  HTTP is one, a self-signed HTTPS origin is not)
//   https://localhost:8789 (.wrangler/e2e-https)  for WebKit (it does not send Secure / __Host- cookies over
//                                                  http://localhost; wrangler's self-signed certificate + ignoreHTTPSErrors)
//   http://localhost:8790  forward proxy WebKit uses, so tests can cut its network (see scripts/e2e-proxy.mjs)
//   http://127.0.0.1:8791  mock of the Claude Messages API (scripts/e2e-ai-mock.mjs); the real API is never called
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { startProxy } from "./e2e-proxy.mjs";
import { startAiMock } from "./e2e-ai-mock.mjs";
import { loadLibrary } from "./e2e-library.mjs";

export const SERVERS = [
  { protocol: "http", port: process.env.E2E_HTTP_PORT ?? "8788", persist: ".wrangler/e2e" },
  { protocol: "https", port: process.env.E2E_HTTPS_PORT ?? "8789", persist: ".wrangler/e2e-https" },
];

const children = [];
const stop = () => children.forEach((c) => c.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function waitFor(url) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start: ${url}`);
}

const proxy = await startProxy(process.env.E2E_PROXY_PORT ?? "8790");
process.on("exit", () => proxy.close());
const AI_PORT = process.env.E2E_AI_PORT ?? "8791";
const aiMock = await startAiMock(AI_PORT);
process.on("exit", () => aiMock.close());

for (const s of SERVERS) {
  rmSync(s.persist, { recursive: true, force: true });
  const w = (...args) => execFileSync("npx", ["wrangler", ...args, "--local", "--persist-to", s.persist], { stdio: "inherit" });
  w("d1", "migrations", "apply", "DB");
  w("d1", "execute", "DB", "--file", "seed/seed.sql");
  loadLibrary(s.persist);
  const dev = spawn(
    "npx",
    [
      "wrangler", "dev", "--port", s.port, "--local-protocol", s.protocol, "--persist-to", s.persist,
      "--var", "SETUP_TOKEN:e2e-setup-token-0123456789",
      "--var", "ANTHROPIC_API_KEY:e2e-not-a-real-key",
      "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${AI_PORT}`,
    ],
    { stdio: "inherit" }
  );
  dev.on("exit", (code) => {
    stop();
    process.exit(code ?? 0);
  });
  children.push(dev);
  // Start the next server only when this one answers, so Playwright's readiness URL (the last server) implies both.
  await waitFor(`${s.protocol}://localhost:${s.port}/manifest.webmanifest`);
}

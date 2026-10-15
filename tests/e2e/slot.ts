import { test, type TestInfo } from "@playwright/test";
import { WORKERS, slot } from "../../scripts/e2e-slots.mjs";

/**
 * The current worker's servers (scripts/e2e-slots.mjs): the Worker this project talks to (HTTPS for WebKit, HTTP for
 * Chromium) with its local D1/R2, the WebKit proxy and the AI mock. Parallel workers never share any of them.
 */
export function currentSlot(info: TestInfo = test.info()) {
  if (info.parallelIndex >= WORKERS) {
    throw new Error(`worker ${info.parallelIndex} has no e2e servers (${WORKERS} slots): set E2E_WORKERS instead of --workers`);
  }
  const s = slot(info.parallelIndex);
  const server = info.project.name.startsWith("webkit") ? s.https : s.http;
  return {
    baseURL: `${server.protocol}://localhost:${server.port}`,
    persist: server.persist,
    proxy: `http://localhost:${s.proxy}`,
    ai: `http://127.0.0.1:${s.ai}`,
  };
}

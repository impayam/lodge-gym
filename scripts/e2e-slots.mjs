// One server stack per Playwright worker, so parallel workers never share data. A worker's slot is its parallelIndex
// (0 … workers − 1; workers running at the same time always have different ones). Slot i, with B = E2E_PORT_BASE:
//   http://localhost:B+6i     Worker for Chromium, local D1/R2 in .wrangler/e2e/<i>-http
//   https://localhost:B+6i+1  Worker for WebKit,   local D1/R2 in .wrangler/e2e/<i>-https
//   http://localhost:B+6i+2   forward proxy WebKit uses, so a test can cut its network (scripts/e2e-proxy.mjs)
//   http://127.0.0.1:B+6i+3   mock of the Claude Messages API (scripts/e2e-ai-mock.mjs)
//   B+6i+4, B+6i+5            the two Workers' devtools ports (wrangler's default, 9229, would race between them)
// E2E_WORKERS is both the number of Playwright workers and the number of slots the e2e server starts.

/**
 * Playwright workers and server slots. Default 2: measured on the 4-core dev machine (2026-10-15), 2 workers run the
 * suite in 20 min with every test passing; 4 make WebKit tests run out of time (one WebKit page uses up to ~2.7
 * cores). E2E_WORKERS=1 runs the suite one test at a time.
 */
export const WORKERS = Number(process.env.E2E_WORKERS ?? 2);
const PORT_BASE = Number(process.env.E2E_PORT_BASE ?? 8788);

/** Ports and local storage of slot i. */
export function slot(i) {
  const port = PORT_BASE + 6 * i;
  return {
    http: { protocol: "http", port, inspector: port + 4, persist: `.wrangler/e2e/${i}-http` },
    https: { protocol: "https", port: port + 1, inspector: port + 5, persist: `.wrangler/e2e/${i}-https` },
    proxy: port + 2,
    ai: port + 3,
  };
}

// Starts the e2e servers for Playwright: one slot per worker (scripts/e2e-slots.mjs), so parallel workers never share
// data. Every slot runs the Worker twice, each on its own copy of one freshly migrated and seeded local D1/R2:
//   http   for Chromium (service workers need a trusted origin; localhost over HTTP is one, a self-signed HTTPS origin
//          is not)
//   https  for WebKit (it does not send Secure / __Host- cookies over http://localhost; wrangler's self-signed
//          certificate + ignoreHTTPSErrors)
// plus the forward proxy WebKit uses (scripts/e2e-proxy.mjs) and a mock of the Claude Messages API
// (scripts/e2e-ai-mock.mjs); the real API is never called. Each Worker logs to
// .wrangler/e2e-logs/<run start>/<slot>-<protocol>.log; the last LOG_RUNS runs are kept, so the server log of a run
// that failed is still there after the next run (.wrangler/e2e itself is wiped at every start).
// Prints "e2e servers ready" once every slot answers; playwright.config.ts waits for that line.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { startProxy } from "./e2e-proxy.mjs";
import { startAiMock } from "./e2e-ai-mock.mjs";
import { loadLibrary } from "./e2e-library.mjs";
import { WORKERS, slot } from "./e2e-slots.mjs";

const ROOT = ".wrangler/e2e";
const TEMPLATE = `${ROOT}/template`;
const LOG_ROOT = ".wrangler/e2e-logs";
const LOG_RUNS = 10;
const LOGS = `${LOG_ROOT}/${new Date().toISOString().replace(/[:.]/g, "-")}`;

const children = [];
const closers = [];
let stopping = false;
const stop = () => {
  stopping = true;
  children.forEach((c) => c.kill());
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", () => closers.forEach((s) => s.close()));

/** True when nothing listens on the port (on any address). */
const isFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer().once("error", () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });

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

const slots = Array.from({ length: WORKERS }, (_, i) => slot(i));
const ports = slots.flatMap((s) => [s.http.port, s.https.port, s.proxy, s.ai, s.http.inspector, s.https.inspector]);
const busy = [];
for (const p of ports) if (!(await isFree(p))) busy.push(p);
if (busy.length) {
  console.error(`e2e: port(s) ${busy.join(", ")} already in use; stop the other e2e server or set E2E_PORT_BASE.`);
  process.exit(1);
}

// One migrated and seeded D1/R2 with the exercise library; every Worker starts on its own copy.
rmSync(ROOT, { recursive: true, force: true });
const w = (...args) => execFileSync("npx", ["wrangler", ...args, "--local", "--persist-to", TEMPLATE], { stdio: "inherit" });
w("d1", "migrations", "apply", "DB");
w("d1", "execute", "DB", "--file", "seed/seed.sql");
loadLibrary(TEMPLATE);
mkdirSync(LOGS, { recursive: true });
// Only the newest runs' logs are kept (the folder names sort by start time).
for (const old of readdirSync(LOG_ROOT).sort().slice(0, -LOG_RUNS)) rmSync(`${LOG_ROOT}/${old}`, { recursive: true, force: true });
console.log(`e2e: server logs in ${LOGS}`);

function startWorker(i, s, ai) {
  cpSync(TEMPLATE, s.persist, { recursive: true });
  const logFile = `${LOGS}/${i}-${s.protocol}.log`;
  const log = openSync(logFile, "a");
  const dev = spawn(
    "npx",
    [
      "wrangler", "dev", "--port", String(s.port), "--inspector-port", String(s.inspector), "--local-protocol", s.protocol,
      "--persist-to", s.persist,
      "--var", "SETUP_TOKEN:e2e-setup-token-0123456789",
      "--var", "ANTHROPIC_API_KEY:e2e-not-a-real-key",
      "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${ai}`,
    ],
    { stdio: ["ignore", log, log] }
  );
  dev.on("exit", (code) => {
    if (stopping) return process.exit(0);
    console.error(`e2e: the ${s.protocol} Worker of slot ${i} exited (${code}); last lines of ${logFile}:`);
    console.error(readFileSync(logFile, "utf8").split("\n").slice(-30).join("\n"));
    stop();
    process.exit(code || 1);
  });
  children.push(dev);
  return waitFor(`${s.protocol}://localhost:${s.port}/manifest.webmanifest`);
}

await Promise.all(
  slots.map(async (s, i) => {
    closers.push(await startProxy(s.proxy), await startAiMock(s.ai));
    await Promise.all([startWorker(i, s.http, s.ai), startWorker(i, s.https, s.ai)]);
  })
);
console.log(`e2e servers ready (${WORKERS} slot${WORKERS === 1 ? "" : "s"})`);

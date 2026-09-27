// Starts the Worker for Playwright with a fresh local D1 (migrated + seeded) under .wrangler/e2e.
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";

const PERSIST = ".wrangler/e2e";
const PORT = process.env.E2E_PORT ?? "8788";
rmSync(PERSIST, { recursive: true, force: true });
const w = (...args) => execFileSync("npx", ["wrangler", ...args, "--local", "--persist-to", PERSIST], { stdio: "inherit" });
w("d1", "migrations", "apply", "DB");
w("d1", "execute", "DB", "--file", "seed/seed.sql");
const dev = spawn("npx", ["wrangler", "dev", "--port", PORT, "--persist-to", PERSIST, "--var", "SETUP_TOKEN:e2e-setup-token-0123456789"], { stdio: "inherit" });
const stop = () => dev.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
dev.on("exit", (code) => process.exit(code ?? 0));

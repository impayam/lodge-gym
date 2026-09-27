// Local development: rebuilds the PWA on change and serves it with the Worker, local D1 and R2 at http://localhost:8787.
// First run: `npm run db:migrate:local && npm run seed:local`, and put SETUP_TOKEN=... in .dev.vars.
import { spawn } from "node:child_process";

const run = (cmd, args) => spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
const vite = run("npx", ["vite", "build", "--watch", "--mode", "development"]);
const wrangler = run("npx", ["wrangler", "dev", "--port", "8787"]);
const stop = () => {
  vite.kill();
  wrangler.kill();
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
vite.on("exit", stop);
wrangler.on("exit", stop);

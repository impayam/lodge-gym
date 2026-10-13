import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");
const seedSql = readFileSync("./seed/seed.sql", "utf8");
// The 3D anatomy model's nodes (name, extras.type, has a mesh), read from the GLB's JSON chunk for the mapping tests.
const glb = readFileSync("./web/public/models/body.glb");
const glbNodes = (JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")).nodes as { name: string; mesh?: number; extras?: { type?: string } }[]).map(
  (n) => ({ name: n.name, type: n.extras?.type ?? null, mesh: n.mesh !== undefined })
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.test.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_SEED_SQL: seedSql,
          TEST_GLB_NODES: glbNodes,
          // The app stylesheet, for the 3D map colours that must equal the dark theme's status tokens.
          TEST_STYLES: readFileSync("./web/src/styles.css", "utf8"),
          SETUP_TOKEN: "test-setup-token-0123456789",
        },
      },
    }),
  ],
  test: {
    include: ["tests/lib/**/*.test.ts", "tests/worker/**/*.test.ts"],
    setupFiles: ["./tests/worker/apply-migrations.ts"],
  },
});

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");
const seedSql = readFileSync("./seed/seed.sql", "utf8");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.test.toml" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations, TEST_SEED_SQL: seedSql, SETUP_TOKEN: "test-setup-token-0123456789" },
      },
    }),
  ],
  test: {
    include: ["tests/lib/**/*.test.ts", "tests/worker/**/*.test.ts"],
    setupFiles: ["./tests/worker/apply-migrations.ts"],
  },
});

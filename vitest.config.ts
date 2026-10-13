import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");
const seedSql = readFileSync("./seed/seed.sql", "utf8");
// The 3D anatomy model's nodes (name, extras.type, has a mesh), read from the GLB's JSON chunk for the mapping tests.
const glb = readFileSync("./web/public/models/body.glb");
const glbJson = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as {
  nodes: { name: string; mesh?: number; extras?: { type?: string }; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes: { primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { min?: number[]; max?: number[] }[];
};
// Each node's name, type, whether it has a mesh, and (for an untransformed mesh node) its bounds in model space.
const glbNodes = glbJson.nodes.map((n) => {
  const a = n.mesh !== undefined && !n.translation && !n.rotation && !n.scale ? glbJson.accessors[glbJson.meshes[n.mesh].primitives[0].attributes.POSITION] : null;
  return { name: n.name, type: n.extras?.type ?? null, mesh: n.mesh !== undefined, min: a?.min ?? null, max: a?.max ?? null };
});

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
          // Tests never call the real Anthropic API: the model is mocked (worker/ai.ts aiTransport), and anything that
          // slips past the mock goes to a host that does not exist.
          ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key",
          ANTHROPIC_BASE_URL: "https://anthropic.invalid",
        },
      },
    }),
  ],
  test: {
    include: ["tests/lib/**/*.test.ts", "tests/worker/**/*.test.ts"],
    setupFiles: ["./tests/worker/apply-migrations.ts"],
  },
});

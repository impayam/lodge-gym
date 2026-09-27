import { applyD1Migrations, env } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      PHOTOS: R2Bucket;
      ASSETS: Fetcher;
      REST_PUSH: DurableObjectNamespace<import("../../worker/push").RestPush>;
      SETUP_TOKEN: string;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      TEST_SEED_SQL: string;
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const seeded = await env.DB.prepare("SELECT COUNT(*) AS n FROM exercises").first<{ n: number }>();
if (!seeded?.n) {
  const lines = env.TEST_SEED_SQL.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
  await env.DB.batch(lines.map((l) => env.DB.prepare(l)));
}

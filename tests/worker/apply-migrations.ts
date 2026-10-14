import { applyD1Migrations, env } from "cloudflare:test";
import { aiTransport } from "../../worker/ai";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      PHOTOS: R2Bucket;
      ASSETS: Fetcher;
      REST_PUSH: DurableObjectNamespace<import("../../worker/push").RestPush>;
      AI_JOBS: DurableObjectNamespace<import("../../worker/aiReports").AiJobs>;
      ANTHROPIC_API_KEY: string;
      ANTHROPIC_BASE_URL: string;
      REPORT_MODEL: string;
      REPORT_EFFORT: string;
      ADVICE_EFFORT: string;
      REPORT_MAX_TOKENS: string;
      OVERVIEW_EFFORT: string;
      OVERVIEW_MAX_TOKENS: string;
      SETUP_TOKEN: string;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      TEST_SEED_SQL: string;
      TEST_GLB_NODES: { name: string; type: string | null; mesh: boolean; min: number[] | null; max: number[] | null }[];
      TEST_STYLES: string;
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const seeded = await env.DB.prepare("SELECT COUNT(*) AS n FROM exercises").first<{ n: number }>();
if (!seeded?.n) {
  const lines = env.TEST_SEED_SQL.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
  await env.DB.batch(lines.map((l) => env.DB.prepare(l)));
}

// Tests never reach the Anthropic API: the AI tests install a mock (tests/fixtures/anthropic-mock.ts), and the reports
// and overviews queued by other tests' sessions fail at once with an API error. (A thrown network error would be
// retried by the SDK with backoff, about 1–3 s per job, which made those tests slow and flaky under load.)
aiTransport.fetch = async () =>
  new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "No Anthropic mock is installed in this test." } }), {
    status: 400,
    headers: { "content-type": "application/json", "request-id": "req_no_mock" },
  });

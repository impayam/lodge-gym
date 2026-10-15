export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
  REST_PUSH: DurableObjectNamespace<import("./push").RestPush>;
  SETUP_TOKEN?: string;
  /** AI session report and plan advice (SPEC-v3 M9): the background report writer. */
  AI_JOBS: DurableObjectNamespace<import("./aiReports").AiJobs>;
  /** Worker secret, set in the dashboard or with `wrangler secret put ANTHROPIC_API_KEY`; never sent to the client. */
  ANTHROPIC_API_KEY?: string;
  /** Only for the e2e tests' mock model server; unset in production. */
  ANTHROPIC_BASE_URL?: string;
  /** Model id (default claude-opus-5-5), efforts and the reply's max_tokens, from wrangler.toml [vars]. */
  REPORT_MODEL?: string;
  REPORT_EFFORT?: string;
  ADVICE_EFFORT?: string;
  REPORT_MAX_TOKENS?: string;
  /** Training overview (SPEC-v7 M9d): effort and the reply's max_tokens. */
  OVERVIEW_EFFORT?: string;
  OVERVIEW_MAX_TOKENS?: string;
  /** Coach chat (SPEC-v9 M12): model, effort, max_tokens per call and the history budget in tokens. */
  COACH_MODEL?: string;
  COACH_EFFORT?: string;
  COACH_MAX_TOKENS?: string;
  COACH_CONTEXT_TOKENS?: string;
}

export type SessionScope = "full" | "recovery";

export interface AppBindings {
  Bindings: Env;
  Variables: { scope: SessionScope; tokenHash: string };
}

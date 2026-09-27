export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
  REST_PUSH: DurableObjectNamespace<import("./push").RestPush>;
  SETUP_TOKEN?: string;
}

export type SessionScope = "full" | "recovery";

export interface AppBindings {
  Bindings: Env;
  Variables: { scope: SessionScope; tokenHash: string };
}

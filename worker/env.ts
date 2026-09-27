export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
  SETUP_TOKEN?: string;
}

export type SessionScope = "full" | "recovery";

export interface AppBindings {
  Bindings: Env;
  Variables: { scope: SessionScope; tokenHash: string };
}

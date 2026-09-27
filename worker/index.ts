// Lodge Gym Worker: JSON API under /api and the PWA static assets, one origin (SPEC §2).

import { Hono } from "hono";
import { authRoutes, credentialCount, requireSession } from "./auth";
import { dataRoutes } from "./data";
import type { AppBindings } from "./env";
import { SECURITY_HEADERS } from "./headers";
import { ApiError, errorBody } from "./http";


const app = new Hono<AppBindings>();

// Security headers and CSP on every response, including static assets (SPEC §13).
app.use("*", async (c, next) => {
  await next();
  const res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  c.res = res;
});

// CSRF: SameSite=Strict cookies plus an Origin check on state-changing API requests.
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) {
      return c.json(errorBody("bad_origin", "درخواست از مبدأ نامعتبر رسید."), 403);
    }
  }
  await next();
});

app.use("/api/*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});

app.route("/api/auth", authRoutes);

const api = new Hono<AppBindings>();
api.use("*", requireSession);
api.route("/", dataRoutes);
app.route("/api", api);

app.all("/api/*", (c) => c.json(errorBody("not_found", "مسیر پیدا نشد."), 404));

// First-run setup page exists only until the first passkey is registered.
app.get("/setup", async (c) => {
  if ((await credentialCount(c.env)) > 0) return c.text("Not Found", 404);
  const res = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), c.req.raw));
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-store");
  return out;
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(errorBody(err.code, err.messageFa), err.status);
  console.error(err);
  return c.json(errorBody("internal", "خطای سرور. دوباره امتحان کن."), 500);
});

export default app;

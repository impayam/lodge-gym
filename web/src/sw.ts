/// <reference lib="webworker" />
// Service worker: precached app shell (Workbox injectManifest). API calls go to the network, except library images,
// which are immutable (a new key per upload) and kept in a cache for offline use. The 3D anatomy model, its Draco
// decoder and the 3D code chunk are not precached (installs stay light): they are cached on first use, cache-first, in
// a cache named after the model's SHA-256, so the 3D picker works offline after one online open.

import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { ANATOMY_CACHE, isAnatomyAsset } from "./lib/anatomy-asset";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Every in-app navigation opens the cached shell; /setup and /api never do (setup must 404 once done).
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [/^\/api\//, /^\/setup/] }));

registerRoute(({ url, request }) => request.method === "GET" && url.pathname.startsWith("/api/library/media/"), new CacheFirst({ cacheName: "library-media" }));

registerRoute(
  ({ url, request }) => request.method === "GET" && url.origin === self.location.origin && isAnatomyAsset(url.pathname),
  new CacheFirst({
    cacheName: ANATOMY_CACHE,
    // Never keep the app shell that a missing file falls back to (single-page-application not-found handling).
    plugins: [{ cacheWillUpdate: async ({ response }) => (response.ok && !response.headers.get("Content-Type")?.includes("text/html") ? response : null) }],
  })
);

// Drop the anatomy caches of an older model.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("anatomy-") && k !== ANATOMY_CACHE).map((k) => caches.delete(k))))
  );
});

// Rest-timer push (Web Push): always show a notification (iOS revokes subscriptions that push silently).
self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; tag?: string } = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "GYM time", {
      body: data.body ?? "",
      tag: data.tag ?? "lodge-gym",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      lang: "en",
      dir: "ltr",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows[0];
      if (open) await open.focus();
      else await self.clients.openWindow("/");
    })()
  );
});

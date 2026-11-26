/*
 * Agentaus service worker — offline shell + installed-app caching.
 *
 * Strategy:
 *   - Navigator requests (the main page load): network-first so updates and
 *     reloads always get the new app.js when online; falls back to the cached
 *     shell when offline.
 *   - Everything else (styles, icons, manifest): cache-first, refreshed in the
 *     background.
 *   - The Agentaus API (agentaus.com.au) and the local companion (127.0.0.1)
 *     are never intercepted.
 *
 * Nothing here touches your data. Chats, files and settings live in browser
 * storage (localStorage / IndexedDB), which a service worker never deletes.
 * Update the VERSION string when you publish a new build.
 */
const VERSION = "2026-11-26";
const SHELL = ["./", "app.js", "styles.css", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon.svg", "icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open("agentaus-shell-v1")
      .then((cache) => cache.addAll(SHELL))
      .then(() => {
        if (self.skipWaiting) self.skipWaiting();
      })
      .catch(() => {
        /* Precache is best-effort. A missing icon must never block activation. */
      })
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  const host = url.host || "";
  if (host !== location.host) return; // cross-origin: API, companion, CDNs — never touch

  event.respondWith(
    (async () => {
      const cache = await caches.open("agentaus-shell-v1");
      const isNavigate = req.mode === "navigate";

      if (isNavigate) {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
          return fresh;
        } catch (err) {
          const hit = await cache.match(req);
          if (hit) return hit;
          throw err;
        }
      }

      const hit = await cache.match(req);
      if (hit) {
        fetch(req)
          .then((r) => {
            if (r && r.ok) cache.put(req, r);
          })
          .catch(() => {});
        return hit;
      }
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })()
  );
});

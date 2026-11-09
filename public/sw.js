// Minimal service worker: makes the app installable and gives the shell
// an offline fallback. Market data is always network-first — a trading
// terminal must never show stale prices from cache.
const SHELL_CACHE = "kalshi-astra-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Only handle top-level navigations: network first, cached shell as
  // offline fallback. Everything else (API calls, assets) goes straight
  // to the network untouched.
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/")));
  }
});

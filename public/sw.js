const CACHE_NAME = "dropx-portals-static-v7";
const PRE_CACHE = [
  "/fleet-offline.html",
  "/manifest.webmanifest",
  "/opspulse/icon-192.png?v=2",
  "/opspulse/icon-512.png?v=2",
  "/opspulse/icon-maskable-512.png?v=2",
  "/fleet-manifest.webmanifest",
  "/fleet-control/icon-192.png",
  "/fleet-control/icon-512.png",
  "/fleet-control/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRE_CACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" && url.hostname.startsWith("fleet.")) {
    event.respondWith(fetch(event.request).catch(() => caches.match("/fleet-offline.html")));
    return;
  }
  const isStatic = url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/opspulse/") ||
    (/\.(png|svg|webp|ico)$/.test(url.pathname) && url.pathname.startsWith("/fleet-control/")) ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/fleet-manifest.webmanifest";
  if (!isStatic) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});

const CACHE_NAME = "dropx-opspulse-static-v3";
const PRE_CACHE = [
  "/opspulse/offline.html",
  "/opspulse/offline.js",
  "/manifest.webmanifest",
  "/opspulse/icon-192.png?v=2",
  "/opspulse/icon-512.png?v=2",
  "/opspulse/icon-maskable-512.png?v=2"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRE_CACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("dropx-opspulse-static-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache authenticated HTML or mutations. Only a generic recovery screen is stored.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(async () =>
      (await caches.match("/opspulse/offline.html")) || Response.error()
    ));
    return;
  }
  const isStatic = url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/opspulse/") ||
    url.pathname === "/manifest.webmanifest";
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

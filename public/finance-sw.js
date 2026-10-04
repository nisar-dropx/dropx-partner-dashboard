/* Only a generic offline page is cached. Authenticated pages, APIs, salary data,
   exports and mutations always use the network; no stale financial snapshots. */
const CACHE = 'dropx-finance-shell-v1';
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.add('/finance-app/offline.html'))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('dropx-finance-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match('/finance-app/offline.html')) || new Response('You are offline. Reconnect and retry.', {status:503,headers:{'Content-Type':'text/plain'}})));
});

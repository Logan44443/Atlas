// Four Winds service worker: versioned Cache API layer for world chunks.
// Chunk URLs carry ?v=<content hash> from manifest.json, so a cached response
// is only reused while the chunk is unchanged. When a new version is fetched,
// older versions of the same path are dropped.
const CACHE = 'fw-world-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('fw-world-') && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

function tagged(response, state) {
  const headers = new Headers(response.headers);
  headers.set('x-fw-cache', state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  if (url.pathname.startsWith('/world/chunks/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(event.request);
        if (hit) return tagged(hit, 'hit');
        const res = await fetch(event.request);
        if (res.ok && url.searchParams.has('v')) {
          // Remove stale versions of this chunk, then store the new one.
          await cache.delete(url.pathname, { ignoreSearch: true });
          await cache.put(event.request, res.clone());
        }
        return tagged(res, 'miss');
      })(),
    );
    return;
  }

  if (url.pathname === '/world/manifest.json') {
    // Network first so new world versions are picked up; cache for offline.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(event.request, { cache: 'no-cache' });
          if (res.ok) await cache.put(url.pathname, res.clone());
          return res;
        } catch (err) {
          const hit = await cache.match(url.pathname);
          if (hit) return hit;
          throw err;
        }
      })(),
    );
  }
});

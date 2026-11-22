/* Service worker: precaches the whole app so it runs offline. */
const CACHE = 'scratchjr-web-__VERSION__';
const FILES = __FILES__;

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // add in batches so one slow request does not stall everything
        for (let i = 0; i < FILES.length; i += 40) {
            await cache.addAll(FILES.slice(i, i + 40));
        }
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key !== CACHE) {
                await caches.delete(key);
            }
        }
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') {
        return;
    }
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(event.request, {ignoreSearch: true});
        if (hit) {
            return hit;
        }
        try {
            return await fetch(event.request);
        } catch (e) {
            return new Response('', {status: 504});
        }
    })());
});

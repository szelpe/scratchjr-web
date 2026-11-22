/* Service worker: app code is network-first (updates arrive immediately),
   assets are cache-first; everything is cached for offline use. */
const CACHE = 'scratchjr-web-__VERSION__';
const FILES = __FILES__;
const CODE = /(\/|\.html|\.js|\.css|\.json|\.webmanifest|\.wasm)$/i;
const CORE = FILES.filter((f) => f === './' || CODE.test(f) || /^sounds\//.test(f));

async function cacheAll (list) {
    const cache = await caches.open(CACHE);
    for (let i = 0; i < list.length; i += 40) {
        await cache.addAll(list.slice(i, i + 40)).catch(() => {});
    }
}

self.addEventListener('install', (event) => {
    // only the small core blocks installation, so updates activate quickly
    event.waitUntil(cacheAll(CORE).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // carry over assets from the previous cache so they need not be downloaded again
        const old = (await caches.keys()).filter((k) => k !== CACHE);
        const cache = await caches.open(CACHE);
        for (const key of old) {
            const prev = await caches.open(key);
            for (const req of await prev.keys()) {
                if (!CODE.test(new URL(req.url).pathname) && !(await cache.match(req))) {
                    await cache.put(req, await prev.match(req));
                }
            }
            await caches.delete(key);
        }
        await self.clients.claim();
    })());
    // fill in the rest in the background (assets are also cached on first use)
    cacheAll(FILES.filter((f) => CORE.indexOf(f) < 0));
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
        return;
    }
    const isCode = req.mode === 'navigate' || CODE.test(new URL(req.url).pathname);
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        if (isCode) {
            try {
                const res = await fetch(req, {cache: 'no-cache'});
                if (res.ok) {
                    cache.put(req, res.clone());
                }
                return res;
            } catch (e) {
                const hit = await cache.match(req, {ignoreSearch: true});
                return hit || new Response('', {status: 504});
            }
        }
        const hit = await cache.match(req, {ignoreSearch: true});
        if (hit) {
            return hit;
        }
        try {
            const res = await fetch(req);
            if (res.ok) {
                cache.put(req, res.clone());
            }
            return res;
        } catch (e) {
            return new Response('', {status: 504});
        }
    })());
});

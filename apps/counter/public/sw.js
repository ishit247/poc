// App-shell service worker. Lets the counter start with no network. Sales data is NOT cached
// here: it lives in IndexedDB. API calls always go to the network (or fail, which the app handles).
const CACHE = 'shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // Newest page when online; the cached page when not.
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put('/', copy)); return res; })
        .catch(() => caches.match('/')),
    );
    return;
  }
  // Built assets have content-hashed names, so cache-first is safe.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});

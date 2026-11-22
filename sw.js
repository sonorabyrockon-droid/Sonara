/* SONORA shell cache. Versioned assets prevent a previous deployment from masking updated frontend code. */
const CACHE = 'sonora-shell-v3-16-0';
const SHELL = ['./', './index.html', './styles.css?v=3.16.0', './app.js?v=3.16.0', './config.js?v=3.16.0', './manifest.webmanifest', './public/sonora-mark.svg'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('sonora-shell-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/stream/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put('./index.html', response.clone()));
      return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  if (SHELL.some((item) => new URL(item, self.registration.scope).href === url.href)) {
    /* Network-first for app assets: a newly deployed app wins; cache is offline fallback only. */
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request)));
  }
});

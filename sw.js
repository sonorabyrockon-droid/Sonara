/* SONORA shell cache. Versioned assets prevent a previous deployment from masking updated frontend code. */
const CACHE = 'sonora-shell-v3-28-0';
const SHELL = ['./', './index.html', './styles.css?v=3.28.0', './app.js?v=3.28.0', './sonora-ux.js?v=3.28.0', './config.js?v=3.28.0', './sonora-offline.js?v=3.28.0', './manifest.webmanifest', './public/sonora-mark.svg'];
const EXT = ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2', 'https://cdn.jsdelivr.net/npm/jsmediatags@3.9.7/dist/jsmediatags.min.js'];
self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)),
    /* pre-cache the CDN libraries too (best effort) so the very next launch works with no connection */
    caches.open(CACHE + '-ext').then((cache) => Promise.all(EXT.map((u) => fetch(new Request(u, { mode:'no-cors' })).then((r) => cache.put(u, r)).catch(() => {}))))
  ]).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('sonora-shell-') && key !== CACHE && key !== CACHE + '-ext').map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.includes('/stream/')) return;
  /* Third-party libraries and fonts (Supabase client, tag reader, Google Fonts): cached on first load so the app can start with no connection. */
  if (url.origin !== self.location.origin) {
    if (/(^|\.)(jsdelivr\.net|googleapis\.com|gstatic\.com)$/.test(url.hostname)) {
      event.respondWith(caches.open(CACHE + '-ext').then((cache) => cache.match(request).then((hit) => {
        const fresh = fetch(request).then((response) => { if (response.ok || response.type === 'opaque') cache.put(request, response.clone()); return response; }).catch(() => hit);
        return hit || fresh;
      })));
    }
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put('./index.html', response.clone()));
      return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  if (SHELL.some((item) => new URL(item, self.registration.scope).href === url.href) || /\/public\//.test(url.pathname)) {
    /* Network-first for app assets: a newly deployed app wins; cache is offline fallback only. */
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request)));
  }
});

/* Notifications: tap opens/focuses SONORA at the right page. The push handler is ready for server push (needs VAPID keys + a sender). */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '#/home';
  event.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then((list) => {
    for (const client of list) { if ('focus' in client) { client.postMessage({ type:'sonora-open', url }); return client.focus(); } }
    return self.clients.openWindow('./' + url);
  }));
});
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'SONORA', {
    body: d.body || '', icon: 'public/icons/icon-192.png', badge: 'public/icons/icon-192.png', image: d.image, tag: d.tag || 'sonora', data: { url: d.url || '#/home' }
  }));
});

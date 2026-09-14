/* Service worker — Journal de Dev HSE (PWA)
 * Met en cache la coquille de l'app (fonctionnement hors-ligne du shell).
 * Les appels à l'API GitHub (api.github.com) ne sont JAMAIS mis en cache :
 * ils passent toujours par le réseau (données fraîches + token).
 */
var CACHE = 'journal-hse-v1';
var SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // Tout ce qui n'est pas notre origine (ex. api.github.com) : réseau direct.
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  // App shell : cache d'abord, réseau en secours (et on rafraîchit le cache).
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      var net = fetch(e.request).then(function (resp) {
        if (resp && resp.status === 200) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return resp;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});

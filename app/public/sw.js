'use strict';
// Service worker: guarda la app para abrirla sin conexión. Los datos (/api) nunca se cachean aquí;
// la app guarda sus capturas en el almacenamiento local y las sincroniza sola.
const VERSION = 'a5s-v40';
const BASICOS = ['/', '/manifest.webmanifest', '/icon.svg', '/favicon.png', '/danfoss.svg', '/i18n.js', '/5s.png', '/icon-180.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(BASICOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || /\/api\//.test(url.pathname)) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copia = res.clone(); caches.open(VERSION).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copia)); }
      return res;
    }).catch(() => caches.match(req.mode === 'navigate' ? '/' : req).then((r) => r || caches.match('/'))),
  );
});

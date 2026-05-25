const CACHE_NAME = 'gaycord-v7-1-shell';
const APP_SHELL = [
  '/',
  '/styles.css?v=7.0.1',
  '/mobile.css?v=7.1.0',
  '/app.js?v=7.0.1',
  '/mobile.js?v=7.1.0',
  '/manifest.webmanifest',
  '/brand/favicon.ico',
  '/brand/app-mark.png',
  '/brand/icon-64.png',
  '/brand/icon-192.png',
  '/brand/icon-512.png',
  '/brand/gaycord-logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (requestUrl.pathname.startsWith('/api') || requestUrl.pathname.startsWith('/socket.io') || requestUrl.pathname.startsWith('/uploads')) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
    return response;
  }).catch(() => caches.match(event.request)));
});
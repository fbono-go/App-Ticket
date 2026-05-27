const CACHE_NAME = 'area51-v1';
const urlsToCache = [
  '/App-Ticket/',
  '/App-Ticket/index.html',
  '/App-Ticket/manifest.json',
  '/App-Ticket/icons/icon-192x192.png',
  '/App-Ticket/icons/icon-512x512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache).catch(err => {
        console.log('Cache failed:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Network first para API calls
  if (event.request.url.includes('gored-proxy') || event.request.url.includes('api')) {
    event.respondWith(
      fetch(event.request)
        .then(response => response)
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache first para recursos estáticos
    event.respondWith(
      caches.match(event.request)
        .then(response => response || fetch(event.request))
    );
  }
});

const CACHE_NAME = 'shadow-app-v3';

const APP_SHELL = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './db.js',
    './audio.js',
    './editor.js',
    './manifest.json',
    './icons/icon.svg',
    './icons/icon-maskable.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.map((name) => (name !== CACHE_NAME ? caches.delete(name) : null))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // Cache-first with a network fallback keeps the app fully usable offline.
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) return cached;

            return fetch(request).then((response) => {
                if (response && response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
                }
                return response;
            }).catch(() => {
                if (request.mode === 'navigate') return caches.match('./index.html');
                return new Response('Offline', { status: 503, statusText: 'Offline' });
            });
        })
    );
});

const CACHE_NAME = 'github-fm-v2'; // version change করলেই পুরোনো ক্যাশ ক্লিন হবে
const urlsToCache = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
    // CDN resources (optional, but will work online only if not cached)
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/dracula.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/default.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/python/python.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/xml/xml.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/htmlmixed/htmlmixed.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/css/css.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/markdown/markdown.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/clike/clike.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/shell/shell.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/yaml/yaml.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/sql/sql.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js'
];

// Install event – cache all essential files
self.addEventListener('install', event => {
    console.log('[Service Worker] Install');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[Service Worker] Caching app shell');
                return cache.addAll(urlsToCache);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate event – clean old caches
self.addEventListener('activate', event => {
    console.log('[Service Worker] Activate');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[Service Worker] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch event
// - Navigation requests (index.html / page loads) -> NETWORK FIRST
//   এইখানেই আগের বাগ ছিল: cache-first দেওয়ার কারণে নতুন ডিপ্লয় (যেমন dark mode ফিক্স)
//   পুরনো cached HTML-এর কারণে ইউজার পর্যন্ত পৌঁছাচ্ছিল না।
// - বাকি static assets (JS/CSS/CDN libs) -> CACHE FIRST (পারফরম্যান্স ও অফলাইন সাপোর্টের জন্য)
self.addEventListener('fetch', event => {
    const req = event.request;
    const isNavigation = req.mode === 'navigate' ||
        (req.method === 'GET' && req.headers.get('accept') && req.headers.get('accept').includes('text/html'));

    if (isNavigation) {
        event.respondWith(
            fetch(req)
                .then(networkResponse => {
                    caches.open(CACHE_NAME).then(cache => cache.put(req, networkResponse.clone()));
                    return networkResponse;
                })
                .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
        );
        return;
    }

    event.respondWith(
        caches.match(req)
            .then(cachedResponse => {
                return cachedResponse || fetch(req).then(networkResponse => {
                    if (req.url.startsWith(self.location.origin) ||
                        req.url.includes('cdnjs.cloudflare.com')) {
                        return caches.open(CACHE_NAME).then(cache => {
                            cache.put(req, networkResponse.clone());
                            return networkResponse;
                        });
                    }
                    return networkResponse;
                });
            }).catch(() => {
                return new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' } });
            })
    );
});

// Listen for message to skip waiting
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
        self.clients.claim();
        self.clients.matchAll().then(clients => {
            clients.forEach(client => client.postMessage({ type: 'RELOAD' }));
        });
    }
});

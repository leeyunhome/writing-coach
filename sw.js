// 서비스 워커: 한 번 연 뒤에는 인터넷 없이도 연습과 채점이 되게 화면 파일과 글꼴을 보관합니다.
'use strict';

// 보관 형식을 바꿀 때만 숫자를 올립니다. 화면 파일은 아래에서 늘 새 것을 먼저 받으므로 올릴 필요가 없습니다.
const SHELL_CACHE = 'shell-v1';
const FONT_CACHE = 'fonts-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'style.css',
  'scoring.js',
  'app.js',
  'pilsa.html',
  'pilsa.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== SHELL_CACHE && key !== FONT_CACHE).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

/** 화면 파일: 새 것을 먼저 받고, 인터넷이 안 되면 보관해 둔 것을 씁니다. */
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

/** 구글 폰트: 한 번 받은 글꼴 조각은 바뀌지 않으므로 보관한 것을 먼저 씁니다. */
async function cacheFirst(request) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;   // AI 조언은 보관하지 않고 늘 서버로 보냅니다

  event.respondWith(networkFirst(request));
});

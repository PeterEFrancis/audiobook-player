importScripts('js/background-downloads-sw.js');
const SHELL_CACHE = 'folio-shell-v37';
const MEDIA_CACHE = 'folio-media-v1';
const ROOT = new URL(self.registration.scope);
const SHELL = [
  './', 'index.html', 'app.html', 'css/app.css', 'css/landing.css', 'css/dark.css', 'js/theme.js',
  'js/app.js', 'js/book-sheet.js', 'js/player.js', 'js/plex.js', 'js/db.js', 'js/downloads.js',
  'js/librivox.js', 'js/librivox-catalog.js', 'js/sample-migration.js', 'js/install.js', 'js/utils.js', 'js/plex-progress.js', 'js/servers.js', 'js/server-http.js', 'js/audiobookshelf.js', 'js/jellyfin.js', 'js/background-downloads-sw.js', 'manifest.webmanifest',
  'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable.png',
  'assets/cover-walden.svg', 'assets/cover-sea.svg', 'assets/cover-pride.svg',
];
const SHELL_URLS = new Set(SHELL.map(path => new URL(path, ROOT).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // A missing optional icon must not prevent audio downloads or installation.
    await Promise.allSettled(SHELL.map(async path => {
      const url = new URL(path, ROOT);
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (response.ok) await cache.put(url, response);
    }));
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      client.postMessage({ type: 'UPDATE_AVAILABLE' });
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('folio-shell-') && name !== SHELL_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'OFFLINE_READY' });
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'BACKGROUND_FETCH_CAPABILITY') event.ports[0]?.postMessage({ backgroundDownloads: true });
});

async function offlineMedia(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const response = await cache.match(request.url);
  if (!response) return new Response('This file is not downloaded. Connect to your server and download the book first.', { status: 404 });
  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  const range = request.headers.get('Range');
  if (!range) return request.method === 'HEAD' ? new Response(null, { status: 200, headers }) : response;
  // Blob slicing lets the browser serve a chapter without allocating a whole
  // multi-gigabyte audiobook as an ArrayBuffer in the service worker.
  const blob = await response.blob();
  const size = blob.size;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  let start;
  let end;
  if (match && (match[1] || match[2])) {
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    headers.set('Content-Range', `bytes */${size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(request.method === 'HEAD' ? null : blob.slice(start, end + 1), { status: 206, headers });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
  // Plex credentials and authenticated requests never enter the shell cache.
  if ([...url.searchParams.keys()].some(key => /token|authorization|api_?key/i.test(key)) || request.headers.has('Authorization')) return;
  const path = url.pathname.slice(ROOT.pathname.length);
  if ((request.method === 'GET' || request.method === 'HEAD') && (path.startsWith('offline-audio/') || path.startsWith('offline-art/'))) {
    event.respondWith(offlineMedia(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) return response;
      } catch {}
      const file = path === '' || path === 'index.html' ? 'index.html' : 'app.html';
      return await caches.match(new URL(file, ROOT)) || new Response('Open Folio once while online to prepare it for offline use.', { status: 503 });
    })());
    return;
  }
  const cleanURL = new URL(url);
  cleanURL.search = '';
  cleanURL.hash = '';
  if (SHELL_URLS.has(cleanURL.href)) {
    event.respondWith((async () => {
      const cached = await caches.match(cleanURL);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(cleanURL, response.clone());
      }
      return response;
    })());
  }
});

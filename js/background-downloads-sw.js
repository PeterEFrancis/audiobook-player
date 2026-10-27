// Loaded by the classic service worker; browser-owned transfers survive closed pages.
(() => {
  const CACHE = 'folio-media-v1';
  const positive = value => Math.max(0, Number(value) || 0);
  const complete = response => response?.headers.get('X-Folio-Complete') === '1';
  const active = (record, id) => record?.status === 'downloading' && record.backgroundId === id;
  class DownloadError extends Error {}
  let connection;

  function database() {
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('folio', 1);
      request.onupgradeneeded = () => {
        for (const name of ['books', 'progress', 'bookmarks', 'downloads', 'history', 'settings', 'sync']) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = null; };
        request.result.onclose = () => { connection = null; };
        resolve(request.result);
      };
      request.onerror = () => { connection = null; reject(request.error); };
    });
    return connection;
  }

  async function recordFor(bookId) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('downloads', 'readonly');
      const request = transaction.objectStore('downloads').get(bookId);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || request.error);
    });
  }

  async function save(bookId, id, updates) {
    const db = await database();
    const record = await new Promise((resolve, reject) => {
      const transaction = db.transaction('downloads', 'readwrite');
      const store = transaction.objectStore('downloads');
      const request = store.get(bookId);
      let saved;
      request.onsuccess = () => {
        if (!active(request.result, id)) return;
        saved = { ...request.result, ...(request.result.backgroundSavingAt ? { backgroundSavingAt: Date.now() } : {}), ...updates, updatedAt: Date.now() };
        store.put(saved);
      };
      transaction.oncomplete = () => resolve(saved);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || request.error);
    });
    if (record) {
      for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
        client.postMessage({ type: 'DOWNLOAD_CHANGE', record });
      }
    }
    return record;
  }

  async function audioResponse(response, file) {
    const type = response?.headers.get('Content-Type') || file.mime || 'audio/mpeg';
    if (response?.status === 200 && !response.body) {
      const error = new DownloadError('This browser could not save the background audio. Resume with Folio open.');
      error.backgroundUnavailable = true;
      throw error;
    }
    if (response?.status !== 200 || !response.body || response.type === 'opaque' || /^(text\/(html|xml)|application\/(?:[^;]+\+)?(?:json|xml))(?:;|$)/i.test(type)) {
      throw new DownloadError('The server did not return a complete audio file. Reconnect and resume.');
    }
    const expected = positive(response.headers.get('Content-Length'));
    const encoding = response.headers.get('Content-Encoding');
    const verifyLength = expected && (!encoding || encoding === 'identity');
    const reader = response.body.getReader();
    let bytes = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            if (!bytes || (verifyLength && bytes !== expected)) throw new DownloadError('The server returned an incomplete audio file. Resume to retry.');
            controller.close();
          } else {
            bytes += value.byteLength;
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(error);
          void reader.cancel().catch(() => {});
        }
      },
      cancel: reason => reader.cancel(reason),
    });
    const headers = new Headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Folio-Complete': '1' });
    if (verifyLength) headers.set('Content-Length', String(expected));
    return { response: new Response(stream, { headers }), bytes: () => bytes };
  }

  async function settle(event, outcome) {
    const id = event.registration.id;
    const match = /^folio:([^:]+):.+$/.exec(id);
    if (!match) return;
    const bookId = decodeURIComponent(match[1]);
    const current = () => recordFor(bookId);
    let record = await current();
    if (!active(record, id)) return;
    record = await save(bookId, id, { backgroundSavingAt: Date.now() });
    if (!record) return;
    const cache = await caches.open(CACHE);
    const root = new URL(self.registration.scope);
    const summaries = async () => {
      const trackBytes = {};
      for (const trackId of record.trackIds || []) {
        const url = new URL(`offline-audio/${encodeURIComponent(bookId)}/${encodeURIComponent(trackId)}`, root).href;
        const response = await cache.match(url);
        if (complete(response)) trackBytes[trackId] = positive(response.headers.get('Content-Length')) || positive(record.trackBytes?.[trackId]);
      }
      const bytes = Object.values(trackBytes).reduce((sum, size) => sum + size, 0);
      return { trackBytes, bytes, completedTracks: Object.keys(trackBytes).length };
    };
    let failure;
    let backgroundUnavailable = false;
    if (outcome !== 'abort') {
      for (const file of record.backgroundFiles || []) {
        if (!active(await current(), id)) return;
        let written = false;
        let committed = false;
        try {
          if (!complete(await cache.match(file.cacheURL))) {
            const fetched = await event.registration.match(file.url);
            if (!fetched) throw new DownloadError('A background audio download did not finish. Resume to retry.');
            const audio = await audioResponse(await fetched.responseReady, file);
            if (!active(await current(), id)) { await audio.response.body.cancel(); return; }
            written = true;
            await cache.put(file.cacheURL, audio.response);
            committed = true;
            if (!active(await current(), id)) { await cache.delete(file.cacheURL); return; }
            // Compression may prevent trusting the server's Content-Length.
            record.trackBytes = { ...record.trackBytes, [file.trackId]: audio.bytes() };
          }
          record = await save(bookId, id, await summaries());
          if (!record) return;
        } catch (error) {
          if (written && !committed) await cache.delete(file.cacheURL);
          backgroundUnavailable ||= error.backgroundUnavailable === true;
          failure = error.name === 'QuotaExceededError'
            ? 'Device storage is full. Remove a download or free space, then resume.'
            : error instanceof DownloadError ? error.message : 'The background download failed. Reconnect to your server and resume.';
        }
      }
    }
    if (!active(await current(), id)) return;
    const summary = await summaries();
    const finished = summary.completedTracks === (record.trackIds || []).length && summary.completedTracks > 0;
    if (finished && record.backgroundArtwork && outcome !== 'abort') {
      const artwork = record.backgroundArtwork;
      try {
        if (!await cache.match(artwork.cacheURL)) {
          const fetched = await event.registration.match(artwork.url);
          const response = await fetched?.responseReady;
          if (response?.ok && response.type !== 'opaque' && active(await current(), id)) {
            await cache.put(artwork.cacheURL, new Response(response.body, { headers: { 'Content-Type': response.headers.get('Content-Type') || 'image/jpeg' } }));
            if (!active(await current(), id)) { await cache.delete(artwork.cacheURL); return; }
          }
        }
      } catch {} // A missing cover must not discard downloaded audio.
    }
    const status = outcome === 'abort' ? 'paused' : finished ? 'complete' : 'error';
    await save(bookId, id, {
      ...summary, status,
      ...(finished ? { totalBytes: summary.bytes } : {}),
      error: status === 'error' ? failure || 'The background download did not finish. Reconnect to your server and resume.' : null,
      backgroundUnavailable: status === 'error' && backgroundUnavailable,
      backgroundId: null, backgroundFiles: null, backgroundArtwork: null, backgroundSavingAt: null,
    });
  }

  for (const [name, outcome] of [['backgroundfetchsuccess', 'success'], ['backgroundfetchfail', 'fail'], ['backgroundfetchabort', 'abort']]) {
    self.addEventListener(name, event => event.waitUntil(settle(event, outcome)));
  }
})();

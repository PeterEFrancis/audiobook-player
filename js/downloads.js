import { db } from './db.js';

const MEDIA_CACHE = 'folio-media-v1';
const ROOT = new URL('../', import.meta.url);
const positive = value => Math.max(0, Number(value) || 0);
const isComplete = response => response?.headers.get('X-Folio-Complete') === '1';
const abortError = () => new DOMException('Download paused.', 'AbortError');

export class DownloadManager extends EventTarget {
  constructor({ getServer, plex }) {
    super();
    this.getServer = getServer;
    this.plex = plex;
    this.jobs = new Map();
    this.backgrounds = new Map();
    this.backgroundAvailable = 'BackgroundFetchManager' in globalThis;
    this.running = false;
    navigator.serviceWorker?.addEventListener('message', event => {
      if (event.data?.type !== 'DOWNLOAD_CHANGE') return;
      const record = event.data.record;
      if (!record?.backgroundId) this.backgrounds.delete(record?.id);
      void this._backgroundChange(record);
    });
    globalThis.document?.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this._refreshBackground();
    });
    this.ready = this._recover();
  }

  get backgroundSupported() { return this.backgroundAvailable; }

  _notify(record) {
    if (record) this.dispatchEvent(new CustomEvent('change', { detail: { record: { ...record } } }));
  }

  async _backgroundChange(record) {
    if (record?.backgroundUnavailable) {
      this.backgroundBroken = true;
      this.backgroundAvailable = false;
      if (record.status === 'error' && globalThis.document && !document.hidden) {
        const book = await db.get('books', record.id);
        if (book) {
          try { await this.download(book); return; } catch {}
        }
      }
    }
    this._notify(record);
  }

  async _backgroundManager() {
    if (this.backgroundBroken) return null;
    const registration = await navigator.serviceWorker?.getRegistration(ROOT.href).catch(() => null);
    this.backgroundAvailable = !!registration?.backgroundFetch;
    if (!registration?.backgroundFetch || !registration.active) return null;
    // Older installed workers cannot persist Background Fetch completion events.
    const ready = await new Promise(resolve => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 1200);
      channel.port1.onmessage = event => {
        clearTimeout(timeout); channel.port1.close(); resolve(event.data?.backgroundDownloads === true);
      };
      registration.active.postMessage({ type: 'BACKGROUND_FETCH_CAPABILITY' }, [channel.port2]);
    });
    return ready ? registration.backgroundFetch : null;
  }

  async _refreshBackground() {
    for (const record of await db.all('downloads')) {
      if (record.mode === 'background' && record.backgroundId) {
        const registration = await navigator.serviceWorker?.getRegistration(ROOT.href).catch(() => null);
        const active = await registration?.backgroundFetch?.get(record.backgroundId).catch(() => null);
        if (active) this._watchBackground(record, active);
      } else if (this.backgrounds.has(record.id) || (record.status === 'error' && record.backgroundUnavailable)) {
        this.backgrounds.delete(record.id);
        await this._backgroundChange(record);
      }
    }
  }

  _watchBackground(record, registration) {
    if (this.backgrounds.get(record.id)?.id === registration.id) return;
    this.backgrounds.set(record.id, registration);
    const saved = Object.values(record.trackBytes || {}).reduce((sum, value) => sum + positive(value), 0);
    let reportedAt = 0;
    const progress = async () => {
      if (Date.now() - reportedAt < 600 && !registration.result) return;
      reportedAt = Date.now();
      const updated = await db.update('downloads', record.id, current => {
        if (current?.backgroundId !== registration.id || current.status !== 'downloading') return;
        return { ...current, bytes: Math.max(current.bytes || 0, saved + registration.downloaded), updatedAt: Date.now() };
      });
      this._notify(updated);
    };
    registration.addEventListener('progress', () => { void progress().catch(() => {}); });
    void progress().catch(() => {});
  }

  async _recover() {
    const registration = await navigator.serviceWorker?.getRegistration(ROOT.href).catch(() => null);
    this.backgroundAvailable ||= !!registration?.backgroundFetch;
    for (const record of await db.all('downloads')) {
      if (record.backgroundUnavailable) { this.backgroundBroken = true; this.backgroundAvailable = false; }
      if (record.status === 'downloading' || record.status === 'queued') {
        if (record.backgroundId) {
          const active = await registration?.backgroundFetch?.get(record.backgroundId).catch(() => null);
          if (active) { this._watchBackground(record, active); continue; }
          if (record.backgroundSavingAt && Date.now() - record.backgroundSavingAt < 600000) continue;
        }
        const bytes = record.trackBytes
          ? Object.values(record.trackBytes).reduce((sum, value) => sum + positive(value), 0)
          : record.bytes;
        await this._save({ ...record, bytes, status: 'paused', error: null, backgroundId: null, backgroundFiles: null, backgroundArtwork: null });
      }
    }
  }

  async _save(record) {
    record.updatedAt = Date.now();
    await db.put('downloads', record);
    this._notify(record);
    return record;
  }

  audioURL(bookId, trackId) {
    return new URL(`offline-audio/${encodeURIComponent(bookId)}/${encodeURIComponent(trackId)}`, ROOT).href;
  }

  artworkURL(bookId) {
    return new URL(`offline-art/${encodeURIComponent(bookId)}`, ROOT).href;
  }

  async hasTrack(bookId, trackId) {
    const cache = await caches.open(MEDIA_CACHE);
    return isComplete(await cache.match(this.audioURL(bookId, trackId)));
  }

  async list() {
    await this.ready;
    return (await db.all('downloads')).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async storage() {
    const estimate = await navigator.storage?.estimate?.() || {};
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
      available: Math.max(0, (estimate.quota || 0) - (estimate.usage || 0)),
      persisted: await navigator.storage?.persisted?.() || false,
    };
  }

  async requestPersistence() {
    return await navigator.storage?.persist?.() || false;
  }

  async download(book) {
    await this.ready;
    if (!book?.id || !book.tracks?.length) throw new Error('This book has no playable audio files.');
    const key = String(book.id);
    if (this.jobs.has(key)) return db.get('downloads', book.id);
    if (!('caches' in globalThis)) throw new Error('Offline downloads require HTTPS or localhost in a supported browser.');
    const previous = await db.get('downloads', book.id);
    if (previous?.backgroundId && previous.status === 'downloading') return previous;
    let finish;
    const job = { book, preparing: true, foregroundOnly: previous?.mode === 'background' && previous.status === 'error', controller: new AbortController(), done: new Promise(resolve => { finish = resolve; }), finish: () => finish() };
    this.jobs.set(key, job);
    const record = {
      ...previous,
      id: book.id,
      bookId: book.id,
      title: book.title,
      status: 'queued',
      bytes: previous?.bytes || 0,
      totalBytes: book.tracks.reduce((sum, track) => sum + positive(track.size), 0),
      completedTracks: previous?.completedTracks || 0,
      totalTracks: book.tracks.length,
      trackIds: book.tracks.map(track => track.id),
      trackBytes: previous?.trackBytes || {},
      error: null,
      mode: 'foreground', backgroundId: null, backgroundFiles: null, backgroundArtwork: null, backgroundSavingAt: null, backgroundUnavailable: false,
    };
    try {
      await db.put('books', book);
      await this._save(record);
      job.started = true;
      if (await this._startBackground(job, record)) {
        this.jobs.delete(key); job.finish();
        void this._pump();
        return await db.get('downloads', book.id);
      }
      job.preparing = false;
      job.started = false;
      void this._pump();
      return record;
    } catch (error) {
      this.jobs.delete(key);
      const current = await db.get('downloads', book.id);
      if (current && ['queued', 'downloading'].includes(current.status)) {
        await this._save({ ...current, status: job.controller.signal.aborted ? 'paused' : 'error', error: job.controller.signal.aborted ? null : error.message, backgroundId: null, backgroundFiles: null, backgroundArtwork: null });
      }
      job.finish();
      throw error;
    }
  }

  async _startBackground(job, record) {
    if (job.foregroundOnly) return false;
    const manager = await this._backgroundManager();
    if (!manager) return false;
    const { book, controller } = job;
    const cache = await caches.open(MEDIA_CACHE);
    const files = [], trackBytes = {};
    const server = await this.getServer(book.serverId);
    if (!server) return false;
    for (const track of book.tracks) {
      const cacheURL = this.audioURL(book.id, track.id);
      const saved = await cache.match(cacheURL);
      if (isComplete(saved)) trackBytes[track.id] = positive(record.trackBytes[track.id]) || positive(saved.headers.get('Content-Length')) || positive(track.size);
      else files.push({ url: await (this.plex.downloadURL || this.plex.mediaURL)(server, track), cacheURL, trackId: track.id, mime: track.mime, title: track.title });
    }
    if (!files.length) return false;
    let artwork;
    try {
      if (!(await cache.match(this.artworkURL(book.id)))) {
        const url = await this.plex.artworkURL(server, book);
        if (url) artwork = { url, cacheURL: this.artworkURL(book.id) };
      }
    } catch {}
    if (controller.signal.aborted) throw abortError();
    const backgroundId = `folio:${encodeURIComponent(book.id)}:${crypto.randomUUID()}`;
    Object.assign(record, {
      mode: 'background', status: 'downloading', backgroundId, backgroundFiles: files,
      backgroundArtwork: artwork || null, trackBytes, completedTracks: Object.keys(trackBytes).length,
      bytes: Object.values(trackBytes).reduce((a, b) => a + b, 0),
    });
    await this._save(record);
    try {
      const requests = [...files, ...(artwork ? [artwork] : [])].map(file => new Request(file.url, { credentials: 'omit', mode: 'cors', cache: 'no-store' }));
      const active = await manager.fetch(backgroundId, requests, {
        title: book.title.slice(0, 80), icons: [{ src: new URL('assets/icon-192.png', ROOT).href, sizes: '192x192', type: 'image/png' }],
      });
      if (controller.signal.aborted) {
        await this._save({ ...record, status: 'paused', backgroundId: null, backgroundFiles: null, backgroundArtwork: null });
        await active.abort(); throw abortError();
      }
      this._watchBackground(record, active);
      return true;
    } catch (error) {
      Object.assign(record, { mode: 'foreground', status: controller.signal.aborted ? 'paused' : 'queued', backgroundId: null, backgroundFiles: null, backgroundArtwork: null });
      await this._save(record);
      if (controller.signal.aborted) throw abortError();
      // Unsupported permissions or server restrictions retain the foreground queue.
      return false;
    }
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.size) {
        const pending = [...this.jobs.entries()].find(([, job]) => !job.preparing);
        if (!pending) break;
        const [key, job] = pending;
        job.started = true;
        try {
          await this._run(job);
        } catch (error) {
          const record = await db.get('downloads', job.book.id);
          if (record) {
            const aborted = job.controller.signal.aborted || error.name === 'AbortError';
            const message = error.name === 'QuotaExceededError'
              ? 'Device storage is full. Remove a download or free space, then resume.'
              : (error.message || 'Download failed. Reconnect to your server and resume.');
            await this._save({ ...record, status: aborted ? 'paused' : 'error', error: aborted ? null : message });
          }
        } finally {
          this.jobs.delete(key);
          job.finish();
        }
      }
    } finally {
      this.running = false;
    }
  }

  async _run(job) {
    const { book, controller } = job;
    const { signal } = controller;
    const cache = await caches.open(MEDIA_CACHE);
    const record = await db.get('downloads', book.id);
    record.status = 'downloading';
    record.bytes = 0;
    record.completedTracks = 0;
    const sizes = new Map(book.tracks.map(track => [String(track.id), positive(track.size)]));
    const completedBytes = () => Object.values(record.trackBytes).reduce((sum, bytes) => sum + positive(bytes), 0);
    const savedBytes = record.trackBytes;
    record.trackBytes = {};
    await this._save(record);
    let server;
    const getServer = async () => {
      if (!server) server = await this.getServer(book.serverId);
      if (!server) throw new Error('Reconnect to this book’s server to resume its download.');
      return server;
    };

    for (const track of book.tracks) {
      if (signal.aborted) throw abortError();
      const url = this.audioURL(book.id, track.id);
      const existing = await cache.match(url);
      if (isComplete(existing)) {
        record.trackBytes[track.id] = positive(savedBytes[track.id]) || positive(existing.headers.get('Content-Length')) || positive(track.size);
        sizes.set(String(track.id), record.trackBytes[track.id]);
        record.bytes = completedBytes();
        record.completedTracks++;
        record.totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
        await this._save(record);
        continue;
      }
      const mediaURL = await (this.plex.downloadURL || this.plex.mediaURL)(await getServer(), track);
      const response = await fetch(mediaURL, { signal, cache: 'no-store', credentials: 'omit' });
      const contentType = response.headers.get('Content-Type') || track.mime || 'audio/mpeg';
      if (response.status !== 200 || !response.body || response.type === 'opaque') {
        throw new Error(`Could not download ${track.title || 'audio file'} (${response.status || 'server unavailable'}).`);
      }
      if (/^(text\/(html|xml)|application\/(json|xml))/i.test(contentType)) {
        await response.body.cancel();
        throw new Error('The server returned a login page or error instead of audio. Reconnect to your server and resume.');
      }
      const expected = positive(response.headers.get('Content-Length'));
      if (expected) sizes.set(String(track.id), expected);
      record.totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
      const headers = new Headers({
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'X-Folio-Complete': '1',
      });
      const encoding = response.headers.get('Content-Encoding');
      const verifyLength = expected && (!encoding || encoding === 'identity');
      if (verifyLength) headers.set('Content-Length', String(expected));
      const reader = response.body.getReader();
      let received = 0;
      let reportedAt = 0;
      let progressWrite = Promise.resolve();
      const stream = new ReadableStream({
        pull: async streamController => {
          try {
            if (signal.aborted) throw abortError();
            const { done, value } = await reader.read();
            if (done) {
              if (verifyLength && received !== expected) throw new Error('The server returned an incomplete audio file. Resume to retry.');
              if (!received) throw new Error('The server returned an empty audio file.');
              streamController.close();
              return;
            }
            received += value.byteLength;
            record.bytes = completedBytes() + received;
            if (Date.now() - reportedAt >= 600) {
              reportedAt = Date.now();
              const snapshot = { ...record, trackBytes: { ...record.trackBytes } };
              progressWrite = progressWrite.then(() => this._save(snapshot));
              await progressWrite;
            }
            streamController.enqueue(value);
          } catch (error) {
            streamController.error(error);
            void reader.cancel().catch(() => {});
          }
        },
        cancel: reason => reader.cancel(reason),
      });
      try {
        await cache.put(url, new Response(stream, { status: 200, headers }));
        await progressWrite;
        if (signal.aborted) throw abortError();
        if (!isComplete(await cache.match(url))) throw new Error('The browser could not save this audio file.');
      } catch (error) {
        await cache.delete(url);
        await progressWrite.catch(() => {});
        record.bytes = completedBytes();
        await this._save(record);
        throw error;
      }
      record.trackBytes[track.id] = received;
      sizes.set(String(track.id), received);
      record.bytes = completedBytes();
      record.completedTracks++;
      record.totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
      await this._save(record);
    }

    if (signal.aborted) throw abortError();
    for (const track of book.tracks) {
      if (!isComplete(await cache.match(this.audioURL(book.id, track.id)))) {
        throw new Error('An audio file is missing. Resume to finish downloading this book.');
      }
    }
    // Artwork failures must not discard successfully downloaded audio.
    try {
      if (!(await cache.match(this.artworkURL(book.id)))) {
        const artwork = await this.plex.artworkURL(await getServer(), book);
        if (artwork) {
          const response = await fetch(artwork, { signal, cache: 'no-store', credentials: 'omit' });
          if (response.ok && response.type !== 'opaque') {
            await cache.put(this.artworkURL(book.id), new Response(response.body, {
              headers: { 'Content-Type': response.headers.get('Content-Type') || 'image/jpeg' },
            }));
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
    }
    record.status = 'complete';
    record.error = null;
    record.bytes = completedBytes();
    record.totalBytes = record.bytes;
    await this._save(record);
  }

  async cancel(bookId) {
    await this.ready;
    const key = String(bookId);
    const job = this.jobs.get(key);
    if (job) {
      job.controller.abort();
      if (job.started) {
        await job.done;
        return;
      }
      this.jobs.delete(key);
      job.finish();
    }
    const record = await db.get('downloads', bookId);
    if (record && record.status !== 'complete') {
      const backgroundId = record.backgroundId;
      this._notify(await db.update('downloads', bookId, current => {
        if (!current || current.status === 'complete') return;
        return { ...current, status: 'paused', error: null, backgroundId: null, backgroundFiles: null, backgroundArtwork: null, backgroundSavingAt: null, bytes: Object.values(current.trackBytes || {}).reduce((sum, value) => sum + positive(value), 0), updatedAt: Date.now() };
      }));
      if (backgroundId) {
        const registration = await navigator.serviceWorker?.getRegistration(ROOT.href).catch(() => null);
        const active = await registration?.backgroundFetch?.get(backgroundId).catch(() => null);
        await active?.abort().catch(() => {});
        this.backgrounds.delete(bookId);
      }
    }
  }

  async remove(bookId) {
    await this.cancel(bookId);
    const cache = await caches.open(MEDIA_CACHE);
    const prefix = new URL(`offline-audio/${encodeURIComponent(bookId)}/`, ROOT).href;
    for (const request of await cache.keys()) {
      if (request.url.startsWith(prefix) || request.url === this.artworkURL(bookId)) await cache.delete(request);
    }
    await db.delete('downloads', bookId);
    this.dispatchEvent(new CustomEvent('change', { detail: { record: { id: bookId, bookId, status: 'removed' } } }));
  }

  async clearAll() {
    await this.ready;
    for (const record of await this.list()) await this.remove(record.bookId);
    await caches.delete(MEDIA_CACHE);
  }
}

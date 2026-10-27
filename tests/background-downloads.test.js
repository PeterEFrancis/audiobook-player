import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/background-downloads-sw.js', import.meta.url), 'utf8');
const scope = 'https://example.com/folio/';
const sourceURL = 'https://plex.example/audio?X-Plex-Token=private';
const audioURL = `${scope}offline-audio/book/track`;
const backgroundId = 'folio:book:123';

function worker({ response, responseError, record: initial = {}, missing = false, afterPut } = {}) {
  const listeners = new Map();
  const records = new Map([['book', {
    id: 'book', bookId: 'book', status: 'downloading', mode: 'background', backgroundId,
    backgroundFiles: [{ url: sourceURL, cacheURL: audioURL, trackId: 'track', mime: 'audio/mpeg' }],
    backgroundArtwork: null, trackIds: ['track'], trackBytes: {}, totalTracks: 1,
    ...initial,
  }]]);
  const entries = new Map();
  const messages = [];
  const cache = {
    match: async url => entries.get(url)?.clone(),
    async put(url, value) {
      // CacheStorage consumes the whole stream before committing an entry.
      const bytes = await value.arrayBuffer();
      entries.set(url, new Response(bytes, { headers: value.headers }));
      await afterPut?.({ records, url });
    },
    delete: async url => entries.delete(url),
  };
  const database = {
    transaction() {
      let pending = 0;
      const transaction = {
        objectStore: () => ({
          get: key => request(() => structuredClone(records.get(key))),
          put: value => request(() => { records.set(value.id, structuredClone(value)); return value.id; }),
        }),
      };
      function request(operation) {
        pending++;
        const result = {};
        queueMicrotask(() => {
          try { result.result = operation(); result.onsuccess?.(); }
          catch (error) { transaction.error = error; transaction.onerror?.(); }
          pending--;
          queueMicrotask(() => { if (!pending) transaction.oncomplete?.(); });
        });
        return result;
      }
      return transaction;
    },
  };
  const indexedDB = {
    open() {
      const request = { result: database };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  };
  const self = {
    registration: { scope },
    addEventListener: (name, handler) => listeners.set(name, handler),
    clients: { matchAll: async () => [{ postMessage: value => messages.push(structuredClone(value)) }] },
  };
  vm.runInNewContext(source, { self, indexedDB, caches: { open: async () => cache }, URL, Response, Headers, ReadableStream, Date });
  return {
    records, entries, messages, cache,
    async finish(name = 'backgroundfetchsuccess') {
      let promise;
      listeners.get(name)({
        registration: {
          id: backgroundId,
          match: async url => missing || url !== sourceURL ? undefined : { responseReady: responseError ? Promise.reject(responseError) : Promise.resolve(response || new Response('audio', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '5' } })) },
        },
        waitUntil: value => { promise = value; },
      });
      await promise;
      return records.get('book');
    },
  };
}

test('background completion persists playable audio, byte counts, and notifies open clients', async () => {
  const app = worker();
  const record = await app.finish();
  assert.equal(record.status, 'complete');
  assert.equal(record.bytes, 5);
  assert.equal(record.completedTracks, 1);
  assert.equal(record.backgroundId, null);
  assert.equal(record.backgroundFiles, null);
  assert.equal(record.backgroundSavingAt, null);
  assert.ok(app.messages[0].record.backgroundSavingAt > 0);
  assert.equal(app.entries.get(audioURL).headers.get('X-Folio-Complete'), '1');
  assert.equal(await app.entries.get(audioURL).text(), 'audio');
  assert.equal(app.messages.at(-1).type, 'DOWNLOAD_CHANGE');
  assert.equal(app.messages.at(-1).record.status, 'complete');
});

test('missing background response keeps already cached tracks available for resuming', async () => {
  const app = worker({ missing: true, record: { trackIds: ['prior', 'track'], trackBytes: { prior: 3 } } });
  await app.cache.put(`${scope}offline-audio/book/prior`, new Response('old', { headers: { 'X-Folio-Complete': '1', 'Content-Length': '3' } }));
  const record = await app.finish('backgroundfetchfail');
  assert.equal(record.status, 'error');
  assert.equal(record.bytes, 3);
  assert.equal(record.completedTracks, 1);
  assert.match(record.error, /Resume|resume/);
  assert.equal(app.entries.size, 1);
});

test('an incomplete response never becomes playable offline audio', async () => {
  const app = worker({ response: new Response('short', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '20' } }) });
  const record = await app.finish();
  assert.equal(record.status, 'error');
  assert.match(record.error, /incomplete/);
  assert.equal(app.entries.size, 0);
});

test('failure imports successful responses before reporting the remaining missing track', async () => {
  const app = worker({ record: {
    trackIds: ['track', 'missing'],
    backgroundFiles: [
      { url: sourceURL, cacheURL: audioURL, trackId: 'track' },
      { url: 'https://plex.example/missing', cacheURL: `${scope}offline-audio/book/missing`, trackId: 'missing' },
    ],
  } });
  const record = await app.finish('backgroundfetchfail');
  assert.equal(record.status, 'error');
  assert.equal(record.bytes, 5);
  assert.equal(record.completedTracks, 1);
  assert.equal(app.entries.get(audioURL).headers.get('X-Folio-Complete'), '1');
});

test('browser cancellation pauses downloads without retaining credential URLs', async () => {
  const app = worker();
  const record = await app.finish('backgroundfetchabort');
  assert.equal(record.status, 'paused');
  assert.equal(record.error, null);
  assert.equal(record.backgroundId, null);
  assert.equal(record.backgroundFiles, null);
  assert.equal(app.entries.size, 0);
});

test('late completion cannot resurrect a cancelled or removed download', async () => {
  const cancelled = worker({ record: { status: 'paused', backgroundId: null } });
  assert.equal((await cancelled.finish()).status, 'paused');
  assert.equal(cancelled.entries.size, 0);
  const removed = worker();
  removed.records.delete('book');
  assert.equal(await removed.finish(), undefined);
  assert.equal(removed.entries.size, 0);
});

test('removal during cache persistence removes the late audio write and never recreates its record', async () => {
  const app = worker({ afterPut: ({ records }) => records.delete('book') });
  assert.equal(await app.finish(), undefined);
  assert.equal(app.entries.size, 0);
  assert.ok(app.messages.every(message => message.record.status === 'downloading'));
});

test('browser response errors never expose credential URLs in saved records', async () => {
  const app = worker({ responseError: new Error(`Could not retrieve ${sourceURL}`) });
  const record = await app.finish('backgroundfetchfail');
  assert.equal(record.status, 'error');
  assert.doesNotMatch(record.error, /private|X-Plex-Token|https:/);
  assert.equal(record.backgroundFiles, null);
});

test('an advertised background API with no audio body requests foreground fallback', async () => {
  const app = worker({ response: new Response(null, { status: 200, headers: { 'Content-Type': 'audio/x-wav' } }) });
  const record = await app.finish();
  assert.equal(record.status, 'error');
  assert.equal(record.backgroundUnavailable, true);
  assert.match(record.error, /Resume with Folio open/);
  assert.equal(app.entries.size, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const scope = 'https://example.com/projects/folio/';

function worker() {
  const listeners = new Map();
  const stores = new Map();
  const key = value => new URL(typeof value === 'string' ? value : value.url || value.href, scope).href;
  const cacheFor = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      match: async value => entries.get(key(value))?.clone(),
      put: async (value, response) => { entries.set(key(value), response.clone()); },
      delete: async value => entries.delete(key(value)),
      keys: async () => [...entries.keys()].map(url => new Request(url)),
    };
  };
  const caches = {
    open: async name => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    match: async value => {
      for (const name of stores.keys()) {
        const response = await cacheFor(name).match(value);
        if (response) return response;
      }
    },
  };
  const self = {
    registration: { scope },
    addEventListener: (name, listener) => listeners.set(name, listener),
    clients: { matchAll: async () => [], claim: async () => {} },
    skipWaiting: async () => {},
  };
  vm.runInNewContext(source, { self, caches, URL, Request, Response, Headers, importScripts: () => {}, fetch: async () => { throw new TypeError('Offline'); } });
  return {
    cache: cacheFor,
    async request(path, { range, headers = {}, method = 'GET', mode = 'cors' } = {}) {
      let pending;
      const requestHeaders = new Headers(headers);
      if (range) requestHeaders.set('Range', range);
      listeners.get('fetch')({
        request: { url: new URL(path, scope).href, headers: requestHeaders, method, mode },
        respondWith: value => { pending = value; },
      });
      return pending ? await pending : undefined;
    },
  };
}

for (const [range, expected, contentRange] of [
  ['bytes=2-5', '2345', 'bytes 2-5/10'],
  ['bytes=7-', '789', 'bytes 7-9/10'],
  ['bytes=-3', '789', 'bytes 7-9/10'],
  ['bytes=8-100', '89', 'bytes 8-9/10'],
]) {
  test(`offline audio serves ${range} as a correct partial response`, async () => {
    const app = worker();
    await app.cache('folio-media-v1').put('offline-audio/book/track', new Response('0123456789', { headers: { 'Content-Type': 'audio/mpeg' } }));
    const response = await app.request('offline-audio/book/track', { range });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(expected.length));
    assert.equal(await response.text(), expected);
  });
}

test('out-of-bounds and empty suffix ranges return 416 with the stored size', async () => {
  const app = worker();
  await app.cache('folio-media-v1').put('offline-audio/book/track', new Response('0123456789'));
  for (const range of ['bytes=10-', 'bytes=7-2', 'bytes=-0']) {
    const response = await app.request('offline-audio/book/track', { range });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
  }
});

test('offline navigation selects the landing or app shell within a GitHub Pages subpath', async () => {
  const app = worker();
  await app.cache('folio-shell-v39').put('index.html', new Response('Landing page'));
  await app.cache('folio-shell-v39').put('app.html', new Response('Audiobook player'));
  assert.equal(await (await app.request('./', { mode: 'navigate' })).text(), 'Landing page');
  assert.equal(await (await app.request('index.html', { mode: 'navigate' })).text(), 'Landing page');
  assert.equal(await (await app.request('app.html?book=example', { mode: 'navigate' })).text(), 'Audiobook player');
});

test('Plex credentials, authenticated requests, and other origins bypass service-worker caching', async () => {
  const app = worker();
  assert.equal(await app.request('app.html?X-Plex-Token=private-token'), undefined);
  assert.equal(await app.request('app.html?ApiKey=private-token'), undefined);
  assert.equal(await app.request('app.html?api_key=private-token'), undefined);
  assert.equal(await app.request('app.html', { headers: { Authorization: 'Bearer private-token' } }), undefined);
  assert.equal(await app.request('https://plex.example/library/parts/1?X-Plex-Token=private-token'), undefined);
  assert.equal(await app.request('https://example.com/unrelated/app.html'), undefined);
});

test('missing offline files report an explicit error, and HEAD ranges have no body', async () => {
  const app = worker();
  assert.equal((await app.request('offline-audio/book/missing')).status, 404);
  await app.cache('folio-media-v1').put('offline-audio/book/track', new Response('0123456789'));
  const response = await app.request('offline-audio/book/track', { method: 'HEAD', range: 'bytes=2-5' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Length'), '4');
  assert.equal(await response.text(), '');
});

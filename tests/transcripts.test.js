import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptManager } from '../js/transcripts.js';

function setup(transcript) {
  const responses = new Map(), calls = [];
  const cache = {
    async match(key) { return responses.get(key)?.clone(); },
    async put(key, response) { responses.set(key, response.clone()); },
    async delete(key) { return responses.delete(key); },
  };
  const plex = { async transcript(server, track, options) { calls.push({ server, track, options }); return transcript(server, track, options); } };
  const manager = new TranscriptManager({ plex, getServer: id => ({ id, token: 'secret-token', url: 'https://plex.example' }), cacheStorage: { async open(name) { assert.equal(name, 'folio-transcripts-v1'); return cache; } }, root: 'https://folio.test/audiobook-player/' });
  const book = { id: 'book', serverId: 'server-one', tracks: [{ id: 'track-one' }] };
  return { manager, book, track: book.tracks[0], responses, calls, cache };
}
const lrc = { text: '[00:01.00]One\n[00:03.00]Two\n[00:05.00]', offset: 2, source: '/library/streams/1?X-Plex-Token=secret-token#fragment' };

test('successful LRC is cached without credentials and remains readable offline with shifted timestamps', async t => {
  const { manager, book, track, responses, calls } = setup(() => lrc);
  const loaded = await manager.load(book, track);
  assert.equal(loaded.cues[0].start, 3);
  assert.equal(loaded.cues[0].end, 5);
  assert.equal(loaded.source, '/library/streams/1');
  const [key, response] = [...responses.entries()][0];
  assert.equal(key, 'https://folio.test/audiobook-player/offline/transcripts/server-one/track-one.json');
  assert.doesNotMatch(await response.clone().text(), /secret-token|plex\.example/);
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'navigator', prior) : delete globalThis.navigator);
  assert.deepEqual(await manager.load(book, track, { refresh: true }), loaded);
  assert.equal(calls.length, 1);
});

test('misses are not cached, refresh sees added LRC, and explicit removal clears stale cached text', async () => {
  let value = null;
  const { manager, book, track, responses, calls } = setup(() => value);
  assert.equal(await manager.load(book, track), null);
  assert.equal(responses.size, 0);
  value = lrc;
  assert.ok(await manager.load(book, track));
  value = null;
  assert.ok(await manager.load(book, track));
  assert.equal(calls.length, 2);
  assert.equal(await manager.load(book, track, { refresh: true }), null);
  assert.equal(responses.size, 0);
});

test('network failures can reuse cached text while uncached failures remain actionable', async () => {
  let fail = false;
  const { manager, book, track } = setup(() => { if (fail) throw new Error('Server unavailable'); return lrc; });
  const cached = await manager.load(book, track);
  fail = true;
  assert.deepEqual(await manager.load(book, track, { refresh: true }), cached);
  await assert.rejects(manager.load(book, { id: 'uncached' }), /Server unavailable/);
});

test('abort while fetching or committing cannot leave a transcript cached', async () => {
  let resolve;
  const { manager, book, track, responses, cache } = setup(() => new Promise(done => { resolve = done; }));
  const controller = new AbortController();
  const pending = manager.load(book, track, { signal: controller.signal });
  while (!resolve) await new Promise(done => setImmediate(done));
  controller.abort(); resolve(lrc);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(responses.size, 0);
  manager.plex.transcript = async () => lrc;
  const duringWrite = new AbortController(), put = cache.put;
  cache.put = async (...args) => { await put(...args); duringWrite.abort(); };
  await assert.rejects(manager.load(book, track, { signal: duringWrite.signal }), { name: 'AbortError' });
  assert.equal(responses.size, 0);
});

test('whole-book caching uses at most two requests and removal preserves other servers', async () => {
  let active = 0, peak = 0;
  const { manager, book, responses } = setup(async (_server, track) => {
    active++; peak = Math.max(peak, active);
    await new Promise(done => setImmediate(done)); active--;
    if (track.id === 'missing') throw new Error('Optional failure');
    return lrc;
  });
  book.tracks = [{ id: 'one' }, { id: 'two' }, { id: 'missing' }];
  await manager.download(book);
  await manager.load({ ...book, serverId: 'server-two' }, book.tracks[0]);
  assert.equal(peak, 2);
  assert.equal(responses.size, 3);
  await manager.remove(book);
  assert.equal(responses.size, 1);
  assert.match([...responses.keys()][0], /server-two/);
});

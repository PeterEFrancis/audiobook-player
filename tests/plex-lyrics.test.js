import test from 'node:test';
import assert from 'node:assert/strict';
import { PlexClient } from '../js/plex.js';
import { ServerClient } from '../js/servers.js';

const server = { id: 'plex', url: 'https://plex.example:32400', token: 'test-token' };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const metadata = parts => ({ MediaContainer: { totalSize: 1, Metadata: [{ ratingKey: '10', duration: 120000, Chapter: [], Media: [{ Part: parts }] }] } });

test('tracks preserve safe timed lyric descriptors separately from audio streams', async t => {
  t.mock.method(globalThis, 'fetch', async () => json(metadata([{ id: '20', key: '/library/parts/20/file.m4b', Stream: [
    { id: '1', streamType: 2, codec: 'aac' },
    { id: '2', streamType: '4', key: '/library/streams/2?X-Plex-Token=should-not-persist', format: 'lrc', timed: '1' },
    { id: '3', streamType: 4, key: '//attacker.example/lyrics', format: 'lrc' },
    { id: '4', streamType: 4, key: 'https://name:password@plex.example:32400/lyrics', format: 'lrc' },
  ] }])));
  const [track] = await new PlexClient().tracks(server, { ratingKey: 'book' });
  assert.equal(track.partId, '20');
  assert.deepEqual(track.lyrics, [{ id: '2', key: '/library/streams/2', format: 'lrc', timed: true, provider: '' }]);
});

test('fresh metadata discovers a new LRC for a cached multipart track and uses file-relative timing', async t => {
  const requests = [];
  const text = '[00:01.20]Café\n[00:03.00]Next line\n';
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address);
    requests.push(url.pathname);
    assert.equal(url.origin, new URL(server.url).origin);
    assert.equal(url.searchParams.get('X-Plex-Token'), server.token);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    if (url.pathname === '/library/metadata/10') return json(metadata([
      { id: '19', key: '/library/parts/19/file.m4b', duration: 60000, Stream: [{ id: '99', streamType: 4, format: 'lrc' }] },
      { id: '20', key: '/library/parts/20/new/file.m4b', duration: 60000, Stream: [{ id: '100', streamType: 4, format: 'lrc', timed: 1 }] },
    ]));
    assert.equal(url.pathname, '/library/streams/100');
    return new Response(text, { headers: { 'Content-Type': 'text/plain' } });
  });
  const result = await new ServerClient().transcript(server, { ratingKey: '10', key: '/library/parts/20/old/file.m4b', partOffset: 60, lyrics: [] });
  assert.deepEqual(result, { text, offset: 0, source: '/library/streams/100' });
  assert.deepEqual(requests, ['/library/metadata/10', '/library/streams/100']);
});

test('missing, untimed and outside-server lyrics never trigger transcript requests', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json(metadata([{ key: '/audio.m4b', Stream: [
    { streamType: 4, key: 'https://attacker.example/file.lrc', format: 'lrc', timed: 1 },
    { streamType: 4, key: '/plain.txt', format: 'txt', timed: 0 },
  ] }])); });
  assert.equal(await new PlexClient().transcript(server, { ratingKey: '10', key: '/audio.m4b' }), null);
  assert.equal(calls, 1);
  assert.equal(await new ServerClient().transcript({ provider: 'librivox' }, {}), null);
});

test('transcript downloads reject redirects and bound both declared and streamed size', async t => {
  const client = new PlexClient();
  const track = { ratingKey: '10', key: '/audio.m4b' };
  let response;
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    if (new URL(address).pathname === '/library/metadata/10') return json(metadata([{ key: '/audio.m4b', Stream: [{ id: '100', streamType: 4, format: 'lrc' }] }]));
    assert.equal(options.redirect, 'error');
    return response;
  });
  response = Response.redirect('https://attacker.example/file.lrc', 302);
  await assert.rejects(client.transcript(server, track), /HTTP 302/);
  response = new Response('', { headers: { 'Content-Length': String(5 * 1024 * 1024 + 1) } });
  await assert.rejects(client.transcript(server, track), /too large/);
  let canceled = false;
  response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); },
    cancel() { canceled = true; },
  }));
  await assert.rejects(client.transcript(server, track), /too large/);
  assert.equal(canceled, true);
});

test('transcript cancellation propagates and authorization failures are not reported as missing text', async t => {
  const client = new PlexClient();
  const controller = new AbortController();
  const reason = new DOMException('Closed read-along', 'AbortError');
  controller.abort(reason);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.signal.aborted) throw options.signal.reason;
    return new Response(null, { status: 403 });
  });
  await assert.rejects(client.transcript(server, { ratingKey: '10' }, { signal: controller.signal }), error => error === reason);
  await assert.rejects(client.transcript(server, { ratingKey: '10' }), error => error.status === 403);
});

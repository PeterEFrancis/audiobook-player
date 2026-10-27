import test from 'node:test';
import assert from 'node:assert/strict';
import { PlexClient } from '../js/plex.js';

const server = { id: 'server', url: 'https://plex.example:32400', token: 'test-only-token' };
const client = () => new PlexClient({ clientId: 'folio-test' });
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('Plex pagination advances container offsets, deduplicates albums, and converts wire milliseconds', async t => {
  const offsets = [];
  t.mock.method(globalThis, 'fetch', async address => {
    const url = new URL(address);
    const offset = url.searchParams.get('X-Plex-Container-Start');
    offsets.push(offset);
    assert.equal(url.searchParams.get('X-Plex-Container-Size'), '200');
    assert.equal(url.searchParams.get('type'), '9');
    return json({ MediaContainer: { offset: Number(offset), totalSize: 4, Metadata: offset === '0'
      ? [{ ratingKey: '1', title: 'First', duration: 90000, viewOffset: 12500 }, { ratingKey: '2', title: 'Second' }]
      : [{ ratingKey: '2', title: 'Second' }, { ratingKey: '3', title: 'Third' }],
    } });
  });
  const progress = [];
  const books = await client().books(server, '7', { onProgress: value => progress.push(value.loaded) });
  assert.deepEqual(offsets, ['0', '2']);
  assert.deepEqual(books.map(book => book.id), ['server:1', 'server:2', 'server:3']);
  assert.deepEqual(progress, [2, 3]);
  assert.equal(books[0].duration, 90);
  assert.equal(books[0].viewOffset, 12.5);
});

test('tracks use disc/track order and split multipart chapters into local seconds without duplicating encodings', async t => {
  const metadata = [
    { ratingKey: '20', title: 'Long track', parentIndex: 2, index: 1, duration: 120000, viewOffset: 70000,
      Chapter: [
        { id: 1, title: 'One', startTimeOffset: 0, endTimeOffset: 40000 },
        { id: 2, title: 'Two', startTimeOffset: 40000, endTimeOffset: 75000 },
        { id: 3, title: 'Three', startTimeOffset: 75000, endTimeOffset: 120000 },
      ],
      Media: [
        { container: 'm4b', Part: [
          { id: 'a', key: '/library/parts/a/file.m4b', duration: 60000, size: 100 },
          { id: 'b', key: '/library/parts/b/file.m4b', duration: 60000, size: 100 },
        ] },
        { container: 'mp3', Part: [{ id: 'alternative', key: '/library/parts/alternative/file.mp3', duration: 120000 }] },
      ],
    },
    { ratingKey: '11', title: 'Second', parentIndex: 1, index: 2, duration: 30000, Chapter: [], Media: [{ container: 'mp3', Part: [{ key: '/second.mp3' }] }] },
    { ratingKey: '10', title: 'First', parentIndex: 1, index: 1, duration: 10000, Chapter: [], Media: [{ container: 'mp3', Part: [{ key: '/first.mp3' }] }] },
  ];
  t.mock.method(globalThis, 'fetch', async () => json({ MediaContainer: { totalSize: metadata.length, Metadata: metadata } }));
  const tracks = await client().tracks(server, { ratingKey: 'book' });
  assert.deepEqual(tracks.map(track => track.id), ['server:10', 'server:11', 'server:20:a', 'server:20:b']);
  assert.deepEqual(tracks.map(track => track.duration), [10, 30, 60, 60]);
  assert.equal(tracks[2].mime, 'audio/mp4');
  assert.deepEqual(tracks[2].chapters.map(({ start, end }) => [start, end]), [[0, 40], [40, 60]]);
  assert.deepEqual(tracks[3].chapters.map(({ start, end }) => [start, end]), [[0, 15], [15, 60]]);
  assert.equal(tracks[3].partOffset, 60);
  assert.equal(tracks[3].viewOffset, 10);
  assert.equal(tracks[3].metadataDuration, 120);
});

test('timeline converts local part position back to Plex metadata milliseconds', async t => {
  let captured;
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    captured = new URL(address);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    return new Response(null, { status: 204 });
  });
  await client().timeline(server, { ratingKey: '20', duration: 60, partOffset: 60, metadataDuration: 120 }, { position: 12.345, state: 'paused' });
  assert.equal(captured.pathname, '/:/timeline');
  assert.equal(captured.searchParams.get('time'), '72345');
  assert.equal(captured.searchParams.get('duration'), '120000');
  assert.equal(captured.searchParams.get('playbackTime'), '12345');
  assert.equal(captured.searchParams.get('state'), 'paused');
});

test('server credentials cannot follow absolute or protocol-relative media keys to another origin', () => {
  const plex = client();
  assert.throws(() => plex.mediaURL(server, { key: 'https://other.example/audio.mp3' }), /outside this server/);
  assert.throws(() => plex.mediaURL(server, { key: '//other.example/audio.mp3' }), /outside this server/);
  const url = new URL(plex.mediaURL(server, { key: '/library/parts/1/audio.mp3' }));
  assert.equal(url.origin, new URL(server.url).origin);
  assert.equal(url.searchParams.get('X-Plex-Token'), server.token);
});

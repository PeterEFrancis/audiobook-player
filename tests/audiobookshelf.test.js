import test from 'node:test';
import assert from 'node:assert/strict';
import { AudiobookshelfClient } from '../js/audiobookshelf.js';
import { plexProgress } from '../js/plex-progress.js';

const server = { id: 'abs', provider: 'audiobookshelf', url: 'https://audio.example/shelf', token: 'test-token', canDownload: true };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const client = options => new AudiobookshelfClient({ clientId: 'folio-test', ...options });

test('Audiobookshelf login preserves proxy paths and stores a token rather than the password', async t => {
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    assert.equal(new URL(address).pathname, '/shelf/login');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(JSON.parse(options.body), { username: 'reader', password: 'secret' });
    assert.equal(options.headers['x-return-tokens'], 'true');
    return json({ user: { id: 'reader-id', token: 'persistent-token', accessToken: 'temporary-token', permissions: { download: false } } });
  });
  const connection = await client().login({ url: `${server.url}/`, username: ' reader ', password: 'secret' });
  assert.equal(connection.url, server.url);
  assert.equal(connection.provider, 'audiobookshelf');
  assert.equal(connection.token, 'persistent-token');
  assert.equal(connection.canDownload, false);
  assert.equal(connection.password, undefined);
  assert.equal(connection.id.includes('secret'), false);
});

test('Audiobookshelf paginates audio books and includes zero progress rows for unplayed resets', async t => {
  const pages = [];
  t.mock.method(globalThis, 'fetch', async address => {
    const url = new URL(address);
    if (url.pathname.endsWith('/api/me')) return json({ mediaProgress: [{ libraryItemId: 'b', duration: 120, currentTime: 75, lastUpdate: 1720000000123, isFinished: false }] });
    pages.push(Number(url.searchParams.get('page')));
    return json({ total: 3, results: pages.length === 1 ? [
      { id: 'a', mediaType: 'book', media: { numAudioFiles: 1, duration: 50, metadata: { title: 'A' } } },
      { id: 'ebook', mediaType: 'book', media: { numAudioFiles: 0, metadata: { title: 'Ebook' } } },
    ] : [{ id: 'b', mediaType: 'book', media: { numAudioFiles: 2, duration: 120, coverPath: '/metadata/cover.jpg', metadata: { title: 'B', authorName: 'Author' } } }] });
  });
  const abs = client(), books = await abs.books(server, 'library');
  assert.deepEqual(pages, [0, 1]);
  assert.deepEqual(books.map(book => book.ratingKey), ['a', 'b']);
  const rows = await abs.libraryProgress(server, 'library');
  assert.equal(rows[0].viewOffset, 0);
  assert.equal(rows[0].viewCount, 0);
  assert.equal(rows[1].viewOffset, 75);
  assert.equal(rows[1].lastViewedAt, 1720000000.123);
});

test('Audiobookshelf file metadata maps whole-book progress and chapters into local file positions', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ media: { duration: 120,
    tracks: [
      { ino: 'second', index: 2, startOffset: 60, duration: 60, mimeType: 'audio/mp4', metadata: { filename: 'second.m4b', size: 200 } },
      { ino: 'first', index: 1, startOffset: 0, duration: 60, mimeType: 'audio/mpeg', metadata: { filename: 'first.mp3', size: 100 }, contentUrl: 'https://evil.example/file' },
    ], chapters: [{ id: '1', title: 'One', start: 0, end: 40 }, { id: '2', title: 'Two', start: 40, end: 80 }, { id: '3', title: 'Three', start: 80, end: 120 }],
  }, userMediaProgress: { currentTime: 75, duration: 120, lastUpdate: 1720000000000 } }));
  const abs = client(), book = { id: 'abs:book', ratingKey: 'book', duration: 120 };
  book.tracks = await abs.tracks(server, book);
  assert.deepEqual(book.tracks.map(track => [track.partOffset, track.duration, track.viewOffset]), [[0, 60, 60], [60, 60, 15]]);
  assert.deepEqual(book.tracks[1].chapters.map(chapter => [chapter.start, chapter.end]), [[0, 20], [20, 60]]);
  assert.equal(book.tracks[1].mime, 'audio/mp4');
  assert.equal(new URL(abs.mediaURL(server, book.tracks[0])).pathname, '/shelf/api/items/book/file/first');
  const progress = plexProgress(book, await abs.bookProgress(server, book));
  assert.equal(progress.trackIndex, 1);
  assert.equal(progress.position, 15);
  assert.equal(progress.elapsed, 75);
});

test('Audiobookshelf sends absolute book progress and explicit finished/unplayed changes', async t => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    assert.equal(new URL(address).pathname, '/shelf/api/me/progress/book');
    assert.equal(options.method, 'PATCH');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    sent.push(JSON.parse(options.body));
    return new Response('OK');
  });
  const abs = client();
  await abs.timeline(server, { ratingKey: 'book', partOffset: 60, metadataDuration: 120, duration: 60 }, { position: 15, state: 'paused' });
  await abs.markPlayed(server, { ratingKey: 'book', duration: 120 }, true);
  await abs.markPlayed(server, { ratingKey: 'book', duration: 120 }, false);
  assert.deepEqual(sent, [
    { duration: 120, currentTime: 75, progress: 0.625, isFinished: false },
    { duration: 120, currentTime: 120, progress: 1, isFinished: true },
    { duration: 120, currentTime: 0, progress: 0, isFinished: false },
  ]);
});

test('Audiobookshelf media URLs stay within the configured server and download permission is enforced', () => {
  const abs = client(), track = { key: 'api/items/book/file/ino' };
  const url = new URL(abs.downloadURL(server, track));
  assert.equal(url.pathname, '/shelf/api/items/book/file/ino/download');
  assert.equal(url.searchParams.get('token'), 'test-token');
  assert.throws(() => abs.downloadURL({ ...server, canDownload: false }, track), /permission/);
  for (const key of ['https://evil.example/file', '//evil.example/file', '../outside']) assert.throws(() => abs.mediaURL(server, { key }), /outside/);
});

test('Audiobookshelf refreshes modern sessions and persists rotated credentials before retrying', async t => {
  const connection = { ...server, token: 'expired-token', refreshToken: 'refresh-one' };
  let saved, denied = false;
  const abs = client({ onServerChanged: async value => { saved = { ...value }; } });
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    if (new URL(address).pathname.endsWith('/auth/refresh')) {
      assert.equal(options.headers['x-refresh-token'], 'refresh-one');
      assert.equal(options.headers.Authorization, undefined);
      return json({ user: { accessToken: 'new-token', refreshToken: 'refresh-two' } });
    }
    if (!denied) { denied = true; return new Response(null, { status: 401 }); }
    assert.equal(saved.token, 'new-token');
    assert.equal(options.headers.Authorization, 'Bearer new-token');
    return json({ libraries: [{ id: 'books', mediaType: 'book', name: 'Books' }, { id: 'podcasts', mediaType: 'podcast', name: 'Podcasts' }] });
  });
  assert.deepEqual(await abs.libraries(connection), [{ id: 'books', title: 'Books', type: 'book' }]);
  assert.equal(connection.refreshToken, 'refresh-two');
});

test('Audiobookshelf finished multipart tracks round-trip as finished rather than an active replay', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ media: { duration: 120, tracks: [
    { ino: 'first', startOffset: 0, duration: 60 }, { ino: 'second', startOffset: 60, duration: 60 },
  ] }, userMediaProgress: { currentTime: 120, duration: 120, isFinished: true, lastUpdate: 1720000000000 } }));
  const abs = client(), book = { id: 'abs:book', ratingKey: 'book', duration: 120, leafCount: 1 };
  book.tracks = await abs.tracks(server, book);
  assert.deepEqual(book.tracks.map(track => track.viewOffset), [0, 0]);
  const rows = [...new Map(book.tracks.map(track => [track.ratingKey, { ...track, duration: track.metadataDuration }])).values()];
  const progress = plexProgress(book, rows);
  assert.equal(progress.completed, true);
  assert.equal(progress.elapsed, 120);
  assert.equal(progress.trackIndex, 1);
  assert.equal(progress.position, 60);
});

test('Audiobookshelf concurrent catalog/progress refresh shares fresh pages including newly added books', async t => {
  let pages = 0, refresh = 0;
  t.mock.method(globalThis, 'fetch', async address => {
    if (new URL(address).pathname.endsWith('/api/me')) return json({ mediaProgress: [{ libraryItemId: 'new', duration: 90, currentTime: 30 }] });
    pages++;
    const results = [{ id: 'old', mediaType: 'book', media: { numAudioFiles: 1, duration: 60, metadata: { title: 'Old' } } }];
    if (refresh) results.push({ id: 'new', mediaType: 'book', media: { numAudioFiles: 1, duration: 90, metadata: { title: 'New' } } });
    return json({ total: results.length, results });
  });
  const abs = client();
  await Promise.all([abs.books(server, 'library'), abs.libraryProgress(server, 'library')]);
  assert.equal(pages, 1);
  refresh++;
  const [books, progress] = await Promise.all([abs.books(server, 'library'), abs.libraryProgress(server, 'library')]);
  assert.equal(pages, 2);
  assert.deepEqual(books.map(book => book.ratingKey), ['old', 'new']);
  assert.equal(progress.find(row => row.ratingKey === 'new').viewOffset, 30);
});

test('Audiobookshelf queued mark actions recover duration from minimal book metadata', async t => {
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    if (options.method === 'GET') return json({ media: { duration: 180 } });
    assert.deepEqual(JSON.parse(options.body), { duration: 180, currentTime: 180, progress: 1, isFinished: true });
    return new Response('OK');
  });
  await client().markPlayed(server, { ratingKey: 'book' }, true);
});

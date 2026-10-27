import test from 'node:test';
import assert from 'node:assert/strict';
import { JellyfinClient } from '../js/jellyfin.js';
import { plexProgress } from '../js/plex-progress.js';

const server = { id: 'jellyfin:server', provider: 'jellyfin', url: 'https://media.example/jellyfin', token: 'test-token', userId: 'reader' };
const client = provider => new JellyfinClient({ clientId: 'folio-test', provider });
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const tick = seconds => seconds * 10000000;

test('Jellyfin password login uses MediaBrowser authorization, preserves proxy base path and download permissions', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address); calls.push(url.pathname);
    assert.match(options.headers.Authorization, /^MediaBrowser /);
    assert.doesNotMatch(options.headers.Authorization, /Bearer/);
    if (url.pathname.endsWith('/AuthenticateByName')) {
      assert.deepEqual(JSON.parse(options.body), { Username: 'reader', Pw: 'password' });
      return json({ AccessToken: 'test-token', ServerId: 'server', User: { Id: 'reader', Name: 'Reader', Policy: { EnableContentDownloading: false } } });
    }
    assert.match(options.headers.Authorization, /Token="test-token"/);
    return json({ Id: 'server', ServerName: 'Library' });
  });
  const result = await client().login({ url: server.url + '/', username: ' reader ', password: 'password' });
  assert.equal(result.id, 'jellyfin:server');
  assert.equal(result.url, server.url);
  assert.equal(result.canDownload, false);
  assert.deepEqual(calls, ['/jellyfin/Users/AuthenticateByName', '/jellyfin/System/Info/Public']);
});

test('Emby token validation uses current-user endpoint and Emby token header', async t => {
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    assert.equal(options.headers['X-Emby-Token'], server.token);
    assert.match(options.headers.Authorization, /^Emby /);
    assert.doesNotMatch(options.headers.Authorization, /Token=/);
    return json(new URL(address).pathname.endsWith('/Me') ? { Id: 'reader', ServerId: 'server' } : { Id: 'server', ServerName: 'Emby books' });
  });
  const result = await client('emby').validateServer(server);
  assert.equal(result.id, 'emby:server');
  assert.equal(result.provider, 'emby');
});

test('catalog pagination groups album tracks, includes standalone audiobooks, and excludes ebooks', async t => {
  const items = [
    { Id: 'album', Type: 'MusicAlbum', Name: 'Collected', AlbumArtists: [{ Name: 'Author', Id: 'author' }], ImageTags: { Primary: 'cover' } },
    { Id: 'second', Type: 'Audio', Name: 'Track 2', AlbumId: 'album', ParentIndexNumber: 2, IndexNumber: 1, RunTimeTicks: tick(90), UserData: { Played: false, PlaybackPositionTicks: tick(25) } },
    { Id: 'first', Type: 'Audio', Name: 'Track 1', AlbumId: 'album', ParentIndexNumber: 1, RunTimeTicks: tick(30), UserData: { Played: true } },
    { Id: 'standalone', Type: 'AudioBook', Name: 'A book', RunTimeTicks: tick(300) },
    { Id: 'ebook', Type: 'Book', Name: 'A PDF', Container: 'pdf', MediaType: 'Book' },
  ];
  const offsets = [];
  t.mock.method(globalThis, 'fetch', async address => {
    const url = new URL(address), offset = Number(url.searchParams.get('StartIndex')); offsets.push(offset);
    assert.equal(url.pathname, '/jellyfin/Items');
    assert.equal(url.searchParams.get('ParentId'), 'library');
    return json({ TotalRecordCount: items.length, Items: items.slice(offset, offset + 2) });
  });
  const books = await client().books(server, 'library');
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(books.map(book => book.ratingKey), ['album', 'standalone']);
  assert.equal(books[0].duration, 120);
  assert.equal(books[0].author, 'Author');
  assert.equal(books[0].leafCount, 2);
  assert.equal(books[0].viewedLeafCount, 1);
  assert.equal(books[0].thumb, 'album');
  const rows = await client().libraryProgress(server, 'library');
  assert.deepEqual(rows.filter(row => row.bookRatingKey === 'album').map(row => row.ratingKey), ['first', 'second']);
  assert.equal(rows.find(row => row.ratingKey === 'second').viewOffset, 25);
});

test('album tracks preserve disc order, original media identity and chapter ticks', async t => {
  const items = [
    { Id: 'two', Type: 'Audio', Name: 'Second', ParentIndexNumber: 2, IndexNumber: 1, RunTimeTicks: tick(60), Container: 'm4b', CanDownload: false, MediaSources: [{ Id: 'original', Container: 'm4b', Size: 500 }], Chapters: [{ Name: 'One', StartPositionTicks: 0 }, { Name: 'Two', StartPositionTicks: tick(25) }], UserData: { PlaybackPositionTicks: tick(31), LastPlayedDate: '2026-10-20T12:00:00Z' } },
    { Id: 'one', Type: 'Audio', Name: 'First', ParentIndexNumber: 1, RunTimeTicks: tick(40), Container: 'mp3' },
  ];
  t.mock.method(globalThis, 'fetch', async address => {
    assert.equal(new URL(address).searchParams.get('ParentId'), 'album');
    return json({ Items: items, TotalRecordCount: 2 });
  });
  const tracks = await client().tracks(server, { ratingKey: 'album', nativeItemType: 'MusicAlbum' });
  assert.deepEqual(tracks.map(track => track.ratingKey), ['one', 'two']);
  assert.equal(tracks[1].duration, 60);
  assert.equal(tracks[1].viewOffset, 31);
  assert.equal(tracks[1].mime, 'audio/mp4');
  assert.equal(tracks[1].mediaSourceId, 'original');
  assert.equal(tracks[1].canDownload, false);
  assert.deepEqual(tracks[1].chapters.map(({ start, end }) => [start, end]), [[0, 25], [25, 60]]);
  const rows = await client().bookProgress(server, { ratingKey: 'album', nativeItemType: 'MusicAlbum' });
  assert.equal(rows[1].bookRatingKey, 'album');
  assert.equal(rows[1].lastViewedAt, Date.parse('2026-10-20T12:00:00Z') / 1000);
});

test('headerless media URLs use modern Jellyfin ApiKey, legacy Emby api_key and permissioned downloads', () => {
  const track = { ratingKey: 'audio', mediaSourceId: 'source' };
  const url = new URL(client().mediaURL(server, track));
  assert.equal(url.pathname, '/jellyfin/Audio/audio/stream');
  assert.equal(url.searchParams.get('ApiKey'), server.token);
  assert.equal(url.searchParams.get('Static'), 'true');
  assert.equal(url.searchParams.get('MediaSourceId'), 'source');
  assert.equal(new URL(client('emby').mediaURL(server, track)).searchParams.get('api_key'), server.token);
  assert.equal(new URL(client().downloadURL(server, track)).pathname, '/jellyfin/Items/audio/Download');
  assert.throws(() => client().downloadURL({ ...server, canDownload: false }, track), /does not allow downloading/);
  assert.throws(() => client().downloadURL(server, { ...track, canDownload: false }), /does not allow downloading/);
  assert.equal(new URL(client().artworkURL(server, { thumb: '//evil.example' })).origin, new URL(server.url).origin);
});

test('offline checkpoint persists without live session and is written after optional dashboard reports', async t => {
  for (const provider of ['jellyfin', 'emby']) {
    const calls = [];
    const fake = t.mock.method(globalThis, 'fetch', async (address, options) => {
      const url = new URL(address); calls.push({ path: url.pathname, body: JSON.parse(options.body) });
      return url.pathname.includes('/Sessions/') ? new Response(null, { status: 404 }) : new Response(null, { status: 204 });
    });
    await client(provider).timeline(server, { ratingKey: 'audio', duration: 100 }, { position: 47.125, state: 'stopped' });
    const last = calls.at(-1);
    assert.equal(last.path, provider === 'emby' ? '/jellyfin/Users/reader/Items/audio/UserData' : '/jellyfin/UserItems/audio/UserData');
    assert.equal(last.body.PlaybackPositionTicks, 471250000);
    assert.equal(last.body.Played, false);
    assert.ok(last.body.LastPlayedDate);
    fake.mock.restore();
  }
});

test('marking an album unplayed clears every member using provider-specific played routes', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address);
    if (options.method === 'GET') return json({ TotalRecordCount: 2, Items: [{ Id: 'one', Type: 'Audio' }, { Id: 'two', Type: 'Audio' }] });
    assert.equal(options.method, 'DELETE'); paths.push(url.pathname);
    return new Response(null, { status: 204 });
  });
  await client('emby').markPlayed(server, { ratingKey: 'album', nativeItemType: 'MusicAlbum' }, false);
  assert.deepEqual(paths, ['/jellyfin/Users/reader/PlayedItems/one', '/jellyfin/Users/reader/PlayedItems/two']);
});

test('finished userdata roundtrips through the shared progress parser while partial replay resumes', async t => {
  let userData = { Played: true, PlaybackPositionTicks: tick(100), LastPlayedDate: '2026-10-27T12:00:00Z' };
  const book = { id: 'book', ratingKey: 'audio', duration: 100, nativeItemType: 'AudioBook' };
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address);
    if (url.pathname.includes('/Sessions/')) return new Response(null, { status: 204 });
    if (options.method === 'POST') { userData = JSON.parse(options.body); return new Response(null, { status: 204 }); }
    return json({ Id: 'audio', Type: 'AudioBook', RunTimeTicks: tick(100), UserData: userData });
  });
  const adapter = client();
  assert.equal(plexProgress(book, await adapter.bookProgress(server, book)).completed, true);
  await adapter.timeline(server, { ratingKey: 'audio', duration: 100 }, { position: 100, state: 'stopped' });
  assert.equal(userData.PlaybackPositionTicks, 0);
  assert.equal(plexProgress(book, await adapter.bookProgress(server, book)).completed, true);
  userData = { Played: true, PlaybackPositionTicks: tick(40) };
  const replay = plexProgress(book, await adapter.bookProgress(server, book));
  assert.equal(replay.completed, false);
  assert.equal(replay.position, 40);
});

test('older Jellyfin metadata routes fall back and durable progress succeeds only after stored userdata readback', async t => {
  let position = 40;
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address); paths.push(url.pathname);
    if (url.pathname.includes('/Sessions/')) return new Response(null, { status: 204 });
    if (url.pathname.includes('/UserItems/')) return new Response(null, { status: 405 });
    if (url.pathname === '/jellyfin/Items/audio') return new Response(null, { status: 404 });
    if (url.pathname === '/jellyfin/Users/reader/Items/audio') return json({ Id: 'audio', Type: 'AudioBook', UserData: { Played: false, PlaybackPositionTicks: tick(position) } });
    if (url.pathname === '/jellyfin/UserViews') return new Response(null, { status: 404 });
    if (url.pathname === '/jellyfin/Users/reader/Views') return json({ Items: [{ Id: 'books', CollectionType: 'books', Name: 'Books' }] });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const adapter = client();
  assert.equal((await adapter.libraries(server))[0].id, 'books');
  await adapter.timeline(server, { ratingKey: 'audio', duration: 100 }, { position: 40, state: 'stopped' });
  assert.ok(paths.includes('/jellyfin/Users/reader/Items/audio'));
  position = 0;
  await assert.rejects(adapter.timeline(server, { ratingKey: 'audio', duration: 100 }, { position: 40, state: 'stopped' }), /progress remains pending/);
});

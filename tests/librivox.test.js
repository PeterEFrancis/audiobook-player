import test from 'node:test';
import assert from 'node:assert/strict';
import { LibriVoxAPI, librivoxServer, requestCatalog, fetchArchiveJSON } from '../js/librivox.js';

const row = id => ({ id: String(id), title: 'A &amp; B', description: '<i>A book</i><br />Second line', authors: [{ first_name: 'An', last_name: 'Author' }], num_sections: '2', totaltimesecs: 120, coverart_jpg: 'http://archive.org/cover.jpg', genres: [{ name: 'Fiction' }] });

test('LibriVox searches Archive title prefixes and paginates with page rather than start', async () => {
  const calls = [];
  const client = new LibriVoxAPI({ fetchJSON: async url => { calls.push(new URL(url)); return { response: { numFound: 5, docs: [{ identifier: 'book', title: 'Moby Dick', creator: 'Herman Melville', runtime: '1:02:03', description: '<b>A book</b>' }] } }; } });
  const result = await client.search(' Moby-D ', { offset: 2, limit: 2 });
  assert.equal(calls[0].origin, 'https://archive.org');
  assert.equal(calls[0].searchParams.get('q'), 'collection:librivoxaudio AND mediatype:audio AND title:("Moby" AND D*)');
  assert.equal(calls[0].searchParams.get('page'), '2');
  assert.equal(calls[0].searchParams.get('start'), null);
  assert.equal(calls[0].searchParams.get('rows'), '2');
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 3);
  assert.equal(result.books[0].id, 'librivox:archive:book');
  assert.equal(result.books[0].archiveIdentifier, 'book');
  assert.equal(result.books[0].duration, 3723);
  assert.equal(result.books[0].summary, 'A book');
  assert.equal(result.books[0].sourceURL, '');
  assert.equal(result.books[0].cover, 'https://archive.org/services/img/book');
  assert.equal(result.books[0].localProgress, true);
  assert.equal(result.books[0].inLibrary, false);
  assert.equal(result.books[0].tracks, undefined);
});

test('LibriVox author searches escape punctuation, cap pages, and report genuine empty results', async () => {
  let address;
  const client = new LibriVoxAPI({ fetchJSON: async url => { address = new URL(url); return { response: { numFound: 0, docs: [] } }; } });
  assert.deepEqual(await client.search('Thoreau" OR *:*', { field: 'author', offset: 50, limit: 900 }), { books: [], hasMore: false, nextOffset: 50 });
  assert.equal(address.searchParams.get('rows'), '50');
  assert.equal(address.searchParams.get('page'), '2');
  assert.equal(address.searchParams.get('q'), 'collection:librivoxaudio AND mediatype:audio AND creator:("Thoreau" AND OR*)');
});

test('LibriVox never enumerates the full catalog or searches blank and single-character queries', async () => {
  const client = new LibriVoxAPI({ fetchJSON: async () => { throw new Error('Unexpected request'); } });
  for (const query of ['', '   ', 'a', ' a ', '?!']) assert.deepEqual(await client.search(query), { books: [], hasMore: false, nextOffset: 0 });
  assert.deepEqual(await client.books(librivoxServer, 'catalog'), []);
});

test('Archive chapters prefer one 64Kbps rendition and retain original track order, lengths, and sources', async () => {
  const client = new LibriVoxAPI({ fetchJSON: async () => ({ metadata: {
    narrator: ['A Reader'], description: 'A book. <a href="http://librivox.org/example-by-author/">Catalog</a>',
  }, files: [
    { name: '10.mp3', format: 'VBR MP3', title: 'Second', track: '2/2', length: '72.5' },
    { name: '10_64kb.mp3', original: '10.mp3', format: '64Kbps MP3', length: '1:12', size: '500' },
    { name: '2.mp3', format: 'VBR MP3', title: 'First', track: '1/2', length: '3600' },
    { name: '2_64kb.mp3', original: '2.mp3', format: '64Kbps MP3', title: 'First title', length: '1:00:00', size: '800' },
    { name: 'cover.jpg', format: 'JPEG' },
  ] }) });
  const book = { id: 'librivox:archive:example', ratingKey: 'example', archiveIdentifier: 'example' };
  const tracks = await client.tracks(librivoxServer, book);
  assert.deepEqual(tracks.map(track => [track.title, track.duration, track.size]), [['First title', 3600, 800], ['Second', 72, 500]]);
  assert.equal(tracks[0].key, 'https://archive.org/download/example/2_64kb.mp3');
  assert.equal(book.narrator, 'A Reader');
  assert.equal(book.sourceURL, 'https://librivox.org/example-by-author/');
  assert.equal(book.duration, 3672);
});

test('Archive chapters fall back to 128Kbps or VBR, deduplicate renditions, and find narrator in description', async () => {
  const client = new LibriVoxAPI({ fetchJSON: async () => ({ metadata: { description: 'Read in English by A Reader. A book.' }, files: [
    { name: 'chapter_128.mp3', original: 'original.wav', format: '128Kbps MP3', length: '60' },
    { name: 'duplicate_128.mp3', original: 'original.wav', format: '128Kbps MP3', length: '60' },
    { name: 'chapter_vbr.mp3', original: 'original.wav', format: 'VBR MP3', length: '60' },
  ] }) });
  const book = { id: 'book', archiveIdentifier: 'book' };
  assert.equal((await client.tracks(librivoxServer, book)).length, 1);
  assert.equal(book.narrator, 'A Reader');
});

test('Archive JSON fetch surfaces HTTP failure and honors caller cancellation', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(fetchArchiveJSON('https://archive.org/metadata/book'), /503/);
  const controller = new AbortController(); controller.abort();
  t.mock.method(globalThis, 'fetch', async (url, options) => { assert.equal(options.signal.aborted, true); throw new DOMException('Abort', 'AbortError'); });
  await assert.rejects(fetchArchiveJSON('https://archive.org/metadata/book', { signal: controller.signal }), { name: 'AbortError' });
});

test('LibriVox lazily loads ordered playable chapters and keeps progress local', async () => {
  let parameters;
  const client = new LibriVoxAPI({ request: async params => { parameters = params; return { books: [{ sections: [
    { id: 'two', section_number: '2', title: 'Second', playtime: '1:02', listen_url: 'http://archive.org/download/book/2.mp3', readers: [{ display_name: 'Reader' }] },
    { id: 'bad', section_number: '3', listen_url: 'javascript:alert(1)' },
    { id: 'one', section_number: '1', title: 'First', playtime: '60', listen_url: 'https://archive.org/download/book/1.mp3' },
  ] }] }; } });
  const book = { ratingKey: '12' }, tracks = await client.tracks(librivoxServer, book);
  assert.equal(parameters.id, '12');
  assert.equal(parameters.extended, 1);
  assert.deepEqual(tracks.map(track => [track.title, track.duration]), [['First', 60], ['Second', 62]]);
  assert.equal(client.downloadURL(librivoxServer, tracks[1]), 'https://archive.org/download/book/2.mp3');
  assert.equal(book.narrator, 'Reader');
  assert.deepEqual(await client.libraryProgress(), []);
  assert.deepEqual(await client.bookProgress(), []);
});

test('LibriVox JSONP uses its documented callback and removes script and callback after delivery', async t => {
  let script, removed = false;
  globalThis.document = { createElement: () => ({ remove: () => { removed = true; } }), head: { append: value => {
    script = value;
    const url = new URL(value.src);
    assert.equal(url.origin, 'https://librivox.org');
    assert.equal(url.searchParams.get('format'), 'jsonp');
    queueMicrotask(() => globalThis[url.searchParams.get('callback')]({ books: [row(1)] }));
  } } };
  t.after(() => { delete globalThis.document; });
  const result = await requestCatalog({ limit: 1 });
  assert.equal(result.books[0].id, '1');
  assert.equal(removed, true);
  assert.equal(globalThis[new URL(script.src).searchParams.get('callback')], undefined);
});

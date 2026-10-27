import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { plexProgress } from '../js/plex-progress.js';
import { sumDuration } from '../js/utils.js';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const functions = extract('async function applyRemoteProgress(', 'async function ensureBook(') + extract('async function loadLibrary(', 'function refresh(') + extract('async function flushSync(', 'async function downloadBook(');
const book = {id: 'server:book', serverId: 'server', ratingKey: 'book', leafCount: 3};
const rows = [1, 2, 3].map(index => ({ratingKey: String(index), bookRatingKey: 'book', index, duration: 100, viewOffset: 0, viewCount: 0, lastViewedAt: 0}));
const library = {serverId: 'server', id: 'library'};
function setup(local) {
  const stores = new Map(['books', 'progress', 'sync'].map(name => [name, new Map()]));
  if (local) stores.get('progress').set(book.id, structuredClone(local));
  const clock = {value: 1000};
  const context = vm.createContext({
    structuredClone, plexProgress, sumDuration, books: [], progress: new Map(local ? [[book.id, structuredClone(local)]] : []), demoBooks: [],
    Date: {now: () => clock.value}, getServer: () => ({}), connectionStatus: () => {}, syncing: false, outgoingSyncError: '', view:'library', navigator: {onLine: true},
    player: {book: null, playing: false, generation: 0}, stopCurrentBook: async () => {},
    modal: {classList: {contains: () => false}, close: () => {}},
    db: {
      get: async (store, id) => structuredClone(stores.get(store).get(id)),
      put: async (store, value) => stores.get(store).set(value.id, structuredClone(value)),
      delete: async (store, id) => stores.get(store).delete(id),
      all: async store => structuredClone([...stores.get(store).values()]),
    },
    plexAPI: {books: async () => [structuredClone(book)], libraryProgress: async () => structuredClone(rows)},
  });
  vm.runInContext(functions, context);
  return {context, stores, clock, saved: () => stores.get('progress').get(book.id)};
}

test('initial library import shows server progress before any book details open', async () => {
  const {context, saved} = setup();
  context.plexAPI.libraryProgress = async () => rows.map((row, index) => ({...row, viewCount: index === 0 ? 1 : 0, viewOffset: index === 1 ? 30 : 0, lastViewedAt: index === 1 ? 20 : 10}));
  await context.loadLibrary(library);
  assert.equal(saved().elapsed, 130);
  assert.equal(saved().trackIndex, 1);
  assert.equal(context.books[0].tracks, undefined);
});

test('server reset overrides clean local timestamps while retaining playback preferences', async () => {
  const {context, saved} = setup({id: book.id, elapsed: 175, completed: true, updatedAt: 999999, dirty: false, speed: 1.75});
  await context.loadLibrary(library);
  assert.equal(saved().elapsed, 0);
  assert.equal(saved().completed, false);
  assert.equal(saved().speed, 1.75);
});

test('dirty offline progress and either queued checkpoint remain protected', async () => {
  for (const pending of ['dirty', book.id, `mark:${book.id}`]) {
    const local = {id: book.id, elapsed: 175, updatedAt: 99, dirty: pending === 'dirty'};
    const {context, stores, saved} = setup(local);
    if (pending !== 'dirty') stores.get('sync').set(pending, {id: pending});
    await context.loadLibrary(library);
    assert.deepEqual(saved(), local);
  }
});

test('background refresh leaves an actively playing book untouched', async () => {
  const local = {id: book.id, elapsed: 175, dirty: false};
  const {context, saved} = setup(local);
  Object.assign(context.player, {book, playing: true});
  await context.loadLibrary(library);
  assert.deepEqual(saved(), local);
});

test('cached snapshots older than a local checkpoint cannot rewind it', async () => {
  const local = {id: book.id, elapsed: 175, localChangedAt: 200, dirty: false};
  const {context, saved} = setup(local);
  await context.applyRemoteProgress({...book, plexTracks: rows, plexProgressFetchedAt: 100});
  assert.deepEqual(saved(), local);
});

test('an in-flight library read cannot rewind progress uploaded while it was pending', async () => {
  const {context, stores, clock, saved} = setup();
  let finish;
  context.plexAPI.libraryProgress = () => new Promise(resolve => {finish = resolve;});
  const loading = context.loadLibrary(library);
  const local = {id: book.id, elapsed: 175, localChangedAt: 2000, dirty: false};
  stores.get('progress').set(book.id, local);
  context.progress.set(book.id, local);
  clock.value = 3000;
  finish(rows);
  await loading;
  assert.deepEqual(saved(), local);
});

test('offline mark-unplayed uploads before newer playback regardless of stored key order', async () => {
  const {context, stores, saved} = setup({id: book.id, elapsed: 135, updatedAt: 2000, dirty: true});
  const pending = stores.get('sync'), sent = [];
  pending.set(book.id, {id: book.id, serverId: 'server', track: {ratingKey: '2'}, position: 35, updatedAt: 2000});
  pending.set(`mark:${book.id}`, {id: `mark:${book.id}`, bookId: book.id, serverId: 'server', book, markPlayed: false, updatedAt: 1000});
  context.plexAPI.markPlayed = async (_server, _book, played) => {sent.push(['mark', played]);};
  context.plexAPI.timeline = async (_server, _track, checkpoint) => {sent.push(['timeline', checkpoint.position]);};
  await context.flushSync();
  assert.deepEqual(sent, [['mark', false], ['timeline', 35]]);
  assert.equal(pending.size, 0);
  assert.equal(saved().dirty, false);
});

test('failed earlier work retains newer playback until retry while other books still sync', async () => {
  const {context, stores, saved} = setup({id: book.id, elapsed: 135, updatedAt: 2000, dirty: true});
  const pending = stores.get('sync'), sent = [];
  pending.set(book.id, {id: book.id, serverId: 'server', track: {ratingKey: '2'}, position: 35, updatedAt: 2000});
  pending.set(`mark:${book.id}`, {id: `mark:${book.id}`, bookId: book.id, serverId: 'server', book, markPlayed: false, updatedAt: 1000});
  pending.set('other', {id: 'other', serverId: 'server', track: {ratingKey: 'other'}, position: 20, updatedAt: 3000});
  context.plexAPI.markPlayed = async () => {throw new Error('Server unavailable');};
  context.plexAPI.timeline = async (_server, track) => {sent.push(track.ratingKey);};
  await context.flushSync();
  assert.deepEqual(sent, ['other']);
  assert.deepEqual([...pending.keys()], [book.id, `mark:${book.id}`]);
  assert.equal(saved().dirty, true);
  context.plexAPI.markPlayed = async () => {sent.push('mark');};
  await context.flushSync();
  assert.deepEqual(sent, ['other', 'mark', '2']);
  assert.equal(pending.size, 0);
  assert.equal(saved().dirty, false);
});


test('queued played changes recover provider metadata from the saved book', async () => {
  const {context, stores} = setup();
  const full = {...book, nativeItemType: 'MusicAlbum', duration: 300};
  stores.get('books').set(book.id, full);
  stores.get('sync').set(`mark:${book.id}`, {id: `mark:${book.id}`, bookId: book.id, serverId: 'server', book: {ratingKey: 'book'}, markPlayed: true, updatedAt: 1000});
  let sent;
  context.plexAPI.markPlayed = async (_server, metadata) => {sent = metadata;};
  await context.flushSync();
  assert.equal(sent.nativeItemType, 'MusicAlbum');
  assert.equal(sent.duration, 300);
  assert.equal(stores.get('sync').size, 0);
});

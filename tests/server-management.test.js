import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
function extract(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} is defined`);
  const rest = source.slice(match.index), end = rest.slice(1).search(/\n(?:async )?function \w+\(/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}
function setup() {
  const config = {accountToken: 'account', servers: [{id: 'A', name: 'Alpha'}, {id: 'B', name: 'Beta'}], libraries: [
    {id: 'shared', serverId: 'A', title: 'A books'}, {id: 'other', serverId: 'A', title: 'Other'}, {id: 'shared', serverId: 'B', title: 'B books'},
  ]};
  const books = [
    {id: 'A:online', serverId: 'A', libraryId: 'shared'}, {id: 'A:offline', serverId: 'A', libraryId: 'other'},
    {id: 'B:online', serverId: 'B', libraryId: 'shared'}, {id: 'free', librivox: true, inLibrary: true},
  ];
  const records = new Map([
    ['A:offline', {id: 'A:offline', status: 'complete'}], ['A:online', {id: 'A:online', status: 'downloading'}],
    ['B:online', {id: 'B:online', status: 'downloading'}],
  ]);
  const stores = new Map(['books', 'progress', 'sync', 'bookmarks'].map(store => [store, new Map()]));
  books.forEach(book => stores.get('books').set(book.id, structuredClone(book)));
  for (const serverId of ['A', 'B']) {
    const id = `${serverId}:online`;
    stores.get('progress').set(id, {id, elapsed: 42, dirty: true, updatedAt: 1});
    stores.get('sync').set(id, {id, serverId, track: {ratingKey: id}, position: 42, updatedAt: 1});
  }
  stores.get('bookmarks').set('note', {id: 'note', bookId: 'A:offline', note: 'Keep me'});
  const calls = {connect: [], libraries: [], timeline: [], cancel: [], stop: [], save: 0};
  let context;
  context = vm.createContext({
    config, books, downloadRecords: records, progress: new Map(stores.get('progress')),
    selectedServer: null, serverLibraryChoices: new Map([['A', config.libraries.filter(l => l.serverId === 'A')]]),
    player: {book: books[0], local: false, playing: true},
    refreshBusy: false, refreshPromise: null, lastPlexPull: 0, incomingSyncStatus: '', outgoingSyncError: '', syncing: false,
    view: 'library', navigator: {onLine: true}, $: () => null, modal: {close() {}}, render() {}, toast() {},
    saveConfig() {calls.save++;}, providerName: () => 'Plex',
    getServer: id => context.config.servers.find(server => server.id === id),
    stopCurrentBook: async id => {calls.stop.push(id);},
    downloads: {cancel: async id => {calls.cancel.push(id);}, list: async () => [...records.values()]},
    db: {
      all: async store => structuredClone([...stores.get(store).values()]),
      get: async (store, id) => structuredClone(stores.get(store).get(id)),
      put: async (store, value) => stores.get(store).set(value.id, structuredClone(value)),
      delete: async (store, id) => stores.get(store).delete(id),
    },
    plexAPI: {
      connect: async server => {calls.connect.push(server.id); return {...server};},
      timeline: async server => {calls.timeline.push(server.id);}, markPlayed: async () => {},
    },
    loadLibrary: async library => {calls.libraries.push(`${library.serverId}:${library.id}`);},
  });
  vm.runInContext(['libraryBooks', 'removeServer', 'saveServerLibraries', 'refresh', 'flushSync'].map(extract).join('\n'), context);
  return {context, config, books, stores, records, calls};
}

test('refreshing one server uploads and reads only that server, including overlapping library IDs', async () => {
  const {context, stores, calls} = setup();
  await context.refresh({serverId: 'A'});
  assert.deepEqual(calls.connect, ['A']);
  assert.deepEqual(calls.libraries, ['A:shared', 'A:other']);
  assert.deepEqual(calls.timeline, ['A']);
  assert.equal(stores.get('sync').has('A:online'), false);
  assert.equal(stores.get('sync').has('B:online'), true);
  assert.equal(stores.get('progress').get('B:online').dirty, true);
});

test('removing one server preserves other connections, offline books, notes, and pending progress', async () => {
  const {context, config, stores, records, calls, books} = setup();
  const before = structuredClone([...stores].map(([name, rows]) => [name, [...rows]]));
  await context.removeServer('A');
  assert.deepEqual(Array.from(config.servers, server => server.id), ['B']);
  assert.deepEqual(Array.from(config.libraries, library => `${library.serverId}:${library.id}`), ['B:shared']);
  assert.equal(config.accountToken, 'account');
  assert.deepEqual(calls.cancel, ['A:online']);
  assert.deepEqual(calls.stop, ['A:online']);
  assert.equal(records.get('A:offline').status, 'complete');
  assert.deepEqual([...stores].map(([name, rows]) => [name, [...rows]]), before);
  assert.equal(context.books.length, books.length, 'metadata remains available to Downloads and history');
  assert.deepEqual(Array.from(context.libraryBooks(), book => book.id), ['A:offline', 'B:online', 'free']);
});

test('removing a different server leaves current playback and its downloads alone', async () => {
  const {context, calls} = setup();
  context.player.book = context.books.find(book => book.serverId === 'B');
  await context.removeServer('A');
  assert.deepEqual(calls.stop, []);
  assert.deepEqual(calls.cancel, ['A:online']);
});

test('changing one server libraries and display name preserves another server with the same library ID', async () => {
  const {context, config} = setup();
  const refreshed = [];
  context.refresh = async options => {refreshed.push(options.serverId);};
  await context.saveServerLibraries('A', ['other'], 'Living room');
  assert.deepEqual(Array.from(config.libraries, library => `${library.serverId}:${library.id}`).sort(), ['A:other', 'B:shared']);
  assert.equal(config.servers.find(server => server.id === 'A').displayName, 'Living room');
  assert.equal(config.servers.find(server => server.id === 'B').name, 'Beta');
  assert.deepEqual(refreshed, ['A']);
});

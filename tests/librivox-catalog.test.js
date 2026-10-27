import test from 'node:test';
import assert from 'node:assert/strict';
import { retireAutomaticCatalog } from '../js/librivox-catalog.js';

test('automatic catalog retirement retains chosen, downloaded and started books without touching personal libraries', async () => {
  const ids = ['unchosen', 'selected', 'downloaded', 'started', 'finished', 'reading', 'queued', 'bookmark', 'history', 'unplayed'];
  const books = ids.map(id => ({id: `librivox:${id}`, serverId: 'librivox', ...(id === 'selected' ? {inLibrary: true} : {})}));
  const personal = {id: 'personal:book', serverId: 'personal', tracks: [{id: 'track'}]};
  const stores = {
    books: new Map([...books, personal].map(book => [book.id, book])),
    downloads: new Map([['librivox:downloaded', {id: 'librivox:downloaded', status: 'paused'}]]),
    progress: new Map([
      ['librivox:started', {id: 'librivox:started', elapsed: 15}],
      ['librivox:finished', {id: 'librivox:finished', completed: true}],
      ['librivox:unplayed', {id: 'librivox:unplayed', elapsed: 0}],
    ]),
    bookmarks: new Map([['bookmark', {id: 'bookmark', bookId: 'librivox:bookmark'}]]),
    history: new Map([
      ['history', {id: 'history', bookId: 'librivox:history', listened: 10}],
      ['unplayed', {id: 'unplayed', bookId: 'librivox:unplayed', listened: 0}],
    ]),
    settings: new Map([
      ['preferences', {id: 'preferences', reading: ['librivox:reading'], queue: ['librivox:queued']}],
      ['librivox-catalog', {id: 'librivox-catalog', complete: true}],
    ]),
  };
  const original = structuredClone(stores);
  const db = {
    all: async store => [...stores[store].values()],
    get: async (store, id) => stores[store].get(id),
    put: async (store, value) => stores[store].set(value.id, value),
    delete: async (store, id) => stores[store].delete(id),
  };
  await retireAutomaticCatalog(db);
  assert.equal(stores.books.has('librivox:unchosen'), false);
  assert.equal(stores.books.has('librivox:unplayed'), false);
  for (const id of ids.filter(id => !['unchosen', 'unplayed'].includes(id))) assert.equal(stores.books.get(`librivox:${id}`).inLibrary, true);
  assert.deepEqual(stores.books.get(personal.id), personal);
  assert.equal(stores.settings.has('librivox-catalog'), false);
  assert.equal(stores.settings.get('librivox-selection-migration').complete, true);
  assert.deepEqual(stores.settings.get('preferences'), original.settings.get('preferences'));
  for (const store of ['downloads', 'progress', 'bookmarks', 'history']) assert.deepEqual(stores[store], original[store]);
  stores.books.set('librivox:downloaded', {...stores.books.get('librivox:downloaded'), inLibrary: false});
  const migrated = structuredClone(stores);
  await retireAutomaticCatalog(db);
  assert.deepEqual(stores, migrated);
});

test('failed retirement does not mark migration complete', async () => {
  const writes = [];
  const db = {
    get: async () => undefined,
    all: async store => store === 'books' ? [{id: 'librivox:unused', serverId: 'librivox'}] : [],
    delete: async () => {throw new Error('Storage interrupted');},
    put: async (_store, value) => writes.push(value),
  };
  await assert.rejects(retireAutomaticCatalog(db), /Storage interrupted/);
  assert.deepEqual(writes, []);
});

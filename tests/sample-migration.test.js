import test from 'node:test';
import assert from 'node:assert/strict';
import { removeLegacySamples } from '../js/sample-migration.js';

test('retiring all built-in samples awaits downloads and preserves personal libraries and reading data', async () => {
  const humanIds = ['walden_librivox', 'moby_dick_librivox', 'pride_prejudice_krs_librivox', 'adventuressherlockholmes_v4_1501_librivox'].map(id => `demo:librivox:${id}`);
  const stores = {
    books: new Map([
      ['demo:walden', { id: 'demo:walden', serverId: 'demo', demo: true }],
      ['demo:sea', { id: 'demo:sea', serverId: 'demo', demo: true }],
      ['demo:pride', { id: 'demo:pride', serverId: 'real-server', demo: false }],
      ...humanIds.map(id => [id, { id, serverId: 'demo', demo: true }]),
      ['real:book', { id: 'real:book', serverId: 'real-server' }],
    ]),
    downloads: new Map([
      ['demo:walden', { id: 'demo:walden' }],
      ...humanIds.map(id => [id, { id }]),
      ['real:book', { id: 'real:book' }],
    ]),
    progress: new Map([['demo:walden', { position: 30 }], ['real:book', { position: 99 }]]),
    bookmarks: new Map([['bookmark', { bookId: 'demo:walden' }]]),
    history: new Map([['history', { bookId: 'real:book' }]]),
    settings: new Map([['settings', { token: 'keep' }]]),
  };
  const before = structuredClone(stores);
  const removed = [];
  const db = {
    get: async (store, id) => {
      assert.ok(store === 'books' || store === 'downloads');
      return stores[store].get(id);
    },
    delete: async (store, id) => {
      assert.equal(store, 'books');
      assert.ok(!stores.downloads.has(id), 'download cleanup finishes before deleting metadata');
      stores[store].delete(id);
    },
  };
  const downloads = {
    remove: async id => {
      await Promise.resolve();
      stores.downloads.delete(id);
      removed.push(id);
    },
  };

  await removeLegacySamples(db, downloads);

  assert.deepEqual(removed, ['demo:walden', ...humanIds]);
  assert.ok(!stores.books.has('demo:walden'));
  assert.ok(!stores.books.has('demo:sea'));
  assert.deepEqual(stores.books.get('demo:pride'), before.books.get('demo:pride'));
  for (const id of humanIds) {
    assert.ok(!stores.books.has(id));
    assert.ok(!stores.downloads.has(id));
  }
  for (const id of ['real:book']) {
    assert.deepEqual(stores.books.get(id), before.books.get(id));
    assert.deepEqual(stores.downloads.get(id), before.downloads.get(id));
  }
  for (const store of ['progress', 'bookmarks', 'history', 'settings']) {
    assert.deepEqual(stores[store], before[store]);
  }

  await removeLegacySamples(db, downloads);
  assert.deepEqual(removed, ['demo:walden', ...humanIds], 'subsequent boots leave retired samples alone');
});

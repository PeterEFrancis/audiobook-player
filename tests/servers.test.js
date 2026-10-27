import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoint, serverURL } from '../js/server-http.js';
import { ServerClient, providerName } from '../js/servers.js';

const server = { url: 'https://media.example/audiobooks' };

test('server addresses require HTTPS and exclude embedded credentials', () => {
  assert.equal(serverURL(' https://media.example/audiobooks/?ignored=1#fragment '), server.url);
  for (const value of ['http://media.example', 'ftp://media.example', 'https://user:password@media.example', 'media.example']) {
    assert.throws(() => serverURL(value));
  }
});

test('API endpoints preserve reverse-proxy paths and reject escaping addresses', () => {
  assert.equal(endpoint(server, '/api/items', { page: 2 }), `${server.url}/api/items?page=2`);
  assert.equal(endpoint(server, `${server.url}/api/items`), `${server.url}/api/items`);
  for (const path of ['https://other.example/api', '//other.example/api', '../api', '/../../api', 'https://media.example/audiobooks-other/api', 'https://user@media.example/audiobooks/api']) {
    assert.throws(() => endpoint(server, path), /outside/);
  }
});

test('saved connections without a provider continue routing to Plex', () => {
  const facade = new ServerClient({ clientId: 'folio-test' });
  const legacy = { id: 'existing-server-id', ...server };
  facade.clients.plex = { books(value, libraryId) { assert.equal(value, legacy); assert.equal(libraryId, '7'); return ['legacy']; } };
  assert.deepEqual(facade.books(legacy, '7'), ['legacy']);
  assert.equal(providerName(legacy), 'Plex');
  assert.throws(() => facade.client({ provider: 'unknown' }), /not supported/);
});

test('explicit providers retain namespaced identities and dispatch download URLs with a media fallback', () => {
  const facade = new ServerClient({ clientId: 'folio-test' });
  for (const provider of ['audiobookshelf', 'jellyfin', 'emby']) {
    const connection = { ...server, provider, id: `${provider}:shared-server-id` };
    const track = { id: `${connection.id}:shared-track-id` };
    const client = {
      tracks(value, bookId) { assert.equal(this, client); assert.equal(value, connection); return `${value.id}:${bookId}`; },
      downloadURL(value, selectedTrack) { assert.equal(this, client); assert.equal(value, connection); assert.equal(selectedTrack, track); return `${provider}-download`; },
    };
    facade.clients[provider] = client;
    assert.equal(facade.tracks(connection, 'shared-book-id'), `${provider}:shared-server-id:shared-book-id`);
    assert.equal(facade.downloadURL(connection, track), `${provider}-download`);
    assert.equal(providerName(connection), { audiobookshelf: 'Audiobookshelf', jellyfin: 'Jellyfin', emby: 'Emby' }[provider]);
  }
  const plex = { mediaURL(value, track) { assert.equal(this, plex); return `${value.id}/${track.id}`; } };
  facade.clients.plex = plex;
  assert.equal(facade.downloadURL({ id: 'legacy' }, { id: 'track' }), 'legacy/track');
});

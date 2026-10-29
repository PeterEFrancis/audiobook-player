import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('basic comparison opens one track without controlling playback or exposing private data', async () => {
  const forbidden = [], sources = [], seeks = [], reads = [], mediaRequests = [];
  const prohibit = name => () => { forbidden.push(name); throw new Error(name); };
  const element = () => {
    const listeners = new Map();
    return {
      hidden: true, textContent: '', value: '',
      addEventListener(name, fn, options) {
        const list = listeners.get(name) || [];
        list.push({fn, once: options?.once}); listeners.set(name, list);
      },
      async emit(name) {
        for (const listener of [...(listeners.get(name) || [])]) {
          if (listener.once) listeners.set(name, listeners.get(name).filter(item => item !== listener));
          await listener.fn();
        }
      },
    };
  };
  const audio = Object.assign(element(), {
    paused: true, ended: false, seeking: false, duration: 300,
    readyState: 1, networkState: 1, muted: false, volume: 1, playbackRate: 1,
    play: prohibit('audio.play'), pause: prohibit('audio.pause'), load: prohibit('audio.load'),
  });
  let mediaTime = 0, sourceURL = '';
  Object.defineProperties(audio, {
    src: {get: () => sourceURL, set: value => { sources.push(value); sourceURL = value; }},
    currentTime: {get: () => mediaTime, set: value => { seeks.push(value); mediaTime = value; }},
  });
  const nodes = new Map(['audio', 'status', 'book', 'track', 'copy-report', 'report'].map(id => [id, id === 'audio' ? audio : element()]));
  const request = {bookId: 'private-book-id', index: 1, position: 82, local: false, speed: 1.5, volume: 0.7};
  const track = {id: 'private-track-id', title: 'Private chapter title'};
  const book = {id: request.bookId, title: 'Private book title', serverId: 'private-server-id', tracks: [{id: 'wrong-track'}, track]};
  const server = {id: book.serverId, token: 'secret-token', url: 'https://private-server.example'};
  const session = new Map([['folio.audio-test', JSON.stringify(request)]]);
  const storage = new Map([['folio.connection', JSON.stringify({servers: [server]})], ['folio.client', 'private-client-id']]);
  const audioSession = {};
  Object.defineProperty(audioSession, 'type', {get: () => 'auto', set: prohibit('audioSession.type')});
  const mediaSession = {
    setActionHandler: prohibit('mediaSession.setActionHandler'),
    setPositionState: prohibit('mediaSession.setPositionState'),
  };
  for (const property of ['playbackState', 'metadata']) Object.defineProperty(mediaSession, property, {
    get: () => property === 'playbackState' ? 'none' : null,
    set: prohibit(`mediaSession.${property}`),
  });
  let copied;
  const context = vm.createContext({
    URL, moduleURL: 'https://folio.example/js/audio-test.js',
    document: {hidden: false, querySelector: selector => nodes.get(selector.slice(1)), addEventListener() {}},
    window: {addEventListener() {}},
    navigator: {audioSession, mediaSession, clipboard: {writeText: async text => { copied = text; }}},
    AudioContext: prohibit('AudioContext'), Player: prohibit('Player'),
    sessionStorage: {getItem: key => session.get(key), removeItem: key => session.delete(key)},
    localStorage: {getItem: key => storage.get(key), setItem: prohibit('localStorage.setItem')},
    db: new Proxy({get: async (store, id) => { reads.push([store, id]); return book; }}, {
      get: (target, key) => key in target ? target[key] : prohibit(`db.${String(key)}`),
    }),
    librivoxServer: {id: 'librivox'},
    ServerClient: class {
      mediaURL(selectedServer, selectedTrack) {
        mediaRequests.push([selectedServer, selectedTrack]);
        return `${selectedServer.url}/${selectedTrack.id}?token=${selectedServer.token}`;
      }
    },
  });
  const source = readFileSync(new URL('../js/audio-test.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', 'moduleURL');
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(reads, [['books', request.bookId]]);
  assert.equal(session.has('folio.audio-test'), false);
  assert.equal(sources.length, 1);
  assert.equal(sources[0], `${server.url}/${track.id}?token=${server.token}`);
  assert.equal(mediaRequests.length, 1);
  assert.equal(mediaRequests[0][0].id, server.id);
  assert.equal(mediaRequests[0][1], track);
  assert.equal(audio.hidden, false);
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(audio.defaultPlaybackRate, 1.5);
  assert.equal(audio.volume, 0.7);
  assert.deepEqual(seeks, []);
  await audio.emit('loadedmetadata');
  await audio.emit('loadedmetadata');
  assert.deepEqual(seeks, [82]);
  assert.equal(nodes.get('book').textContent, book.title);
  for (let count = 0; count < 45; count++) await audio.emit('playing');
  await nodes.get('copy-report').emit('click');
  const report = JSON.parse(copied);
  assert.equal(report.build, 'folio-basic-test-71');
  assert.equal(report.events.length, 40);
  assert.equal(report.mediaTime, 82);
  assert.equal(report.audioSession.type, 'auto');
  for (const privateValue of [book.id, book.title, track.id, track.title, server.id, server.url, server.token, 'private-client-id']) {
    assert.equal(copied.includes(privateValue), false, `report exposed ${privateValue}`);
  }
  assert.deepEqual(forbidden, []);
  assert.equal(sources.length, 1);
  assert.equal(audio.paused, true);
});

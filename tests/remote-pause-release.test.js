import test from 'node:test';
import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import { Player } from '../js/player.js';
import { db } from '../js/db.js';

class FakeAudio extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.playbackRate = 1; this.volume = 1; this.playCalls = 0; this.loadCalls = 0; }
  set src(value) { this._src = this.currentSrc = value; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.ended = false; }
  get src() { return this._src || ''; }
  removeAttribute(name) { if (name === 'src') this._src = ''; }
  async play() { this.playCalls++; this.paused = false; this.ended = false; this.dispatchEvent(new Event('playing')); }
  pause() { const active = !this.paused; this.paused = true; if (active) this.dispatchEvent(new Event('pause')); }
  load() { this.loadCalls++; this.currentSrc = this.src; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.playbackRate = 1; this.volume = 1; this.paused = true; this.dispatchEvent(new Event('emptied')); }
  metadata() { this.duration = 100; this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
}
globalThis.Audio = FakeAudio;
globalThis.document = new EventTarget();
globalThis.window = new EventTarget();
setMaxListeners(30, document, window);
globalThis.MediaMetadata = window.MediaMetadata = class { constructor(data) { Object.assign(this, data); } };
globalThis.location = { href: 'https://folio.test/app.html' };

const book = () => ({ id: 'book', serverId: 'plex', title: 'The Book', author: 'The Author', tracks: [0, 1].map(n => ({ id: `track-${n}`, title: `Chapter ${n + 1}`, duration: 100, key: `/audio/${n}` })) });
const settle = async player => { await new Promise(resolve => setImmediate(resolve)); await player.saves; };
function setup(t, {ios = true, standalone = true, hidden = true, displayStandalone = false} = {}) {
  const handlers = new Map(), writes = [], errors = [];
  const mediaSession = {
    setActionHandler(action, handler) { handlers.set(action, handler); },
    setPositionState(state) { this.position = state; },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true, mediaSession, audioSession: {}, standalone, userAgent: ios ? 'Mozilla/5.0 (iPhone)' : '' } });
  document.hidden = hidden;
  window.matchMedia = () => ({matches: displayStandalone});
  db.get = async () => ({trackIndex: 1, position: 25});
  db.put = async (store, value) => { writes.push({store, value}); };
  const player = new Player({plex: {mediaURL: (_server, track) => `https://server.test${track.key}`}, downloads: {hasTrack: async () => false}, getServer: () => ({}), artworkURL: () => '/cover.png'});
  player.addEventListener('error', event => errors.push(event.detail));
  t.after(() => { clearInterval(player.timer); document.hidden = false; });
  return {player, handlers, mediaSession, writes, errors};
}

for (const action of ['pause', 'stop']) test(`hidden iPhone app ${action} releases immediately, saves its checkpoint, and resumes from the app`, async t => {
  const {player, handlers, mediaSession, writes, errors} = setup(t, {standalone: action === 'pause', displayStandalone: action === 'stop'});
  await player.open(book(), {autoplay: false});
  player.audio.metadata();
  await player.play();
  player.audio.currentTime = 42.5;
  player.audio.playbackRate = 1.75;
  player.audio.volume = 0.4;
  await settle(player);
  const source = player.audio.src, playCalls = player.audio.playCalls;
  const stalePlay = handlers.get('play'), staleNext = handlers.get('nexttrack');
  const put = db.put;
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  t.after(unblock);
  db.put = async (...args) => { await blocked; return put(...args); };

  const pausing = handlers.get(action)({});
  assert.equal(player.mediaReleased, true);
  assert.equal(player.audio.paused, true);
  assert.equal(player.audio.src, '');
  assert.ok(player.audio.loadCalls > 0);
  assert.equal(player.book.id, 'book');
  assert.equal(player.index, 1);
  assert.equal(player.position, 42.5);
  assert.equal(player.speed, 1.75);
  assert.equal(player.audio.volume, 0.4);
  assert.equal(mediaSession.playbackState, 'none');
  assert.equal(mediaSession.metadata, null);
  assert.equal(mediaSession.position, undefined);
  for (const handler of handlers.values()) assert.equal(handler, null);

  stalePlay({}); staleNext({});
  player.tick();
  player.updateMetadata();
  player.audio.paused = false;
  player.audio.dispatchEvent(new Event('playing'));
  assert.equal(player.audio.paused, true);
  assert.equal(player.audio.playCalls, playCalls);
  assert.equal(player.index, 1);
  assert.equal(mediaSession.playbackState, 'none');
  assert.equal(mediaSession.metadata, null);
  unblock();
  await pausing;
  await settle(player);
  const checkpoint = writes.filter(row => row.store === 'progress').at(-1).value;
  assert.equal(checkpoint.position, 42.5);
  assert.equal(checkpoint.trackIndex, 1);
  assert.equal(checkpoint.elapsed, 142.5);
  assert.equal(checkpoint.speed, 1.75);
  assert.equal(writes.filter(row => row.store === 'sync').at(-1).value.state, 'stopped');

  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(player.audio.playCalls, playCalls);
  assert.equal(mediaSession.playbackState, 'none');
  await player.play();
  assert.equal(player.mediaReleased, false);
  assert.equal(player.audio.src, source);
  assert.equal(player.audio.playCalls, playCalls + 1);
  player.audio.metadata();
  assert.equal(player.position, 42.5);
  assert.equal(player.audio.currentTime, 42.5);
  assert.equal(player.speed, 1.75);
  assert.equal(player.audio.volume, 0.4);
  assert.equal(mediaSession.playbackState, 'playing');
  assert.equal(typeof handlers.get('pause'), 'function');
  assert.deepEqual(errors, []);
});

test('Safari, desktop installs, and visible iPhone installs keep ordinary system pause', async t => {
  for (const options of [
    {standalone: false},
    {ios: false},
    {hidden: false},
  ]) await t.test(JSON.stringify(options), async t => {
    const {player, handlers, mediaSession} = setup(t, options);
    await player.open(book(), {autoplay: false});
    player.audio.metadata();
    await player.play();
    player.audio.currentTime = 42.5;
    const source = player.audio.src;
    await handlers.get('pause')({});
    await settle(player);
    assert.equal(player.mediaReleased, false);
    assert.equal(player.audio.src, source);
    assert.equal(player.audio.loadCalls, 0);
    assert.equal(player.position, 42.5);
    assert.equal(mediaSession.playbackState, 'paused');
    assert.equal(typeof handlers.get('play'), 'function');
  });
});

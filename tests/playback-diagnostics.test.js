import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../js/player.js';
import { db } from '../js/db.js';

class FakeAudio extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { paused: true, currentTime: 0, duration: NaN, readyState: 0, networkState: 0, playbackRate: 1, volume: 1, muted: false, playCalls: 0, loadCalls: 0 });
  }
  set src(value) { this._src = this.currentSrc = value; this.currentTime = 0; this.duration = NaN; this.readyState = 0; }
  get src() { return this._src; }
  async play() { this.playCalls++; this.paused = false; this.dispatchEvent(new Event('playing')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { this.loadCalls++; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.playbackRate = 1; this.paused = true; this.dispatchEvent(new Event('emptied')); }
  metadata() { this.duration = 100; this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
}

function setup(t) {
  const keys = ['Audio', 'document', 'window', 'navigator'];
  const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.defineProperties(globalThis, {
    Audio: { configurable: true, value: FakeAudio },
    document: { configurable: true, value: Object.assign(new EventTarget(), { hidden: true, visibilityState: 'hidden' }) },
    window: { configurable: true, value: new EventTarget() },
    navigator: { configurable: true, value: { userAgent: 'iPhone', onLine: true, audioSession: { type: 'playback', state: 'active' }, mediaSession: { setActionHandler() {}, setPositionState() {} } } },
  });
  t.mock.method(db, 'get', async () => undefined);
  t.mock.method(db, 'put', async () => {});
  const player = new Player({
    plex: { mediaURL: () => 'https://private-server.test/audio?X-Plex-Token=secret-token' },
    downloads: { hasTrack: async () => false }, getServer: () => ({}), artworkURL: () => '',
  });
  const book = { id: 'private-book-id', serverId: 'private-server-id', title: 'Private Book Title', author: 'Private Author', tracks: [{ id: 'private-track-id', title: 'Private Chapter', key: '/private/audio', duration: 100 }] };
  t.after(() => {
    clearInterval(player.timer);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { player, book };
}

test('playback diagnostics are bounded and exclude source addresses, book data, and error messages', async t => {
  const { player, book } = setup(t);
  await player.open(book, { autoplay: false });
  player.audio.metadata();
  player.audio.currentTime = 42;
  player.audio.volume = 0.4;
  player.audio.muted = true;
  for (let i = 0; i < 55; i++) player.tracePlayback('probe');
  player.tracePlayback('play-rejected', new DOMException('secret-token at private-server.test', 'NotAllowedError'));
  const report = player.diagnostics(), serialized = JSON.stringify(report);
  assert.equal(report.build, 'folio-audio-71');
  assert.equal(report.nativeAudioOnly, true);
  assert.ok(report.events.length > 0 && report.events.length <= 40);
  assert.equal(report.events.at(-1).event, 'play-rejected');
  assert.ok(report.events.every(event => Number.isFinite(event.at) && event.at >= 0));
  assert.match(serialized, /NotAllowedError/);
  assert.match(serialized, /"muted":true/);
  assert.match(serialized, /"volume":0\.4/);
  assert.doesNotMatch(serialized, /secret-token|private-server|private-book|private-track|Private Book|Private Author|Private Chapter|https?:|X-Plex/i);
});

test('reload audio starts the same source immediately and restores its position and playback settings', async t => {
  const { player, book } = setup(t);
  await player.open(book, { autoplay: false });
  player.audio.metadata();
  player.audio.currentTime = 42;
  player.audio.playbackRate = 1.5;
  player.audio.volume = 0.4;
  const audio = player.audio, source = audio.src, calls = audio.playCalls;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  db.put.mock.mockImplementation(async () => { await gate; });
  const reloading = player.reloadAudio();
  assert.equal(player.audio, audio);
  assert.equal(audio.src, source);
  assert.equal(audio.loadCalls, 1);
  assert.equal(audio.playCalls, calls + 1);
  assert.equal(audio.paused, false);
  assert.equal(player.position, 42);
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(audio.volume, 0.4);
  audio.metadata();
  assert.equal(audio.currentTime, 42);
  release();
  await reloading;
  await player.saves;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../js/player.js';
import { db } from '../js/db.js';

class FakeAudio extends EventTarget {
  constructor() { super(); this.paused = true; this.playbackRate = 1; this.playCalls = 0; }
  set src(value) { this._src = this.currentSrc = value; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.ended = false; }
  get src() { return this._src; }
  async play() { this.playCalls++; this.paused = false; this.ended = false; this.dispatchEvent(new Event('playing')); }
  pause() { const active = !this.paused; this.paused = true; if (active) this.dispatchEvent(new Event('pause')); }
  loadMetadata() { this.duration = 100; this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
  finish() { this.currentTime = 100; this.paused = true; this.ended = true; }
}
globalThis.Audio = FakeAudio;
globalThis.document = Object.assign(new EventTarget(), { hidden: true });
globalThis.window = new EventTarget();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });

const book = id => ({ id, serverId: 'server', title: id, author: 'Author', tracks: [0, 1, 2].map(index => ({ id: `${id}-${index}`, title: `Chapter ${index + 1}`, duration: 100, key: `/audio/${id}/${index}` })) });
const setup = t => {
  const writes = [];
  db.get = async () => undefined;
  db.put = async (store, value) => { writes.push({ store, value: structuredClone(value) }); };
  const player = new Player({
    plex: { mediaURL: (_server, track) => `https://server.test${track.key}` },
    downloads: { hasTrack: async () => true, audioURL: (bookId, trackId) => `https://app.test/offline/${bookId}/${trackId}` },
    getServer: () => ({}), artworkURL: () => '',
  });
  t.after(() => clearInterval(player.timer));
  return { player, writes };
};
const settled = async player => { await new Promise(setImmediate); await player.saves; };

test('hidden offline playback starts the prepared next file before suspended storage can respond', async t => {
  const { player, writes } = setup(t);
  await player.open(book('a'));
  player.audio.loadMetadata();
  await player.prepareNext();
  player.setSpeed(1.5);
  await player.saves;
  writes.length = 0;
  const audio = player.audio;
  const calls = audio.playCalls;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  db.get = async () => { await gate; return undefined; };
  db.put = async (store, value) => { await gate; writes.push({ store, value: structuredClone(value) }); };
  player.downloads.hasTrack = async () => { await gate; return true; };
  audio.finish();
  const ending = player.ended();
  assert.equal(player.audio, audio);
  assert.equal(player.index, 1);
  assert.equal(audio.src, 'https://app.test/offline/a/a-1');
  assert.equal(audio.playCalls, calls + 1);
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(audio.paused, false);
  audio.loadMetadata();
  release();
  await ending;
  await settled(player);
  const progress = writes.filter(row => row.store === 'progress').map(row => row.value);
  assert.ok(progress.some(row => row.id === 'a' && row.trackIndex === 0 && row.position === 100));
  assert.ok(progress.some(row => row.id === 'a' && row.trackIndex === 1));
});

test('late preparation cannot replace a manually selected book or resume paused audio', async t => {
  const { player } = setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  player.downloads.hasTrack = async (bookId, trackId) => {
    if (bookId === 'a' && trackId === 'a-1') await gate;
    return true;
  };
  await player.open(book('a'));
  player.audio.loadMetadata();
  const preparing = player.prepareNext();
  await player.open(book('b'), { autoplay: false });
  const source = player.audio.src;
  const calls = player.audio.playCalls;
  release();
  await preparing;
  await settled(player);
  assert.equal(player.book.id, 'b');
  assert.equal(player.index, 0);
  assert.equal(player.audio.src, source);
  assert.equal(player.audio.playCalls, calls);
  assert.equal(player.audio.paused, true);
});

test('duplicate ended notifications advance only one chapter', async t => {
  const { player } = setup(t);
  await player.open(book('a'));
  player.audio.loadMetadata();
  await player.prepareNext();
  const calls = player.audio.playCalls;
  player.audio.finish();
  await Promise.all([player.ended(), player.ended()]);
  assert.equal(player.index, 1);
  assert.equal(player.audio.playCalls, calls + 1);
  await settled(player);
});

test('chapter and expired timed sleep stop at the boundary even when background timers did not run', async t => {
  for (const mode of ['chapter', 'time']) {
    const { player } = setup(t);
    await player.open(book(mode));
    player.audio.loadMetadata();
    await player.prepareNext();
    player.setSleep(mode === 'chapter' ? 'chapter' : 1);
    if (mode === 'time') player.sleep.end = Date.now() - 1000;
    const calls = player.audio.playCalls;
    player.audio.finish();
    await player.ended();
    assert.equal(player.index, 0);
    assert.equal(player.audio.playCalls, calls);
    assert.equal(player.audio.paused, true);
    assert.equal(player.sleepStopped, true);
    assert.equal(player.sleep, null);
    await settled(player);
  }
});

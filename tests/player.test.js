import test from 'node:test';
import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import { Player } from '../js/player.js';
import { db } from '../js/db.js';

class FakeAudio extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.playbackRate = 1; }
  set src(value) { this._src = value; this.currentSrc = value; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.ended = false; }
  get src() { return this._src; }
  async play() { this.paused = false; this.ended = false; this.dispatchEvent(new Event('playing')); }
  pause() { const active = !this.paused; this.paused = true; if (active) this.dispatchEvent(new Event('pause')); }
  loadMetadata(duration) { this.duration = duration; this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
}
globalThis.Audio = FakeAudio;
globalThis.document = new EventTarget();
globalThis.window = new EventTarget();
// This fixture constructs many players against the same two event targets.
setMaxListeners(30, document, window);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

const book = (id = 'a', serverId = 'demo') => ({ id, serverId, title: id, author: 'Author', tracks: [0, 1].map(n => ({ id: `${id}-${n}`, title: `Track ${n}`, duration: 100, key: `/audio/${n}` })) });
const setup = t => {
  const writes = [];
  db.get = async () => undefined;
  db.put = async (store, value) => { writes.push({ store, value }); };
  const player = new Player({
    plex: { mediaURL: (_server, track) => `https://server.test${track.key}` },
    downloads: { hasTrack: async () => false }, getServer: () => ({}), artworkURL: () => '',
  });
  t.after(() => clearInterval(player.timer));
  return { player, writes };
};

test('resume and seek wait for finite media metadata', async t => {
  const { player } = setup(t);
  db.get = async () => ({ trackIndex: 0, position: 45 });
  await player.open(book(), { autoplay: false });
  player.audio.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(player.pendingSeek, 45);
  assert.equal(player.audio.currentTime, 0);
  await player.seek(80);
  assert.equal(player.pendingSeek, 80);
  player.audio.loadMetadata(100);
  assert.equal(player.audio.currentTime, 80);
  assert.equal(player.pendingSeek, null);
});

test('restoring and inspecting a paused book never create outgoing progress', async t => {
  const { player, writes } = setup(t);
  db.get = async () => ({ id: 'a', trackIndex: 1, position: 45, updatedAt: 123, dirty: false });
  await player.open(book('a', 'server'), { autoplay: false });
  player.audio.loadMetadata(100);
  player.audio.dispatchEvent(new Event('timeupdate'));
  player.audio.dispatchEvent(new Event('pause'));
  await player.persist();
  await player.open(book('a', 'server'), { autoplay: false });
  assert.equal(player.index, 1);
  assert.equal(player.position, 45);
  assert.deepEqual(writes, []);
});

test('preferences preserve the playback checkpoint without enqueueing a timeline', async t => {
  const { player, writes } = setup(t);
  const saved = { id: 'a', trackIndex: 1, position: 45, elapsed: 145, updatedAt: 123, localChangedAt: 100, source: 'plex', plexFingerprint: 'remote', plexObservedAt: 123, dirty: false };
  db.get = async () => saved;
  await player.open(book('a', 'server'), { autoplay: false });
  player.setSpeed(1.75);
  await player.saves;
  assert.deepEqual(writes.map(w => w.store), ['progress']);
  assert.deepEqual(writes[0].value, {...saved, speed: 1.75, voiceBoost: false, bass: 0, treble: 0});
  player.context = {resume: async () => {}};
  player.bass = player.treble = player.gain = {gain: {}};
  player.compressor = {threshold: {}, ratio: {}};
  player.configureSound({voiceBoost: true, bass: 3, treble: -2});
  await player.saves;
  assert.deepEqual(writes.map(w => w.store), ['progress', 'progress']);
  assert.deepEqual(writes[1].value, {...saved, speed: 1.75, voiceBoost: true, bass: 3, treble: -2});
});

test('seeking, playing and pausing enqueue checkpoints, idle timeupdates do not', async t => {
  const { player, writes } = setup(t);
  db.get = async () => ({plexFingerprint: 'remote', plexObservedAt: 123});
  await player.open(book('a', 'server'), { autoplay: false });
  await player.seek(135);
  assert.equal(writes.find(w => w.store === 'sync').value.track.id, 'a-1');
  assert.equal(writes.find(w => w.store === 'progress').value.position, 35);
  const checkpoint = writes.find(w => w.store === 'progress').value;
  assert.equal(checkpoint.source, 'local');
  assert.equal(checkpoint.localChangedAt, checkpoint.updatedAt);
  assert.equal(checkpoint.plexFingerprint, 'remote');
  assert.equal(checkpoint.plexObservedAt, 123);
  writes.length = 0;
  player.audio.loadMetadata(100);
  await player.play();
  assert.equal(writes.find(w => w.store === 'sync').value.state, 'playing');
  writes.length = 0;
  player.audio.currentTime = 50;
  player.audio.pause();
  await player.saves;
  assert.equal(writes.find(w => w.store === 'sync').value.state, 'stopped');
  assert.equal(writes.find(w => w.store === 'progress').value.position, 50);
  writes.length = 0;
  player.audio.dispatchEvent(new Event('timeupdate'));
  await player.persist();
  assert.deepEqual(writes, []);
});

test('a failed source lookup keeps the current book usable', async t => {
  const { player } = setup(t);
  await player.open(book('a'), { autoplay: false });
  player.downloads.hasTrack = async () => { throw new Error('Cache unavailable'); };
  await assert.rejects(player.open(book('b')), /Cache unavailable/);
  assert.equal(player.book.id, 'a');
  assert.equal(player.switching, false);
});

test('a slower earlier open cannot replace the latest selected book', async t => {
  const { player } = setup(t);
  let resolveFirst;
  player.downloads.hasTrack = id => id === 'a' ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(false);
  const first = player.open(book('a'), { autoplay: false });
  await new Promise(resolve => setImmediate(resolve));
  await player.open(book('b'), { autoplay: false });
  resolveFirst(false);
  await first;
  assert.equal(player.book.id, 'b');
  assert.equal(player.audio.src, 'https://server.test/audio/0');
});

test('sleep at a track boundary does not auto-advance, and explicit play resumes', async t => {
  const { player } = setup(t);
  await player.open(book(), { autoplay: false });
  player.audio.loadMetadata(100);
  player.setSleep('chapter');
  player.audio.currentTime = 100;
  player.audio.ended = true;
  player.checkSleep();
  await player.ended();
  assert.equal(player.index, 0);
  assert.equal(player.audio.paused, true);
  assert.equal(player.sleep, null);
  await player.play();
  assert.equal(player.index, 1);
  assert.equal(player.audio.paused, false);
});

test('saved voice boost activates its audio graph when playback starts', async t => {
  const { player } = setup(t);
  assert.equal(player.nativeAudioOnly, false);
  const node = () => ({ gain: {}, frequency: {}, threshold: {}, ratio: {}, connect(next) { return next; } });
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.destination = node(); }
    createMediaElementSource() { return node(); }
    createBiquadFilter() { return node(); }
    createDynamicsCompressor() { return node(); }
    createGain() { return node(); }
    async resume() {}
  };
  t.after(() => { delete window.AudioContext; });
  db.get = async () => ({ voiceBoost: true, bass: 3, treble: -2 });
  await player.open(book(), { autoplay: false });
  assert.equal(player.context, undefined);
  await player.play();
  assert.equal(player.gain.gain.value, 1.4);
  assert.equal(player.bass.gain.value, 3);
  assert.equal(player.treble.gain.value, -2);
});

test('Apple mobile playback bypasses sound processing without changing speed, volume, or progress', async t => {
  for (const profile of [
    { name: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)' },
    { name: 'iPad desktop mode', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', maxTouchPoints: 5 },
  ]) await t.test(profile.name, async t => {
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const previousContext = window.AudioContext;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true, ...profile } });
    let contexts = 0;
    window.AudioContext = class { constructor() { contexts++; throw new Error('Native playback must not create an audio graph'); } };
    t.after(() => {
      Object.defineProperty(globalThis, 'navigator', previousNavigator);
      if (previousContext) window.AudioContext = previousContext; else delete window.AudioContext;
    });
    const { player, writes } = setup(t);
    player.settings.volume = 0.35;
    db.get = async () => ({ trackIndex: 1, position: 45, speed: 1.75, voiceBoost: true, bass: 3, treble: -2 });
    await player.open(book('native', 'server'), { autoplay: false });
    player.audio.loadMetadata(100);
    player.configureSound({ voiceBoost: true, bass: 5, treble: 4 });
    await player.play();
    assert.equal(player.nativeAudioOnly, true);
    assert.equal(contexts, 0);
    assert.equal(player.context, undefined);
    assert.deepEqual(player.sound, { voiceBoost: false, bass: 0, treble: 0 });
    assert.equal(player.speed, 1.75);
    assert.equal(player.audio.volume, 0.35);
    assert.equal(player.position, 45);
    player.audio.pause();
    await player.saves;
    const audio = player.audio, source = audio.src;
    await player.play();
    assert.equal(player.audio, audio);
    assert.equal(player.audio.src, source);
    assert.equal(player.position, 45);
    assert.equal(player.audio.paused, false);
    assert.equal(writes.filter(write => write.store === 'progress').at(-1).value.position, 45);
    assert.equal(writes.filter(write => write.store === 'sync').at(-1).value.state, 'playing');
  });
});

test('Android remains eligible for the normal sound-processing path', t => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)', platform: 'Linux armv8l', maxTouchPoints: 5 } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', previousNavigator));
  const { player } = setup(t);
  assert.equal(player.nativeAudioOnly, false);
});

test('progress writes snapshot their book and count background playback without buffering', async t => {
  const { player } = setup(t);
  await player.open(book('a', 'server'), { autoplay: false });
  player.audio.loadMetadata(100);
  player.listening = true;
  player.lastTick = Date.now() - 60000;
  const writes = [];
  let release;
  db.put = async (store, value) => {
    writes.push({ store, value });
    if (store === 'progress') await new Promise(resolve => { release = resolve; });
  };
  const saving = player.persist();
  assert.ok(player.session.listened >= 59);
  player.book = book('b', 'server');
  player.session = { id: 'new-session', listened: 0 };
  await new Promise(resolve => setImmediate(resolve));
  release();
  await saving;
  const sync = writes.find(entry => entry.store === 'sync').value;
  assert.equal(sync.id, 'a');
  assert.equal(sync.track.id, 'a-0');
  player.audio.dispatchEvent(new Event('waiting'));
  const listened = player.session.listened;
  player.lastTick = Date.now() - 60000;
  player.accountListening();
  assert.equal(player.session.listened, listened);
});

test('LibriVox saves playback locally without queueing server sync', async t => {
  const {player,writes}=setup(t);
  await player.open({...book('librivox:47','librivox'),localProgress:true},{autoplay:false});
  player.audio.loadMetadata(100);
  await player.seek(25);
  await player.persist();
  assert.ok(writes.some(write=>write.store==='progress' && write.value.elapsed===25 && write.value.dirty===false));
  assert.ok(!writes.some(write=>write.store==='sync'));
});

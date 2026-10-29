import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../js/player.js';
import { db } from '../js/db.js';

class FakeAudio extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.playbackRate = 1; this.playCalls = 0; }
  set src(value) { this._src = this.currentSrc = value; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.ended = false; }
  get src() { return this._src; }
  async play() { this.playCalls++; if (this.failure) throw this.failure; this.paused = false; this.ended = false; this.dispatchEvent(new Event('playing')); }
  pause() { const active = !this.paused; this.paused = true; if (active) this.dispatchEvent(new Event('pause')); }
  metadata() { this.duration = 100; this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }
}
globalThis.Audio = FakeAudio;
globalThis.document = new EventTarget();
globalThis.window = new EventTarget();
globalThis.MediaMetadata = window.MediaMetadata = class { constructor(data) { Object.assign(this, data); } };
globalThis.location = { href: 'https://folio.test/app.html' };

const book = () => ({ id: 'book', serverId: 'demo', title: 'The Book', author: 'The Author', tracks: [0, 1].map(n => ({ id: `track-${n}`, title: `Chapter ${n + 1}`, duration: 100, key: `/audio/${n}` })) });
const settle = async player => { await new Promise(resolve => setImmediate(resolve)); await player.saves; };
function setup(t, unsupported) {
  const handlers = new Map(), writes = [], errors = [];
  const mediaSession = {
    setActionHandler(action, handler) { if (action === unsupported) throw new Error('Unsupported action'); handlers.set(action, handler); },
    setPositionState(state) { this.position = state; },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true, mediaSession, audioSession: {} } });
  db.get = async () => ({ trackIndex: 1, position: 25 });
  db.put = async (store, value) => { writes.push({ store, value }); };
  const player = new Player({ plex: { mediaURL: (_server, track) => `https://server.test${track.key}` }, downloads: { hasTrack: async () => false }, getServer: () => ({}), artworkURL: () => '/cover.png' });
  player.addEventListener('error', event => errors.push(event.detail));
  t.after(() => clearInterval(player.timer));
  const action = async (name, details = {}) => { handlers.get(name)(details); await settle(player); };
  return { player, handlers, mediaSession, writes, errors, action };
}

test('system controls use a chapter timeline while preserving whole-book resume progress', async t => {
  const { player, mediaSession, writes, action } = setup(t);
  await player.open(book(), { autoplay: false });
  player.audio.metadata();
  assert.equal(mediaSession.metadata.title, 'The Book');
  assert.equal(mediaSession.metadata.artist, 'The Author');
  assert.equal(mediaSession.metadata.album, 'Chapter 2');
  assert.equal(mediaSession.playbackState, 'paused');
  assert.deepEqual(mediaSession.position, { duration: 100, position: 25, playbackRate: 1 });
  await action('seekbackward', { seekOffset: 30 });
  player.audio.metadata();
  assert.equal(player.index, 0);
  assert.equal(player.position, 95);
  await action('seekto', { seekTime: 50 });
  player.audio.metadata();
  assert.equal(player.index, 0);
  assert.equal(player.position, 50);
  await action('play');
  assert.equal(mediaSession.playbackState, 'playing');
  assert.equal(navigator.audioSession.type, 'playback');
  await action('pause');
  assert.equal(mediaSession.playbackState, 'paused');
  await action('seekbackward');
  assert.equal(player.position, 35);
  await action('seekforward');
  assert.equal(player.position, 65);
  await action('previoustrack');
  player.audio.metadata();
  assert.equal(player.elapsed, 0);
  await action('nexttrack');
  player.audio.metadata();
  assert.equal(player.elapsed, 100);
  await action('seekto', { seekTime: 50 });
  await action('play');
  await action('stop');
  assert.equal(player.position, 50);
  assert.equal(mediaSession.playbackState, 'paused');
  assert.equal(writes.filter(w => w.store === 'progress').at(-1).value.elapsed, 150);
  await action('play');
  player.audio.currentTime = 100;
  player.audio.paused = true;
  player.audio.ended = true;
  await player.ended();
  assert.equal(mediaSession.playbackState, 'paused');
  assert.equal(mediaSession.position.position, 100);
  player.book = null;
  player.emit();
  assert.equal(mediaSession.playbackState, 'none');
  assert.equal(mediaSession.metadata, null);
  assert.ok(!mediaSession.position || Object.keys(mediaSession.position).length === 0);
});

test('unavailable system actions and rejected commands leave other controls usable', async t => {
  const { player, handlers, errors, action } = setup(t, 'seekto');
  assert.equal(handlers.has('seekto'), false);
  assert.ok(handlers.has('stop'));
  await player.open(book(), { autoplay: false });
  player.audio.metadata();
  player.audio.failure = new Error('Playback requires a tap');
  await action('play');
  assert.equal(errors.at(-1).message, 'Playback requires a tap');
  player.audio.failure = null;
  Object.defineProperty(navigator.audioSession, 'type', { set() { throw new Error('Unavailable audio session'); } });
  await action('play');
  assert.equal(player.playing, true);
  const pause = player.audio.pause;
  player.audio.pause = () => { throw new Error('Control failed'); };
  await action('pause');
  assert.equal(errors.at(-1).message, 'Control failed');
  player.audio.pause = pause;
  await action('pause');
  assert.equal(player.playing, false);
});

test('embedded chapter changes reset system time and map chapter seeks to absolute resume progress', async t => {
  const { player, mediaSession, action, writes } = setup(t);
  const selected = book();
  selected.tracks[1].chapters = [{ title: 'Opening', start: 0, end: 40 }, { title: 'Into the woods', start: 40, end: 100 }];
  await player.open(selected, { index: 1, position: 0, autoplay: false });
  player.audio.metadata();
  assert.equal(mediaSession.metadata.album, 'Opening');
  player.audio.currentTime = 45;
  player.audio.dispatchEvent(new Event('timeupdate'));
  await settle(player);
  assert.equal(mediaSession.metadata.title, 'The Book');
  assert.equal(mediaSession.metadata.album, 'Into the woods');
  assert.deepEqual(mediaSession.position, {duration: 60, position: 5, playbackRate: 1});
  await action('seekto', {seekTime: 15});
  assert.equal(player.position, 55);
  assert.equal(writes.filter(w => w.store === 'progress').at(-1).value.elapsed, 155);
  await action('seekto', {seekTime: 60});
  assert.ok(Math.abs(player.position - 99.95) < 1e-9);
  assert.equal(player.index, 1);
  player.audio.currentTime = 39.99;
  player.audio.dispatchEvent(new Event('timeupdate'));
  await settle(player);
  assert.equal(mediaSession.metadata.album, 'Opening');
  player.audio.currentTime = 40;
  player.audio.dispatchEvent(new Event('timeupdate'));
  await settle(player);
  assert.equal(mediaSession.metadata.album, 'Into the woods');
  assert.deepEqual(mediaSession.position, {duration: 60, position: 0, playbackRate: 1});
});

test('locked system play starts the same audio synchronously while its sound context resumes', async t => {
  for (const state of ['suspended', 'interrupted']) await t.test(state, async t => {
    const { player, handlers, mediaSession } = setup(t);
    const hidden = document.hidden;
    document.hidden = true;
    t.after(() => { document.hidden = hidden; });
    await player.open(book(), { autoplay: false });
    player.audio.metadata();
    await player.play();
    player.audio.currentTime = 55;
    player.audio.pause();
    await settle(player);
    const audio = player.audio, source = audio.src, calls = audio.playCalls;
    let release, playing, resumeCalls = 0;
    const pendingContext = new Promise(resolve => { release = resolve; });
    t.after(async () => { release(); await playing; await settle(player); });
    player.context = { state, resume() { resumeCalls++; return pendingContext; } };

    playing = handlers.get('play')({});
    assert.equal(audio.playCalls, calls + 1);
    assert.equal(audio.paused, false);
    assert.equal(player.audio, audio);
    assert.equal(audio.src, source);
    assert.equal(player.position, 55);
    assert.equal(mediaSession.playbackState, 'playing');
    assert.equal(resumeCalls, 1);
    release();
    await playing;
    await settle(player);
  });
});

test('locked pause then play does not wait for pending checkpoint storage', async t => {
  const { player, handlers, mediaSession, writes } = setup(t);
  const hidden = document.hidden;
  document.hidden = true;
  t.after(() => { document.hidden = hidden; });
  const selected = book();
  selected.serverId = 'plex';
  await player.open(selected, { autoplay: false });
  player.audio.metadata();
  await player.play();
  player.setSpeed(1.5);
  await settle(player);
  const audio = player.audio, source = audio.src, calls = audio.playCalls;
  const put = db.put;
  let release;
  const pendingStorage = new Promise(resolve => { release = resolve; });
  t.after(release);
  db.put = async (...args) => { await pendingStorage; return put(...args); };

  const pausing = handlers.get('pause')({});
  assert.equal(audio.paused, true);
  const playing = handlers.get('play')({});
  assert.equal(audio.playCalls, calls + 1);
  assert.equal(audio.paused, false);
  assert.equal(player.audio, audio);
  assert.equal(audio.src, source);
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(mediaSession.playbackState, 'playing');
  release();
  await Promise.all([pausing, playing]);
  await settle(player);
  assert.equal(writes.filter(row => row.store === 'sync').at(-1).value.state, 'playing');
});

test('a rejected interrupted-context resume is reported without blocking system play', async t => {
  const { player, handlers, errors } = setup(t);
  await player.open(book(), { autoplay: false });
  player.audio.metadata();
  const failure = new Error('Sound context remains interrupted');
  player.context = { state: 'interrupted', resume: () => Promise.reject(failure) };

  const playing = handlers.get('play')({});
  assert.equal(player.audio.paused, false);
  await playing;
  await settle(player);
  assert.ok(errors.includes(failure));
});

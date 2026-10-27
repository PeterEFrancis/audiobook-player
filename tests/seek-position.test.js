import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { absolutePosition, chaptersFor, clock, sumDuration } from '../js/utils.js';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const rendering = source.slice(source.indexOf('function updatePlayer()'), source.indexOf('function showSpeed()'));

test('chapter jumps update focused seek markers while active dragging alone preserves a pending value', () => {
  const selectors = ['mini-player', 'mini-title', 'mini-author', 'mini-cover', 'mini-speed', 'now-chapter', 'now-speed', 'now-sleep', 'now-offline'];
  for (const prefix of ['mini', 'now']) for (const part of ['time', 'seek', 'play', 'duration']) selectors.push(`${prefix}-${part}`);
  const nodes = new Map(selectors.map(id => [`#${id}`, {dataset: {}, value: 0, setAttribute() {}}]));
  const mini = nodes.get('#mini-seek'), now = nodes.get('#now-seek');
  const book = {id: 'book', title: 'Book', author: 'Author', serverId: 'librivox', localProgress: true, tracks: [{title: 'First', duration: 100}, {title: 'Second', duration: 100}]};
  const player = {
    book, index: 0, position: 25, pendingSeek: null, playing: false, speed: 1,
    get elapsed() { return absolutePosition(this.book, this.index, this.pendingSeek ?? this.position); },
    get track() { return this.book.tracks[this.index]; },
  };
  const activeSeeks = new Set();
  const document = {activeElement: now};
  const context = vm.createContext({player, providerName:()=> 'LibriVox', getServer:()=>({provider:'librivox'}), activeSeeks, document, clock, sumDuration, chaptersFor, $: selector => nodes.get(selector), cover: () => '/cover.svg', I: () => ''});
  vm.runInContext(rendering, context);
  context.updatePlayer();
  assert.equal(Number(now.value), 25);

  // A paused cross-file jump reports its target before the new file loads metadata.
  player.index = 1;
  player.pendingSeek = 0;
  context.updatePlayer();
  assert.equal(Number(now.value), 100);
  assert.equal(Number(mini.value), 100);
  assert.equal(Number(now.max), 200);
  assert.equal(Number(mini.max), 200);
  assert.equal(nodes.get('#now-time').textContent, '1:40');
  assert.equal(nodes.get('#now-chapter').textContent, 'Second');
  assert.equal(document.activeElement, now);

  activeSeeks.add(now);
  now.value = 150;
  player.pendingSeek = 10;
  context.updatePlayer();
  assert.equal(Number(now.value), 150);
  assert.equal(Number(mini.value), 110);
  activeSeeks.delete(now);
  context.updatePlayer();
  assert.equal(Number(now.value), 110);

  document.activeElement = mini;
  player.pendingSeek = 50;
  context.updatePlayer();
  assert.equal(Number(mini.value), 150);
  assert.equal(Number(now.value), 150);
});

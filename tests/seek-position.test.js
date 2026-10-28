import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { absolutePosition, clock, playbackChapter } from '../js/utils.js';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const rendering = source.slice(source.indexOf('function updatePlayer()'), source.indexOf('function showSpeed()'));

function setup(tracks = [{title: 'First', duration: 100}, {title: 'Second', duration: 100}]) {
  const selectors = ['mini-player', 'mini-title', 'mini-author', 'mini-cover', 'mini-speed', 'now-chapter', 'now-speed', 'now-sleep', 'now-offline'];
  for (const prefix of ['mini', 'now']) for (const part of ['time', 'seek', 'play', 'duration']) selectors.push(`${prefix}-${part}`);
  const nodes = new Map(selectors.map(id => [`#${id}`, {dataset: {}, value: 0, setAttribute() {}}]));
  const mini = nodes.get('#mini-seek'), now = nodes.get('#now-seek'), seeks = [];
  const book = {id: 'book', title: 'Book', author: 'Author', serverId: 'librivox', tracks};
  const player = {
    book, index: 0, position: 25, pendingSeek: null, playing: false, speed: 1,
    get elapsed() { return absolutePosition(this.book, this.index, this.pendingSeek ?? this.position); },
    get track() { return this.book.tracks[this.index]; },
    async seek(seconds) { seeks.push(seconds); },
  };
  const activeSeeks = new Set(), document = {activeElement: now};
  const context = vm.createContext({player, providerName:()=> 'LibriVox', getServer:()=>({provider:'librivox'}), activeSeeks, document, clock, playbackChapter, $: selector => nodes.get(selector), cover: () => '/cover.svg', I: () => ''});
  vm.runInContext(rendering, context);
  return {context, player, nodes, mini, now, activeSeeks, document, seeks};
}

test('chapter jumps reset focused sliders while active dragging preserves a pending value', () => {
  const {context, player, nodes, mini, now, activeSeeks, document} = setup();
  context.updatePlayer();
  assert.equal(Number(now.value), 25);

  // A paused cross-file jump reports its chapter position before metadata loads.
  player.index = 1;
  player.pendingSeek = 0;
  context.updatePlayer();
  assert.equal(Number(now.value), 0);
  assert.equal(Number(mini.value), 0);
  assert.equal(Number(now.max), 100);
  assert.equal(Number(mini.max), 100);
  assert.equal(nodes.get('#now-time').textContent, '0:00');
  assert.equal(nodes.get('#now-duration').textContent, '1:40');
  assert.equal(nodes.get('#now-chapter').textContent, 'Second');
  assert.equal(document.activeElement, now);

  activeSeeks.add(now);
  now.value = 50;
  player.pendingSeek = 10;
  context.updatePlayer();
  assert.equal(Number(now.value), 50);
  assert.equal(Number(mini.value), 10);
  activeSeeks.delete(now);
  context.updatePlayer();
  assert.equal(Number(now.value), 10);

  document.activeElement = mini;
  player.pendingSeek = 50;
  context.updatePlayer();
  assert.equal(Number(mini.value), 50);
  assert.equal(Number(now.value), 50);
});

test('embedded chapters render relative time and map slider seeks back into the book', async () => {
  const {context, player, nodes, mini, now, seeks} = setup([
    {title: 'Earlier file', duration: 40},
    {title: 'Chaptered file', duration: 180, chapters: [{title: 'Opening', start: 0, end: 60}, {title: 'Next', start: 60, end: 180}]},
  ]);
  player.index = 1;
  player.position = 75;
  context.updatePlayer();
  assert.equal(Number(now.value), 15);
  assert.equal(Number(mini.max), 120);
  assert.equal(Number(now.dataset.chapterStart), 100);
  assert.equal(nodes.get('#now-time').textContent, '0:15');
  assert.equal(nodes.get('#now-duration').textContent, '2:00');
  assert.equal(nodes.get('#now-chapter').textContent, 'Next');
  await context.seekChapter(now, 25);
  await context.seekChapter(now, 120);
  assert.deepEqual(seeks, [125, 219.95]);

  player.position = 59.99;
  context.updatePlayer();
  assert.equal(nodes.get('#now-chapter').textContent, 'Opening');
  player.position = 60;
  context.updatePlayer();
  assert.equal(Number(now.value), 0);
  assert.equal(nodes.get('#now-chapter').textContent, 'Next');
});

test('a chapter rollover during dragging keeps the original seek origin until release', async () => {
  const {context, player, mini, now, activeSeeks, seeks} = setup([{title: 'First', duration: 100}, {title: 'Second', duration: 200}]);
  context.updatePlayer();
  activeSeeks.add(now);
  now.value = 50;
  player.index = 1;
  player.position = 10;
  context.updatePlayer();
  assert.equal(Number(now.max), 100);
  assert.equal(Number(now.dataset.chapterStart), 0);
  assert.equal(Number(mini.max), 200);
  assert.equal(Number(mini.dataset.chapterStart), 100);
  await context.seekChapter(now, 50);
  assert.deepEqual(seeks, [50]);
  activeSeeks.delete(now);
  context.updatePlayer();
  assert.equal(Number(now.max), 200);
  assert.equal(Number(now.value), 10);
  assert.equal(Number(now.dataset.chapterStart), 100);
  await context.seekChapter(now, 50);
  assert.deepEqual(seeks, [50, 150]);
});

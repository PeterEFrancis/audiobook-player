import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const rendering = source.slice(source.indexOf('const downloadRows ='), source.indexOf('function renderBookmarks('));

class Element {
  constructor() { this.children = []; this.nodes = new Map(); this.dataset = {}; this.style = {}; }
  set innerHTML(html) {
    this.html = html;
    const selectors = html.includes('id="download-rows"')
      ? ['#download-rows', '#download-empty', '#download-storage', '#download-capability']
      : ['img', 'h3', '[data-download-status]', '.progress-line span', '[data-download-size]', '[data-download-action]'];
    this.nodes = new Map(selectors.map(selector => [selector, new Element()]));
  }
  querySelector(selector) { return this.nodes.get(selector) || null; }
  prepend(row) { this.children.unshift(row); row.parent = this; }
  remove() { this.parent.children = this.parent.children.filter(row => row !== this); }
}

test('download byte updates preserve covers, row order, focus, and storage shell through completion', async () => {
  const content = new Element();
  const first = {id: 'first', title: 'First book', status: 'downloading', bytes: 10, totalBytes: 100, totalTracks: 1, updatedAt: 2};
  const second = {...first, id: 'second', title: 'Second book', status: 'queued', updatedAt: 1};
  let artworkLoads = 0, storageReads = 0;
  const context = vm.createContext({
    Map, Date, content, view: 'downloads', query: '', books: [first, second], downloadRecords: new Map([[first.id, first], [second.id, second]]),
    document: {createElement: () => new Element()},
    $: (selector, root = content) => root.querySelector(selector),
    e: value => value, bytes: value => String(value), heading: () => '', empty: () => '', I: () => '',
    image: () => { artworkLoads++; return '<img src="cover.jpg">'; },
    downloads: {backgroundSupported: true, storage: async () => {storageReads++; return {usage: 10, quota: 100};}},
  });
  vm.runInContext(rendering, context);
  await context.renderDownloads();
  const list = content.querySelector('#download-rows'), storage = content.querySelector('#download-storage');
  const capability = content.querySelector('#download-capability');
  assert.match(capability.textContent, /Downloads can continue/);
  const [row, other] = list.children, img = row.querySelector('img'), action = row.parts.action;
  context.document.activeElement = action;
  for (let bytes = 20; bytes <= 80; bytes += 20) {
    Object.assign(first, {bytes, updatedAt: 100 + bytes});
    context.downloads.backgroundSupported = false;
    await context.renderDownloads();
  }
  assert.deepEqual(list.children, [row, other]);
  assert.equal(row.querySelector('img'), img);
  assert.equal(context.document.activeElement, action);
  assert.equal(row.parts.bar.style.width, '80%');
  assert.equal(content.querySelector('#download-storage'), storage);
  assert.equal(content.querySelector('#download-capability'), capability);
  assert.match(capability.textContent, /Keep it open/);
  assert.equal(storageReads, 1);
  context.query = 'Second';
  await context.renderDownloads();
  assert.equal(row.hidden, true);
  context.query = '';
  Object.assign(first, {status: 'complete', bytes: 100, completedTracks: 1});
  await context.renderDownloads();
  assert.equal(row.hidden, false);
  assert.equal(row.querySelector('img'), img);
  assert.equal(row.parts.action, action);
  assert.equal(action.dataset.act, 'play-book');
  assert.equal(artworkLoads, 2);
  assert.equal(storageReads, 2);
  context.downloadRecords.delete(first.id);
  await context.renderDownloads();
  assert.deepEqual(list.children, [other]);
});

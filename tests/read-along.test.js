import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadAlongView } from '../js/read-along.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.isConnected = true;
    this.hidden = false;
    this.scrollTop = 0;
    this.clientHeight = 300;
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, force = !classes.has(value)) { if (force) classes.add(value); else classes.delete(value); },
    };
  }
  set innerHTML(value) {
    assert.equal(this.tagName, 'root', 'Transcript content must never be assigned to innerHTML');
    this.parts = new Map(['.read-along-scroll', '.read-along-lines', '.read-along-status', '.read-along-note', '[data-transcript-refresh]', '.read-along-follow'].map(selector => [selector, new Element()]));
    this.template = value;
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === 'fragment') this.append(...node.children);
      else { this.children.push(node); node.parent = this; }
    }
  }
  replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
  querySelector(selector) { return this.parts.get(selector); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector === '[data-word]' && child.dataset.word != null ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  closest(selector) { return selector === '[data-cue]' && this.dataset.cue != null ? this : this.parent?.closest(selector); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  getBoundingClientRect() { return { top: 20, height: 30 }; }
  scrollTo(value) { this.scrolledTo = value; }
  addEventListener(type, handler, { signal } = {}) {
    if (signal?.aborted) return;
    const callbacks = this.listeners.get(type) || new Set();
    callbacks.add(handler);
    this.listeners.set(type, callbacks);
    signal?.addEventListener('abort', () => callbacks.delete(handler), { once: true });
  }
  fire(type, props = {}) { for (const handler of this.listeners.get(type) || []) handler({ target: this, ...props }); }
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cues = () => [
  { start: 0, end: 10, text: 'Opening line.' },
  { start: 10, end: 18, text: 'Later line.' },
  { start: 18, end: null, text: '' },
];

function setup(t, load = async () => ({ cues: cues() })) {
  const previous = new Map(['document', 'navigator', 'matchMedia'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new EventTarget();
  Object.assign(document, { hidden: false, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'), createTextNode: text => { const node = new Element('text'); node.textContent = text; return node; } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
  const player = new EventTarget();
  Object.assign(player, {
    book: { id: 'book', tracks: [{ id: 'first', duration: 100 }, { id: 'second', duration: 60 }] },
    index: 0, position: 2, pendingSeek: null, seeks: [],
    async seek(position) { this.seeks.push(position); },
  });
  Object.defineProperty(player, 'track', { get: () => player.book.tracks[player.index] });
  const view = new ReadAlongView({ player, transcripts: { load } });
  const root = new Element('root'), dialog = new Element(), artwork = new Element(), toggle = new Element();
  view.mount(root, { dialog, artwork, toggle, visible: true });
  t.after(() => {
    view.unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { view, player, root, dialog, artwork, toggle, document };
}

test('read along follows seeks and pending seeks and clears highlighting at an empty cue', async t => {
  const { view, player, artwork, toggle } = setup(t);
  await settle();
  assert.equal(artwork.hidden, true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(view.nodes[0].classList.contains('is-current'), true);
  player.pendingSeek = 12;
  player.dispatchEvent(new Event('change'));
  assert.equal(view.active, 1);
  assert.equal(view.nodes[0].classList.contains('is-current'), false);
  assert.equal(view.nodes[1].getAttribute('aria-current'), 'true');
  player.pendingSeek = 18;
  player.dispatchEvent(new Event('change'));
  assert.equal(view.active, 2);
  assert.equal(view.nodes[1].classList.contains('is-current'), false);
  assert.equal(view.nodes[1].getAttribute('aria-current'), null);
  assert.equal(view.nodes[2], null);
  player.pendingSeek = null;
  player.position = 4;
  player.dispatchEvent(new Event('change'));
  assert.equal(view.active, 0);
});

test('late old-track loads cannot replace the newly selected chapter', async t => {
  const first = defer(), second = defer(), calls = [];
  const { view, player } = setup(t, (_book, track, options) => {
    calls.push({ id: track.id, signal: options.signal });
    return track.id === 'first' ? first.promise : second.promise;
  });
  player.index = 1;
  player.dispatchEvent(new Event('change'));
  assert.equal(calls[0].signal.aborted, true);
  second.resolve({ cues: [{ start: 0, end: null, text: 'New chapter' }] });
  await settle();
  assert.equal(view.nodes[0].textContent, 'New chapter');
  first.resolve({ cues: [{ start: 0, end: null, text: 'Stale chapter' }] });
  await settle();
  assert.equal(view.nodes[0].textContent, 'New chapter');
  assert.equal(view.loading, false);
});

test('clicking a transcript line seeks using the absolute book offset and markup remains literal', async t => {
  const literal = '<img src=x onerror=alert(1)> words';
  const { view, player } = setup(t, async () => ({ cues: [{ start: 12, end: null, text: literal }] }));
  player.index = 1;
  player.dispatchEvent(new Event('change'));
  await settle();
  const button = view.nodes[0];
  assert.equal(button.textContent, literal);
  assert.equal(button.children.length, 0);
  view.list.fire('click', { target: button });
  await settle();
  assert.deepEqual(player.seeks, [112]);
});

test('hiding and unmounting abort pending work and disconnected views stop updating', async t => {
  const pending = defer(), signals = [];
  const { view, root, artwork, dialog } = setup(t, (_book, _track, { signal }) => { signals.push(signal); return pending.promise; });
  view.setVisible(false);
  assert.equal(signals[0].aborted, true);
  assert.equal(root.hidden, true);
  assert.equal(artwork.hidden, false);
  assert.equal(dialog.classList.contains('read-along-open'), false);
  view.setVisible(true);
  assert.equal(signals.length, 2);
  root.isConnected = false;
  view.update();
  assert.equal(signals[1].aborted, true);
  assert.equal(view.root, null);
  pending.resolve({ cues: cues() });
  await settle();
  assert.deepEqual(view.nodes, []);
});

test('the whole sentence stays highlighted across row timestamps and tall sentences align to the top', async t => {
  const { view, player } = setup(t, async () => ({ cues: [
    { start: 0, end: 5, text: 'A sentence split across' },
    { start: 5, end: 12, text: 'two timed rows.', words: [{ start: 5, end: 12, text: 'two timed rows.' }] },
    { start: 12, end: null, text: 'The next sentence.' },
  ] }));
  await settle();
  assert.equal(view.nodes.length, 2);
  assert.equal(view.nodes[0].textContent, 'A sentence split across two timed rows.');
  assert.equal(view.nodes[0].children.length, 0);
  view.nodes[0].getBoundingClientRect = () => ({ top: 45, height: 600 });
  player.position = 8;
  player.dispatchEvent(new Event('change'));
  assert.equal(view.active, 0);
  view.update(true);
  assert.equal(view.scroll.scrolledTo.top, 25);
  player.position = 12;
  player.dispatchEvent(new Event('change'));
  assert.equal(view.active, 1);
});

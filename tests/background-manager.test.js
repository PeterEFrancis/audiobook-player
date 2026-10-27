import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/downloads.js', import.meta.url), 'utf8')
  .replace("import { db } from './db.js';", '')
  .replace("new URL('../', import.meta.url)", "new URL('https://folio.test/books/')")
  .replace('export class DownloadManager', 'globalThis.DownloadManager = class DownloadManager');
const book = {id: 'server:book', serverId: 'server', title: 'Book', tracks: [{id: 'one', size: 10}, {id: 'two', size: 20}]};
const savedBackground = () => ({...book, status: 'downloading', mode: 'background', backgroundId: 'running', backgroundFiles: [{trackId: 'two'}], trackBytes: {one: 10}, bytes: 10});

function setup({supported = true, rows = [], savedBooks = [], hidden = false, fetch, abort} = {}) {
  const stores = new Map([['downloads', new Map(rows.map(row => [row.id, structuredClone(row)]))], ['books', new Map(savedBooks.map(row => [row.id, structuredClone(row)]))]]);
  const db = {
    get: async (store, id) => structuredClone(stores.get(store).get(id)),
    all: async store => structuredClone([...stores.get(store).values()]),
    put: async (store, value) => { stores.get(store).set(value.id, structuredClone(value)); },
    update: async (store, id, change) => {
      const value = change(structuredClone(stores.get(store).get(id)));
      if (value !== undefined) stores.get(store).set(id, structuredClone(value));
      return value;
    },
  };
  const active = Object.assign(new EventTarget(), {id: 'running', downloaded: 4, result: '', abort: async () => {await abort?.();}});
  const backgroundFetch = {
    get: async id => id === active.id ? active : undefined,
    fetch: async (id, requests, options) => { active.id = id; return fetch ? fetch(id, requests, options, active) : active; },
  };
  class Channel {
    constructor() {
      this.port1 = {close() {}};
      this.port2 = {reply: data => this.port1.onmessage({data})};
    }
  }
  const registration = {active: {postMessage: (_message, ports) => ports[0].reply({backgroundDownloads: true})}};
  if (supported) registration.backgroundFetch = backgroundFetch;
  const context = vm.createContext({
    db, URL, Request, Response, Headers, DOMException, AbortController, EventTarget, CustomEvent, MessageChannel: Channel,
    setTimeout, clearTimeout, crypto: {randomUUID: () => 'request-id'},
    navigator: {serviceWorker: {addEventListener() {}, getRegistration: async () => registration}},
    document: Object.assign(new EventTarget(), {hidden}),
    caches: {open: async () => ({match: async () => undefined})},
    ...(supported ? {BackgroundFetchManager: class {}} : {}),
  });
  vm.runInContext(source, context);
  const manager = new context.DownloadManager({getServer: () => ({}), plex: {
    mediaURL: (_server, track) => `https://plex.test/${track.id}?X-Plex-Token=token`, artworkURL: () => 'https://plex.test/cover?X-Plex-Token=token',
  }});
  return {manager, active, saved: () => structuredClone(stores.get('downloads').get(book.id))};
}

test('background requests omit credentials and save their mapping before browser registration', async () => {
  let requestsSeen = 0;
  const h = setup({fetch: async (id, requests, _options, active) => {
    const saved = h.saved();
    assert.equal(saved.status, 'downloading');
    assert.equal(saved.backgroundId, id);
    assert.equal(saved.backgroundFiles.length, 2);
    assert.equal(saved.backgroundArtwork.url, requests[2].url);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.credentials, 'omit');
      assert.equal(request.mode, 'cors');
      assert.equal(request.cache, 'no-store');
      assert.equal(request.headers.has('Authorization'), false);
    }
    requestsSeen++;
    return active;
  }});
  const record = await h.manager.download(book);
  assert.equal(requestsSeen, 1);
  assert.equal(record.mode, 'background');
  assert.equal(h.manager.jobs.size, 0);
});

test('a live browser registration survives recovery and remains attached for progress', async () => {
  const h = setup({rows: [savedBackground()]});
  await h.manager.ready;
  assert.equal(h.saved().status, 'downloading');
  assert.equal(h.saved().backgroundId, 'running');
  assert.equal(h.manager.backgrounds.get(book.id), h.active);
});

test('unsupported browsers and denied permissions retain a clean foreground queue', async () => {
  for (const supported of [false, true]) {
    const h = setup({supported, fetch: async () => {throw new DOMException('Permission denied', 'NotAllowedError');}});
    let foreground = 0;
    h.manager._pump = async () => {foreground++;};
    const record = await h.manager.download(book);
    assert.equal(foreground, 1);
    assert.equal(record.mode, 'foreground');
    assert.equal(h.saved().status, 'queued');
    assert.equal(h.saved().backgroundId, null);
    assert.equal(h.saved().backgroundFiles, null);
    assert.equal(h.saved().backgroundArtwork, null);
  }
});

test('cancel invalidates the saved mapping before aborting the browser registration', async () => {
  let aborted = 0;
  const h = setup({rows: [savedBackground()], abort: () => {
    assert.equal(h.saved().backgroundId, null);
    assert.equal(h.saved().backgroundFiles, null);
    assert.equal(h.saved().status, 'paused');
    aborted++;
  }});
  await h.manager.cancel(book.id);
  assert.equal(aborted, 1);
  assert.equal(h.manager.backgrounds.has(book.id), false);
  h.active.dispatchEvent(new Event('progress'));
  await Promise.resolve();
  assert.equal(h.saved().status, 'paused');
  assert.equal(h.saved().backgroundId, null);
});

test('cancel while browser registration is pending leaves a paused resumable record', async () => {
  let release, started;
  const fetching = new Promise(resolve => {started = resolve;});
  const h = setup({fetch: async (_id, _requests, _options, active) => {
    started();
    await new Promise(resolve => {release = resolve;});
    return active;
  }});
  const downloading = h.manager.download(book);
  const rejected = assert.rejects(downloading, {name: 'AbortError'});
  await fetching;
  const cancelling = h.manager.cancel(book.id);
  await Promise.resolve();
  release();
  await Promise.all([rejected, cancelling]);
  assert.equal(h.saved().status, 'paused');
  assert.equal(h.saved().backgroundId, null);
  assert.equal(h.manager.jobs.size, 0);
});

test('the foreground queue cannot start a book still awaiting background registration', async () => {
  let release, started;
  const fetching = new Promise(resolve => {started = resolve;});
  const h = setup({fetch: async (id, _requests, options, active) => {
    if (options.title === 'Second book') throw new DOMException('Permission denied', 'NotAllowedError');
    started();
    await new Promise(resolve => {release = resolve;});
    active.id = id;
    return active;
  }});
  const foreground = [];
  h.manager._run = async job => {foreground.push(job.book.id);};
  const downloading = h.manager.download(book);
  await fetching;
  await h.manager.download({...book, id: 'second', title: 'Second book'});
  await new Promise(setImmediate);
  const runsWhilePreparing = [...foreground];
  release();
  await downloading;
  assert.deepEqual(runsWhilePreparing, ['second']);
});

test('bodyless background failures fall back once while visible and wait while hidden', async () => {
  for (const hidden of [false, true]) {
    const failure = {...savedBackground(), status: 'error', backgroundId: null, backgroundUnavailable: true, error: 'The browser returned no downloaded audio.'};
    const h = setup({rows: [failure], savedBooks: [book], hidden});
    await h.manager.ready;
    let foreground = 0;
    h.manager._pump = async () => {foreground++;};
    await h.manager._backgroundChange(failure);
    await h.manager._backgroundChange(failure);
    assert.equal(h.manager.backgroundSupported, false);
    assert.equal(await h.manager._backgroundManager(), null);
    assert.equal(foreground, hidden ? 0 : 1);
    assert.equal(h.saved().status, hidden ? 'error' : 'queued');
    assert.equal(h.saved().mode, hidden ? 'background' : 'foreground');
    assert.equal(h.saved().backgroundUnavailable, hidden);
  }
});

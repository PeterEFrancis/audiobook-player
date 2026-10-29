import { parseLRC } from './lrc.js';

const CACHE = 'folio-transcripts-v1';
const MAX_BYTES = 5 * 1024 * 1024;
const abort = signal => {
  if (signal?.aborted) throw signal.reason || new DOMException('Transcript request canceled.', 'AbortError');
};
const sourceKey = source => typeof source === 'string' && /^\/(?!\/)/.test(source) ? source.split(/[?#]/)[0] : '';

function decoded(record) {
  if (typeof record?.text !== 'string' || record.text.length > MAX_BYTES || new TextEncoder().encode(record.text).byteLength > MAX_BYTES) return null;
  const offset = Number.isFinite(Number(record.offset)) ? Number(record.offset) : 0;
  const cues = parseLRC(record.text).map(cue => ({
    ...cue, start: Math.max(0, cue.start + offset), end: cue.end == null ? null : cue.end + offset,
    ...(cue.words ? { words: cue.words.map(word => ({ ...word, start: Math.max(0, word.start + offset), end: word.end == null ? null : Math.max(0, word.end + offset) })) } : {}),
  })).filter(cue => cue.end == null || cue.end > 0);
  return cues.length ? { cues, source: sourceKey(record.source), offset } : null;
}

export class TranscriptManager {
  constructor({ plex, getServer, cacheStorage = globalThis.caches, root = new URL('../', import.meta.url) }) {
    this.plex = plex;
    this.getServer = getServer;
    this.cacheStorage = cacheStorage;
    this.root = root;
    this.writes = new Map();
    this.generations = new Map();
  }

  _key(book, track) {
    return new URL(`offline/transcripts/${encodeURIComponent(book.serverId || '')}/${encodeURIComponent(track.id)}.json`, this.root).href;
  }

  async _cache() {
    try { return await this.cacheStorage?.open(CACHE); } catch { return null; }
  }

  _queue(key, work) {
    const task = (this.writes.get(key) || Promise.resolve()).catch(() => {}).then(work);
    this.writes.set(key, task);
    void task.finally(() => { if (this.writes.get(key) === task) this.writes.delete(key); }).catch(() => {});
    return task;
  }

  async load(book, track, { signal, refresh = false } = {}) {
    abort(signal);
    if (!track?.id) return null;
    const key = this._key(book, track), generation = this.generations.get(key) || 0;
    const current = () => {
      abort(signal);
      if ((this.generations.get(key) || 0) !== generation) throw new DOMException('Transcript removed.', 'AbortError');
    };
    const cache = await this._cache();
    current();
    let cached = null;
    try { cached = decoded(await (await cache?.match(key))?.json()); } catch {}
    current();
    if (cached && !refresh) return cached;
    if (globalThis.navigator?.onLine === false) return cached;
    const server = this.getServer(book.serverId);
    if (!server || !this.plex?.transcript) return cached;
    let record;
    try { record = await this.plex.transcript(server, track, { signal }); }
    catch (error) { current(); if (cached) return cached; throw error; }
    current();
    const result = decoded(record);
    if (!result) {
      if (cache && refresh) await this._queue(key, async () => { current(); await cache.delete(key); });
      return null;
    }
    if (cache) {
      const saved = { text: record.text, offset: result.offset, source: result.source };
      try {
        await this._queue(key, async () => {
          current();
          const before = await cache.match(key);
          current();
          await cache.put(key, new Response(JSON.stringify(saved), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
          try { current(); }
          catch (error) {
            if (before && (this.generations.get(key) || 0) === generation) await cache.put(key, before);
            else await cache.delete(key);
            throw error;
          }
        });
      } catch { current(); } // Playback still works if browser storage is unavailable/full.
    }
    current();
    return result;
  }

  async download(book, { signal } = {}) {
    let next = 0;
    const tracks = book.tracks || [];
    const versions = tracks.map(track => this.generations.get(this._key(book, track)) || 0);
    const worker = async () => {
      for (;;) {
        abort(signal);
        const index = next++, track = tracks[index];
        if (!track) return;
        if ((this.generations.get(this._key(book, track)) || 0) !== versions[index]) return;
        try { await this.load(book, track, { signal, refresh: true }); }
        catch { abort(signal); } // Missing/unreachable optional transcripts never fail audio downloads.
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, tracks.length) }, worker));
  }

  async remove(book) {
    const keys = (book.tracks || []).map(track => this._key(book, track));
    keys.forEach(key => this.generations.set(key, (this.generations.get(key) || 0) + 1));
    const cache = await this._cache();
    if (cache) await Promise.all(keys.map(key => this._queue(key, () => cache.delete(key))));
  }
}

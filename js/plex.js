import { parseLRC } from './lrc.js';

const CLOUD = 'https://plex.tv/api/v2';
const PRODUCT = 'Folio Audiobooks';
const seconds = value => Math.max(0, Number(value) || 0) / 1000;
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const tags = value => array(value).map(item => item.tag || item.title).filter(Boolean);
const localHost = host => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
const progressRows = (items, bookRatingKey = '') => items.map(item => ({
  ratingKey: String(item.ratingKey),
  bookRatingKey: String(item.parentRatingKey || String(item.parentKey || '').match(/\/library\/metadata\/([^/?]+)/)?.[1] || bookRatingKey),
  duration: seconds(item.duration), viewOffset: seconds(item.viewOffset),
  viewCount: Number(item.viewCount) || 0, lastViewedAt: Number(item.lastViewedAt) || 0,
  index: Number(item.index) || 0, disc: Number(item.parentIndex) || 1,
})).sort((a, b) => a.bookRatingKey.localeCompare(b.bookRatingKey, undefined, { numeric: true }) || a.disc - b.disc || a.index - b.index || a.ratingKey.localeCompare(b.ratingKey, undefined, { numeric: true }));

export class PlexError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'PlexError';
    this.status = status;
  }
}

function lyricOffset(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const offset = Number(value);
  return Number.isFinite(offset) && offset >= 0 && offset <= Number.MAX_SAFE_INTEGER ? offset : null;
}

function timedLyrics(lyrics) {
  for (const lyric of array(lyrics)) {
    const rows = array(lyric?.Line).flatMap(line => {
      const spans = array(line?.Span);
      const start = lyricOffset(spans[0]?.startOffset) ?? lyricOffset(line?.startOffset);
      if (start == null) return [];
      const milliseconds = Math.round(start);
      const minutes = Math.floor(milliseconds / 60000), seconds = Math.floor(milliseconds % 60000 / 1000);
      const stamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
      const text = spans.map(span => typeof span?.text === 'string' ? span.text : '').join('').replace(/[\r\n]+/g, ' ');
      return [{ text, row: `[${stamp}]${text}` }];
    });
    if (rows.some(row => row.text.trim())) return rows.map(row => row.row).join('\n') + '\n';
  }
  return null;
}

const xmlEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key) => {
    if (key[0] !== '#') return xmlEntities[key] ?? entity;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

function xmlAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/\b([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[match[1]] = xmlText(match[2] ?? match[3]);
  return attributes;
}

function plexTranscriptText(source) {
  const text = source.replace(/^\uFEFF/, '').trimStart();
  if (!text.trim()) return null;
  if (text.startsWith('{') || text.startsWith('[') && !/^\[(?:\d+:|[A-Za-z]+:)/.test(text)) {
    let data;
    try { data = JSON.parse(text); } catch { throw new PlexError('Plex returned an unsupported transcript response.'); }
    if (!data?.MediaContainer || typeof data.MediaContainer !== 'object') throw new PlexError('Plex returned an unsupported transcript response.');
    return timedLyrics(data.MediaContainer.Lyrics);
  }
  if (text.startsWith('<')) {
    // Plex defaults to a MediaContainer/Lyrics XML envelope. Only read that
    // documented shape; never render markup or expand DTD/external entities.
    const xml = text.replace(/^<\?xml[^?]*\?>\s*/, '');
    if (/^<MediaContainer\b[^>]*\/>\s*$/.test(xml)) return null;
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/^<MediaContainer\b[\s\S]*<\/MediaContainer>\s*$/.test(xml)) throw new PlexError('Plex returned an unsupported transcript response.');
    const lyrics = [];
    for (const lyric of xml.matchAll(/<Lyrics\b[^>]*>([\s\S]*?)<\/Lyrics\s*>/g)) {
      const lines = [];
      for (const line of lyric[1].matchAll(/<Line\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Line\s*>)/g)) {
        const spans = [...(line[2] || '').matchAll(/<Span\b((?:"[^"]*"|'[^']*'|[^'">])*)\/?>/g)].map(span => xmlAttributes(span[1]));
        lines.push({ ...xmlAttributes(line[1]), Span: spans });
      }
      lyrics.push({ Line: lines });
    }
    return timedLyrics(lyrics);
  }
  // Some servers/proxies label raw LRC as XML or JSON. Validate the content,
  // rather than treating the Content-Type header as proof that it is absent.
  return parseLRC(source).some(cue => cue.text.trim()) ? source : null;
}

/** All public durations and offsets are seconds; Plex's wire format is milliseconds. */
export class PlexClient {
  constructor({ clientId } = {}) {
    this.clientId = clientId || globalThis.crypto?.randomUUID?.() || `folio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  _url(base, path = '', token, params = {}) {
    const root = new URL(base);
    const url = new URL(path || root.href, `${root.href.replace(/\/$/, '')}/`);
    // Metadata keys are supplied by the server. Never send its credential elsewhere.
    if (url.origin !== root.origin) throw new PlexError('Plex returned a media address outside this server.');
    Object.entries({
      'X-Plex-Product': PRODUCT,
      'X-Plex-Version': '1.0.0',
      'X-Plex-Client-Identifier': this.clientId,
      'X-Plex-Platform': 'Web',
      'X-Plex-Device': 'Browser',
      'X-Plex-Device-Name': PRODUCT,
      ...(token ? { 'X-Plex-Token': token } : {}),
      ...params,
    }).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });
    return url.href;
  }

  async _request(base, path, token, params, { signal, timeout = 20000, method = 'GET', empty = false, redirect = 'follow' } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(this._url(base, path, token, params), {
        method, headers: { Accept: 'application/json' }, signal: controller.signal, redirect,
        mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new PlexError('Plex denied access. Sign in again or check the server token and library permissions.', response.status);
        if (response.status === 404) throw new PlexError('This Plex item or endpoint could not be found. Refresh the library.', 404);
        if (response.status === 429) throw new PlexError('Plex is receiving too many requests. Please wait a moment and try again.', 429);
        throw new PlexError(`Plex returned HTTP ${response.status}. Please try again.`, response.status);
      }
      if (empty || response.status === 204) return null;
      const body = await response.text();
      if (!body.trim()) return {};
      try { return JSON.parse(body); }
      catch { throw new PlexError('This address did not return Plex JSON. Check the server address and update Plex Media Server.'); }
    } catch (error) {
      if (signal?.aborted) throw signal.reason || new DOMException('Request canceled', 'AbortError');
      if (error instanceof PlexError) throw error;
      if (controller.signal.aborted) throw new PlexError('The Plex server took too long to respond. Check that it is online and reachable.');
      throw new PlexError('Could not reach Plex. Check your connection, server HTTPS certificate, remote access, and browser CORS access.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  _serverURL(server) {
    if (!server?.url) throw new PlexError('Connect to a Plex server first.');
    return server.url;
  }

  async createPin() {
    const pin = await this._request(CLOUD, `${CLOUD}/pins`, null, { strong: true }, { method: 'POST' });
    if (!pin.id || !pin.code) throw new PlexError('Plex did not return a sign-in code. Please try again.');
    const query = new URLSearchParams({ clientID: this.clientId, code: pin.code, 'context[device][product]': PRODUCT });
    return { ...pin, authUrl: `https://app.plex.tv/auth#?${query}` };
  }

  checkPin(id) {
    return this._request(CLOUD, `${CLOUD}/pins/${encodeURIComponent(id)}`);
  }

  async resources(token) {
    const result = await this._request(CLOUD, `${CLOUD}/resources`, token, { includeHttps: 1, includeRelay: 1, includeIPv6: 1 });
    return array(result).filter(resource => String(resource.provides || '').split(',').includes('server')).map(resource => ({
      id: String(resource.clientIdentifier || resource.machineIdentifier || resource.id),
      name: resource.name || 'Plex Media Server',
      token: resource.accessToken || token,
      owned: resource.owned === true || resource.owned === 1 || resource.owned === '1',
      connections: array(resource.connections).map(connection => ({
        uri: connection.uri,
        local: connection.local === true || connection.local === 1 || connection.local === '1',
        relay: connection.relay === true || connection.relay === 1 || connection.relay === '1',
      })).filter(connection => connection.uri),
    }));
  }

  _secureURL(value) {
    let url;
    try { url = new URL(value); }
    catch { throw new PlexError('Enter a complete Plex server address, including https:// and its port.'); }
    if (url.username || url.password) throw new PlexError('Use the token field for authentication, not credentials in the server address.');
    const developmentHTTP = url.protocol === 'http:' && localHost(url.hostname) && globalThis.location?.protocol === 'http:';
    if (url.protocol !== 'https:' && !developmentHTTP) throw new PlexError('Use an HTTPS Plex address, such as its secure plex.direct connection. HTTP is supported only for localhost development over HTTP.');
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/$/, '');
  }

  async validateServer({ url, token }) {
    if (!String(token || '').trim()) throw new PlexError('Enter your Plex access token.');
    const address = this._secureURL(String(url || '').trim());
    const result = await this._request(address, '/', String(token).trim(), {}, { timeout: 9000 });
    const identity = result.MediaContainer || result;
    if (!identity.machineIdentifier) throw new PlexError('This address is not a Plex Media Server.');
    return {
      id: String(identity.machineIdentifier), name: identity.friendlyName || 'Plex Media Server',
      token: String(token).trim(), url: address,
      connections: [{ uri: address, local: localHost(new URL(address).hostname), relay: false }],
    };
  }

  async connect(server) {
    const candidates = [...(server.url ? [{ uri: server.url, local: true, relay: false }] : []), ...array(server.connections)]
      .sort((a, b) => Number(a.relay) - Number(b.relay) || Number(b.local) - Number(a.local));
    const seen = new Set();
    const valid = candidates.filter(connection => {
      try {
        connection.uri = this._secureURL(connection.uri);
        if (seen.has(connection.uri)) return false;
        seen.add(connection.uri);
        return true;
      } catch { return false; }
    });
    if (!valid.length) throw new PlexError('This server has no usable HTTPS connection. Enable secure connections and remote access in Plex, then refresh the server list.');
    // Probe concurrently: an unavailable LAN address must not delay a working remote one.
    try {
      return await Promise.any(valid.map(async connection => {
        const result = await this._request(connection.uri, '/', server.token, {}, { timeout: 8000 });
        const identity = result.MediaContainer || result;
        if (!identity.machineIdentifier || (server.id && String(identity.machineIdentifier) !== String(server.id))) throw new PlexError('The connection belongs to a different Plex server.');
        return { ...server, id: String(identity.machineIdentifier), url: connection.uri };
      }));
    } catch (error) {
      const denied = error.errors?.find(item => item.status === 401 || item.status === 403);
      if (denied) throw denied;
      throw new PlexError('Cannot reach this Plex server over HTTPS. Check that it is online, secure connections and remote access are enabled, and this browser permits the server connection.');
    }
  }

  async libraries(server) {
    const data = await this._request(this._serverURL(server), '/library/sections', server.token);
    return array(data.MediaContainer?.Directory).filter(item => item.type === 'artist' || item.type === 'music').map(item => ({
      id: String(item.key), title: item.title || 'Music', type: item.type,
    }));
  }

  async _pages(server, path, params = {}, { signal, onProgress, timeout } = {}) {
    const items = [];
    const seen = new Set();
    let offset = 0;
    for (;;) {
      const data = await this._request(this._serverURL(server), path, server.token, {
        ...params, 'X-Plex-Container-Start': offset, 'X-Plex-Container-Size': 200,
      }, { signal, timeout });
      const container = data.MediaContainer || {};
      const page = array(container.Metadata);
      let added = 0;
      for (const item of page) {
        const key = String(item.ratingKey || item.key);
        if (!seen.has(key)) { seen.add(key); items.push(item); added++; }
      }
      const total = Number(container.totalSize);
      onProgress?.({ loaded: items.length, total: Number.isFinite(total) ? total : null });
      if (!page.length || !added) break;
      offset = (Number(container.offset) || offset) + page.length;
      if (Number.isFinite(total) && offset >= total) break;
    }
    return items;
  }

  async books(server, libraryId, options = {}) {
    const items = await this._pages(server, `/library/sections/${encodeURIComponent(libraryId)}/all`, {
      type: 9, sort: 'titleSort:asc', includeCollections: 1,
    }, options);
    return items.map(item => ({
      id: `${server.id}:${item.ratingKey}`, ratingKey: String(item.ratingKey), serverId: server.id,
      libraryId: String(libraryId), title: item.title || 'Untitled audiobook',
      author: item.parentTitle || item.originalTitle || 'Unknown author', summary: item.summary || '',
      thumb: item.thumb || item.parentThumb || '', year: Number(item.year) || null,
      duration: seconds(item.duration || item.totalDuration), genres: tags(item.Genre), collections: tags(item.Collection),
      viewCount: Number(item.viewCount) || 0, updatedAt: Number(item.updatedAt) || 0,
      lastViewedAt: Number(item.lastViewedAt) || 0, leafCount: Number(item.leafCount) || 0,
      viewedLeafCount: Number(item.viewedLeafCount) || 0, viewOffset: seconds(item.viewOffset),
    }));
  }

  async libraryProgress(server, libraryId, options = {}) {
    const items = await this._pages(server, `/library/sections/${encodeURIComponent(libraryId)}/all`, { type: 10 }, options);
    return progressRows(items);
  }

  async bookProgress(server, book, options = {}) {
    const items = await this._pages(server, `/library/metadata/${encodeURIComponent(book.ratingKey)}/children`, {}, { timeout: 5000, ...options });
    return progressRows(items, book.ratingKey);
  }

  async tracks(server, book) {
    let items = await this._pages(server, `/library/metadata/${encodeURIComponent(book.ratingKey)}/children`, { includeChapters: 1 });
    const missing = items.filter(item => !item.Chapter && item.ratingKey);
    // Some PMS releases omit chapters on /children; metadata supports comma-separated keys.
    const details = new Map();
    for (let i = 0; i < missing.length; i += 50) {
      const keys = missing.slice(i, i + 50).map(item => encodeURIComponent(item.ratingKey)).join(',');
      try {
        const data = await this._request(this._serverURL(server), `/library/metadata/${keys}`, server.token, { includeChapters: 1 });
        array(data.MediaContainer?.Metadata).forEach(item => details.set(String(item.ratingKey), item));
      } catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
        // The children response remains playable if optional chapter enrichment fails.
      }
    }
    items = items.map(item => ({ ...item, ...details.get(String(item.ratingKey)) }));
    items.sort((a, b) => (Number(a.parentIndex) || 1) - (Number(b.parentIndex) || 1) || (Number(a.index) || 0) - (Number(b.index) || 0) || String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
    return items.flatMap((item, itemIndex) => {
      // Multiple Media entries are alternative encodings, not consecutive tracks.
      const media = array(item.Media).find(candidate => array(candidate.Part).some(part => part.key));
      const parts = array(media?.Part).filter(part => part.key);
      const total = seconds(item.duration || media?.duration);
      const known = parts.reduce((sum, part) => sum + seconds(part.duration), 0);
      const unknownSize = parts.filter(part => !Number(part.duration)).reduce((sum, part) => sum + (Number(part.size) || 1), 0);
      let partOffset = 0;
      return parts.map((part, partIndex) => {
        const duration = seconds(part.duration) || (parts.length === 1 ? total : Math.max(0, total - known) * (Number(part.size) || 1) / (unknownSize || 1));
        const sourceChapters = array(part.Chapter || item.Chapter);
        const chapterOffset = part.Chapter ? 0 : partOffset;
        const chapters = sourceChapters.map((chapter, index) => {
          const start = seconds(chapter.startTimeOffset) - chapterOffset;
          const next = sourceChapters[index + 1];
          const end = chapter.endTimeOffset != null ? seconds(chapter.endTimeOffset) - chapterOffset : next ? seconds(next.startTimeOffset) - chapterOffset : duration;
          return { id: String(chapter.id ?? index), title: chapter.title || `Chapter ${index + 1}`, start: Math.max(0, start), end: duration ? Math.min(duration, end) : end };
        }).filter(chapter => chapter.end > chapter.start && (!duration || chapter.start < duration));
        const ratingKey = String(item.ratingKey);
        const container = String(part.container || media?.container || '').toLowerCase();
        const mime = ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg; codecs=opus', wav: 'audio/wav', wma: 'audio/x-ms-wma' })[container] || 'application/octet-stream';
        const track = {
          id: `${server.id}:${ratingKey}${parts.length > 1 ? `:${part.id || partIndex}` : ''}`,
          ratingKey, title: `${item.title || `Track ${itemIndex + 1}`}${parts.length > 1 ? ` · Part ${partIndex + 1}` : ''}`,
          index: Number(item.index) || itemIndex + 1, disc: Number(item.parentIndex) || 1,
          duration, key: part.key, size: Number(part.size) || 0, mime,
          viewOffset: Math.min(duration || Infinity, Math.max(0, seconds(item.viewOffset) - partOffset)),
          viewCount: Number(item.viewCount) || 0, lastViewedAt: Number(item.lastViewedAt) || 0,
          chapters, partOffset, metadataDuration: total || duration,
          partId: String(part.id || ''), lyrics: this._lyrics(server, part),
          durationEstimated: !Number(part.duration) && parts.length > 1,
        };
        partOffset += duration;
        return track;
      });
    });
  }

  _lyrics(server, part) {
    const root = new URL(this._serverURL(server));
    return array(part?.Stream).filter(stream => Number(stream.streamType) === 4).flatMap(stream => {
      const id = String(stream.id || '');
      const key = stream.key || (/^\d+$/.test(id) ? `/library/streams/${id}` : '');
      if (!key) return [];
      let url;
      try { url = new URL(key, root); } catch { return []; }
      if (url.origin !== root.origin || url.username || url.password) return [];
      // Persist a server-relative descriptor, never an authenticated media URL.
      for (const name of [...url.searchParams.keys()]) if (/^x-plex-token$/i.test(name)) url.searchParams.delete(name);
      return [{ id, key: url.pathname + url.search, format: String(stream.format || stream.codec || '').toLowerCase(),
        timed: stream.timed === true || stream.timed === 1 || stream.timed === '1', provider: String(stream.provider || '') }];
    });
  }

  async transcript(server, track, { signal } = {}) {
    if (!track?.ratingKey) return null;
    // Read fresh metadata so old cached books can discover a newly added sidecar.
    const data = await this._request(this._serverURL(server), `/library/metadata/${encodeURIComponent(track.ratingKey)}`, server.token, {}, { signal, timeout: 10000, redirect: 'error' });
    const item = array(data.MediaContainer?.Metadata).find(item => String(item.ratingKey) === String(track.ratingKey));
    if (!item) return null;
    const media = array(item.Media);
    const parts = media.flatMap(media => array(media.Part));
    const partId = track.partId || String(track.key || '').match(/\/library\/parts\/(\d+)(?:\/|$)/)?.[1];
    const defaultParts = array(media.find(media => array(media.Part).some(part => part.key))?.Part);
    const part = parts.find(part => part.key === track.key || partId && String(part.id) === String(partId))
      || (defaultParts.length === 1 && !(track.partOffset > 0) ? defaultParts[0] : null);
    const streams = this._lyrics(server, part).filter(stream => stream.format === 'lrc' || stream.timed)
      .sort((a, b) => Number(/local/i.test(b.provider)) - Number(/local/i.test(a.provider)) || Number(b.format === 'lrc') - Number(a.format === 'lrc'));
    for (const stream of streams) {
      const text = await this._transcriptText(server, stream.key, { signal });
      // Lyrics belong to their Media.Part, whose timestamps are file-relative.
      if (text?.trim()) return { text, offset: 0, source: stream.key };
    }
    return null;
  }

  async _transcriptText(server, key, { signal } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 15000);
    const limit = 5 * 1024 * 1024;
    try {
      const response = await fetch(this._url(this._serverURL(server), key, server.token), {
        headers: { Accept: 'application/json' }, signal: controller.signal,
        mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error',
      });
      if (response.status === 404 || response.status === 204) return null;
      if (response.status === 401 || response.status === 403) throw new PlexError('Plex denied access to this transcript. Reconnect the server in Settings.', response.status);
      if (!response.ok) throw new PlexError(`Plex could not load the transcript (HTTP ${response.status}).`, response.status);
      if (Number(response.headers.get('Content-Length')) > limit) { await response.body?.cancel(); throw new PlexError('This transcript is too large to read.'); }
      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > limit) throw new PlexError('This transcript is too large to read.');
        return plexTranscriptText(text);
      }
      const decoder = new TextDecoder();
      let size = 0, text = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); throw new PlexError('This transcript is too large to read.'); }
          text += decoder.decode(value, { stream: true });
        }
        return plexTranscriptText(text + decoder.decode());
      } finally { reader.releaseLock(); }
    } catch (error) {
      if (signal?.aborted) throw signal.reason || new DOMException('Request canceled', 'AbortError');
      if (error instanceof PlexError) throw error;
      if (controller.signal.aborted) throw new PlexError('Plex took too long to return this transcript. Try again.');
      throw new PlexError('Could not load the transcript from Plex. Check the server connection and browser access.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  mediaURL(server, track) {
    if (!track?.key) throw new PlexError('This track has no playable media file.');
    return this._url(this._serverURL(server), track.key, server.token);
  }

  artworkURL(server, book, width = 500) {
    if (!book?.thumb) return '';
    return this._url(this._serverURL(server), '/photo/:/transcode', server.token, {
      url: book.thumb, width: Math.max(64, Math.min(1600, Number(width) || 500)),
      height: Math.max(64, Math.min(1600, Number(width) || 500)), minSize: 1, upscale: 0,
    });
  }

  timeline(server, track, { position = 0, duration = track.duration, state = 'playing' } = {}) {
    return this._request(this._serverURL(server), '/:/timeline', server.token, {
      ratingKey: track.ratingKey, key: `/library/metadata/${track.ratingKey}`,
      state, time: Math.round((Math.max(0, Number(position) || 0) + (track.partOffset || 0)) * 1000),
      duration: Math.round((track.metadataDuration || Number(duration) || 0) * 1000),
      hasMDE: 1, playbackTime: Math.round(Math.max(0, Number(position) || 0) * 1000),
    }, { empty: true, timeout: 10000 });
  }

  markPlayed(server, book, played = true) {
    return this._request(this._serverURL(server), played ? '/:/scrobble' : '/:/unscrobble', server.token, {
      key: book.ratingKey, identifier: 'com.plexapp.plugins.library',
    }, { empty: true });
  }
}

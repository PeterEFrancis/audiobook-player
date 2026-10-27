const CLOUD = 'https://plex.tv/api/v2';
const PRODUCT = 'Folio Audiobooks';
const seconds = value => Math.max(0, Number(value) || 0) / 1000;
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const tags = value => array(value).map(item => item.tag || item.title).filter(Boolean);
const localHost = host => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

export class PlexError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'PlexError';
    this.status = status;
  }
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

  async _request(base, path, token, params, { signal, timeout = 20000, method = 'GET', empty = false } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(this._url(base, path, token, params), {
        method, headers: { Accept: 'application/json' }, signal: controller.signal,
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

  async _pages(server, path, params = {}, { signal, onProgress } = {}) {
    const items = [];
    const seen = new Set();
    let offset = 0;
    for (;;) {
      const data = await this._request(this._serverURL(server), path, server.token, {
        ...params, 'X-Plex-Container-Start': offset, 'X-Plex-Container-Size': 200,
      }, { signal });
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
          durationEstimated: !Number(part.duration) && parts.length > 1,
        };
        partOffset += duration;
        return track;
      });
    });
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

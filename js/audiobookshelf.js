import { serverURL, endpoint, request } from './server-http.js';

const list = value => Array.isArray(value) ? value : [];
const number = value => Math.max(0, Number(value) || 0);
const itemPath = id => `api/items/${encodeURIComponent(id)}`;
const progressRow = (book, progress = {}) => ({
  ratingKey: String(book.ratingKey), bookRatingKey: String(book.ratingKey),
  duration: number(progress.duration) || number(book.duration),
  viewOffset: progress.isFinished ? 0 : number(progress.currentTime),
  viewCount: progress.isFinished ? 1 : 0, lastViewedAt: number(progress.lastUpdate) / 1000,
  index: 1, disc: 1,
});

/** Audiobookshelf uses one whole-book progress record, even for multiple audio files. */
export class AudiobookshelfClient {
  constructor({ clientId, onServerChanged } = {}) {
    this.clientId = clientId;
    this.onServerChanged = onServerChanged;
    this.libraryBooks = new Map();
    this.pendingBooks = new Map();
    this.refreshes = new Map();
  }

  async login({ url, username, password, token }) {
    const address = serverURL(url);
    if (String(token || '').trim()) return this.validateServer({ url: address, token: String(token).trim() });
    if (!String(username || '').trim() || !password) throw new Error('Enter your Audiobookshelf username and password, or an API token.');
    const result = await request({ url: address }, 'login', { method: 'POST', headers: { 'x-return-tokens': 'true' }, body: { username: String(username).trim(), password } });
    // The user token is the persistent API credential; accessToken is a short-lived session token.
    const credential = result.user?.token || result.user?.accessToken;
    if (!credential) throw new Error('Audiobookshelf did not return a token. Create an API token in Audiobookshelf and use it to connect.');
    return { ...this._server(address, credential, result.user), ...(!result.user.token && result.user.refreshToken ? { refreshToken: result.user.refreshToken } : {}) };
  }

  _server(url, token, user) {
    if (!user?.id) throw new Error('This address did not return an Audiobookshelf user.');
    return { id: `audiobookshelf:${encodeURIComponent(url)}`, provider: 'audiobookshelf', url, token,
      userId: String(user.id), name: `Audiobookshelf · ${new URL(url).host}`,
      canDownload: user.isActive !== false && user.permissions?.download !== false };
  }

  async validateServer({ url, token, refreshToken }) {
    if (!String(token || '').trim()) throw new Error('Enter your Audiobookshelf API token.');
    const address = serverURL(url);
    const connection = { url: address, token: String(token).trim(), ...(refreshToken ? { refreshToken } : {}) };
    const user = await this._request(connection, 'api/me');
    return { ...this._server(address, connection.token, user), ...(connection.refreshToken ? { refreshToken: connection.refreshToken } : {}) };
  }

  async _refresh(server) {
    const key = server.id || server.url;
    if (!this.refreshes.has(key)) this.refreshes.set(key, (async () => {
      const result = await request({ ...server, token: '' }, 'auth/refresh', { method: 'POST', headers: { 'x-refresh-token': server.refreshToken } });
      if (!result.user?.accessToken || !result.user?.refreshToken) throw new Error('Your Audiobookshelf session expired. Sign in again or use an API token.');
      server.token = result.user.accessToken;
      server.refreshToken = result.user.refreshToken;
      await this.onServerChanged?.(server);
    })().finally(() => this.refreshes.delete(key)));
    return this.refreshes.get(key);
  }

  async _request(server, path, options) {
    let expires = 0;
    try { expires = Number(JSON.parse(atob(server.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp) * 1000; } catch {}
    if (server.refreshToken && expires && expires < Date.now() + 60000) await this._refresh(server);
    try { return await request(server, path, options); }
    catch (error) {
      if (error.status !== 401 || !server.refreshToken) throw error;
      await this._refresh(server);
      return request(server, path, options);
    }
  }

  async connect(server) {
    const connected = await this.validateServer(server);
    if (server.userId && server.userId !== connected.userId) throw new Error('This token belongs to a different Audiobookshelf user. Add it as a new connection.');
    return { ...server, ...connected };
  }

  async libraries(server) {
    const data = await this._request(server, 'api/libraries');
    return list(data.libraries).filter(library => library.mediaType === 'book').map(library => ({
      id: String(library.id), title: library.name || 'Audiobooks', type: 'book',
    }));
  }

  books(server, libraryId, options = {}) {
    const key = `${server.id}:${libraryId}`;
    if (this.pendingBooks.has(key)) return this.pendingBooks.get(key);
    const pending = this._books(server, libraryId, options).finally(() => this.pendingBooks.delete(key));
    this.pendingBooks.set(key, pending);
    return pending;
  }

  async _books(server, libraryId, { onProgress, signal } = {}) {
    const items = [], seen = new Set();
    for (let page = 0; ; page++) {
      const data = await this._request(server, `api/libraries/${encodeURIComponent(libraryId)}/items`, {
        params: { limit: 200, page, sort: 'media.metadata.title', minified: 1, collapseseries: 0 }, signal,
      });
      const results = list(data.results);
      let added = 0;
      for (const item of results) if (item.id && !seen.has(String(item.id))) {
        seen.add(String(item.id)); items.push(item); added++;
      }
      onProgress?.({ loaded: items.length, total: Number.isFinite(Number(data.total)) ? Number(data.total) : null });
      if (!results.length || !added || (data.total != null && items.length >= Number(data.total))) break;
    }
    const books = items.filter(item => item.mediaType === 'book' && (number(item.media?.numAudioFiles) || list(item.media?.audioFiles).length || number(item.media?.duration))).map(item => {
      const media = item.media || {}, metadata = media.metadata || {};
      const id = String(item.id);
      return { id: `${server.id}:${id}`, ratingKey: id, serverId: server.id, libraryId: String(libraryId),
        title: metadata.title || 'Untitled audiobook', author: metadata.authorName || list(metadata.authors).map(author => author.name).filter(Boolean).join(', ') || 'Unknown author',
        summary: metadata.description || '', thumb: media.coverPath ? `${itemPath(id)}/cover` : '',
        year: Number(metadata.publishedYear) || null, duration: number(media.duration),
        genres: list(metadata.genres), collections: list(metadata.series).map(series => series.name).filter(Boolean).concat(metadata.seriesName ? [metadata.seriesName] : []),
        viewCount: 0, viewedLeafCount: 0, leafCount: 1, lastViewedAt: 0, updatedAt: number(item.updatedAt) / 1000,
        canDownload: server.canDownload !== false,
      };
    });
    this.libraryBooks.set(`${server.id}:${libraryId}`, books);
    return books;
  }

  async libraryProgress(server, libraryId, options = {}) {
    const key = `${server.id}:${libraryId}`;
    const books = await (this.pendingBooks.get(key) || this.libraryBooks.get(key) || this.books(server, libraryId, options));
    const user = await this._request(server, 'api/me', options);
    const progress = new Map(list(user.mediaProgress).filter(row => !row.episodeId).map(row => [String(row.libraryItemId), row]));
    // Include untouched/reset books so another client's "mark unplayed" clears stale local progress.
    return books.map(book => progressRow(book, progress.get(book.ratingKey)));
  }

  async bookProgress(server, book, options = {}) {
    const item = await this._request(server, itemPath(book.ratingKey), { params: { expanded: 1, include: 'progress' }, timeout: 5000, ...options });
    return [progressRow({ ...book, duration: number(item.media?.duration) || book.duration }, item.userMediaProgress || {})];
  }

  async tracks(server, book) {
    const item = await this._request(server, itemPath(book.ratingKey), { params: { expanded: 1, include: 'progress' } });
    const media = item.media || {}, progress = item.userMediaProgress || {};
    const files = list(media.tracks).length ? list(media.tracks) : list(media.audioFiles);
    const ordered = files.filter(file => !file.exclude && file.ino).sort((a, b) =>
      (a.startOffset != null && b.startOffset != null ? number(a.startOffset) - number(b.startOffset) : number(a.index) - number(b.index)));
    const total = number(media.duration) || ordered.reduce((sum, file) => sum + number(file.duration), 0);
    let offset = 0;
    return ordered.map((file, index) => {
      const duration = number(file.duration), partOffset = file.startOffset != null ? number(file.startOffset) : offset;
      offset = partOffset + duration;
      const chapters = list(media.chapters).map((chapter, chapterIndex, source) => ({
        id: String(chapter.id ?? chapterIndex), title: chapter.title || `Chapter ${chapterIndex + 1}`,
        start: Math.max(0, number(chapter.start) - partOffset),
        end: Math.min(duration, (chapter.end != null ? number(chapter.end) : source[chapterIndex + 1] ? number(source[chapterIndex + 1].start) : total) - partOffset),
      })).filter(chapter => chapter.end > chapter.start);
      return { id: `${server.id}:${book.ratingKey}:${file.ino}`, ratingKey: String(book.ratingKey), bookRatingKey: String(book.ratingKey),
        title: file.title || file.metadata?.filename || `Track ${index + 1}`, index: index + 1, disc: 1,
        duration, key: `${itemPath(book.ratingKey)}/file/${encodeURIComponent(file.ino)}`, size: number(file.metadata?.size || file.size),
        mime: file.mimeType || 'application/octet-stream', partOffset, metadataDuration: total,
        viewOffset: progress.isFinished ? 0 : Math.min(duration, Math.max(0, number(progress.currentTime) - partOffset)),
        viewCount: progress.isFinished ? 1 : 0, lastViewedAt: number(progress.lastUpdate) / 1000, chapters,
      };
    });
  }

  mediaURL(server, track) {
    if (!track?.key) throw new Error('This audiobook has no playable audio file.');
    return endpoint(server, track.key, { token: server.token });
  }

  downloadURL(server, track) {
    if (server.canDownload === false) throw new Error('Your Audiobookshelf account does not have download permission.');
    if (!track?.key) throw new Error('This audiobook has no downloadable audio file.');
    return endpoint(server, `${track.key.replace(/\/$/, '')}/download`, { token: server.token });
  }

  artworkURL(server, book, width = 500) {
    return book?.thumb ? endpoint(server, `${itemPath(book.ratingKey)}/cover`, { token: server.token, width: Math.min(1600, Math.max(64, number(width) || 500)), format: 'jpeg' }) : '';
  }

  timeline(server, track, { position = 0, duration = track.duration } = {}) {
    const total = number(track.metadataDuration) || number(duration);
    const currentTime = Math.min(total || Infinity, number(position) + number(track.partOffset));
    return this._request(server, `api/me/progress/${encodeURIComponent(track.ratingKey)}`, { method: 'PATCH', empty: true,
      body: { duration: total, currentTime, progress: total ? currentTime / total : 0, isFinished: total > 0 && currentTime >= total },
    });
  }

  async markPlayed(server, book, played = true) {
    let duration = number(book.duration) || list(book.tracks).reduce((sum, track) => sum + number(track.duration), 0);
    if (!duration) {
      const item = await this._request(server, itemPath(book.ratingKey), { params: { expanded: 1 } });
      duration = number(item.media?.duration);
    }
    return this._request(server, `api/me/progress/${encodeURIComponent(book.ratingKey)}`, { method: 'PATCH', empty: true,
      body: { duration, currentTime: played ? duration : 0, progress: played ? 1 : 0, isFinished: !!played },
    });
  }
}

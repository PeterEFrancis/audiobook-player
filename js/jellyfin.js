import { serverURL, endpoint, request } from './server-http.js';

const seconds = ticks => Math.max(0, Number(ticks) || 0) / 10000000;
const ticks = value => Math.round(Math.max(0, Number(value) || 0) * 10000000);
const array = value => Array.isArray(value) ? value : [];
const date = value => Math.max(0, Date.parse(value) / 1000 || 0);
const id = value => encodeURIComponent(String(value));
const sort = (a, b) => (Number(a.ParentIndexNumber) || 1) - (Number(b.ParentIndexNumber) || 1) || (Number(a.IndexNumber) || 0) - (Number(b.IndexNumber) || 0) || String(a.Name).localeCompare(String(b.Name), undefined, { numeric: true });
const mime = container => ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg; codecs=opus', wav: 'audio/wav', wma: 'audio/x-ms-wma' })[String(container || '').toLowerCase()] || 'application/octet-stream';
const isAudio = item => item.Type === 'Audio' || item.Type === 'AudioBook' || item.MediaType === 'Audio' || mime(item.Container).startsWith('audio/') || array(item.MediaSources).some(source => array(source.MediaStreams).some(stream => stream.Type === 'Audio'));
const fields = 'Overview,Genres,People,ParentId,MediaSources,Chapters,CanDownload,ChildCount,RecursiveItemCount,CumulativeRunTimeTicks,DateCreated,DateLastSaved';
const progress = (item, bookId) => ({
  ratingKey: String(item.Id), bookRatingKey: String(bookId || item.AlbumId || item.Id),
  duration: seconds(item.RunTimeTicks), viewOffset: item.UserData?.Played && Number(item.RunTimeTicks) > 0 && Number(item.UserData.PlaybackPositionTicks) >= Number(item.RunTimeTicks) ? 0 : seconds(item.UserData?.PlaybackPositionTicks),
  viewCount: item.UserData?.Played ? Math.max(1, Number(item.UserData.PlayCount) || 0) : 0,
  lastViewedAt: date(item.UserData?.LastPlayedDate), index: Number(item.IndexNumber) || 1, disc: Number(item.ParentIndexNumber) || 1,
});

/** Jellyfin and Emby use 100ns ticks on the wire; Folio uses seconds. */
export class JellyfinClient {
  constructor({ clientId, provider = 'jellyfin' } = {}) {
    this.clientId = clientId || globalThis.crypto?.randomUUID?.() || `folio-${Date.now()}`;
    this.provider = provider === 'emby' ? 'emby' : 'jellyfin';
    this.sessions = new Map();
  }

  _headers(server) {
    const quote = value => String(value || '').replace(/["\\\r\n]/g, '');
    const auth = `${this.provider === 'emby' ? 'Emby' : 'MediaBrowser'} Client="Folio Audiobooks", Device="Browser", DeviceId="${quote(this.clientId)}", Version="1.0.0"${server.userId ? `, UserId="${quote(server.userId)}"` : ''}${server.token && this.provider !== 'emby' ? `, Token="${quote(server.token)}"` : ''}`;
    return { Authorization: auth, ...(this.provider === 'emby' && server.token ? { 'X-Emby-Token': server.token } : {}) };
  }

  async _request(server, path, options = {}) {
    const settings = { ...options, headers: { ...this._headers(server), ...options.headers } };
    try { return await request(server, path, settings); }
    catch (error) {
      if (this.provider !== 'jellyfin' || ![404, 405].includes(error.status)) throw error;
      const legacy = path === 'UserViews' ? this._userPath(server, '/Views')
        : path === 'Items' ? this._userPath(server, '/Items')
        : /^Items\/[^/]+$/.test(path) ? this._userPath(server, `/${path}`)
        : /^UserPlayedItems\//.test(path) ? this._userPath(server, `/PlayedItems/${path.slice('UserPlayedItems/'.length)}`) : '';
      if (!legacy) throw error;
      return request(server, legacy, settings);
    }
  }

  _userPath(server, suffix = '') {
    if (!server.userId) throw new Error('Sign in with a user account to access this library.');
    return `Users/${id(server.userId)}${suffix}`;
  }

  async login({ url, username, password, token, userId } = {}) {
    const server = { url: serverURL(url), provider: this.provider };
    if (token) return this.validateServer({ ...server, token, userId });
    if (!String(username || '').trim()) throw new Error('Enter your server username.');
    const result = await this._request(server, 'Users/AuthenticateByName', { method: 'POST', body: { Username: String(username).trim(), Pw: String(password || '') } });
    if (!result.AccessToken || !result.User?.Id) throw new Error('The server did not return a valid user session.');
    return this._identity({ ...server, token: result.AccessToken, userId: String(result.User.Id) }, result.User, result.ServerId);
  }

  async _identity(server, user, serverId) {
    const info = await this._request(server, 'System/Info/Public');
    if (!info.Id && !serverId && !user.ServerId) throw new Error('This address is not a compatible media server.');
    return { ...server, id: `${this.provider}:${info.Id || serverId || user.ServerId}`, provider: this.provider,
      name: info.ServerName || user.ServerName || (this.provider === 'emby' ? 'Emby' : 'Jellyfin'), userId: String(user.Id), username: user.Name || '',
      canDownload: user.Policy?.EnableContentDownloading !== false };
  }

  async validateServer({ url, token, userId } = {}) {
    if (!String(token || '').trim()) throw new Error('Enter a user access token.');
    const server = { url: serverURL(url), token: String(token).trim(), userId, provider: this.provider };
    const user = await this._request(server, userId ? `Users/${id(userId)}` : 'Users/Me');
    if (!user.Id) throw new Error('Use a user access token or sign in with your username and password.');
    return this._identity(server, user);
  }

  async connect(server) {
    const connected = await this.validateServer(server);
    if (server.id && connected.id !== server.id) throw new Error('This address belongs to a different media server.');
    return { ...server, ...connected };
  }

  async libraries(server) {
    const data = await this._request(server, this.provider === 'emby' ? this._userPath(server, '/Views') : 'UserViews', { params: { userId: server.userId } });
    return array(data.Items).filter(item => ['books', 'music', 'audiobooks'].includes(String(item.CollectionType || '').toLowerCase())).map(item => ({ id: String(item.Id), title: item.Name || 'Audiobooks', type: item.CollectionType }));
  }

  async _pages(server, params, { onProgress, timeout, signal } = {}) {
    const items = [], seen = new Set();
    let offset = 0;
    for (;;) {
      const data = await this._request(server, this.provider === 'emby' ? this._userPath(server, '/Items') : 'Items', { params: { userId: server.userId, Recursive: true, EnableUserData: true, Fields: fields, Limit: 200, ...params, StartIndex: offset }, timeout, signal });
      const page = array(data.Items);
      let added = 0;
      for (const item of page) if (item.Id && !seen.has(String(item.Id))) { seen.add(String(item.Id)); items.push(item); added++; }
      const total = Number(data.TotalRecordCount);
      onProgress?.({ loaded: items.length, total: Number.isFinite(total) ? total : null });
      offset += page.length;
      if (!page.length || !added || (Number.isFinite(total) && offset >= total)) return items;
    }
  }

  _catalog(server, libraryId, options) {
    return this._pages(server, { ParentId: libraryId, IncludeItemTypes: 'MusicAlbum,AudioBook,Audio,Book', SortBy: 'SortName', SortOrder: 'Ascending' }, options);
  }

  async books(server, libraryId, options = {}) {
    const items = await this._catalog(server, libraryId, options);
    const albums = new Map(items.filter(item => item.Type === 'MusicAlbum').map(item => [String(item.Id), item]));
    const audio = items.filter(isAudio);
    const members = new Map();
    // Album tracks are represented by their album, never as duplicate books.
    for (const item of audio) if (item.AlbumId) {
      const albumId = String(item.AlbumId);
      if (!members.has(albumId)) members.set(albumId, []);
      members.get(albumId).push(item);
      if (!albums.has(albumId)) albums.set(albumId, { ...item, Id: albumId, Name: item.Album || item.Name, Type: 'MusicAlbum', RunTimeTicks: 0, UserData: {} });
    }
    return [...albums.values(), ...audio.filter(item => !item.AlbumId)].map(item => {
      const children = members.get(String(item.Id)) || [];
      const user = item.UserData || {};
      const authors = array(item.AlbumArtists).length ? item.AlbumArtists : array(item.People).filter(person => ['Author', 'Writer'].includes(person.Type)).map(person => person.Name);
      const author = [...authors, ...array(item.Artists), ...array(item.ArtistItems)].map(value => typeof value === 'string' ? value : value?.Name).filter(Boolean)[0] || 'Unknown author';
      const thumbId = item.ImageTags?.Primary ? item.Id : item.ParentPrimaryImageItemId || (item.AlbumPrimaryImageTag ? item.AlbumId : '');
      return { id: `${server.id}:${item.Id}`, ratingKey: String(item.Id), serverId: server.id, libraryId: String(libraryId), nativeItemType: item.Type,
        title: item.Name || 'Untitled audiobook', author, summary: item.Overview || '', thumb: thumbId ? String(thumbId) : '', year: Number(item.ProductionYear) || null,
        duration: children.length ? children.reduce((total, child) => total + seconds(child.RunTimeTicks), 0) : seconds(item.RunTimeTicks || item.CumulativeRunTimeTicks),
        genres: array(item.Genres), collections: array(item.Tags), viewCount: user.Played ? Math.max(1, Number(user.PlayCount) || 0) : 0,
        viewedLeafCount: children.length ? children.filter(child => child.UserData?.Played).length : user.Played ? 1 : 0, leafCount: children.length || 1,
        lastViewedAt: Math.max(date(user.LastPlayedDate), ...children.map(child => date(child.UserData?.LastPlayedDate))),
        viewOffset: seconds(user.PlaybackPositionTicks), updatedAt: date(item.DateLastSaved || item.DateCreated), canDownload: item.CanDownload !== false && server.canDownload !== false };
    });
  }

  async libraryProgress(server, libraryId, options = {}) {
    const items = (await this._catalog(server, libraryId, options)).filter(isAudio).sort(sort);
    return items.map(item => progress(item));
  }

  async _bookItems(server, book, options = {}) {
    if (book.nativeItemType === 'MusicAlbum') return (await this._pages(server, { ParentId: book.ratingKey, IncludeItemTypes: 'Audio,AudioBook' }, options)).filter(isAudio).sort(sort);
    const item = await this._request(server, this.provider === 'emby' ? this._userPath(server, `/Items/${id(book.ratingKey)}`) : `Items/${id(book.ratingKey)}`, { params: { userId: server.userId }, ...options });
    if (item.Type === 'MusicAlbum') return (await this._pages(server, { ParentId: book.ratingKey, IncludeItemTypes: 'Audio,AudioBook' }, options)).filter(isAudio).sort(sort);
    return isAudio(item) ? [item] : [];
  }

  async bookProgress(server, book, options = {}) {
    return (await this._bookItems(server, book, { timeout: 5000, ...options })).map(item => progress(item, book.ratingKey));
  }

  async tracks(server, book) {
    const items = await this._bookItems(server, book);
    return items.map((item, index) => {
      const source = array(item.MediaSources).find(value => value.Protocol !== 'Http' && value.IsRemote !== true) || array(item.MediaSources)[0] || {};
      const duration = seconds(item.RunTimeTicks || source.RunTimeTicks);
      const chapterRows = array(item.Chapters);
      const chapters = chapterRows.map((chapter, chapterIndex) => ({ id: String(chapterIndex), title: chapter.Name || `Chapter ${chapterIndex + 1}`, start: seconds(chapter.StartPositionTicks), end: chapterRows[chapterIndex + 1] ? seconds(chapterRows[chapterIndex + 1].StartPositionTicks) : duration })).filter(chapter => chapter.end > chapter.start);
      return { id: `${server.id}:${item.Id}`, ratingKey: String(item.Id), bookRatingKey: String(book.ratingKey), title: item.Name || `Track ${index + 1}`,
        key: `Audio/${id(item.Id)}/stream`, index: Number(item.IndexNumber) || index + 1, disc: Number(item.ParentIndexNumber) || 1,
        duration, size: Number(source.Size || item.Size) || 0, mime: mime(source.Container || item.Container), mediaSourceId: source.Id || String(item.Id),
        canDownload: server.canDownload !== false && book.canDownload !== false && item.CanDownload !== false, chapters, ...Object.fromEntries(Object.entries(progress(item)).filter(([key]) => ['viewOffset', 'viewCount', 'lastViewedAt'].includes(key))) };
    });
  }

  _mediaParams(server) {
    return { ...(this.provider === 'jellyfin' ? { ApiKey: server.token } : {}), api_key: server.token, DeviceId: this.clientId };
  }

  mediaURL(server, track) {
    if (!track?.ratingKey) throw new Error('This track has no playable media file.');
    return endpoint(server, `Audio/${id(track.ratingKey)}/stream`, { ...this._mediaParams(server), Static: true, MediaSourceId: track.mediaSourceId || track.ratingKey });
  }

  downloadURL(server, track) {
    if (server.canDownload === false || track.canDownload === false) throw new Error('This server account does not allow downloading this audiobook.');
    if (!track?.ratingKey) throw new Error('This track has no downloadable media file.');
    return endpoint(server, `Items/${id(track.ratingKey)}/Download`, this._mediaParams(server));
  }

  artworkURL(server, book, width = 500) {
    return book?.thumb ? endpoint(server, `Items/${id(book.thumb)}/Images/Primary`, { ...this._mediaParams(server), MaxWidth: Math.max(64, Math.min(1600, Number(width) || 500)), Quality: 90 }) : '';
  }

  async timeline(server, track, { position = 0, duration = track.duration, state = 'playing' } = {}) {
    const played = Boolean(Number(duration) > 0 && position >= duration);
    const body = { PlaybackPositionTicks: played ? 0 : ticks(position), Played: played, LastPlayedDate: new Date().toISOString() };
    const userDataPath = this.provider === 'emby' ? this._userPath(server, `/Items/${id(track.ratingKey)}/UserData`) : `UserItems/${id(track.ratingKey)}/UserData`;
    // Dashboard check-ins are optional; the durable checkpoint is saved last.
    const sessionKey = `${server.id}:${track.ratingKey}`;
    const info = { ItemId: track.ratingKey, MediaSourceId: track.mediaSourceId || track.ratingKey, PositionTicks: ticks(position), CanSeek: true, IsPaused: state !== 'playing', PlayMethod: 'DirectPlay', PlaySessionId: `${this.clientId}-${track.ratingKey}`, QueueableMediaTypes: ['Audio'] };
    try {
      if (state === 'stopped') { await this._request(server, 'Sessions/Playing/Stopped', { method: 'POST', body: info, empty: true }); this.sessions.delete(sessionKey); }
      else {
        const started = this.sessions.has(sessionKey);
        await this._request(server, started ? 'Sessions/Playing/Progress' : 'Sessions/Playing', { method: 'POST', body: { ...info, EventName: state === 'paused' ? 'Pause' : 'TimeUpdate' }, empty: true });
        this.sessions.set(sessionKey, true);
      }
    } catch { /* A missing playback session must not prevent offline progress sync. */ }
    try { await this._request(server, userDataPath, { method: 'POST', params: { userId: server.userId }, body, empty: true }); }
    catch (error) {
      if (this.provider !== 'jellyfin' || ![404, 405].includes(error.status)) throw error;
      // Older servers may persist session reports. Verify their stored userdata
      // rather than assuming a successful dashboard event saved a checkpoint.
      let verified = false;
      try {
        const item = await this._request(server, `Items/${id(track.ratingKey)}`, { params: { userId: server.userId } });
        const stored = item.UserData, offset = seconds(stored?.PlaybackPositionTicks);
        verified = !!stored && (played ? stored.Played === true && (offset === 0 || offset >= duration)
          : Math.abs(offset - Math.max(0, Number(position) || 0)) <= 1 && (stored.Played !== true || position > 0));
      } catch { /* Keep the pending checkpoint if authoritative readback fails. */ }
      if (!verified) {
        const pending = new Error('This server could not save your listening position. Your progress remains pending on this device. Update Jellyfin or check its resume settings.');
        pending.status = error.status;
        throw pending;
      }
    }
  }

  async markPlayed(server, book, played = true) {
    const targets = book.nativeItemType === 'MusicAlbum' ? (await this._bookItems(server, book)).map(item => item.Id) : [book.ratingKey];
    for (const target of targets) await this._request(server, this.provider === 'emby' ? this._userPath(server, `/PlayedItems/${id(target)}`) : `UserPlayedItems/${id(target)}`, { method: played ? 'POST' : 'DELETE', params: { userId: server.userId }, empty: true });
  }
}

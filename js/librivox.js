const endpoint = 'https://librivox.org/api/feed/audiobooks';
const list = value => Array.isArray(value) ? value : [];
const number = value => Math.max(0, Number(value) || 0);
const seconds = value => String(value).includes(':') ? String(value).split(':').reduce((total, part) => total * 60 + number(part), 0) : number(value);
const plain = value => String(value || '').replace(/<br\s*\/?\s*>|<\/(?:p|div)>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
  if (entity[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity.toLowerCase()];
  const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}).trim();
const secureURL = value => {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};
const abortError = () => new DOMException('Request canceled', 'AbortError');
let callbackId = 0;

// LibriVox explicitly supports JSONP; its catalog API does not send browser CORS headers.
export function requestCatalog(params, { signal, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const callback = `folioLibriVox${Date.now()}_${++callbackId}`;
    const script = document.createElement('script');
    const url = new URL(endpoint);
    Object.entries({ ...params, format: 'jsonp', callback }).forEach(([key, value]) => { if (value != null) url.searchParams.set(key, value); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); script.remove(); delete globalThis[callback]; };
    const finish = (error, data) => { cleanup(); error ? reject(error) : resolve(data); };
    const abort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error('LibriVox took too long to respond. Try refreshing the catalog.')), timeout);
    globalThis[callback] = data => finish(null, data);
    script.src = url.href;
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.onerror = () => finish(new Error('Could not reach the LibriVox catalog. Check your connection and try again.'));
    signal?.addEventListener('abort', abort, { once: true });
    document.head.append(script);
  });
}

export const librivoxServer = { id: 'librivox', provider: 'librivox', name: 'LibriVox', url: 'https://librivox.org', localProgress: true, canDownload: true };
export const librivoxLibrary = { id: 'catalog', serverId: 'librivox', title: 'LibriVox', type: 'book' };
const records = data => {
  if (Array.isArray(data?.books)) return data.books;
  if (/audiobooks could not be found/i.test(data?.error || '')) return [];
  throw new Error(data?.error || 'LibriVox did not return catalog data. Try refreshing the catalog.');
};
export async function fetchArchiveJSON(url, { signal, timeout = 30000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`Internet Archive returned HTTP ${response.status}. Try again later.`);
    const data = await response.json();
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : 'Internet Archive could not complete this request.');
    return data;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (controller.signal.aborted) throw new Error('Internet Archive took too long to respond. Try again.');
    if (error instanceof TypeError) throw new Error('Could not reach Internet Archive. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

const values = value => (Array.isArray(value) ? value : [value]).filter(Boolean);
const sourceURL = metadata => {
  for (const value of [...values(metadata.source), ...values(metadata['librivox-url']), ...values(metadata.description)]) {
    const matches = String(value).match(/https?:\/\/(?:www\.)?librivox\.org\/[^\s"'<>]+/gi) || [];
    const match = matches.find(url => new URL(url).pathname !== '/');
    if (match) return secureURL(match);
  }
  return '';
};
const archiveBook = row => {
  const id = String(row.identifier), cover = `https://archive.org/services/img/${encodeURIComponent(id)}`;
  return {
    id: `librivox:archive:${id}`, ratingKey: id, archiveIdentifier: id, serverId: 'librivox', libraryId: 'catalog',
    title: plain(values(row.title).join(', ')) || 'Untitled audiobook', author: plain(values(row.creator).join(', ')) || 'Unknown author',
    summary: plain(values(row.description).join('\n')), language: values(row.language).join(', '),
    year: Number(String(row.year || row.date || '').slice(0, 4)) || null, duration: seconds(values(row.runtime)[0] || 0),
    genres: values(row.subject).flatMap(value => String(value).split(';')).map(plain).filter(Boolean), collections: ['LibriVox'],
    cover, thumb: cover, sourceURL: sourceURL(row), archiveURL: `https://archive.org/details/${encodeURIComponent(id)}`,
    license: 'Public domain in the USA (LibriVox)', librivox: true, localProgress: true, inLibrary: false, canDownload: true,
    viewCount: 0, viewedLeafCount: 0, lastViewedAt: 0, updatedAt: 0,
  };
};

export class LibriVoxAPI {
  constructor({ request = requestCatalog, fetchJSON = fetchArchiveJSON } = {}) { this.request = request; this.fetchJSON = fetchJSON; }
  async login() { return { ...librivoxServer }; }
  async validateServer() { return { ...librivoxServer }; }
  async connect(server) { return { ...server, ...librivoxServer }; }
  async libraries() { return [{ ...librivoxLibrary }]; }

  async books() { return []; }

  async search(query, { field = 'title', offset = 0, limit = 30, signal } = {}) {
    const tokens = String(query || '').match(/[\p{L}\p{N}]+/gu) || [];
    if (tokens.join('').length < 2) return { books: [], hasMore: false, nextOffset: 0 };
    const start = Math.floor(number(offset));
    const pageSize = Math.min(50, Math.max(1, Math.floor(number(limit)) || 30));
    const term = tokens.map((token, index) => index === tokens.length - 1 ? `${token}*` : `"${token}"`).join(' AND ');
    const url = new URL('https://archive.org/advancedsearch.php');
    url.searchParams.set('q', `collection:librivoxaudio AND mediatype:audio AND ${field === 'author' ? 'creator' : 'title'}:(${term})`);
    url.searchParams.set('output', 'json');
    url.searchParams.set('rows', pageSize);
    // Archive echoes `start` but actually paginates using `page`.
    url.searchParams.set('page', Math.floor(start / pageSize) + 1);
    url.searchParams.set('sort[]', 'identifier asc');
    for (const name of ['identifier', 'title', 'creator', 'description', 'language', 'date', 'year', 'subject', 'runtime']) url.searchParams.append('fl[]', name);
    const data = await this.fetchJSON(url.href, { signal });
    if (!Array.isArray(data.response?.docs)) throw new Error('Internet Archive did not return catalog data. Try again.');
    const rows = data.response.docs.slice(start % pageSize);
    const nextOffset = start + rows.length;
    return { books: rows.filter(row => row.identifier).map(archiveBook), hasMore: nextOffset < number(data.response.numFound), nextOffset };
  }

  async archiveTracks(book, { signal } = {}) {
    const identifier = book.archiveIdentifier;
    const data = await this.fetchJSON(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { signal });
    const metadata = data.metadata || {}, files = list(data.files), byName = new Map(files.map(file => [file.name, file]));
    const playable = files.filter(file => /\.mp3$/i.test(file.name || '') && /MP3/i.test(file.format || ''));
    const formats = ['64Kbps MP3', '128Kbps MP3', 'VBR MP3', 'MP3'];
    const format = formats.find(value => playable.some(file => file.format === value)) || playable[0]?.format;
    const rank = file => number(String(file.track || byName.get(file.original)?.track || '').split('/')[0]);
    const chosen = playable.filter(file => file.format === format).sort((a, b) => {
      const disc = number(a.disc || byName.get(a.original)?.disc) - number(b.disc || byName.get(b.original)?.disc);
      return disc || (rank(a) && rank(b) ? rank(a) - rank(b) : 0) || a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    const seen = new Set();
    const narrator = plain(values(metadata.narrator || metadata.reader || metadata.readby).join(', ')) || plain(values(metadata.description).join('\n')).match(/Read(?: in [\p{L} ]+)? by\s+([^\n.]+)/iu)?.[1]?.trim() || '';
    const tracks = chosen.filter(file => { const original = file.original || file.name; if (seen.has(original)) return false; seen.add(original); return true; }).map((file, index) => {
      const original = byName.get(file.original) || {};
      return {
        id: `${book.id}:${file.name}`, ratingKey: file.name, bookRatingKey: String(book.ratingKey),
        title: plain(file.title || original.title) || `Chapter ${index + 1}`, index: index + 1, disc: number(file.disc || original.disc) || 1,
        duration: seconds(file.length || original.length), size: number(file.size), mime: 'audio/mpeg', chapters: [], narrator,
        key: `https://archive.org/download/${encodeURIComponent(identifier)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
      };
    });
    if (!tracks.length) throw new Error('Internet Archive did not return playable MP3 chapters for this book. Try again later.');
    book.narrator = narrator;
    book.sourceURL = sourceURL(metadata) || book.sourceURL || '';
    book.summary = plain(values(metadata.description).join('\n')) || book.summary;
    book.duration = tracks.reduce((sum, track) => sum + track.duration, 0);
    book.leafCount = tracks.length;
    return tracks;
  }

  async tracks(server, book, { signal } = {}) {
    if (book.archiveIdentifier) return this.archiveTracks(book, { signal });
    const row = records(await this.request({ id: book.ratingKey, extended: 1, limit: 1 }, { signal }))[0];
    const tracks = list(row?.sections).filter(section => secureURL(section.listen_url)).sort((a, b) => number(a.section_number) - number(b.section_number)).map((section, index) => ({
      id: `librivox:${book.ratingKey}:${section.id || index + 1}`, ratingKey: String(section.id || index + 1), bookRatingKey: String(book.ratingKey),
      title: plain(section.title) || `Chapter ${index + 1}`, index: index + 1, disc: 1,
      duration: seconds(section.playtime), key: secureURL(section.listen_url), size: 0, mime: 'audio/mpeg', chapters: [],
      narrator: list(section.readers).map(reader => plain(reader.display_name)).filter(Boolean).join(', '),
    }));
    if (!tracks.length) throw new Error('LibriVox did not return playable chapters for this book. Try again later.');
    book.narrator = [...new Set(tracks.map(track => track.narrator).filter(Boolean))].join(', ');
    return tracks;
  }
  mediaURL(server, track) {
    const url = secureURL(track?.key);
    if (!url) throw new Error('This audiobook has no playable audio file.');
    return url;
  }
  downloadURL(server, track) { return this.mediaURL(server, track); }
  artworkURL(server, book) { return secureURL(book?.thumb || book?.cover); }
  async libraryProgress() { return []; }
  async bookProgress() { return []; }
  async timeline() {}
  async markPlayed() {}
}

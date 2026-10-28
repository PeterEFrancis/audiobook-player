import { ServerClient, providerName } from './servers.js';
import { plexProgress } from './plex-progress.js';
import { db } from './db.js';
import { DownloadManager } from './downloads.js';
import { Player } from './player.js';
import { librivoxServer, librivoxLibrary } from './librivox.js';
import { retireAutomaticCatalog } from './librivox-catalog.js';
import { removeLegacySamples } from './sample-migration.js';
import { bindBookSheet } from './book-sheet.js';
import { escapeHTML as e, clock, duration, bytes, sumDuration, chaptersFor } from './utils.js';

const paths = {
  library:'M4 4h4v16H4zM10 4h4v16h-4zM16 5l4-1 3 15-4 1z', headphones:'M4 14v-3a8 8 0 0116 0v3M4 12H2v7h5v-7H4m16 0h2v7h-5v-7h3',
  download:'M12 3v12m-5-5l5 5 5-5M4 16v5h16v-5',heart:'M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 00-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 000-7.8z',
  bookmark:'M6 3h12v18l-6-4-6 4z',collection:'M3 6h7l2 2h9v12H3zM3 6V3h7l2 2h9v3',history:'M3 4v6h6M3 10a9 9 0 119 11M12 7v6l4 2',
  search:'M20 20l-5-5M17 10a7 7 0 11-14 0 7 7 0 0114 0',
  plex:'M8 3h5l7 9-7 9H8l7-9z',menu:'M3 6h18M3 12h18M3 18h18',play:'M7 4l14 8-14 8z',pause:'M6 4h4v16H6zM14 4h4v16h-4z',
  back:'M4 9a8 8 0 111 9M3 3v7h7',forward:'M20 9a8 8 0 10-1 9M21 3v7h-7',moon:'M20 15a8 8 0 01-11-11 9 9 0 1011 11z',
  expand:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',close:'M5 5l14 14M19 5L5 19',more:'M5 12h.1M12 12h.1M19 12h.1',check:'M4 12l5 5L20 6',
  arrow:'M4 12h16m-5-5l5 5-5 5',refresh:'M20 8a8 8 0 00-14-3L3 8m0-5v5h5m-4 8a8 8 0 0014 3l3-3m0 5v-5h-5',trash:'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  cloud:'M7 18a5 5 0 110-10 6 6 0 0112 1 4.5 4.5 0 01-1 9M9 14l3-3 3 3m-3-3v10',leaf:'M5 20C1 6 13 3 21 3c0 8-3 18-12 14M5 20L16 9',
  queue:'M3 5h18M3 11h18M3 17h10m4-2l5 3-5 3z',volume:'M3 9h4l5-5v16l-5-5H3zM16 8a6 6 0 010 8m3-11a10 10 0 010 14',previous:'M5 4v16m14-16L7 12l12 8z',next:'M19 4v16M5 4l12 8-12 8z',book:'M3 3h6l3 3 3-3h6v16h-6l-3 3-3-3H3zM12 6v16'
};
const I = name => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="${paths[name] || paths.book}"/></svg>`;
const $ = (selector, root = document) => root.querySelector(selector);
const content = $('#content');
const modal = $('#modal');
const resetBookSheet = bindBookSheet(modal);
let modalVersion = 0;
const activeSeeks = new Set(), pendingSeeks = new WeakMap();
const isPlaybackSeek = el => ['mini-seek','now-seek'].includes(el?.id);
let config;
try { config = JSON.parse(localStorage.getItem('folio.connection') || '{}'); } catch { config = {}; }
config.servers ||= []; config.libraries ||= [];
const clientId = localStorage.getItem('folio.client') || crypto.randomUUID();
localStorage.setItem('folio.client', clientId);
const plexAPI = new ServerClient({clientId, onServerChanged: () => saveConfig()});
const plex = {
  mediaURL:(server,track)=>plexAPI.mediaURL(server,track),
  downloadURL:(server,track)=>plexAPI.downloadURL(server,track),
  artworkURL:(server,book)=>plexAPI.artworkURL(server,book)
};
const getServer = id => id === librivoxServer.id ? librivoxServer : config.servers.find(s => s.id === id);
const downloads = new DownloadManager({getServer, plex});
let books = [], progress = new Map(), downloadRecords = new Map(), bookmarks = [], history = [], settings = {}, reading = [], queue = [];
let view = location.hash.slice(1) || 'library', query = '', filter = 'all', sort = 'title', group = null, detailBook = null;
let syncing = false, refreshBusy = false, pinTimer, workerRegistration;
let refreshPromise, lastPlexPull = 0, incomingSyncStatus = '', refreshingServerId = null;
let outgoingSyncError = '', shelfLimit = 60;
let catalogQuery = '', catalogField = 'title', catalogResults = [], catalogOffset = 0, catalogHasMore = false, catalogSearching = false, catalogError = '', catalogSearched = false, catalogAbort, catalogVersion = 0;
const labels = {library:'Library',continue:'Continue listening',downloads:'Downloads',reading:'Reading list',bookmarks:'Bookmarks',collections:'Collections & authors',history:'Listening history',settings:'Settings'};
if (!labels[view]) view = 'library';
const workerReady = prepareWorker();
const player = new Player({plex, downloads, getServer, artworkURL: cover, settings});

document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = I(el.dataset.icon));
function saveConfig() { localStorage.setItem('folio.connection', JSON.stringify(config)); }
function cover(book) {
  if (downloadRecords.get(book.id)?.status === 'complete') return downloads.artworkURL(book.id);
  const server = getServer(book.serverId);
  return server?.url && book.thumb ? plexAPI.artworkURL(server, book) : './assets/icon.svg';
}
function toast(message, error = false, action) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error-toast' : ''}`; el.textContent = message;
  if (action) { const button = document.createElement('button'); button.textContent = action.label; button.onclick = () => { action.run(); el.remove(); }; el.append(button); }
  $('#toasts').append(el); setTimeout(() => el.remove(), error ? 12000 : 6000);
}
function image(book, className = '') { return `<img class="${className}" src="${e(cover(book))}" alt="${e(book.title)} cover" loading="lazy">`; }
document.addEventListener('error', event => { const img = event.target; if (img.tagName === 'IMG' && !img.src.endsWith('/assets/icon.svg')) img.src = './assets/icon.svg'; }, true);
function heading(title, subtitle, action = '') { return `<div class="page-heading"><div><p class="eyebrow">THE ART OF LISTENING</p><h1>${title}</h1><p class="lead">${subtitle}</p></div>${action}</div>`; }
function empty(title, text, icon = 'book', action = '') { return `<div class="empty-state">${I(icon)}<h2>${title}</h2><p>${text}</p>${action}</div>`; }
function ratio(book) { const p = progress.get(book.id); return p?.completed ? 100 : Math.min(100, (p?.elapsed || 0) / (sumDuration(book) || 1) * 100); }
function libraryBooks() { return books.filter(book => book.librivox ? book.inLibrary : downloadRecords.get(book.id)?.status==='complete' || config.libraries.some(library=>library.serverId===book.serverId&&(!book.libraryId||String(library.id)===String(book.libraryId)))); }
function activeLibraries() { return [...config.libraries,...(libraryBooks().some(book=>book.librivox) ? [librivoxLibrary] : [])]; }
function visibleBooks() {
  return libraryBooks().filter(book => {
    const p = progress.get(book.id);
    if (view === 'continue' && (!p?.elapsed || p.completed)) return false;
    if (view === 'reading' && !reading.includes(book.id)) return false;
    if (group && ![book.author,...(book.collections || []),...(book.genres || [])].includes(group)) return false;
    if (filter === 'progress' && (!p?.elapsed || p.completed)) return false;
    if (filter === 'finished' && !p?.completed) return false;
    if (filter === 'unread' && (p?.elapsed || p?.completed)) return false;
    return `${book.title} ${book.author} ${(book.collections || []).join(' ')} ${(book.genres || []).join(' ')}`.toLowerCase().includes(query.toLowerCase());
  }).sort((a,b) => sort === 'recent' ? (progress.get(b.id)?.updatedAt || 0) - (progress.get(a.id)?.updatedAt || 0) : sort === 'author' ? a.author.localeCompare(b.author) : sort === 'duration' ? sumDuration(a) - sumDuration(b) : a.title.localeCompare(b.title));
}
function bookCard(book) {
  const p = progress.get(book.id), d = downloadRecords.get(book.id);
  return `<article class="book-card"><div class="cover-wrap"><button class="cover-button" data-act="detail" data-id="${e(book.id)}" aria-label="Open ${e(book.title)}">${image(book)}<span class="cover-play">${I('play')}</span></button>${p?.completed ? '<span class="cover-badge">Finished</span>' : book.librivox ? '<span class="cover-badge">LIBRIVOX</span>' : p?.elapsed ? `<span class="cover-badge">${Math.round(ratio(book))}% listened</span>` : ''}${d?.status === 'complete' ? `<span class="cover-badge downloaded" title="Available offline">${I('download')}</span>` : ''}</div><div class="book-meta"><div><h3><button class="title-button" data-act="detail" data-id="${e(book.id)}">${e(book.title)}</button></h3><p>${e(book.author)}</p><small>${duration(sumDuration(book))}${book.genres?.length ? ` <span aria-hidden="true">·</span> ${e(book.genres.join(', '))}` : ''}</small></div><button class="icon-button" data-act="detail" data-id="${e(book.id)}" aria-label="Options for ${e(book.title)}">${I('more')}</button></div>${p?.elapsed ? `<div class="progress-line"><span style="width:${ratio(book)}%"></span></div>` : ''}</article>`;
}
function renderShelf() {
  const items = visibleBooks();
  const shelf = libraryBooks();
  const free = shelf.length > 0 && shelf.every(b => b.librivox);
  const libraries = activeLibraries();
  const latest = shelf.filter(b => progress.get(b.id)?.elapsed && !progress.get(b.id)?.completed).sort((a,b) => progress.get(b.id).updatedAt - progress.get(a.id).updatedAt)[0] || shelf.find(b => !progress.get(b.id)?.completed) || shelf[0];
  const p = latest && progress.get(latest.id);
  const welcome = view === 'library' && !query && !group;
  content.innerHTML = heading(group ? e(group) : labels[view], group ? `${items.length} books` : `${shelf.length.toLocaleString()} ${shelf.length===1?'book':'books'} · ${libraries.length>1 ? `${libraries.length} libraries` : e(libraries[0]?.title || 'Your library')}`, view==='library' && settings.includeLibrivox !== false ? `<button class="button outline" data-act="find-librivox">${I('search')} Find LibriVox books</button>` : '') +
    (welcome && latest ? `<div class="welcome-cards"><article class="resume-card">${image(latest,'resume-cover')}<div class="resume-body"><p class="eyebrow">${p?.elapsed ? 'CONTINUE LISTENING' : free ? 'EXPLORE LIBRIVOX' : 'READY TO LISTEN'}</p><h2>${e(latest.title)}</h2><p>${e(latest.author)}</p><div class="progress-line"><span style="width:${ratio(latest)}%"></span></div><div class="progress-meta"><span>${p?.elapsed ? `${Math.round(ratio(latest))}%` : 'Not started'}</span><span>${duration(Math.max(0,sumDuration(latest) - (p?.elapsed || 0)))} left</span></div><div class="resume-actions"><button class="button" data-act="play-book" data-id="${e(latest.id)}">${I('play')}${p?.elapsed ? 'Resume' : 'Listen'}</button><button class="icon-button" data-act="detail" data-id="${e(latest.id)}" aria-label="Book details">${I('more')}</button></div></div></article></div>` : '') +
    `<div class="shelf-toolbar"><div class="shelf-title"><h2>${group ? 'Books' : view === 'reading' ? 'Saved for later' : view === 'continue' ? 'In progress' : 'All books'}</h2><span>${items.length}</span></div><div class="toolbar-actions"><div class="filters" role="group" aria-label="Listening status">${[['all','All'],['progress','In progress'],['unread','Unplayed'],['finished','Finished']].map(([id,label]) => `<button data-act="filter" data-value="${id}" class="${filter === id ? 'active' : ''}" aria-pressed="${filter === id}">${label}</button>`).join('')}</div><select id="sort" aria-label="Sort books"><option value="title">Title</option><option value="author">Author</option><option value="recent">Recent</option><option value="duration">Length</option></select></div></div>` +
    (items.length ? `<div class="book-grid">${items.slice(0,shelfLimit).map(bookCard).join('')}</div>${items.length>shelfLimit ? `<p><button class="button outline" data-act="more-books">Show more books (${Math.min(shelfLimit,items.length)} of ${items.length.toLocaleString()})</button></p>` : ''}` : empty(query ? 'No stories by that name.' : 'A fresh page.', query ? 'Try another title, author, or collection.' : view === 'reading' ? 'Add a book to your reading list from its details. Your next listen will be waiting here.' : !shelf.length ? settings.includeLibrivox !== false ? 'Find a free audiobook in the LibriVox catalog and add it to your library, or connect your server in Settings.' : 'Connect your audiobook server in Settings, or enable LibriVox catalog search.' : 'The books you’re looking for will appear here.', view === 'reading' ? 'heart' : 'book')) + (group ? '<p><button class="text-button" data-view="collections">← Back to collections</button></p>' : '');
  $('#sort').value = sort;
  if (welcome && latest) $('.welcome-cards',content).insertAdjacentHTML('beforeend',`<article class="offline-promo">${I('download')}<h2>Take your next<br>story offline.</h2><p>Save a book before you go. Your place, your chapters, and your audio come with you.</p><button data-view="downloads">Open downloads &nbsp; →</button></article>`);
}
const downloadRows = new Map();
let downloadStorageAt = 0, downloadStorageState = '', downloadStoragePromise;
async function renderDownloads() {
  if (view !== 'downloads') return;
  if (!$('#download-rows',content)) {
    content.innerHTML = heading('Downloads', 'Your books, ready to go offline.') +
      `<div class="storage-panel"><div><h2>Room for another chapter</h2><p id="download-storage">Checking available storage…</p><p id="download-capability"></p></div><button class="button outline" data-act="persist">Protect downloads ${I('arrow')}</button></div><div id="download-rows"></div><div id="download-empty">${empty('Adventure, packed.', 'Open any book and choose Download. Try a free audiobook first, then put your device offline and press play.', 'download', '<button class="button" data-view="library">Explore your library</button>')}</div>`;
    downloadRows.clear();
    downloadStorageAt = 0;
  }
  $('#download-capability',content).textContent = downloads.backgroundSupported ? 'Downloads can continue after you leave Folio. Your browser may ask for permission.' : 'This browser pauses downloads when Folio is closed or suspended. Keep it open until finished. Completed tracks stay saved.';
  const list = $('#download-rows',content);
  const records = [...downloadRecords.values()];
  for (const [id,row] of downloadRows) if (!downloadRecords.has(id)) { row.remove(); downloadRows.delete(id); }
  let visible = 0;
  // Only new rows are positioned; byte updates must not replace covers or move rows.
  for (const d of records.sort((a,b) => a.updatedAt - b.updatedAt)) {
    let row = downloadRows.get(d.id);
    if (!row) {
      const book = books.find(b => b.id === d.id);
      row = document.createElement('article');
      row.className = 'download-row';
      row.dataset.downloadId = d.id;
      row.innerHTML = `${book ? image(book,'row-cover') : I('book')}<div class="row-body"><h3></h3><p data-download-status></p><div class="progress-line"><span></span></div><p data-download-size></p></div><div class="row-actions"><button data-download-action data-id="${e(d.id)}"></button><button class="icon-button" data-act="remove-download" data-id="${e(d.id)}" aria-label="Remove download of ${e(d.title)}">${I('trash')}</button></div>`;
      row.parts = {title: $('h3',row),status: $('[data-download-status]',row),bar: $('.progress-line span',row),size: $('[data-download-size]',row),action: $('[data-download-action]',row)};
      downloadRows.set(d.id,row);
      list.prepend(row);
    }
    row.hidden = !d.title.toLowerCase().includes(query.toLowerCase());
    if (!row.hidden) visible++;
    const {title,status,bar,size,action} = row.parts;
    title.textContent = d.title;
    status.textContent = d.status === 'complete' ? 'Ready for offline listening' : d.status === 'downloading' ? d.mode === 'background' ? 'Downloading in the background…' : 'Downloading · keep Folio open' : d.status === 'queued' ? 'Waiting in queue' : d.status === 'error' ? d.error || 'Download interrupted' : 'Paused · ready to resume';
    bar.style.width = `${d.status === 'complete' ? 100 : Math.min(100,d.bytes / (d.totalBytes || 1) * 100)}%`;
    size.textContent = `${bytes(d.bytes)}${d.totalBytes ? ` / ${bytes(d.totalBytes)}` : ''} · ${d.completedTracks || 0}/${d.totalTracks} files`;
    const act = d.status === 'complete' ? 'play-book' : ['downloading','queued'].includes(d.status) ? 'pause-download' : 'download';
    if (action.dataset.act !== act) {
      action.dataset.act = act;
      action.className = `button${act === 'pause-download' ? ' outline' : ''}`;
      action.innerHTML = act === 'play-book' ? `${I('play')} Play` : act === 'pause-download' ? 'Pause' : 'Resume';
    }
  }
  $('#download-empty',content).hidden = visible > 0;
  const storageState = records.filter(d => !['queued','downloading'].includes(d.status)).map(d => `${d.id}:${d.status}`).join('|');
  if (!downloadStoragePromise && (Date.now() - downloadStorageAt > 30000 || storageState !== downloadStorageState)) {
    downloadStorageAt = Date.now();
    downloadStorageState = storageState;
    downloadStoragePromise = downloads.storage().then(storage => {
      const label = view === 'downloads' && $('#download-storage',content);
      if (label) label.textContent = `${bytes(storage.usage)} used${storage.quota ? ` of ${bytes(storage.quota)} available to this site` : ''}. ${storage.persisted ? 'Persistent storage granted.' : 'Your browser manages storage.'}`;
    }).finally(() => { downloadStoragePromise = null; });
  }
  return downloadStoragePromise;
}
function renderBookmarks() {
  const rows = bookmarks.filter(b => `${b.title} ${b.note}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => b.createdAt-a.createdAt);
  content.innerHTML = heading('Bookmarks', 'Saved moments and notes.') + (rows.length ? rows.map(bookmarkRow).join('') : empty('Some words stay with you.', 'Tap the bookmark button while listening to save your place and add a note.', 'bookmark'));
}
function bookmarkRow(b) { return `<article class="bookmark-row">${I('bookmark')}<div class="row-body"><h3>${e(b.title)}</h3><p>${e(b.note || 'Saved a little moment.')}<br>${clock(b.absolute || 0)} · ${new Date(b.createdAt).toLocaleDateString()}</p></div><div class="row-actions"><button class="button outline" data-act="jump-bookmark" data-id="${e(b.id)}">Listen</button><button class="icon-button" data-act="edit-bookmark" data-id="${e(b.id)}" aria-label="Edit bookmark">${I('more')}</button><button class="icon-button" data-act="delete-bookmark" data-id="${e(b.id)}" aria-label="Delete bookmark">${I('trash')}</button></div></article>`; }
function renderCollections() {
  const groups = new Map();
  for (const b of libraryBooks()) for (const name of new Set([b.author,...(b.collections || []),...(b.genres || [])])) groups.set(name, (groups.get(name) || 0) + 1);
  content.innerHTML = heading('Collections', 'Browse authors, genres, and collections.') + `<div class="collection-grid">${[...groups].filter(([name]) => name.toLowerCase().includes(query.toLowerCase())).sort((a,b) => a[0].localeCompare(b[0])).map(([name,count]) => `<button class="collection-tile" data-act="group" data-value="${e(name)}">${I('collection')}<strong>${e(name)}</strong><small>${count} ${count === 1 ? 'book' : 'books'} &nbsp; →</small></button>`).join('')}</div>`;
}
async function renderHistory() {
  await player.persist();
  history = await db.all('history');
  if (view !== 'history') return;
  const real = history.filter(h => h.listened > 0.5);
  const dates = new Set(real.map(h => new Date(h.startedAt).toLocaleDateString('en-CA')));
  let streak = 0, day = new Date();
  if (!dates.has(day.toLocaleDateString('en-CA'))) day.setDate(day.getDate()-1);
  while (dates.has(day.toLocaleDateString('en-CA'))) { streak++; day.setDate(day.getDate()-1); }
  content.innerHTML = heading('Listening history', 'Your listening time on this device.') + `<div class="stat-grid"><div class="stat"><strong>${duration(real.reduce((s,h) => s+h.listened,0))}</strong><span>LISTENED</span></div><div class="stat"><strong>${books.filter(b => progress.get(b.id)?.completed).length}</strong><span>FINISHED</span></div><div class="stat"><strong>${streak}</strong><span>DAY STREAK</span></div></div>` +
    (real.length ? real.sort((a,b) => b.startedAt-a.startedAt).filter(h => `${h.title} ${h.author}`.toLowerCase().includes(query.toLowerCase())).slice(0,100).map(h => `<article class="history-row">${I('headphones')}<div class="row-body"><h3>${e(h.title)}</h3><p>${e(h.author)} · ${new Date(h.startedAt).toLocaleString()}<br>${duration(h.listened)} listened</p></div><button class="button outline" data-act="play-book" data-id="${e(h.bookId)}">Listen again</button></article>`).join('') : empty('Every story starts somewhere.', 'Your listening sessions and time will appear here after you press play.', 'history'));
}
function serverLabel(server) { return server.displayName || server.name || providerName(server); }
function serverAddress(server) {
  try { const url=new URL(server.url);return url.origin+url.pathname.replace(/\/$/,''); } catch { return ''; }
}
function serverSettingsCard() {
  return `<section class="settings-card servers-settings"><h2>Your server libraries</h2><button class="button" data-act="connect">${I('cloud')} Add server</button><ul class="server-list">${config.servers.map(server=>{
    const libraries=config.libraries.filter(library=>library.serverId===server.id);
    return `<li><div class="server-title"><h3>${e(serverLabel(server))}</h3><span>${e(providerName(server))}</span></div><p class="server-address">${e(serverAddress(server))}</p><p>${libraries.length ? libraries.map(library=>e(library.title)).join(', ') : 'No libraries selected'}</p><div class="server-actions"><button class="button secondary" data-act="manage-server" data-id="${e(server.id)}" aria-label="Manage ${e(serverLabel(server))}">Manage</button><button class="button outline" data-act="refresh-server" data-id="${e(server.id)}" ${refreshBusy?'disabled':''} aria-label="Refresh ${e(serverLabel(server))}">${refreshBusy&&(!refreshingServerId||refreshingServerId===server.id)?'Refreshing…':'Refresh'}</button><button class="text-button server-remove" data-act="remove-server" data-id="${e(server.id)}" aria-label="Remove ${e(serverLabel(server))}">Remove</button></div></li>`;
  }).join('')}</ul><label class="setting-line">Enable LibriVox catalog search<input type="checkbox" role="switch" data-setting="includeLibrivox" ${settings.includeLibrivox!==false?'checked':''}></label><p id="sync-status">${outgoingSyncError?e(outgoingSyncError):''}</p></section>`;
}
function renderSettings() {
  content.innerHTML = heading('Make yourself <em>at home.</em>', 'A few small things to make your listening feel like yours.') + `<div class="settings-grid">${serverSettingsCard()}<section class="settings-card"><h2>Player settings</h2><label class="setting-line">Default playback speed<select data-setting="speed">${[.5,.75,1,1.1,1.25,1.5,1.75,2,2.5,3].map(n => `<option value="${n}" ${settings.speed === n ? 'selected' : ''}>${n}×</option>`).join('')}</select></label><label class="setting-line">Smart rewind after a pause<input type="checkbox" data-setting="smartRewind" ${settings.smartRewind !== false ? 'checked' : ''}></label><label class="setting-line">Smart rewind seconds<input type="number" min="0" max="60" data-setting="rewindSeconds" value="${settings.rewindSeconds || 10}"></label><label class="setting-line">Keep screen awake while listening<input type="checkbox" data-setting="wakeLock" ${settings.wakeLock ? 'checked' : ''}></label></section><section class="settings-card app-settings-card"><h2>App settings</h2><label class="setting-line">Dark mode<input type="checkbox" role="switch" data-setting="darkMode" ${settings.darkMode ? 'checked' : ''}></label><div class="app-settings-group"><h3>Backups</h3><p>Export your progress, reading list, bookmarks, listening history, and preferences.</p><div class="app-settings-actions"><button class="button secondary" data-act="export">Export backup</button><button class="button outline" data-act="import">Restore backup</button><input type="file" id="backup-file" class="backup-file" accept="application/json,.json"></div></div><div class="app-settings-group"><h3>Updates</h3><div class="app-settings-actions"><button class="button outline" data-act="check-update">Check for updates</button></div></div><div class="app-settings-group"><h3>Listening history</h3><div class="app-settings-actions"><button class="text-button" data-act="clear-history">Clear listening history</button></div></div></section></div>`;
}
function render() {
  $('#view-label').textContent = group || labels[view];
  document.title = `${group || labels[view]} · Folio`;
  document.querySelectorAll('.nav-item[data-view]').forEach(el => { const active = el.dataset.view === view; el.classList.toggle('active',active); if(active) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); });
  document.querySelectorAll('.bottom-tabs [data-view]').forEach(el => {
    const tab = ['bookmarks','collections','history'].includes(view) ? 'settings' : view === 'continue' ? 'library' : view;
    const active = el.dataset.view === tab;
    el.classList.toggle('active',active); el.setAttribute('aria-current',active ? 'page' : 'false');
  });
  $('.search').hidden = ['settings','history'].includes(view);
  $('#download-count').textContent = [...downloadRecords.values()].filter(d => d.status === 'complete').length;
  if (['library','continue','reading'].includes(view)) renderShelf();
  else if (view === 'downloads') renderDownloads().catch(error => toast(error.message,true));
  else if (view === 'bookmarks') renderBookmarks();
  else if (view === 'collections') renderCollections();
  else if (view === 'history') renderHistory().catch(error => toast(error.message,true));
  else if (view === 'settings') {
    renderSettings();
    $('.page-heading h1',content).textContent = 'Settings';
    $('.page-heading .lead',content).remove();
    if (incomingSyncStatus) $('#sync-status').textContent = incomingSyncStatus;
  }
}
function navigate(target) { shelfLimit=60; view = labels[target] ? target : 'library'; group = null; filter = 'all'; query = ''; $('#search').value = ''; location.hash = view; document.body.classList.remove('nav-open'); render(); window.scrollTo(0,0); }
function showModal(title, html, className = '') {
  modalVersion++;
  resetBookSheet();
  modal.className = `modal ${className}`;
  modal.setAttribute('aria-label',title || 'Book details');
  $('#modal-content').innerHTML = `<div class="modal-content">${className === 'book-modal' ? '<button type="button" class="modal-handle" data-act="close" aria-label="Close book details"></button>' : ''}<div class="modal-header">${title ? `<h2>${title}</h2>` : ''}<button class="icon-button" data-act="close" aria-label="Close dialog">${I('close')}</button></div>${html}</div>`;
  if (!modal.open) modal.showModal();
}
function showLibriVoxSearch() {
  if(settings.includeLibrivox === false)return;
  if(query.trim().length>=2 && query!==catalogQuery){catalogQuery=query.trim();catalogResults=[];catalogSearched=false;}
  showModal('Find LibriVox books', `<p>Search the public catalog, then add the books you want to your library.</p><form id="librivox-search"><label class="field">Title or author<input type="search" name="query" minlength="2" required value="${e(catalogQuery)}" placeholder="Search LibriVox" autocomplete="off"></label><div class="form-row"><label class="field">Search by<select name="field"><option value="title" ${catalogField==='title'?'selected':''}>Title</option><option value="author" ${catalogField==='author'?'selected':''}>Author</option></select></label><button type="submit" class="button">${I('search')} Search</button></div></form><div id="librivox-results" aria-live="polite"></div>`);
  renderLibriVoxResults();
  if(catalogQuery.length>=2 && !catalogSearched)void searchLibriVox(catalogQuery,catalogField);
}
function renderLibriVoxResults() {
  const results=$('#librivox-results');if(!results)return;
  results.innerHTML=(catalogError ? `<p class="error">${e(catalogError)}</p>` : '')+
    (catalogResults.length ? `<p>${catalogResults.length} results${catalogHasMore?' shown':''}</p>`+catalogResults.map(book=>{
      const added=books.some(saved=>sameLibriVoxBook(saved,book) && saved.inLibrary);
      return `<article class="history-row">${image(book,'row-cover')}<div class="row-body"><h3>${e(book.title)}</h3><p>${e(book.author)} · ${e(book.language)}<br>${sumDuration(book)>0?duration(sumDuration(book)):'Length available when opened'}</p></div><button class="button outline" data-act="add-librivox" data-id="${e(book.id)}" ${added?'disabled':''}>${added?'Added':'Add to library'}</button></article>`;
    }).join('') : catalogSearched && !catalogSearching && !catalogError ? '<p>No books found. Try another title, or search by author.</p>' : !catalogSearching && !catalogError ? '<p>Your library contains only the books you add. Audio streams when you listen, or you can download it for offline use.</p>' : '')+
    (catalogSearching ? '<p class="loading">Searching LibriVox…</p>' : catalogHasMore ? '<p><button class="button outline" data-act="more-librivox">Show more results</button></p>' : '');
}
async function searchLibriVox(value,field='title',more=false) {
  if(settings.includeLibrivox === false)return;
  const term=String(value||'').trim();if(term.length<2)return;
  catalogAbort?.abort();catalogAbort=new AbortController();
  const version=++catalogVersion;
  catalogQuery=term;catalogField=field==='author'?'author':'title';
  if(!more){catalogResults=[];catalogOffset=0;catalogHasMore=false;}
  catalogSearching=true;catalogError='';catalogSearched=true;renderLibriVoxResults();
  try {
    const result=await plexAPI.clients.librivox.search(term,{field:catalogField,offset:catalogOffset,signal:catalogAbort.signal});
    if(version!==catalogVersion)return;
    const rows=new Map(catalogResults.map(book=>[book.id,book]));for(const book of result.books)rows.set(book.id,book);
    catalogResults=[...rows.values()];catalogOffset=result.nextOffset;catalogHasMore=result.hasMore;
  }catch(error){if(version===catalogVersion && error.name!=='AbortError')catalogError=error.message;}
  finally{if(version===catalogVersion){catalogSearching=false;renderLibriVoxResults();}}
}
function sameLibriVoxBook(a,b) {
  if(a.id===b.id)return true;
  const key=book=>book.archiveIdentifier || book.archiveURL?.match(/\/details\/([^/?#]+)/)?.[1];
  return !!key(a) && key(a)===key(b);
}
async function addLibriVoxBook(id) {
  const result=catalogResults.find(book=>book.id===id);if(!result)return;
  const old=books.find(book=>sameLibriVoxBook(book,result)) || await db.get('books',id);
  const book={...result,...old,inLibrary:true};
  await db.put('books',book);
  const index=books.findIndex(saved=>saved.id===book.id);if(index<0)books.push(book);else books[index]=book;
  render();renderLibriVoxResults();toast(`“${book.title}” added to your library.`);
}
async function stopCurrentBook(id, save = true) {
  if(player.book?.id!==id)return;
  player.switching=true;
  player.audio.pause();
  player.clearSleep();
  player.switching=false;
  const saved=save?player.persist():Promise.resolve();
  player.switching=true;
  player.generation++;
  player.book=null;
  player.pendingSeek=null;
  player.listening=false;
  player.activeSource=null;
  player.audio.removeAttribute('src');
  player.audio.load();
  $('#mini-player').hidden=true;
  if(navigator.mediaSession){navigator.mediaSession.metadata=null;navigator.mediaSession.playbackState='none';}
  try{await saved;}finally{player.switching=false;player.emit();}
}
async function fetchBookTracks(book) {
  const observedAt=Date.now();
  const tracks=await plexAPI.tracks(getServer(book.serverId),book);
  if(!tracks.length)throw new Error('The server returned no audio files for this book.');
  book.tracks=tracks;
  book.duration=sumDuration(book);
  book.tracksRemoteAt=Math.max(book.lastViewedAt||0,...tracks.map(t=>t.lastViewedAt||0));
  book.tracksStale=false;
  const rows=new Map();
  for(const track of tracks) {
    let row=rows.get(track.ratingKey);
    if(!row) {row={ratingKey:track.ratingKey,bookRatingKey:book.ratingKey,duration:track.metadataDuration||track.duration,viewOffset:0,viewCount:track.viewCount,lastViewedAt:track.lastViewedAt,index:track.index,disc:track.disc};rows.set(track.ratingKey,row);}
    if(track.viewOffset>0)row.viewOffset=Math.max(row.viewOffset,(track.partOffset||0)+track.viewOffset);
  }
  book.plexTracks=[...rows.values()];
  book.plexProgressFetchedAt=observedAt;
  await db.put('books',book);
}
async function applyRemoteProgress(book) {
  if(book.demo || book.localProgress || !book.plexTracks?.length || player.book?.id===book.id&&player.playing)return;
  const local=await db.get('progress',book.id)||progress.get(book.id);
  if(local?.dirty || await db.get('sync',book.id) || await db.get('sync',`mark:${book.id}`))return;
  // A cached server snapshot must not rewind a checkpoint just uploaded here.
  if((book.plexProgressFetchedAt||0)<=(local?.localChangedAt||0))return;
  const remote=plexProgress(book,book.plexTracks);
  remote.source=getServer(book.serverId)?.provider || 'plex';
  if(local?.plexFingerprint===remote.plexFingerprint && local.trackIndex===remote.trackIndex && Math.abs(local.position-remote.position)<0.01 && local.completed===remote.completed && local.duration===remote.duration)return;
  const p={...local,...remote,plexObservedAt:book.plexProgressFetchedAt};
  if(player.book?.id===book.id&&player.playing || progress.get(book.id)?.dirty)return;
  const wasCurrent=player.book?.id===book.id;
  await stopCurrentBook(book.id,false);
  const generation=player.generation;
  progress.set(book.id,p);
  await db.put('progress',p);
  if(wasCurrent && player.generation===generation && !player.book) {
    if(book.tracks?.length&&!p.completed)await player.open(book,{index:p.trackIndex,position:p.position,autoplay:false});
    else if(modal.classList.contains('player-modal'))modal.close();
  }
}
async function ensureBook(id,{refreshProgress=false}={}) {
  const book = books.find(b => b.id === id) || await db.get('books',id);
  if (!book) throw new Error('This book is no longer in the library. Refresh your server library to load it again.');
  if(!book.tracks?.length || book.tracksStale&&navigator.onLine) {
    if(!navigator.onLine)throw new Error('Connect to your server and download this book before listening offline.');
    try{await fetchBookTracks(book);}catch(error){if(!book.tracks?.length)throw error;}
  }
  if(refreshProgress && !book.localProgress && navigator.onLine && getServer(book.serverId)?.url && !(player.book?.id===book.id&&player.playing) && Date.now()-(book.plexProgressFetchedAt||0)>10000) {
    try {
      const observedAt=Date.now();
      book.plexTracks=await plexAPI.bookProgress(getServer(book.serverId),book);
      book.plexProgressFetchedAt=observedAt;
      await db.put('books',book);
    } catch { /* Downloaded books remain usable when the server is unreachable. */ }
  }
  await applyRemoteProgress(book);
  return book;
}
async function playBook(id, options) {
  const book = await ensureBook(id,{refreshProgress:true});
  if (await downloads.hasTrack(book.id,book.tracks[options?.index || 0].id)) await workerReady;
  await player.open(book,options); updatePlayer(); if (modal.open && !modal.classList.contains('player-modal')) modal.close();
}
async function showDetail(id, tab = 'chapters') {
  const original = books.find(b => b.id === id); if (!original) throw new Error('Book not found.');
  detailBook = id;
  if (!original.tracks?.length) showModal('Book details', '<p class="loading">Loading chapters…</p>', 'book-modal');
  const version = ++modalVersion;
  let book = original, trackError;
  try { book = await ensureBook(id); } catch(error) { trackError = error.message; }
  if (version !== modalVersion) return;
  const p = progress.get(id), d = downloadRecords.get(id);
  showModal('', `<div class="detail-hero">${image(book)}<div><p class="eyebrow">${book.librivox ? 'LIBRIVOX · FREE AUDIOBOOK' : `FROM YOUR ${providerName(getServer(book.serverId)).toUpperCase()} LIBRARY`}</p><h3>${e(book.title)}</h3><p>${e(book.author)}${book.year ? ` · ${book.year}` : ''}</p><p>${duration(sumDuration(book))} · ${book.tracks?.length || book.leafCount || '—'} audio files</p><div class="detail-actions"><button class="button" data-act="play-book" data-id="${e(id)}">${I('play')}${p?.elapsed && !p.completed ? 'Continue' : 'Play'}</button><button class="button secondary" data-act="${d?.status === 'complete' ? 'remove-download' : 'download'}" data-id="${e(id)}">${I('download')}${d?.status === 'complete' ? 'Remove download' : d && d.status !== 'error' ? d.status === 'paused' ? 'Resume download' : d.status : 'Download'}</button></div></div></div><div class="chips">${book.genres?.length ? `<span class="book-tags">${book.genres.map(g=>e(g)).join(', ')}</span>` : ''}${p?.completed ? '<span class="chip">Finished</span>' : ''}</div>${book.summary?.trim() ? `<p>${e(book.summary)}</p>` : ''}${book.librivox ? `<p>${book.narrator ? `Read by <strong>${e(book.narrator)}</strong> · ` : ''} ${book.sourceURL ? `<a href="${e(book.sourceURL)}" target="_blank" rel="noopener noreferrer">LibriVox recording ↗</a> · ` : ''}<a href="${e(book.archiveURL)}" target="_blank" rel="noopener noreferrer">Original audio ↗</a><br><small>${e(book.license)}.</small></p>` : ''}<div class="form-row"><button class="button outline" data-act="reading" data-id="${e(id)}">${I('heart')}${reading.includes(id) ? 'On your reading list' : 'Read later'}</button><button class="button outline" data-act="queue" data-id="${e(id)}">${I('queue')} Add to queue</button><button class="text-button" data-act="mark-finished" data-id="${e(id)}">${p?.completed ? 'Mark unplayed' : 'Mark finished'}</button>${book.librivox && book.inLibrary ? `<button class="text-button" data-act="remove-librivox" data-id="${e(id)}">Remove from library</button>` : ''}</div>${trackError ? `<p class="error">${e(trackError)}</p>` : ''}<div class="detail-tabs"><button class="${tab === 'chapters' ? 'active' : ''}" data-act="detail-tab" data-value="chapters">Chapters</button><button class="${tab === 'bookmarks' ? 'active' : ''}" data-act="detail-tab" data-value="bookmarks">Bookmarks</button></div>${tab === 'chapters' ? `<div class="chapter-list">${chaptersFor(book).map((c,n) => `<button class="chapter-item ${player.book?.id === id && player.index === c.index && player.position >= c.position && player.position < c.position+c.duration ? 'active' : ''}" data-act="play-chapter" data-id="${e(id)}" data-index="${c.index}" data-position="${c.position}"><span>${String(n+1).padStart(2,'0')}</span><strong>${e(c.title)}</strong><small>${clock(c.duration)}</small></button>`).join('')}</div>` : bookmarks.filter(b => b.bookId === id).map(bookmarkRow).join('') || '<p>No bookmarks in this book yet.</p>'}`, 'book-modal');
  modal.setAttribute('aria-label',book.title);
}
function showNowPlaying() {
  if (!player.book) { toast('Choose a book to start listening.'); return; }
  const b = player.book;
  showModal('Now playing', `${image(b,'now-cover')}<div class="now-text"><p class="eyebrow">A LITTLE MORE LOST IN THE STORY</p><h3>${e(b.title)}</h3><p>${e(b.author)}</p><small id="now-chapter"></small></div><div class="now-controls"><div class="scrubber"><span id="now-time">0:00</span><input type="range" id="now-seek" min="0" max="${sumDuration(b)}" value="${player.elapsed}" step=".1" aria-label="Book playback position"><span id="now-duration">${clock(sumDuration(b))}</span></div><div class="transport"><button class="icon-button" data-act="prev-chapter" aria-label="Previous chapter">${I('previous')}</button><button class="icon-button" data-act="back" aria-label="Rewind 15 seconds">${I('back')}<small>15</small></button><button class="play-button" data-act="toggle" id="now-play" aria-label="Play">${I('play')}</button><button class="icon-button" data-act="forward" aria-label="Forward 30 seconds">${I('forward')}<small>30</small></button><button class="icon-button" data-act="next-chapter" aria-label="Next chapter">${I('next')}</button></div><div class="now-tools"><button data-act="speed">${I('volume')}<span id="now-speed">${player.speed}× speed</span></button><button data-act="sleep">${I('moon')}<span id="now-sleep">Sleep timer</span></button><button data-act="add-bookmark">${I('bookmark')}Bookmark</button><button data-act="queue-view">${I('queue')}Up next</button></div><div class="now-tools"><button data-act="detail" data-id="${e(b.id)}">Chapters & notes ↗</button><small id="now-offline" class="text-button"></small></div></div>`, 'player-modal');
  updatePlayer();
}
function updatePlayer() {
  if (!player.book) return;
  const b = player.book;
  $('#mini-player').hidden = false;
  $('#mini-title').textContent = b.title; $('#mini-author').textContent = b.author;
  if ($('#mini-cover').dataset.book !== b.id) { $('#mini-cover').src = cover(b); $('#mini-cover').dataset.book = b.id; }
  for (const prefix of ['mini','now']) {
    const time = $(`#${prefix}-time`), seek = $(`#${prefix}-seek`), play = $(`#${prefix}-play`), total = $(`#${prefix}-duration`);
    if (time) time.textContent = clock(player.elapsed);
    if (total) total.textContent = clock(sumDuration(b));
    if (seek) { seek.max = sumDuration(b); if (!activeSeeks.has(seek)) seek.value = player.elapsed; }
    if (play) { play.innerHTML = I(player.playing ? 'pause' : 'play'); play.setAttribute('aria-label',player.playing ? 'Pause' : 'Play'); }
  }
  $('#mini-speed').textContent = `${player.speed}×`;
  if ($('#now-chapter')) {
    const chapter = chaptersFor(b).findLast(c => c.absolute <= player.elapsed+.1);
    $('#now-chapter').textContent = chapter?.title || player.track.title;
    $('#now-speed').textContent = `${player.speed}× speed`;
    $('#now-sleep').textContent = player.sleep ? player.sleep.type === 'chapter' ? 'End of chapter' : `${Math.max(0,Math.ceil((player.sleep.end-Date.now())/60000))} min left` : 'Sleep timer';
    $('#now-offline').textContent = player.local ? '↓ Playing offline file' : `Streaming from ${providerName(getServer(b.serverId))}`;
  }
}
function showSpeed() {
  if (!player.book) return toast('Start a book to adjust its playback.');
  showModal('At your own pace', `<p class="lead">Speed and sound settings are remembered for this book.</p><div class="speed-options">${[.5,.75,1,1.1,1.25,1.5,1.75,2,2.5,3].map(n => `<button class="${player.speed === n ? 'active' : ''}" data-act="set-speed" data-value="${n}">${n}×</button>`).join('')}</div><label class="setting-line">Voice boost<input type="checkbox" id="voice-boost" ${player.sound?.voiceBoost ? 'checked' : ''}></label><label class="sound-control">Warmth · bass<input type="range" id="sound-bass" min="-10" max="10" step="1" value="${player.sound?.bass || 0}" aria-label="Bass gain"></label><label class="sound-control">Clarity · treble<input type="range" id="sound-treble" min="-10" max="10" step="1" value="${player.sound?.treble || 0}" aria-label="Treble gain"></label><label class="sound-control">Volume<input type="range" id="volume" min="0" max="1" step=".05" value="${settings.volume ?? 1}"></label><p>Sound processing requires your server to allow browser audio access.</p><div class="modal-actions"><button class="button" data-act="now-playing">Back to your book</button></div>`);
}
function showSleep() {
  if (!player.book) return toast('Choose a book before setting a sleep timer.');
  showModal('One more chapter?', `<p class="lead">Drift off. Folio will save your place and pause for you. Timed playback fades out over the last ten seconds.</p><div class="sleep-options">${[5,10,15,30,45,60].map(n => `<button data-act="set-sleep" data-value="${n}">${n} min</button>`).join('')}<button data-act="set-sleep" data-value="chapter">End of chapter</button></div><form id="sleep-form" class="form-row" style="margin-top:20px"><label class="field">Or choose minutes<input type="number" name="minutes" min="1" max="480" required placeholder="20"></label><button class="button" type="submit">Set timer</button></form>${player.sleep ? '<button class="text-button" data-act="cancel-sleep">Cancel active timer</button>' : ''}${player.sleepStart?.bookId === player.book.id ? '<p><button class="text-button" data-act="sleep-rewind">Return to where the last timer started</button></p>' : ''}`);
}
function bookmarkEditor(bookmark) {
  if (!bookmark && !player.book) return toast('Start listening to save a bookmark.');
  const b = bookmark || {id:crypto.randomUUID(),bookId:player.book.id,title:player.book.title,trackIndex:player.index,position:player.position,absolute:player.elapsed,createdAt:Date.now(),note:''};
  showModal(bookmark ? 'A note to come back to' : 'Save a little moment', `<p>${e(b.title)} · ${clock(b.absolute)}</p><form id="bookmark-form"><input name="bookmark" type="hidden" value="${e(JSON.stringify(b))}"><label class="field">Your note<textarea name="note" maxlength="5000" placeholder="A thought worth keeping…">${e(b.note)}</textarea></label><div class="modal-actions"><button type="submit" class="button">${I('bookmark')} Save bookmark</button></div></form>`);
}
function showQueue() {
  showModal('Up next', `<p class="lead">Your next chapter, already lined up. Add books from their details.</p>${queue.length ? queue.map((id,n) => {const b=books.find(b=>b.id===id);return `<div class="queue-item"><span>${n+1}</span><strong>${e(b?.title || 'Unavailable book')}</strong><button class="icon-button" data-act="queue-up" data-index="${n}" aria-label="Move up">↑</button><button class="icon-button" data-act="queue-remove" data-index="${n}" aria-label="Remove from queue">${I('close')}</button></div>`;}).join('') : '<p>Your queue is clear. There’s always room for another story.</p>'}`);
}
function showConnect(provider='plex') {
  const names={plex:'Plex',audiobookshelf:'Audiobookshelf',jellyfin:'Jellyfin',emby:'Emby'};
  if(!names[provider])provider='plex';
  const address=`<label class="field">Secure server URL<input type="url" name="url" required placeholder="https://books.example.com" autocomplete="url"></label>`;
  const fields=provider==='plex'
    ? `<button class="button" data-act="plex-login">${I('plex')} Sign in with Plex</button>${config.accountToken ? '<button class="button outline" data-act="discover" style="margin-left:8px">Find my servers</button>' : ''}<details><summary>Use a server address and Plex token</summary><form id="manual-connect">${address}<label class="field">X-Plex-Token<input type="password" name="token" required autocomplete="off" spellcheck="false"></label><button type="submit" class="button">Connect server</button></form></details>`
    : `<form id="server-login"><input type="hidden" name="provider" value="${provider}">${address}<label class="field">Username<input name="username" autocomplete="username"></label><label class="field">Password<input type="password" name="password" autocomplete="current-password"></label><details><summary>Use an access token instead</summary><label class="field">Access token<input type="password" name="token" autocomplete="off" spellcheck="false"></label>${provider==='audiobookshelf'?'': '<label class="field">User ID, if using an administrator API key<input name="userId" autocomplete="off" spellcheck="false"></label>'}</details><button type="submit" class="button">Connect ${names[provider]}</button></form><div class="notice">${provider==='audiobookshelf'?'Choose an Audiobookshelf book library.':'Choose a Books or Music library containing audiobook audio files or albums.'} Sign in with your server account or provide an access token. Your password is sent only to your server and is not stored by Folio.</div>`;
  showModal('Connect your library', `<p class="lead">Your books, wherever they live.</p><label class="field">Server type<select id="server-provider">${Object.entries(names).map(([id,name])=>`<option value="${id}" ${id===provider?'selected':''}>${name}</option>`).join('')}</select></label>${fields}<div id="connection-status" aria-live="polite"></div>${config.libraries.length ? `<p>Connected: ${config.libraries.map(l=>`${e(l.title)} (${providerName(getServer(l.serverId))})`).join(', ')}</p>` : ''}`);
}
function connectionStatus(html) { const status=$('#connection-status'); if(status) status.innerHTML=html; }
async function beginLogin() {
  clearTimeout(pinTimer);
  const popup=window.open('about:blank','folio-plex','popup,width=800,height=700');
  connectionStatus('<p>Creating a secure Plex sign-in…</p>');
  try {
    const pin=await plexAPI.createPin();
    sessionStorage.setItem('folio.pin',JSON.stringify({...pin,startedAt:Date.now()}));
    if(popup) { popup.opener=null; popup.location.href=pin.authUrl; }
    connectionStatus(`<div class="notice">Finish signing in with Plex, then return here.<br><a href="${e(pin.authUrl)}" target="_blank" rel="noopener noreferrer">Open Plex sign-in ↗</a></div>`);
    pollPin(pin.id,Date.now());
  } catch(error) {popup?.close();connectionStatus(`<p class="error">${e(error.message)}</p>`);}
}
async function pollPin(id,startedAt) {
  if(Date.now()-startedAt>600000) {sessionStorage.removeItem('folio.pin');connectionStatus('<p class="error">This sign-in expired. Try signing in again.</p>');return;}
  try {
    const result=await plexAPI.checkPin(id);
    if(result.authToken) {config.accountToken=result.authToken;saveConfig();sessionStorage.removeItem('folio.pin');await discover();return;}
    pinTimer=setTimeout(()=>pollPin(id,startedAt),2000);
  } catch(error) {connectionStatus(`<p class="error">${e(error.message)}</p>`);sessionStorage.removeItem('folio.pin');}
}
let discovered=[];
async function discover() {
  connectionStatus('<p>Looking for your Plex servers…</p>');
  discovered=await plexAPI.resources(config.accountToken);
  connectionStatus(discovered.length ? `<p>Choose where your stories live.</p>${discovered.map((s,n)=>`<button class="server-option" data-act="connect-server" data-index="${n}">${e(s.name)}<span>${s.owned?'Your server':'Shared with you'} &nbsp; →</span></button>`).join('')}` : '<p class="error">No Plex servers are available to this account. Check server sharing and remote access.</p>');
}
const serverLibraryChoices = new Map();
async function manageServer(id) {
  const server=getServer(id);if(!server)return;
  showModal('Manage server','<p class="loading">Loading libraries…</p>');
  const version=modalVersion;
  let libraries=config.libraries.filter(library=>library.serverId===id), error='';
  try { libraries=await plexAPI.libraries(server); } catch(failure) { error=failure.message; }
  if(version!==modalVersion || !getServer(id))return;
  serverLibraryChoices.set(id,libraries);
  showModal('Manage server',`<form id="server-settings" data-id="${e(id)}"><label class="field">Server name<input name="displayName" required maxlength="100" value="${e(serverLabel(server))}"></label><p>${e(providerName(server))} · ${e(serverAddress(server))}</p>${error?`<p class="error">${e(error)}</p>`:''}<fieldset class="server-libraries"><legend>Libraries</legend>${libraries.length?libraries.map(library=>`<label class="setting-line">${e(library.title)}<input type="checkbox" name="libraries" value="${e(library.id)}" ${config.libraries.some(saved=>saved.serverId===id&&String(saved.id)===String(library.id))?'checked':''}></label>`).join(''):'<p>No supported libraries found.</p>'}</fieldset><div class="form-row"><button class="button" type="submit">Save changes</button><button class="button outline" type="button" data-act="reconnect-server" data-id="${e(id)}">Reconnect</button></div></form>`);
}
async function saveServerLibraries(id, ids, displayName) {
  const server=getServer(id);if(!server)throw new Error('This server is no longer connected.');
  const selected=new Set(ids.map(String));
  const choices=serverLibraryChoices.get(id)||config.libraries.filter(library=>library.serverId===id);
  const libraries=choices.filter(library=>selected.has(String(library.id))).map(library=>({...library,serverId:id}));
  server.displayName=String(displayName||'').trim().slice(0,100)||server.name;
  config.libraries=[...config.libraries.filter(library=>library.serverId!==id),...libraries];
  saveConfig();modal.close();render();
  if(libraries.length)await refresh({serverId:id});
}
async function removeServer(id) {
  if(!getServer(id))return;
  if(player.book?.serverId===id && downloadRecords.get(player.book.id)?.status!=='complete')await stopCurrentBook(player.book.id);
  await Promise.all(books.filter(book=>book.serverId===id&&downloadRecords.has(book.id)&&downloadRecords.get(book.id).status!=='complete').map(book=>downloads.cancel(book.id)));
  config.servers=config.servers.filter(server=>server.id!==id);
  config.libraries=config.libraries.filter(library=>library.serverId!==id);
  serverLibraryChoices.delete(id);
  saveConfig();modal.close();render();toast('Server removed. Downloads and saved progress are kept.');
}
let selectedServer, selectedLibraries=[];
async function selectServer(server,validate=true) {
  connectionStatus('<p>Connecting to your server…</p>');
  selectedServer=validate ? await plexAPI.connect(server) : server;
  const index=config.servers.findIndex(s=>s.id===selectedServer.id);
  if(index>=0) config.servers[index]=selectedServer={...config.servers[index],...selectedServer}; else config.servers.push(selectedServer);
  saveConfig(); selectedLibraries=await plexAPI.libraries(selectedServer);
  connectionStatus(selectedLibraries.length ? `<form id="library-connect"><p>Choose an audiobook library on ${e(selectedServer.name)}.</p><label class="field">Library<select name="library">${selectedLibraries.map(l=>`<option value="${e(l.id)}">${e(l.title)}</option>`).join('')}</select></label><button class="button" type="submit">Open my library ${I('arrow')}</button></form>` : '<p class="error">This account has no supported book or music libraries. Check the library type and your account’s permissions.</p>');
}
async function loadLibrary(library,showProgress=false) {
  const server=getServer(library.serverId);
  const observedAt=Date.now();
  const [incoming,remoteRows]=await Promise.all([
    plexAPI.books(server,library.id,{onProgress:({loaded,total})=>{if(showProgress)connectionStatus(`<p>Making room on your shelf… ${loaded}${total?` / ${total}`:''} books loaded.</p>`);}}),
    plexAPI.libraryProgress(server,library.id)
  ]);
  const byBook=new Map();
  for(const row of remoteRows) {
    if(!byBook.has(row.bookRatingKey))byBook.set(row.bookRatingKey,[]);
    byBook.get(row.bookRatingKey).push(row);
  }
  const oldMap=new Map(books.map(b=>[b.id,b]));
  for(const b of incoming) {
    const old=oldMap.get(b.id);
    if(old?.tracks?.length) {
      b.tracks=old.tracks;
      b.duration=sumDuration(b);
      b.tracksStale=!!old.tracksStale||old.updatedAt!==b.updatedAt;
    }
    b.plexTracks=byBook.get(b.ratingKey)||[];
    b.plexProgressFetchedAt=observedAt;
    if(!b.tracks?.length)b.duration=b.plexTracks.reduce((sum,row)=>sum+row.duration,0)||b.duration;
    await db.put('books',b);
    await applyRemoteProgress(b);
  }
  const savedBooks=await db.all('books');
  books=savedBooks.filter(b=>!b.demo);
}
function refresh({quiet=false,force=true,serverId}={}) {
  if(refreshPromise)return serverId ? refreshPromise.catch(()=>{}).then(()=>refresh({quiet,force,serverId})) : refreshPromise;
  const libraries=config.libraries.filter(library=>!serverId||library.serverId===serverId);
  if(!libraries.length)return quiet ? Promise.resolve() : (toast(serverId?'Choose libraries for this server from Manage.':'Add a server or find LibriVox books to start your library.'),Promise.resolve());
  if(quiet&&!force&&Date.now()-lastPlexPull<30000)return Promise.resolve();
  refreshBusy=true;refreshingServerId=serverId||null;
  incomingSyncStatus='Reading played status and progress from your servers…';
  if(view==='settings')render();
  if(!quiet)toast('Refreshing your libraries and progress…');
  refreshPromise=(async()=>{
    // Pending offline checkpoints are sent before reading the server snapshot.
    await flushSync(serverId);
    const errors=[];
    const unavailable=new Set();
    if(force) {
      for(const server of config.servers.filter(server=>!serverId||server.id===serverId)) {
        try{Object.assign(server,await plexAPI.connect(server));}
        catch(error){unavailable.add(server.id);errors.push(`${server.name || providerName(server)}: ${error.message}`);}
      }
      saveConfig();
    }
    for(const library of libraries) {
      if(unavailable.has(library.serverId))continue;
      try{await loadLibrary(library);}catch(error){errors.push(`${library.title}: ${error.message}`);}
    }
    lastPlexPull=Date.now();
    if(errors.length || outgoingSyncError)throw new Error([...errors,outgoingSyncError].filter(Boolean).join(' '));
    incomingSyncStatus=`Server progress updated ${new Date(lastPlexPull).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}. Playback changes also sync back to each server.`;
    if(!quiet)toast('Your libraries and listening progress are up to date.');
  })().catch(error=>{
    incomingSyncStatus=`Server progress could not refresh. Saved progress is still available. ${error.message}`;
    if(!quiet)throw error;
  }).finally(()=>{refreshBusy=false;refreshingServerId=null;refreshPromise=null;render();});
  return refreshPromise;
}
async function flushSync(serverId) {
  if(syncing || !navigator.onLine) return;
  syncing=true;
  try {
    const pending=(await db.all('sync')).filter(item=>!serverId||item.serverId===serverId).sort((a,b)=>a.updatedAt-b.updatedAt || Number(b.markPlayed!=null)-Number(a.markPlayed!=null));
    const failedBooks=new Set();
    for(const item of pending) {
      const bookId=item.bookId||item.id;
      if(failedBooks.has(bookId))continue;
      const server=getServer(item.serverId); if(!server) continue;
      try {
        if(item.markPlayed != null) {
          const stored=books.find(book=>book.id===bookId) || await db.get('books',bookId);
          await plexAPI.markPlayed(server,{...item.book,...stored},item.markPlayed);
        }
        else {
          await plexAPI.timeline(server,item.track,item);
          const state=await db.get('progress',bookId);
          const book=books.find(b=>b.id===bookId);
          if(state?.completed && book?.ratingKey)await plexAPI.markPlayed(server,book,true);
        }
        const newest=await db.get('sync',item.id);
        if(newest?.updatedAt===item.updatedAt) {
          await db.delete('sync',item.id);
          const p=await db.get('progress',bookId);
          if(p && p.updatedAt<=item.updatedAt && !await db.get('sync',bookId) && !await db.get('sync',`mark:${bookId}`)) {p.dirty=false;await db.put('progress',p);progress.set(p.id,p);}
        }
      } catch(error) {
        failedBooks.add(bookId);
        outgoingSyncError=`${server.name || 'Server'}: ${error.message || 'Listening progress could not upload.'} Saved changes will retry.`;
      }
    }
    if(!failedBooks.size)outgoingSyncError='';
    const label=view==='settings'&&$('#sync-status');
    if(label&&outgoingSyncError)label.textContent=outgoingSyncError;
  } finally {syncing=false;}
}
async function downloadBook(id) {
  await workerReady;
  if(!navigator.serviceWorker?.controller) throw new Error('Offline support is still starting. Reload Folio once, then try downloading again.');
  const book=await ensureBook(id);
  if(book.canDownload===false)throw new Error('This server account does not permit audiobook downloads.');
  await downloads.requestPersistence();
  const record=await downloads.download(book);
  toast(`“${book.title}” added to downloads. ${record.mode==='background' ? 'Your browser will continue the download in the background.' : 'Keep Folio open until it finishes.'}`);
  if(modal.open) modal.close();
}
async function saveSettings() { settings.id='preferences';settings.reading=reading;settings.queue=queue;await db.put('settings',settings);Object.assign(player.settings,settings);window.FolioTheme?.apply(settings.darkMode === true); }
async function exportBackup() {
  await player.persist();
  const data={format:'folio-backup',version:1,exportedAt:new Date().toISOString(),progress:await db.all('progress'),bookmarks:await db.all('bookmarks'),history:await db.all('history'),settings:{...settings,reading,queue}};
  data.progress=data.progress.map(({dirty,...p})=>({...p,dirty:false}));
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`folio-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function restoreBackup(file) {
  if(!file || file.size>10*1024*1024) throw new Error('Choose a Folio JSON backup smaller than 10 MB.');
  const data=JSON.parse(await file.text());
  if(data.format!=='folio-backup' || data.version!==1) throw new Error('This is not a supported Folio backup.');
  for(const store of ['progress','bookmarks','history']) {
    if(!Array.isArray(data[store])) throw new Error('The backup is missing its records.');
    for(const row of data[store]) {
      if(typeof row.id!=='string' || row.id.length>500) throw new Error('The backup contains an invalid record.');
      const old=await db.get(store,row.id);
      if(!old || (row.updatedAt || row.createdAt || 0)>(old.updatedAt || old.createdAt || 0)) await db.put(store,{...row,...(store==='progress'?{dirty:false}:{})});
    }
  }
  if(data.settings) {
    for(const key of ['speed','smartRewind','rewindSeconds','wakeLock','volume','includeLibrivox','darkMode']) if(data.settings[key]!=null)settings[key]=data.settings[key];
    reading=[...new Set([...reading,...(data.settings.reading || []).filter(id=>typeof id==='string')])];
    queue=[...new Set([...queue,...(data.settings.queue || []).filter(id=>typeof id==='string')])];
    await saveSettings();
  }
  await reloadState();render();toast('Your saved moments are back. Reconnect the matching server library to play its books.');
}
let wakeLock;
async function updateWakeLock() {
  if(settings.wakeLock && player.playing && !document.hidden && navigator.wakeLock && !wakeLock) {
    try {wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}catch{}
  } else if((!player.playing || !settings.wakeLock) && wakeLock) {await wakeLock.release();wakeLock=null;}
}
async function prepareWorker() {
  if(!('serviceWorker' in navigator)) return;
  try {
    workerRegistration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller) await new Promise(resolve=>{
      const ready=()=>{clearTimeout(timeout);navigator.serviceWorker.removeEventListener('controllerchange',ready);resolve();};
      const timeout=setTimeout(ready,10000);navigator.serviceWorker.addEventListener('controllerchange',ready,{once:true});
    });
    if(workerRegistration.waiting) offerUpdate();
    workerRegistration.addEventListener('updatefound',()=>{const worker=workerRegistration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed' && navigator.serviceWorker.controller)offerUpdate();});});
  } catch(error) {toast('Offline setup could not finish. Use HTTPS or localhost, then reload to try again.',true);}
}
function offerUpdate() {toast('A fresh version of Folio is ready.',false,{label:'Update',run:async()=>{await player.persist();workerRegistration?.waiting?.postMessage({type:'SKIP_WAITING'});navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload(),{once:true});}});}
function networkState() {$('#network-label').innerHTML=`<span class="status-dot" style="background:${navigator.onLine?'#789360':'#b28f5d'}"></span>${navigator.onLine?'Online':'Offline'}`;if(navigator.onLine)refresh({quiet:true,force:true});}

document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-act],[data-view]'); if(!target)return;
  if(target.dataset.view) {navigate(target.dataset.view);return;}
  const {act,id,value,index,position}=target.dataset;
  try {
    switch(act) {
      case 'find-librivox':showLibriVoxSearch();break;
      case 'more-librivox':await searchLibriVox(catalogQuery,catalogField,true);break;
      case 'add-librivox':await addLibriVoxBook(id);break;
      case 'remove-librivox':{const book=books.find(b=>b.id===id);if(book){book.inLibrary=false;await db.put('books',book);}modal.close();render();toast('Book removed from your library. Downloads and listening progress are kept.');break;}
      case 'more-books':shelfLimit+=60;render();break;
      case 'menu':document.body.classList.toggle('nav-open');break;
      case 'close':modal.close();break;
      case 'connect':showConnect();break;
      case 'manage-server':await manageServer(id);break;
      case 'refresh-server':await refresh({serverId:id});break;
      case 'reconnect-server':{const server=getServer(id);if(server){showConnect(server.provider||'plex');const input=$('input[name="url"]',modal);if(input)input.value=server.url||'';}break;}
      case 'remove-server':{const server=getServer(id);if(server)showModal('Remove server?',`<p>Remove “${e(serverLabel(server))}” from this device? Downloaded books and saved progress are kept.</p><div class="modal-actions"><button class="button outline" data-act="close">Keep server</button><button class="button" data-act="confirm-remove-server" data-id="${e(id)}">Remove server</button></div>`);break;}
      case 'confirm-remove-server':await removeServer(id);break;
      case 'plex-login':beginLogin();break;
      case 'discover':await discover();break;
      case 'connect-server':await selectServer(discovered[Number(index)]);break;
      case 'refresh':await refresh();break;
      case 'play-book':target.disabled=true;await playBook(id);break;
      case 'play-chapter':await playBook(id,{index:Number(index),position:Number(position)});break;
      case 'detail':await showDetail(id);break;
      case 'detail-tab':await showDetail(detailBook,value);break;
      case 'toggle':await player.toggle();break;
      case 'back':await player.skip(-15);break;
      case 'forward':await player.skip(30);break;
      case 'prev-chapter':await player.chapter(-1);break;
      case 'next-chapter':await player.chapter(1);break;
      case 'now-playing':showNowPlaying();break;
      case 'speed':showSpeed();break;
      case 'set-speed':player.setSpeed(Number(value));showSpeed();break;
      case 'sleep':showSleep();break;
      case 'set-sleep':player.setSleep(value==='chapter'?'chapter':Number(value));modal.close();toast(value==='chapter'?'Sleep timer set for the end of this chapter.':`Sleep timer set for ${value} minutes.`);break;
      case 'cancel-sleep':player.clearSleep();modal.close();toast('Sleep timer canceled.');break;
      case 'sleep-rewind':await player.seek(player.sleepStart.position);showNowPlaying();break;
      case 'add-bookmark':bookmarkEditor();break;
      case 'edit-bookmark':bookmarkEditor(bookmarks.find(b=>b.id===id));break;
      case 'delete-bookmark':await db.delete('bookmarks',id);bookmarks=bookmarks.filter(b=>b.id!==id);render();if(detailBook&&modal.open)showDetail(detailBook,'bookmarks');toast('Bookmark removed.');break;
      case 'jump-bookmark':{const b=bookmarks.find(b=>b.id===id);await playBook(b.bookId,{index:b.trackIndex,position:b.position});break;}
      case 'download':target.disabled=true;await downloadBook(id);break;
      case 'pause-download':await downloads.cancel(id);break;
      case 'remove-download':showModal('Make a little room?',`<p>Remove the downloaded audio for “${e(books.find(b=>b.id===id)?.title || 'this book')}” from this device? Your progress and bookmarks stay saved.</p><div class="modal-actions"><button class="button outline" data-act="close">Keep it</button><button class="button" data-act="confirm-remove" data-id="${e(id)}">Remove download</button></div>`);break;
      case 'confirm-remove':await downloads.remove(id);modal.close();toast('Download removed. Your place is saved.');break;
      case 'reading':reading=reading.includes(id)?reading.filter(x=>x!==id):[...reading,id];await saveSettings();await showDetail(id);toast(reading.includes(id)?'Added to your reading list.':'Removed from your reading list.');break;
      case 'queue':if(!queue.includes(id))queue.push(id);await saveSettings();toast('Added to your listening queue.');break;
      case 'queue-view':showQueue();break;
      case 'queue-up':{const n=Number(index);if(n>0)[queue[n-1],queue[n]]=[queue[n],queue[n-1]];await saveSettings();showQueue();break;}
      case 'queue-remove':queue.splice(Number(index),1);await saveSettings();showQueue();break;
      case 'mark-finished':{const b=await ensureBook(id);const completed=!progress.get(id)?.completed;await stopCurrentBook(id);const p={...(progress.get(id)||{}),id,completed,trackIndex:completed?b.tracks.length-1:0,position:completed?b.tracks.at(-1).duration:0,elapsed:completed?sumDuration(b):0,updatedAt:Date.now(),localChangedAt:Date.now(),source:'local',dirty:!b.localProgress};await db.put('progress',p);progress.set(id,p);if(!b.localProgress){await db.delete('sync',id);await db.put('sync',{id:`mark:${id}`,bookId:id,serverId:b.serverId,book:{ratingKey:b.ratingKey,nativeItemType:b.nativeItemType,duration:sumDuration(b)},markPlayed:completed,updatedAt:p.updatedAt});await flushSync();}showDetail(id);render();break;}
      case 'filter':shelfLimit=60;filter=value;render();break;
      case 'group':shelfLimit=60;group=value;view='library';filter='all';render();break;
      case 'persist':toast(await downloads.requestPersistence()?'Persistent storage granted. Your offline shelf is protected from automatic eviction when possible.':'Your browser manages storage. Keep backups and check downloads before a trip.');downloadStorageAt=0;render();break;
      case 'export':await exportBackup();toast('Your backup is ready. Keep it somewhere safe.');break;
      case 'import':$('#backup-file').click();break;
      case 'check-update':await workerRegistration?.update();if(workerRegistration?.waiting)offerUpdate();else toast('Update check finished. Folio will let you know when a new version is ready.');break;
      case 'disconnect':showModal('Disconnect your servers?',`<p>Your server tokens will be removed from this browser. Downloaded books, progress, and notes stay available on this device.</p><div class="modal-actions"><button class="button outline" data-act="close">Keep connected</button><button class="button" data-act="confirm-disconnect">Disconnect</button></div>`);break;
      case 'confirm-disconnect':config={servers:[],libraries:[]};saveConfig();clearTimeout(pinTimer);sessionStorage.removeItem('folio.pin');modal.close();render();toast('Servers disconnected. Your offline shelf is still here.');break;
      case 'clear-history':showModal('Clear listening history?',`<p>This removes listening sessions and statistics from this device. Your books, progress, and bookmarks stay saved.</p><div class="modal-actions"><button class="button outline" data-act="close">Keep history</button><button class="button" data-act="confirm-clear-history">Clear history</button></div>`);break;
      case 'confirm-clear-history':await db.clear('history');history=[];player.session=null;modal.close();render();toast('Listening history cleared.');break;
    }
  } catch(error) {toast(error.message || 'Something interrupted that. Try again.',true);if(['discover','connect-server'].includes(act))connectionStatus(`<p class="error">${e(error.message)}</p>`);}
  finally {if(target.isConnected)target.disabled=false;}
});
document.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target;const data=new FormData(form);const button=$('[type=submit]',form);if(button)button.disabled=true;
  try {
    if(form.id==='server-settings'){await saveServerLibraries(form.dataset.id,data.getAll('libraries'),data.get('displayName'));}
    else if(form.id==='librivox-search'){await searchLibriVox(data.get('query'),data.get('field'));}
    else if(form.id==='manual-connect') {const server=await plexAPI.validateServer({url:data.get('url'),token:data.get('token')});form.reset();await selectServer(server,false);}
    else if(form.id==='server-login') {const server=await plexAPI.login(Object.fromEntries(data));form.reset();await selectServer(server,false);}
    else if(form.id==='library-connect') {
      const chosen=selectedLibraries.find(l=>l.id===data.get('library'));const library={...chosen,serverId:selectedServer.id};
      if(!config.libraries.some(l=>l.serverId===library.serverId&&l.id===library.id))config.libraries.push(library);saveConfig();
      await loadLibrary(library,true);modal.close();navigate('library');toast('Your library is ready. Pick a story.');
    } else if(form.id==='bookmark-form') {
      const b=JSON.parse(data.get('bookmark'));b.note=String(data.get('note')).trim();b.updatedAt=Date.now();await db.put('bookmarks',b);bookmarks=await db.all('bookmarks');modal.close();render();toast('Moment saved.');
    } else if(form.id==='sleep-form') {player.setSleep(Number(data.get('minutes')));modal.close();toast(`Sleep timer set for ${data.get('minutes')} minutes.`);}
  } catch(error) {toast(error.message,true);if(['manual-connect','server-login','library-connect','server-settings'].includes(form.id))connectionStatus(`<p class="error">${e(error.message)}</p>`);}
  finally {if(button?.isConnected)button.disabled=false;}
});
document.addEventListener('pointerdown',event=>{
  if(isPlaybackSeek(event.target))activeSeeks.add(event.target);
});
document.addEventListener('input',event=>{
  if(isPlaybackSeek(event.target)) {
    activeSeeks.add(event.target);
    pendingSeeks.set(event.target,Number(event.target.value));
  }
});
document.addEventListener('pointerup',()=>{
  // A changed value stays protected until its native change event commits it.
  for(const el of activeSeeks)if(!pendingSeeks.has(el))activeSeeks.delete(el);
});
document.addEventListener('pointercancel',event=>{
  if(isPlaybackSeek(event.target)){activeSeeks.delete(event.target);pendingSeeks.delete(event.target);updatePlayer();}
});
document.addEventListener('focusout',event=>{
  if(isPlaybackSeek(event.target))activeSeeks.delete(event.target);
});
document.addEventListener('change',async event=>{
  const el=event.target;
  try {
    if(el.id==='server-provider'){clearTimeout(pinTimer);sessionStorage.removeItem('folio.pin');showConnect(el.value);}
    if(el.id==='sort'){shelfLimit=60;sort=el.value;render();}
    if(isPlaybackSeek(el)) {
      const target=pendingSeeks.get(el) ?? Number(el.value);
      pendingSeeks.delete(el);activeSeeks.delete(el);
      try{await player.seek(target);}finally{updatePlayer();}
    }
    if(el.dataset.setting){settings[el.dataset.setting]=el.type==='checkbox'?el.checked:Number(el.value);await saveSettings();await updateWakeLock();if(el.dataset.setting==='includeLibrivox'){shelfLimit=60;if(!el.checked){catalogAbort?.abort();if($('#librivox-search'))modal.close();}render();}}
    if(['voice-boost','sound-bass','sound-treble'].includes(el.id))player.configureSound({voiceBoost:$('#voice-boost').checked,bass:$('#sound-bass').value,treble:$('#sound-treble').value});
    if(el.id==='volume'){settings.volume=Number(el.value);player.setVolume(el.value);await saveSettings();}
    if(el.id==='backup-file')await restoreBackup(el.files[0]);
  }catch(error){toast(error.message,true);}
});
$('#search').addEventListener('input',event=>{shelfLimit=60;query=event.target.value;render();});
modal.addEventListener('close',()=>{modalVersion++;});
modal.addEventListener('click',event=>{if(event.target===modal){const rect=modal.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)modal.close();}});
document.addEventListener('keydown',event=>{
  if(event.target.closest('input,textarea,select,[contenteditable]'))return;
  if(event.key==='/'){event.preventDefault();$('#search').focus();}
  if(modal.open||!player.book)return;
  if(event.code==='Space'){event.preventDefault();player.toggle().catch(error=>toast(error.message,true));}
  if(event.key==='ArrowLeft'){event.preventDefault();player.skip(-15).catch(error=>toast(error.message,true));}
  if(event.key==='ArrowRight'){event.preventDefault();player.skip(30).catch(error=>toast(error.message,true));}
  if(event.key.toLowerCase()==='b')bookmarkEditor();
});
player.addEventListener('change',()=>{updatePlayer();updateWakeLock();});
player.addEventListener('error',event=>toast(event.detail.message,true));
player.addEventListener('progress',event=>{progress.set(event.detail.id,event.detail);});
let syncTimeout;
player.addEventListener('syncneeded',()=>{clearTimeout(syncTimeout);syncTimeout=setTimeout(flushSync,1000);});
player.addEventListener('sleepend',()=>toast('Sleep well. Your place is saved.'));
player.addEventListener('complete',async event=>{
  toast(`You finished “${event.detail.title}”. A story well spent.`);render();
  if(queue.length){const id=queue.shift();await saveSettings();try{await playBook(id);}catch(error){toast(error.message,true);}}
});
let downloadRender;
downloads.addEventListener('change',event=>{
  const record=event.detail.record;
  if(player.book?.id===record.id && (['complete','removed'].includes(record.status) || record.completedTracks!==downloadRecords.get(record.id)?.completedTracks))void player.prepareNext({force:true});
  if(record.status==='removed')downloadRecords.delete(record.id);else downloadRecords.set(record.id,record);
  $('#download-count').textContent=[...downloadRecords.values()].filter(d=>d.status==='complete').length;
  if(record.status==='complete')toast(`“${record.title}” is ready for offline listening.`);
  if(record.status==='error')toast(record.error || 'Download interrupted. Resume from Downloads.',true);
  clearTimeout(downloadRender);downloadRender=setTimeout(()=>{if(view==='downloads')render();},150);
});
window.addEventListener('online',networkState);window.addEventListener('offline',networkState);
window.addEventListener('hashchange',()=>{const target=location.hash.slice(1);if(labels[target]&&target!==view){view=target;group=null;render();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){updateWakeLock();refresh({quiet:true,force:false});}});
setInterval(flushSync,15000);
setInterval(()=>{if(navigator.onLine&&!document.hidden)refresh({quiet:true,force:false});},60000);
async function reloadState() {
  const [savedBooks,savedProgress,savedBookmarks,savedHistory,savedSettings,savedDownloads]=await Promise.all([db.all('books'),db.all('progress'),db.all('bookmarks'),db.all('history'),db.get('settings','preferences'),downloads.list()]);
  books=savedBooks.filter(b=>!b.demo);
  progress=new Map(savedProgress.map(p=>[p.id,p]));bookmarks=savedBookmarks;history=savedHistory;
  settings={speed:1,smartRewind:true,rewindSeconds:10,volume:1,includeLibrivox:true,darkMode:false,...savedSettings};reading=settings.reading||[];queue=settings.queue||[];Object.assign(player.settings,settings);window.FolioTheme?.apply(settings.darkMode === true);
  downloadRecords=new Map(savedDownloads.map(d=>[d.id,d]));
}
async function boot() {
  try {
    await downloads.ready;await removeLegacySamples(db,downloads);await retireAutomaticCatalog(db);await reloadState();render();networkState();
    const pin=JSON.parse(sessionStorage.getItem('folio.pin')||'null');if(pin){showConnect();pollPin(pin.id,pin.startedAt);}
    const latest=libraryBooks().filter(b=>progress.get(b.id)?.elapsed>0&&!progress.get(b.id).completed).sort((a,b)=>progress.get(b.id).updatedAt-progress.get(a.id).updatedAt)[0];
    if(latest?.tracks?.length){await workerReady;await player.open(latest,{autoplay:false});updatePlayer();}
  }catch(error){content.innerHTML=empty('Your shelf couldn’t open.',`${e(error.message)} Enable browser storage and reload Folio.`,'book');}
}
boot();

import { db } from './db.js';
import { ServerClient } from './servers.js';
import { librivoxServer } from './librivox.js';

const audio = document.querySelector('#audio');
const status = document.querySelector('#status');
const started = Date.now(), events = [];
let sourceKind = null, lastSample = 0;
const finite = value => Number.isFinite(value) ? value : null;

function snapshot() {
  let audioSession = null;
  try { if (navigator.audioSession) audioSession = {type: navigator.audioSession.type, state: navigator.audioSession.state || null}; } catch {}
  return {
    hidden: !!document.hidden, sourcePresent: !!(audio.currentSrc || audio.src),
    paused: audio.paused, ended: audio.ended, seeking: audio.seeking,
    mediaTime: finite(audio.currentTime), duration: finite(audio.duration),
    readyState: audio.readyState, networkState: audio.networkState,
    muted: audio.muted, volume: finite(audio.volume), rate: finite(audio.playbackRate),
    mediaError: audio.error?.code || null, audioSession,
    mediaSession: navigator.mediaSession?.playbackState || null,
  };
}

function record(event) {
  events.push({at: Math.max(0, Date.now() - started), event, ...snapshot()});
  if (events.length > 40) events.shift();
}

for (const event of ['loadstart', 'loadedmetadata', 'play', 'playing', 'pause', 'waiting', 'stalled', 'suspend', 'seeking', 'seeked', 'ended', 'emptied', 'error']) {
  audio.addEventListener(event, () => record(event));
}
audio.addEventListener('timeupdate', () => {
  if (Date.now() - lastSample >= 2000) { lastSample = Date.now(); record('timeupdate'); }
});
audio.addEventListener('error', () => { status.textContent = 'The audio file could not be loaded. Return to Folio and check its server connection or download.'; });
document.addEventListener('visibilitychange', () => record('visibility'));
window.addEventListener('pagehide', () => record('pagehide'));

document.querySelector('#copy-report').addEventListener('click', async () => {
  const report = JSON.stringify({build: 'folio-basic-test-71', nativeControls: true, customMediaSessionHandlers: false, sourceKind, ...snapshot(), events: [...events]}, null, 2);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(report);
    status.textContent = 'Test report copied.';
  } catch {
    const field = document.querySelector('#report');
    field.value = report;
    field.hidden = false;
    field.focus();
    field.select();
    status.textContent = 'Copy the selected report below.';
  }
});

async function openCurrentFile() {
  let request;
  try {
    request = JSON.parse(sessionStorage.getItem('folio.audio-test') || 'null');
    sessionStorage.removeItem('folio.audio-test');
  } catch {}
  if (!request?.bookId) { status.textContent = 'Open a book in Folio, then start this test from Player settings → Playback help.'; return; }
  const book = await db.get('books', request.bookId);
  const index = Number.isInteger(request.index) ? request.index : 0;
  const track = book?.tracks?.[index];
  if (!track) { status.textContent = 'The current audio file is unavailable. Return to Folio and open the book again.'; return; }
  let source;
  if (request.local === true) {
    sourceKind = 'offline';
    source = new URL(`../offline-audio/${encodeURIComponent(book.id)}/${encodeURIComponent(track.id)}`, import.meta.url).href;
  } else {
    let config;
    try { config = JSON.parse(localStorage.getItem('folio.connection') || '{}'); } catch {}
    const server = book.serverId === librivoxServer.id ? librivoxServer : config?.servers?.find(server => server.id === book.serverId);
    if (!server) { status.textContent = 'Reconnect this book’s server in Folio before starting the test.'; return; }
    sourceKind = 'server';
    source = new ServerClient({clientId: localStorage.getItem('folio.client') || undefined}).mediaURL(server, track);
  }
  const position = Math.max(0, Number(request.position) || 0);
  const speed = Math.max(0.5, Math.min(3, Number(request.speed) || 1));
  const volume = Number.isFinite(request.volume) ? Math.max(0, Math.min(1, request.volume)) : 1;
  audio.addEventListener('loadedmetadata', () => {
    audio.playbackRate = speed;
    if (position > 0 && Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Math.min(position, Math.max(0, audio.duration - 0.05));
  }, {once: true});
  audio.src = source;
  audio.defaultPlaybackRate = speed;
  audio.playbackRate = speed;
  audio.volume = volume;
  audio.hidden = false;
  document.querySelector('#book').textContent = book.title;
  document.querySelector('#book').hidden = false;
  document.querySelector('#track').textContent = track.title || 'Current audio file';
  document.querySelector('#track').hidden = false;
  status.textContent = 'Tap the native Play control to begin. This test leaves your saved Folio position unchanged.';
  record('source-ready');
}

openCurrentFile().catch(() => { status.textContent = 'Could not open the current audio file. Return to Folio, open the book, and try the test again.'; });

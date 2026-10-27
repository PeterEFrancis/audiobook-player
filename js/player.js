import { db } from './db.js';
import { absolutePosition, locatePosition, sumDuration, chaptersFor } from './utils.js';

export class Player extends EventTarget {
  constructor({plex, downloads, getServer, artworkURL, settings = {}}) {
    super();
    Object.assign(this, {plex, downloads, getServer, artworkURL, settings});
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.audio.crossOrigin = 'anonymous';
    this.index = 0;
    this.lastSave = 0;
    this.lastTick = Date.now();
    this.pausedAt = 0;
    this.sleep = null;
    this.generation = 0;
    this.listening = false;
    const metadata = () => {
      if (!this.book || this.switching || (this.audio.currentSrc && this.audio.currentSrc !== this.activeSource)) return;
      const t = this.track;
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
        t.duration = this.audio.duration;
        this.book.duration = sumDuration(this.book);
      }
      this.applyPendingSeek();
      this.emit();
    };
    this.audio.addEventListener('loadedmetadata', metadata);
    this.audio.addEventListener('durationchange', metadata);
    this.audio.addEventListener('timeupdate', () => this.tick());
    this.audio.addEventListener('playing', () => {
      this.accountListening();
      this.listening = true;
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
      this.emit();
    });
    this.audio.addEventListener('pause', () => {
      if (!this.audio.paused) return;
      this.accountListening();
      this.listening = false;
      if (!this.switching) this.pausedAt = Date.now();
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
      if (!this.switching) this.persist().catch(e => this.error(e));
      this.emit();
    });
    this.audio.addEventListener('ended', () => this.ended().catch(e => this.error(e)));
    this.audio.addEventListener('error', () => {
      if (this.audio.error) this.error(new Error(navigator.onLine ? 'This audio could not be played. Check the Plex connection and that your browser supports its format (MP3, AAC, or M4B/AAC).' : 'This track is not available offline. Download the complete book before disconnecting.'));
    });
    this.audio.addEventListener('waiting', () => { this.accountListening(); this.listening = false; this.emit(); });
    this.timer = setInterval(() => this.checkSleep(), 500);
    this.setupMediaSession();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.persist().catch(() => {}); });
    window.addEventListener('pagehide', () => this.persist().catch(() => {}));
  }
  get track() { return this.book?.tracks?.[this.index]; }
  get position() { return this.pendingSeek ?? this.audio.currentTime ?? 0; }
  get elapsed() { return this.book ? absolutePosition(this.book, this.index, this.position) : 0; }
  get playing() { return !this.audio.paused; }
  get speed() { return this.audio.playbackRate; }
  emit() {
    this.dispatchEvent(new CustomEvent('change'));
    const duration = this.audio.duration;
    if (navigator.mediaSession?.setPositionState && Number.isFinite(duration) && duration > 0) {
      try { navigator.mediaSession.setPositionState({duration, playbackRate: this.speed, position: Math.min(this.position, duration)}); } catch {}
    }
  }
  error(error) { this.dispatchEvent(new CustomEvent('error', {detail: error})); }
  applyPendingSeek() {
    if (this.pendingSeek == null || !Number.isFinite(this.audio.duration) || this.audio.duration <= 0 || this.audio.readyState < 1) return;
    this.audio.currentTime = Math.min(this.pendingSeek, Math.max(0, this.audio.duration - 0.05));
    this.pendingSeek = null;
  }
  accountListening() {
    const now = Date.now();
    if (this.listening && this.session) this.session.listened += Math.max(0, (now - this.lastTick) / 1000);
    this.lastTick = now;
  }
  async open(book, {index, position, autoplay = true, respectSleep = false} = {}) {
    const generation = ++this.generation;
    if (!book.tracks?.length) throw new Error('This book has no playable audio tracks.');
    await this.persist();
    const saved = await db.get('progress', book.id);
    if (generation !== this.generation) return;
    const sameBook = this.book?.id === book.id;
    const previousBookId = this.book?.id;
    if (index == null) {
      index = saved?.completed ? 0 : (saved?.trackIndex || 0);
      position = saved?.completed ? 0 : (saved?.position || 0);
    }
    index = Math.max(0, Math.min(index, book.tracks.length - 1));
    const track = book.tracks[index];
    const local = await this.downloads.hasTrack(book.id, track.id);
    if (generation !== this.generation) return;
    const source = local ? this.downloads.audioURL(book.id, track.id) : this.plex.mediaURL(this.getServer(book.serverId), track);
    this.accountListening();
    this.listening = false;
    this.switching = true;
    this.audio.pause();
    if (!sameBook) {
      this.clearSleep();
      this.sleepStopped = false;
    }
    this.book = book;
    this.index = index;
    this.pendingSeek = Math.max(0, Number(position) || 0);
    this.audio.src = source;
    this.activeSource = this.audio.src;
    this.audio.playbackRate = saved?.speed || this.settings.speed || 1;
    this.audio.volume = this.settings.volume ?? 1;
    this.switching = false;
    this.local = local;
    this.completed = false;
    this.pausedAt = 0;
    if (!respectSleep) this.sleepStopped = false;
    if (!sameBook || !this.session) this.session = {id: crypto.randomUUID(), bookId: book.id, title: book.title, author: book.author, startedAt: Date.now(), listened: 0};
    if (previousBookId !== book.id) this.configureSound(saved || this.settings, false);
    this.updateMetadata();
    this.emit();
    if (autoplay && !this.sleepStopped) await this.play();
  }
  async play() {
    if (!this.book) return;
    this.sleepStopped = false;
    if (this.pendingSeek == null && (this.completed || this.audio.ended)) {
      const index = !this.completed && this.index < this.book.tracks.length - 1 ? this.index + 1 : 0;
      await this.open(this.book, {index, position: 0});
      return;
    }
    if (this.pausedAt && Date.now() - this.pausedAt > 30000 && this.settings.smartRewind !== false) {
      this.pendingSeek = Math.max(0, this.position - Number(this.settings.rewindSeconds || 10));
      this.applyPendingSeek();
    }
    this.pausedAt = 0;
    if (!this.context && (this.sound?.voiceBoost || this.sound?.bass || this.sound?.treble)) {
      try { this.configureSound(this.sound); } catch (error) { this.error(error); }
    }
    if (this.context?.state === 'suspended') await this.context.resume();
    await this.audio.play();
    await this.persist();
  }
  async toggle() { if (this.playing) this.audio.pause(); else await this.play(); }
  async seek(seconds) {
    if (!this.book) return;
    const target = locatePosition(this.book, seconds);
    if (target.index !== this.index) await this.open(this.book, {...target, autoplay: this.playing});
    else {
      this.pendingSeek = target.position;
      this.applyPendingSeek();
      this.completed = false;
      this.emit();
      await this.persist();
    }
  }
  async skip(seconds) { await this.seek(this.elapsed + seconds); }
  async chapter(direction) {
    if (!this.book) return;
    const chapters = chaptersFor(this.book);
    const current = chapters.findLastIndex(c => c.absolute <= this.elapsed + 0.1);
    const target = chapters[Math.max(0, Math.min(chapters.length - 1, current + direction))];
    if (target) await this.seek(target.absolute);
  }
  setSpeed(speed) { this.audio.playbackRate = Math.max(0.5, Math.min(3, Number(speed) || 1)); this.persist().catch(e => this.error(e)); this.emit(); }
  setVolume(volume) { this.settings.volume = Math.max(0, Math.min(1, Number(volume) || 0)); this.audio.volume = this.settings.volume; }
  async persist() {
    if (!this.book || this.switching) return;
    this.accountListening();
    const book = this.book;
    const session = this.session ? {...this.session, updatedAt: Date.now()} : null;
    const progress = {id: this.book.id, trackIndex: this.index, position: this.position, elapsed: this.elapsed, duration: sumDuration(this.book), speed: this.speed, completed: !!this.completed, voiceBoost: !!this.sound?.voiceBoost, bass: this.sound?.bass || 0, treble: this.sound?.treble || 0, updatedAt: Date.now(), dirty: this.book.serverId !== 'demo'};
    const sync = {id: book.id, serverId: book.serverId, track: this.track, position: progress.position, duration: this.track.duration, state: this.playing ? 'playing' : 'stopped', updatedAt: progress.updatedAt};
    await db.put('progress', progress);
    if (session) await db.put('history', session);
    if (book.serverId !== 'demo') {
      await db.put('sync', sync);
      this.dispatchEvent(new CustomEvent('syncneeded'));
    }
    this.dispatchEvent(new CustomEvent('progress', {detail: progress}));
  }
  tick() {
    const now = Date.now();
    this.accountListening();
    if (now - this.lastSave > 5000) { this.lastSave = now; this.persist().catch(e => this.error(e)); }
    this.checkSleep();
    this.emit();
  }
  async ended() {
    if (!this.book || this.switching || this.pendingSeek != null) return;
    this.accountListening();
    this.listening = false;
    if (this.sleepStopped) return;
    if (this.sleep?.type === 'chapter' && this.elapsed >= this.sleep.end - 0.15) {
      this.sleepStopped = true;
      this.clearSleep(); this.audio.pause(); await this.persist(); this.emit();
      this.dispatchEvent(new CustomEvent('sleepend'));
      return;
    }
    if (this.index < this.book.tracks.length - 1) await this.open(this.book, {index: this.index + 1, position: 0, respectSleep: true});
    else {
      this.completed = true;
      await this.persist();
      this.dispatchEvent(new CustomEvent('complete', {detail: this.book}));
      this.emit();
    }
  }
  setSleep(minutes) {
    if (!this.book) return;
    this.sleepStopped = false;
    if (minutes === 'chapter') {
      const chapters = chaptersFor(this.book);
      const next = chapters.find(c => c.absolute > this.elapsed + 0.2);
      this.sleep = {type: 'chapter', end: next?.absolute ?? sumDuration(this.book)};
    } else this.sleep = {type: 'time', end: Date.now() + Number(minutes) * 60000};
    this.sleepStart = {bookId: this.book.id, position: this.elapsed};
    this.emit();
  }
  clearSleep() { this.sleep = null; this.audio.volume = this.settings.volume ?? 1; this.emit(); }
  checkSleep() {
    if (!this.sleep || !this.book) return;
    const remaining = this.sleep.type === 'time' ? (this.sleep.end - Date.now()) / 1000 : this.sleep.end - this.elapsed;
    if (this.sleep.type === 'time' && remaining <= 10) this.audio.volume = (this.settings.volume ?? 1) * Math.max(0, remaining / 10);
    if (remaining <= 0.15) {
      this.sleepStopped = true;
      this.audio.pause();
      this.clearSleep();
      this.persist().catch(e => this.error(e));
      this.dispatchEvent(new CustomEvent('sleepend'));
    }
  }
  configureSound(options = {}, activate = true) {
    this.sound = {voiceBoost: !!options.voiceBoost, bass: Number(options.bass || 0), treble: Number(options.treble || 0)};
    if (!this.context && activate) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('Audio equalization is unavailable in this browser.');
      this.context = new AudioContext();
      const source = this.context.createMediaElementSource(this.audio);
      this.bass = this.context.createBiquadFilter(); this.bass.type = 'lowshelf'; this.bass.frequency.value = 250;
      this.treble = this.context.createBiquadFilter(); this.treble.type = 'highshelf'; this.treble.frequency.value = 3000;
      this.compressor = this.context.createDynamicsCompressor();
      this.gain = this.context.createGain();
      source.connect(this.bass).connect(this.treble).connect(this.compressor).connect(this.gain).connect(this.context.destination);
    }
    if (this.context) {
      this.bass.gain.value = this.sound.bass;
      this.treble.gain.value = this.sound.treble;
      this.compressor.threshold.value = this.sound.voiceBoost ? -28 : 0;
      this.compressor.ratio.value = this.sound.voiceBoost ? 5 : 1;
      this.gain.gain.value = this.sound.voiceBoost ? 1.4 : 1;
      if (activate) this.context.resume().catch(() => {});
    }
    if (activate) this.persist().catch(e => this.error(e));
  }
  updateMetadata() {
    if (!navigator.mediaSession || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new MediaMetadata({title: this.track.title || this.book.title, artist: this.book.author, album: this.book.title, artwork: [{src: new URL(this.artworkURL(this.book), location.href).href}]});
  }
  setupMediaSession() {
    if (!navigator.mediaSession) return;
    const actions = {play: () => this.play(), pause: () => this.audio.pause(), seekbackward: d => this.skip(-(d.seekOffset || 15)), seekforward: d => this.skip(d.seekOffset || 30), previoustrack: () => this.chapter(-1), nexttrack: () => this.chapter(1), seekto: d => { if (this.book && Number.isFinite(d.seekTime)) return this.seek(absolutePosition(this.book, this.index, d.seekTime)); }};
    for (const [action, handler] of Object.entries(actions)) {
      try { navigator.mediaSession.setActionHandler(action, d => Promise.resolve(handler(d)).catch(e => this.error(e))); } catch {}
    }
  }
}

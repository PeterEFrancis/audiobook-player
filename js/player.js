import { db } from './db.js';
import { absolutePosition, locatePosition, sumDuration, chaptersFor, playbackChapter } from './utils.js';

export class Player extends EventTarget {
  constructor({plex, downloads, getServer, artworkURL, settings = {}}) {
    super();
    Object.assign(this, {plex, downloads, getServer, artworkURL, settings});
    this.nativeAudioOnly = /iPhone|iPad|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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
    this.progressChanged = false;
    this.playbackStarted = false;
    this.saves = Promise.resolve();
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
      this.playbackStarted = true;
      this.progressChanged = true;
      this.setupMediaSession();
      this.mediaMetadataKey = null;
      this.emit();
    });
    this.audio.addEventListener('pause', () => {
      if (!this.audio.paused) return;
      this.accountListening();
      this.listening = false;
      if (this.playbackStarted) this.progressChanged = true;
      this.playbackStarted = false;
      if (!this.switching) this.pausedAt = Date.now();
      if (!this.switching) this.persist().catch(e => this.error(e));
      this.emit();
    });
    this.audio.addEventListener('ended', () => this.ended().catch(e => this.error(e)));
    this.audio.addEventListener('error', () => {
      if (this.audio.error) this.error(new Error(navigator.onLine ? 'This audio could not be played. Check the server connection and that your browser supports its format (MP3, AAC, or M4B/AAC).' : 'This track is not available offline. Download the complete book before disconnecting.'));
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
    this.updateMediaSession();
  }
  updateMediaSession() {
    const session = navigator.mediaSession;
    if (!session) return;
    try { session.playbackState = this.book ? this.playing && !this.audio.ended ? 'playing' : 'paused' : 'none'; } catch {}
    if (!this.book) {
      this.mediaMetadataKey = null;
      try { session.metadata = null; session.setPositionState?.(); } catch {}
      return;
    }
    this.updateMetadata();
    const chapter = playbackChapter(this.book, this.index, this.position);
    const duration = chapter.duration;
    if (session.setPositionState && Number.isFinite(duration) && duration > 0 && Number.isFinite(chapter.elapsed) && this.speed > 0) {
      try { session.setPositionState({duration, playbackRate: this.speed, position: chapter.elapsed}); } catch {}
    } else {
      try { session.setPositionState?.(); } catch {}
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
  async open(book, options = {}) {
    const generation = ++this.generation;
    this.opening = generation;
    this.nextSource = this.nextPreparation = null;
    try { return await this.openSource(book, options, generation); }
    finally { if (this.opening === generation) this.opening = null; }
  }
  async openSource(book, {index, position, autoplay = true, respectSleep = false}, generation) {
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
    this.progressChanged = false;
    this.playbackStarted = false;
    this.pausedAt = 0;
    if (!respectSleep) this.sleepStopped = false;
    if (!sameBook || !this.session) this.session = {id: crypto.randomUUID(), bookId: book.id, title: book.title, author: book.author, startedAt: Date.now(), listened: 0};
    if (previousBookId !== book.id) this.configureSound(saved || this.settings, false);
    this.updateMetadata();
    this.emit();
    this.opening = null;
    void this.prepareNext();
    if (autoplay && !this.sleepStopped) await this.play();
  }
  prepareNext({force = false} = {}) {
    const book = this.book, index = this.index + 1, generation = this.generation;
    if (!book?.tracks[index]) { this.nextSource = this.nextPreparation = null; return Promise.resolve(null); }
    const current = value => value?.bookId === book.id && value.index === index && value.generation === generation;
    if (!force && current(this.nextSource)) return Promise.resolve(this.nextSource);
    if (!force && current(this.nextPreparation)) return this.nextPreparation.promise;
    this.nextSource = null;
    const task = {bookId: book.id, index, generation};
    this.nextPreparation = task;
    task.promise = (async () => {
      try {
        const track = book.tracks[index];
        const local = await this.downloads.hasTrack(book.id, track.id);
        const source = local ? this.downloads.audioURL(book.id, track.id) : this.plex.mediaURL(this.getServer(book.serverId), track);
        if (this.nextPreparation !== task || this.book !== book || this.index + 1 !== index || this.generation !== generation) return null;
        return this.nextSource = {...task, source, local};
      } catch { return null; } // A failed look-ahead must not stop the current chapter.
      finally { if (this.nextPreparation === task) this.nextPreparation = null; }
    })();
    return task.promise;
  }
  continuePlayback() {
    const book = this.book, index = this.index + 1, track = book.tracks[index];
    const prepared = this.nextSource;
    const ready = prepared?.bookId === book.id && prepared.index === index && prepared.generation === this.generation;
    const local = (ready && prepared.local) || !navigator.onLine;
    const source = local ? (ready && prepared.local ? prepared.source : this.downloads.audioURL(book.id, track.id)) : this.plex.mediaURL(this.getServer(book.serverId), track);
    // Snapshot the finished file, but never wait for storage while iOS is handing off audio.
    void this.persist().catch(error => this.error(error));
    const rate = this.speed, volume = this.audio.volume;
    this.generation++;
    this.nextSource = this.nextPreparation = null;
    this.index = index;
    this.pendingSeek = 0;
    this.local = local;
    this.completed = false;
    this.playbackStarted = false;
    this.pausedAt = 0;
    this.progressChanged = true;
    this.audio.src = source;
    this.activeSource = this.audio.src;
    this.audio.playbackRate = rate;
    this.audio.volume = volume;
    // Keep the same media element and start in the ended event's task, before any await.
    const playing = this.startAudio();
    this.emit();
    void this.prepareNext();
    void this.persist().catch(error => this.error(error));
    return playing;
  }
  startAudio() {
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch {}
    // Keep play in the system-control event's task. A locked iPhone can leave
    // sound processing suspended/interrupted with a resume promise that stalls.
    const playing = this.audio.play();
    if (['suspended', 'interrupted'].includes(this.context?.state)) {
      try { void Promise.resolve(this.context.resume()).catch(error => this.error(error)); }
      catch (error) { this.error(error); }
    }
    return playing;
  }
  async play() {
    if (!this.book) return;
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch {}
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
    await this.startAudio();
    await this.persist();
  }
  async toggle() { if (this.playing) this.audio.pause(); else await this.play(); }
  async seek(seconds) {
    if (!this.book) return;
    const target = locatePosition(this.book, seconds);
    if (target.index !== this.index) {
      const autoplay = this.playing;
      await this.open(this.book, {...target, autoplay});
      if (autoplay) return;
    }
    else {
      this.pendingSeek = target.position;
      this.applyPendingSeek();
    }
    this.completed = false;
    this.progressChanged = true;
    this.emit();
    await this.persist();
  }
  async skip(seconds) { await this.seek(this.elapsed + seconds); }
  async chapter(direction) {
    if (!this.book) return;
    const chapters = chaptersFor(this.book);
    const current = chapters.findLastIndex(c => c.absolute <= this.elapsed + 0.1);
    const target = chapters[Math.max(0, Math.min(chapters.length - 1, current + direction))];
    if (target) await this.seek(target.absolute);
  }
  setSpeed(speed) { this.audio.playbackRate = Math.max(0.5, Math.min(3, Number(speed) || 1)); this.persist({preferencesOnly: true}).catch(e => this.error(e)); this.emit(); }
  setVolume(volume) { this.settings.volume = Math.max(0, Math.min(1, Number(volume) || 0)); this.audio.volume = this.settings.volume; }
  async persist({preferencesOnly = false} = {}) {
    if (!this.book || this.switching) return;
    this.accountListening();
    const changed = !preferencesOnly && (this.progressChanged || this.listening);
    // Restoring metadata or inspecting a paused book must not become a local checkpoint.
    if (!changed && !preferencesOnly) return this.saves;
    if (changed) this.progressChanged = false;
    const book = this.book;
    const preferences = {speed: this.speed, voiceBoost: !!this.sound?.voiceBoost, bass: this.sound?.bass || 0, treble: this.sound?.treble || 0};
    const session = this.session ? {...this.session, updatedAt: Date.now()} : null;
    const updatedAt = Date.now();
    const remoteProgress = book.serverId !== 'demo' && !book.localProgress;
    const progress = {id: book.id, trackIndex: this.index, position: this.position, elapsed: this.elapsed, duration: sumDuration(book), ...preferences, completed: !!this.completed, updatedAt, localChangedAt: updatedAt, source: 'local', dirty: remoteProgress};
    const sync = {id: book.id, serverId: book.serverId, track: this.track, position: progress.position, duration: this.track.duration, state: this.playing ? 'playing' : 'stopped', updatedAt: progress.updatedAt};
    const saving = this.saves.catch(() => {}).then(async () => {
      const current = await db.get('progress', book.id);
      if (!changed) {
        const updated = {...current, id: book.id, ...preferences};
        await db.put('progress', updated);
        this.dispatchEvent(new CustomEvent('progress', {detail: updated}));
        return;
      }
      const updated = {...current, ...progress};
      await db.put('progress', updated);
      if (session) await db.put('history', session);
      if (remoteProgress) {
        await db.put('sync', sync);
        this.dispatchEvent(new CustomEvent('syncneeded'));
      }
      this.dispatchEvent(new CustomEvent('progress', {detail: updated}));
    });
    this.saves = saving;
    try { await saving; }
    catch (error) { if (changed && this.book?.id === book.id) this.progressChanged = true; throw error; }
  }
  tick() {
    const now = Date.now();
    this.accountListening();
    if (now - this.lastSave > 5000) { this.lastSave = now; this.persist().catch(e => this.error(e)); }
    this.checkSleep();
    this.emit();
  }
  async ended() {
    if (!this.book || this.switching || this.opening || this.pendingSeek != null || !this.audio.ended || this.completed) return;
    this.accountListening();
    this.listening = false;
    this.progressChanged = true;
    this.checkSleep();
    if (this.sleepStopped) return;
    if (this.index < this.book.tracks.length - 1) await this.continuePlayback();
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
    // iOS can keep a resumed Web Audio graph silent. Never route its media
    // element through that graph; disconnecting it later cannot restore output.
    if (this.nativeAudioOnly) {
      this.sound = {voiceBoost: false, bass: 0, treble: 0};
      if (activate) this.persist({preferencesOnly: true}).catch(e => this.error(e));
      return;
    }
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
    if (activate) this.persist({preferencesOnly: true}).catch(e => this.error(e));
  }
  updateMetadata() {
    if (!this.book || !this.track || !navigator.mediaSession || !window.MediaMetadata) return;
    const chapter = this.track.chapters?.findLast(chapter => (chapter.start || 0) <= this.position);
    const album = chapter?.title || this.track.title || this.book.title;
    const src = new URL(this.artworkURL(this.book) || './assets/icon-512.png', location.href).href;
    const key = JSON.stringify([this.book.id, this.book.title, this.book.author, album, src]);
    if (key === this.mediaMetadataKey) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({title: this.book.title, artist: this.book.author, album, artwork: [{src}]});
      this.mediaMetadataKey = key;
    } catch {} // Unsupported system metadata must not interrupt audiobook playback.
  }
  setupMediaSession() {
    if (!navigator.mediaSession) return;
    const pause = async () => { this.audio.pause(); await this.persist(); this.emit(); };
    const actions = {play: () => this.play(), pause, stop: pause, seekbackward: d => this.skip(-(d.seekOffset || 15)), seekforward: d => this.skip(d.seekOffset || 30), previoustrack: () => this.chapter(-1), nexttrack: () => this.chapter(1), seekto: d => {
      if (!this.book || !Number.isFinite(d.seekTime)) return;
      const chapter = playbackChapter(this.book, this.index, this.position);
      if (!Number.isFinite(chapter.duration) || chapter.duration <= 0) return;
      const offset = Math.max(0, Math.min(d.seekTime, Math.max(0, chapter.duration - 0.05)));
      return this.seek(chapter.absolute + offset);
    }};
    for (const [action, handler] of Object.entries(actions)) {
      try {
        navigator.mediaSession.setActionHandler(action, details => {
          try { return Promise.resolve(handler(details || {})).catch(error => this.error(error)); }
          catch (error) { this.error(error); }
        });
      } catch {}
    }
  }
}

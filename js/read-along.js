import { cueAt, sentenceCues } from './lrc.js';
import { absolutePosition } from './utils.js';

export class ReadAlongView {
  constructor({ player, transcripts, onError = () => {} }) {
    this.player = player;
    this.transcripts = transcripts;
    this.onError = onError;
    player.addEventListener('change', () => this.update());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.update(true); });
  }

  mount(root, { dialog, artwork, toggle, visible = false }) {
    this.unmount();
    if (!root) return;
    Object.assign(this, { root, dialog, artwork, toggle, key: null, cues: [], nodes: [], active: -1, following: true });
    root.innerHTML = '<div class="read-along-toolbar"><span>Read along</span><button type="button" class="text-button" data-transcript-refresh>Refresh</button></div><p class="read-along-status" role="status"></p><p class="read-along-note" hidden></p><div class="read-along-scroll" tabindex="0" aria-label="Timed transcript"><ol class="read-along-lines"></ol></div><button type="button" class="read-along-follow button secondary" hidden>Follow playback</button>';
    this.scroll = root.querySelector('.read-along-scroll');
    this.list = root.querySelector('.read-along-lines');
    this.status = root.querySelector('.read-along-status');
    this.note = root.querySelector('.read-along-note');
    this.refresh = root.querySelector('[data-transcript-refresh]');
    this.follow = root.querySelector('.read-along-follow');
    this.events = new AbortController();
    const options = { signal: this.events.signal };
    this.refresh.addEventListener('click', () => { void this.load(true); }, options);
    this.follow.addEventListener('click', () => { this.following = true; this.follow.hidden = true; this.update(true); }, options);
    const browse = () => { this.following = false; this.follow.hidden = !this.cues.length; };
    this.scroll.addEventListener('pointerdown', browse, options);
    this.scroll.addEventListener('wheel', browse, { ...options, passive: true });
    this.scroll.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) browse(); }, options);
    this.list.addEventListener('click', event => {
      const button = event.target.closest('[data-cue]');
      if (!button || !this.list.contains(button)) return;
      const cue = this.cues[Number(button.dataset.cue)];
      if (!cue || this.key !== this.trackKey()) return;
      this.following = true;
      this.follow.hidden = true;
      const track = this.player.track;
      const at = Math.max(0, Math.min(cue.start, track.duration > 0 ? Math.max(0, track.duration - 0.05) : cue.start));
      void this.player.seek(absolutePosition(this.player.book, this.player.index, at)).catch(this.onError);
    }, options);
    this.setVisible(visible);
  }

  unmount() {
    this.controller?.abort();
    this.events?.abort();
    this.dialog?.classList.remove('read-along-open');
    this.root = null;
    this.cues = [];
    this.nodes = [];
    this.key = null;
  }

  trackKey() {
    return this.player.book && this.player.track ? JSON.stringify([this.player.book.id, this.player.track.id]) : null;
  }

  setVisible(visible) {
    if (!this.root) return;
    this.visible = visible;
    this.root.hidden = !visible;
    this.artwork.hidden = visible;
    this.dialog.classList.toggle('read-along-open', visible);
    this.toggle.setAttribute('aria-pressed', String(visible));
    if (visible) this.update(true);
    else { this.controller?.abort(); if (this.loading) this.key = null; }
  }

  update(force = false) {
    if (!this.root) return;
    if (!this.root.isConnected) { this.unmount(); return; }
    if (!this.visible || document.hidden) return;
    if (this.key !== this.trackKey()) { void this.load(); return; }
    if (this.loading || !this.cues.length) return;
    const position = this.player.pendingSeek ?? this.player.position;
    const index = cueAt(this.cues, position);
    if (index !== this.active || force) {
      this.nodes[this.active]?.classList.remove('is-current');
      this.nodes[this.active]?.removeAttribute('aria-current');
      this.active = index;
      const node = this.nodes[index];
      node?.classList.add('is-current');
      node?.setAttribute('aria-current', 'true');
      if (node && this.following) {
        const scrollRect = this.scroll.getBoundingClientRect(), nodeRect = node.getBoundingClientRect();
        this.scroll.scrollTo({ top: this.scroll.scrollTop + nodeRect.top - scrollRect.top - Math.max(0, (this.scroll.clientHeight - nodeRect.height) / 2), behavior: force || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    }
  }

  async load(refresh = false) {
    if (!this.root || !this.visible || !this.player.track) return;
    this.controller?.abort();
    const controller = this.controller = new AbortController(), root = this.root;
    const book = this.player.book, track = this.player.track, key = this.key = this.trackKey();
    this.loading = true;
    this.cues = [];
    this.nodes = [];
    this.active = -1;
    this.following = true;
    this.follow.hidden = true;
    this.list.replaceChildren();
    this.note.hidden = true;
    this.status.hidden = false;
    this.status.textContent = 'Loading transcript…';
    this.refresh.disabled = true;
    const current = () => !controller.signal.aborted && this.root === root && root.isConnected && this.trackKey() === key;
    try {
      const result = await this.transcripts.load(book, track, { signal: controller.signal, refresh });
      if (!current()) return;
      this.cues = sentenceCues(result?.cues || []);
      if (!this.cues.some(cue => cue.text.trim())) {
        this.status.textContent = navigator.onLine === false ? 'No downloaded transcript for this chapter.' : 'No timed transcript for this chapter.';
        this.note.textContent = 'Add a matching .lrc file beside the audio, then refresh the book’s metadata in Plex.';
        this.note.hidden = navigator.onLine === false;
        return;
      }
      const fragment = document.createDocumentFragment();
      this.nodes = this.cues.map((cue, index) => {
        if (!cue.text.trim()) return null;
        const item = document.createElement('li'), button = document.createElement('button');
        button.type = 'button';
        button.dataset.cue = index;
        button.textContent = cue.text;
        item.append(button);
        fragment.append(item);
        return button;
      });
      this.list.append(fragment);
      this.status.hidden = true;
    } catch (error) {
      if (current()) this.status.textContent = error.message || 'Could not load the transcript. Try Refresh.';
    } finally {
      if (current()) { this.loading = false; this.refresh.disabled = false; this.update(true); }
    }
  }
}

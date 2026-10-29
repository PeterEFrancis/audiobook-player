import { PlexClient } from './plex.js';
import { AudiobookshelfClient } from './audiobookshelf.js';
import { JellyfinClient } from './jellyfin.js';
import { LibriVoxAPI } from './librivox.js';

const names = { plex: 'Plex', audiobookshelf: 'Audiobookshelf', jellyfin: 'Jellyfin', emby: 'Emby', librivox: 'LibriVox' };
export const providerName = server => names[typeof server === 'string' ? server : server?.provider || 'plex'] || 'Server';

// Existing connections without a provider remain Plex connections and keep their IDs.
export class ServerClient {
  constructor(options = {}) {
    this.clients = {
      plex: new PlexClient(options), audiobookshelf: new AudiobookshelfClient(options),
      jellyfin: new JellyfinClient({ ...options, provider: 'jellyfin' }), emby: new JellyfinClient({ ...options, provider: 'emby' }),
      librivox: new LibriVoxAPI(),
    };
  }
  client(server) {
    const client = this.clients[server?.provider || 'plex'];
    if (!client) throw new Error('This server type is not supported. Reconnect it from Settings.');
    return client;
  }
  createPin(...args) { return this.clients.plex.createPin(...args); }
  checkPin(...args) { return this.clients.plex.checkPin(...args); }
  resources(...args) { return this.clients.plex.resources(...args); }
  validateServer(options) { return this.client(options).validateServer(options); }
  login(options) { return options.provider === 'plex' ? this.validateServer(options) : this.client(options).login(options); }
  connect(server) { return this.client(server).connect(server); }
  libraries(server) { return this.client(server).libraries(server); }
  books(server, ...args) { return this.client(server).books(server, ...args); }
  libraryProgress(server, ...args) { return this.client(server).libraryProgress(server, ...args); }
  bookProgress(server, ...args) { return this.client(server).bookProgress(server, ...args); }
  tracks(server, ...args) { return this.client(server).tracks(server, ...args); }
  transcript(server, ...args) { return this.client(server).transcript?.(server, ...args) ?? Promise.resolve(null); }
  mediaURL(server, ...args) { return this.client(server).mediaURL(server, ...args); }
  downloadURL(server, ...args) { const client = this.client(server); return (client.downloadURL || client.mediaURL).call(client, server, ...args); }
  artworkURL(server, ...args) { return this.client(server).artworkURL(server, ...args); }
  timeline(server, ...args) { return this.client(server).timeline(server, ...args); }
  markPlayed(server, ...args) { return this.client(server).markPlayed(server, ...args); }
}

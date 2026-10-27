# Folio

A responsive, installable audiobook player for Plex, Audiobookshelf, Jellyfin, and Emby, with offline downloads. Phones use bottom tabs, touch controls, bottom sheets, and a full-screen listening view. Computers use a wider layout with a sidebar and expanded shelves and controls. `index.html` is the separate public information and installation page; `app.html` opens the app. Folio is inspired by audiobook apps such as Prologue and is not affiliated with Prologue or the supported server projects.

## Run locally

Install Python 3 and Node.js 20 or later, then run:

```sh
npm run dev
```

Open [the landing page](http://127.0.0.1:4173/) or [the player](http://127.0.0.1:4173/app.html). Run `npm test` for the focused automated checks. There are no npm dependencies and no `npm install` or build step. Serve the files over HTTP locally or HTTPS in production; opening them with `file://` does not provide a working PWA.

## Connect a server

In **More**, choose the server type when adding a connection. Plex sign-in and automatic server discovery remain available. Audiobookshelf, Jellyfin, and Emby use a server URL with a username and password or an access token. Authentication happens directly with the selected server.

| Server | Library setup |
| --- | --- |
| Plex | Music library with each audiobook as an album, its author as the artist, and numbered audio tracks |
| Audiobookshelf | Book library containing audiobooks |
| Jellyfin / Emby | Music albums or standalone audio/audiobook items; ebook-only Book folders are excluded |

### Plex setup

1. Create a **Music** library in Plex Media Server. Organize each audiobook as an album, its author as the artist, and its audio files as numbered tracks. Set disc numbers for books spanning multiple discs. Embedded chapters are supported when Plex exposes them in track metadata.
2. Open Folio, sign in through the Plex authentication page, select a server, and choose your audiobook library. Folio never handles your Plex password. Alternatively, enter a complete HTTPS server URL and its Plex access token in the manual connection form.
3. Refresh the library after adding or changing books on your server. Open a book to retrieve its tracks and chapters.

On iPhone or iPad, open the site in Safari and use **Share → Add to Home Screen**, then launch the installed app **before signing in**. The installed app can have separate storage from a browser tab. On desktop and Android, use the browser's install option when available. Installation downloads a web app, not a native application or audiobook collection.

All providers must be reachable from your device with a valid HTTPS certificate and browser-compatible CORS responses. Use the complete server URL, including any configured base path. If a server or reverse proxy blocks cross-origin requests, configure it to allow the Folio site’s origin and the authentication headers used by its API. Folio has no backend proxy. Plex's secure `plex.direct` connections are supported; check secure connections and remote access in Plex if discovery succeeds but connection fails. Manual HTTP connections are limited to localhost development while the page itself uses HTTP. A GitHub Pages HTTPS site cannot connect to an ordinary HTTP LAN server.

## Offline listening

Download a book while connected to its server. In browsers that support Background Fetch (including Chrome and Edge), Folio asks the browser to manage the transfer, so it can continue after you switch apps or close Folio. The browser may request permission or show download controls. Folio saves completed audio for offline playback in its service worker.

Safari and iPhone/iPad PWAs do not support Background Fetch. On those devices, or if background downloads are denied, Folio uses a foreground queue: keep the app open and the device awake until the book is marked complete. The Downloads screen identifies the mode being used. A service worker alone cannot guarantee long transfers while the app is suspended.

Pause, resume, and retry preserve **completed tracks**. An interrupted track restarts from its beginning; partial-file byte resume is not provided. Background transfers remain subject to browser permissions, storage quotas, and operating-system limits. The app verifies nonempty responses and available content lengths before accepting a track. Saved audio supports byte-range playback and seeking; the app shell, book metadata, and covers are retained for offline use.

Check the download's complete status before disconnecting. Storage estimates and a persistence request are available, but the browser and operating system control quotas and may evict saved files. Removing a download frees its cached media. Clearing site data removes local downloads and reading data. For long trips, open the installed app and verify downloaded playback in airplane mode first.

Folio prepares the next audio source while a chapter is playing and starts it on the same audio element at the file boundary, without waiting for local progress writes or cache lookups. Downloaded next tracks work offline; speed and sound settings carry over, and sleep timers still stop at their requested boundary. Background continuation is designed for locked-screen and app-switching use, but still needs testing on the target iPhone/iOS version.

## CarPlay Now Playing

Connect your iPhone to CarPlay, start a book in Folio on the phone, then open **Now Playing** on the car display. If another app is shown, select the current audio source or return to Folio on the phone and press Play.

Folio supplies the book title, author, cover, playback position, and media controls to iOS. Play/pause, back 15 seconds, forward 30 seconds, previous/next chapter, and scrubbing are available where iOS and your vehicle expose them. The visible buttons and background playback behavior depend on the browser, iOS, and vehicle; verify operation while parked. Folio has no dedicated CarPlay icon or dashboard library browser. [Apple describes the shared Now Playing experience](https://developer.apple.com/videos/play/wwdc2017/719/).

## Reading state and privacy

Server connection details and access tokens stay in this browser's `localStorage`. Metadata, progress, bookmarks, listening history, download records, and pending sync work use IndexedDB; downloaded media uses Cache Storage. Requests go directly to your server; Plex sign-in also uses Plex’s authentication service. There is no Folio backend, account service, or analytics service, and no credential belongs in this repository or deployment configuration.

Sync works in both directions. Connecting, launching, refreshing, returning to the app, and periodic checks while it is open import the connected server’s played/unplayed status and resume positions across the library. Starting playback also checks the selected book's latest progress. Remote changes appear in the bookshelf, Finished filter, and Continue listening, including books never opened in Folio. Opening a paused book does not send a playback update.

Playback sends position updates and finished/played changes back to the matching server. Plex uses track positions, Jellyfin and Emby use item playback progress, and Audiobookshelf uses whole-book progress. Offline changes retry when connected; the pending queue retains the latest position per book and sends changes in order. Unsynced local progress takes precedence, and incoming refreshes never interrupt active playback. When local changes are synced, fresh server snapshots can restore another client’s progress or unplayed resets. Bookmarks, lists, and listening history stay on this device; use the token-free JSON backup and restore controls to move reading data between devices. Audio files are not included in backups.

Older Jellyfin versions can use playback-session reports when the direct progress API is unavailable. Folio confirms the stored position before clearing a queued checkpoint; if the server cannot retain it, the local checkpoint stays pending and More shows the sync error.

## Features and platform limits

| Capability | Folio |
| --- | --- |
| Plex, Audiobookshelf, Jellyfin, and Emby libraries | Supported |
| Search, sorting, authors, collections | Supported where supplied by the server |
| Continuous playback, track and embedded chapters, whole-book seeking | Supported |
| Playback speed, configurable skips, smart rewind | Supported |
| Sleep timer, end-of-chapter sleep, fade-out | Supported |
| Bookmarks, personal lists, listening history, reading-data backup | Stored on this device |
| Offline queue, pause/resume, storage management | Supported; background transfers use Background Fetch where available |
| Voice boost, bass and treble | Requires browser Web Audio support |
| Lock-screen and headset controls, background playback | Browser and OS dependent |
| CarPlay shared Now Playing controls | Browser, iOS, and vehicle dependent; start playback on the phone |
| Dedicated CarPlay app/library, Apple Watch, Siri shortcuts, native widgets | Not implemented |
| iCloud sync, cloud bookmarks, transcript or EPUB read-along | Not implemented |
| Silence removal, native casting integrations, guaranteed background downloads | Not implemented |

Folio streams and downloads original files from all providers; it does not transcode. A server’s own clients may support formats that the browser cannot play directly. MP3 and AAC in M4A/M4B are common browser-compatible choices. Other codecs depend on the device and browser. A downloaded file still needs a supported codec. Native audiobook apps can provide OS integrations that a PWA cannot reproduce; Folio does not claim complete feature parity.

The free shelf contains complete, human-read LibriVox audiobooks, with original SVG covers:

- [Walden](https://librivox.org/walden-by-henry-david-thoreau/), read by Gord Mackenzie (2006).
- [Moby-Dick](https://librivox.org/moby-dick-by-herman-melville/), read by Stewart Wills (2007).
- [Pride and Prejudice](https://librivox.org/pride-and-prejudice-by-jane-austen-2/), read by Karen Savage (2007).
- [The Adventures of Sherlock Holmes](https://librivox.org/the-adventures-of-sherlock-holmes-version-4-by-sir-arthur-conan-doyle/), read by David Clarke (2015).

LibriVox identifies these volunteer recordings as public domain in the USA. Each book’s details show its narrator, original recording, and Internet Archive audio source. Chapter MP3s stream directly from Internet Archive and can be downloaded through Folio for offline listening. Opening the app alone does not download the audio; complete books range from approximately 300 to 680 MiB. Audio hosting availability still depends on Internet Archive. Chapter durations and sizes come from its recording metadata. The previous synthetic sample files and their cached sample downloads are retired on update; personal server libraries and reading data are retained.

## GitHub Pages

Create a GitHub repository and push these files when ready. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**. The included `.github/workflows/pages.yml` deploys on pushes to `main` or `master`, or through **Actions → Deploy GitHub Pages → Run workflow**. No server token or custom deployment secret is required.

The workflow copies only the public HTML, manifest, service worker, CSS, JavaScript, and assets into its artifact. Both root sites and repository subpaths work because application URLs are relative. Serve `index.html` as the public entry page and link to `app.html` to launch the player. Follow GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) for repository permissions or deployment environment issues.

## Source map

| File | Purpose |
| --- | --- |
| `index.html` | Public information and installation page |
| `app.html`, `css/app.css` | Phone-first player with bottom tabs, touch controls, and full-screen playback |
| `js/servers.js`, `js/server-http.js` | Provider routing and shared HTTPS/API requests |
| `js/plex.js` | Plex sign-in, discovery, metadata, and progress APIs |
| `js/audiobookshelf.js` | Audiobookshelf authentication, book libraries, original audio, and progress |
| `js/jellyfin.js` | Jellyfin and Emby authentication, libraries, original audio, and progress |
| `js/player.js` | Playback, sleep timer, audio controls, media session |
| `js/downloads.js`, `js/background-downloads-sw.js`, `sw.js` | Download queue, browser background transfers, cached shell, offline range responses |
| `js/demo.js`, `js/sample-audio.js`, `js/sample-migration.js` | Human-read sample library, source credits, and retirement of synthetic samples |
| `js/db.js` | Local IndexedDB storage |
| `manifest.webmanifest`, `assets/` | Installation metadata, icons and covers |
| `tests/` | Focused automated regression checks |

API references: [Plex](https://developer.plex.tv/pms/), [Audiobookshelf](https://api.audiobookshelf.org/), [Jellyfin](https://api.jellyfin.org/), and [Emby authentication](https://dev.emby.media/doc/restapi/User-Authentication.html).

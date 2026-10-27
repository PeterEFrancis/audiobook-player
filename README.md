# Folio

A responsive, installable audiobook player for your Plex music library, with offline downloads. Phones use bottom tabs, touch controls, bottom sheets, and a full-screen listening view. Computers use a wider layout with a sidebar and expanded shelves and controls. `index.html` is the separate public information and installation page; `app.html` opens the app. Folio is inspired by audiobook apps such as Prologue and is not affiliated with Prologue or Plex.

## Run locally

Install Python 3 and Node.js 20 or later, then run:

```sh
npm run dev
```

Open [the landing page](http://127.0.0.1:4173/) or [the player](http://127.0.0.1:4173/app.html). Run `npm test` for the focused automated checks. There are no npm dependencies and no `npm install` or build step. Serve the files over HTTP locally or HTTPS in production; opening them with `file://` does not provide a working PWA.

## Connect Plex

1. Create a **Music** library in Plex Media Server. Organize each audiobook as an album, its author as the artist, and its audio files as numbered tracks. Set disc numbers for books spanning multiple discs. Embedded chapters are supported when Plex exposes them in track metadata.
2. Open Folio, sign in through the Plex authentication page, select a server, and choose your audiobook library. Folio never handles your Plex password. Alternatively, enter a complete HTTPS server URL and its Plex access token in the manual connection form.
3. Refresh the library after adding or changing books in Plex. Open a book to retrieve its tracks and chapters.

On iPhone or iPad, open the site in Safari and use **Share → Add to Home Screen**, then launch the installed app **before signing in**. The installed app can have separate storage from a browser tab. On desktop and Android, use the browser's install option when available. Installation downloads a web app, not a native application or audiobook collection.

The server must be reachable from your device with a valid HTTPS certificate and browser-compatible CORS responses. Plex's secure `plex.direct` connections are supported; check secure connections and remote access in Plex if discovery succeeds but connection fails. Manual HTTP connections are limited to localhost development while the page itself uses HTTP. A GitHub Pages HTTPS site cannot connect to an ordinary HTTP LAN server.

## Offline listening

Download a book while connected to Plex. Downloads run one book at a time and show byte progress. Keep Folio open and the device awake until the book is marked complete: browsers can suspend transfers when an app is closed or backgrounded.

Pause, resume, and retry preserve **completed tracks**. An interrupted track restarts from its beginning; partial-file byte resume and guaranteed background downloads are not provided. The app verifies nonempty responses and available content lengths before accepting a track. Saved audio supports byte-range playback and seeking; the app shell, book metadata, and covers are retained for offline use.

Check the download's complete status before disconnecting. Storage estimates and a persistence request are available, but the browser and operating system control quotas and may evict saved files. Removing a download frees its cached media. Clearing site data removes local downloads and reading data. For long trips, open the installed app and verify downloaded playback in airplane mode first.

## Reading state and privacy

Plex credentials stay in this browser's `localStorage`. Metadata, progress, bookmarks, listening history, download records, and pending sync work use IndexedDB; downloaded media uses Cache Storage. Requests go directly to Plex and your server. There is no Folio backend, account service, or analytics service, and no credential belongs in this repository or deployment configuration.

Playback sends per-track position updates to Plex. Offline changes remain local and retry when connected; the pending queue retains the latest position per book. Unsynced local progress takes precedence. When local progress is already synced, a newer Plex track timestamp can restore progress from another client. This is not simultaneous collaborative playback or a cloud bookmark service. Bookmarks, lists, and listening history stay on this device; use the token-free JSON backup and restore controls to move reading data between devices. Audio files are not included in backups.

## Features and platform limits

| Capability | Folio |
| --- | --- |
| Plex libraries, search, sorting, authors, collections | Supported |
| Continuous playback, track and embedded chapters, whole-book seeking | Supported |
| Playback speed, configurable skips, smart rewind | Supported |
| Sleep timer, end-of-chapter sleep, fade-out | Supported |
| Bookmarks, personal lists, listening history, reading-data backup | Stored on this device |
| Offline queue, pause/resume, storage management | Supported while the app runs |
| Voice boost, bass and treble | Requires browser Web Audio support |
| Lock-screen and headset controls, background playback | Browser and OS dependent |
| CarPlay, Apple Watch, Siri shortcuts, native widgets | Not implemented |
| iCloud sync, cloud bookmarks, transcript or EPUB read-along | Not implemented |
| Silence removal, native casting integrations, guaranteed background downloads | Not implemented |

Folio streams and downloads original files; it does not transcode. MP3 and AAC in M4A/M4B are common browser-compatible choices. Other codecs depend on the device and browser. A downloaded file still needs a supported codec. Native audiobook apps can provide OS integrations that a PWA cannot reproduce; Folio does not claim complete feature parity.

The included demo contains four short public-domain literary excerpts narrated with the synthetic Samantha voice, with original SVG covers. These are playable samples, not complete audiobooks. The durations in the demo metadata come from the actual bundled audio files.

## GitHub Pages

Create a GitHub repository and push these files when ready. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**. The included `.github/workflows/pages.yml` deploys on pushes to `main` or `master`, or through **Actions → Deploy GitHub Pages → Run workflow**. No Plex token or custom deployment secret is required. Publishing has not been performed by creating these files.

The workflow copies only the public HTML, manifest, service worker, CSS, JavaScript, and assets into its artifact. Both root sites and repository subpaths work because application URLs are relative. Serve `index.html` as the public entry page and link to `app.html` to launch the player. Follow GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) for repository permissions or deployment environment issues.

## Source map

| File | Purpose |
| --- | --- |
| `index.html` | Public information and installation page |
| `app.html`, `css/app.css` | Phone-first player with bottom tabs, touch controls, and full-screen playback |
| `js/plex.js` | Plex sign-in, discovery, metadata, and progress APIs |
| `js/player.js` | Playback, sleep timer, audio controls, media session |
| `js/downloads.js`, `sw.js` | Download queue, cached shell, offline range responses |
| `js/db.js` | Local IndexedDB storage |
| `manifest.webmanifest`, `assets/` | Installation metadata, icons, covers, demo audio |
| `tests/` | Focused automated regression checks |

Plex API integration follows its [official API documentation](https://developer.plex.tv/pms/).

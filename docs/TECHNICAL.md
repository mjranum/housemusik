# housemusik: technical notes

How to run, configure and test the server, and what the prototype does not do yet. For an overview, see the [README](../README.md).

## Requirements

- Node.js 18+ and npm (no npm packages are installed; npm only runs scripts).
- ffmpeg (provides `ffprobe`) for tags, durations, `npm run demo-music` and
  `npm test`. Without it the server still runs, using path-derived names.

## Run it

```sh
MUSIC_DIR=/path/to/your/music ROOMS="Living Room,Kitchen,Bedroom,Office" npm start
# then open http://<server-ip>:8080 on any device on the LAN
```

No music handy? `npm run demo-music` writes a few test tones into `./music`
(needs ffmpeg), and `npm start` uses `./music` by default.

| Setting     | Default                              |
|-------------|--------------------------------------|
| `MUSIC_DIR` | `./music`                            |
| `ROOMS`     | `Living Room,Kitchen,Bedroom,Office` |
| `PORT`      | `8080`                               |
| `HOST`      | `0.0.0.0` (whole LAN)                |
| `THEME_FILE`| `./config/theme.css`                 |
| `PLAYLIST_DB` | unset (use the folder scan)        |
| `PLAYLIST_TABLE` | `playlist`                      |
| `PLAYLIST_POLL_MS` | `5000`                        |

The library is read from the folder layout `Artist/Album/NN Title.ext`
(mp3, m4a, aac, flac, ogg, opus, wav, webm). If `ffprobe` is installed, a
track's real tags and duration replace the folder-derived ones the first time
it plays. Press *Rescan* after adding music.

## Playlist from a database

Set `PLAYLIST_DB` to a SQLite file and the player takes its track list from a
table in it (`playlist` by default, or `PLAYLIST_TABLE`) instead of scanning
`MUSIC_DIR`. `config/playlist.sql` creates the table:

| Column     | Meaning                                                    |
|------------|------------------------------------------------------------|
| `path`     | required; absolute, or relative to `MUSIC_DIR`             |
| `position` | play order (rows without it fall back to insertion order)  |
| `title`, `artist`, `album` | optional; override the file's own tags     |

The server re-reads the table every few seconds, so rows you add, remove or
reorder show up without a restart. Rows whose file is missing or isn't audio
are skipped and logged. *Play results* with an empty search plays the whole
table in order.

```sh
sqlite3 housemusik.db < config/playlist.sql        # or: node test/make-demo-db.js music housemusik.db
PLAYLIST_DB=housemusik.db MUSIC_DIR=/path/to/music node server.js
```

This uses Node's built-in SQLite module, so it needs Node 22.5 or newer (Node
prints an "experimental" warning on startup; that is expected). The folder
scan still works on Node 18.

## Colors

The page is black and gray by default. Colors, font and corner rounding are
set in `config/theme.css`, a short commented file of CSS variables. Edit it
and reload the page; the server does not need a restart. There is no settings
screen for this on purpose.

## How it fits together

```
server.js        HTTP routes, Server-Sent Events push, media streaming (Range)
lib/library.js   playlist table or folder scan, metadata, lazy ffprobe
lib/house.js     rooms, zones (groups of rooms), queue, playback timeline
public/app.js    remote UI, speaker mode, clock sync, drift correction
public/ambient.js  generated ambient scenes
config/theme.css   colors and font, served as /theme.css
```

- `GET /api/events[?speaker=Room]` streams the full house state on every change.
- `POST /api/cmd` takes `{cmd, ...}`: `play`, `enqueue`, `ambient`, `pause`,
  `resume`, `seek`, `next`, `prev`, `stop`, `sleep`, `volume`, `join`,
  `leave`, `groupAll`, and `ended` (sent by speakers).
- `GET /media/<id>` streams a track; only ids from the scan resolve, so request
  paths never touch the filesystem directly.

## Tests

`npm test` generates demo tracks (needs ffmpeg), starts the server and checks
the library, range streaming, path-traversal rejection, and the playback,
queue, grouping, volume and sleep commands.

## Known limits of this prototype

- **No authentication.** Anyone on your LAN can control it. Don't expose the
  port to the internet.
- Browsers need one tap before they will play sound, so a speaker device needs
  that tap after each page load (kiosk Chromium can skip it with
  `--autoplay-policy=no-user-gesture-required`).
- The library is sent to the browser as one list. Fine for a few thousand
  tracks; a very large library would want server-side search and paging.
- Sync is good enough for adjacent rooms, not for two speakers in one room.
- Phones that lock their screen will stop playing as speakers; use them as
  remotes.

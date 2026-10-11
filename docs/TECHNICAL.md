# housemusik: technical notes

How to run, configure and test the server, and what the prototype does not do yet. For an overview, see the [README](../README.md).

## Requirements

- Node.js 18+ and npm (no npm packages are installed; npm only runs scripts).
- The `mariadb` command-line client, when the playlist comes from MariaDB.
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
| `PLAYLIST_DB` | unset (use the folder scan); a MariaDB database name |
| `PLAYLIST_QUERY_FILE` | `./config/playlist-query.sql` |
| `PLAYLIST_POLL_MS` | `5000`                        |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | unset (client defaults) |
| `DB_DEFAULTS_FILE` | unset (an option file for the client) |
| `DB_CLIENT` | `mariadb` (use `mysql` for the MySQL client) |

The library is read from the folder layout `Artist/Album/NN Title.ext`
(mp3, m4a, aac, flac, ogg, opus, wav, webm). If `ffprobe` is installed, a
track's real tags and duration replace the folder-derived ones the first time
it plays. Press *Rescan* after adding music.

## Playlist from MariaDB

Set `PLAYLIST_DB` to a MariaDB database name and the player takes its track
list from that database instead of scanning `MUSIC_DIR`. It runs the query in
`config/playlist-query.sql`, which you edit to match your tables. The query
must return a `path` column (absolute, or relative to `MUSIC_DIR`) and can
also return `id`, `title`, `artist` and `album`. Rows play in the order the
query returns them.

The server re-reads the playlist every few seconds (and re-reads the query
file each time), so changes show up without a restart. Rows whose file is
missing or isn't audio are skipped and logged. *Play results* with an empty
search plays the whole playlist in order.

The server talks to MariaDB through the `mariadb` command-line client, so no
database driver is installed. It logs in the same way the client does for you
at a shell: your socket login, `~/.my.cnf`, `DB_DEFAULTS_FILE`, or the `DB_*`
settings. The password, if given, is passed in the environment, not on the
command line. A read-only database user is enough.

```sh
PLAYLIST_DB=housemusik MUSIC_DIR=/path/to/music node server.js
```

`config/playlist-schema.sql` has an example table that works with the default
query, for testing or if you don't have one yet.

## Colors

The page is black and gray by default. Colors, font and corner rounding are
set in `config/theme.css`, a short commented file of CSS variables. Edit it
and reload the page; the server does not need a restart. There is no settings
screen for this on purpose.

## How it fits together

```
server.js        HTTP routes, Server-Sent Events push, media streaming (Range)
lib/library.js   playlist (MariaDB) or folder scan, metadata, lazy ffprobe
lib/db.js        runs the playlist query through the mariadb client
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

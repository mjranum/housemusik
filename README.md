# housemusik

Ephemeral whole-house ambient and music library playback, in the browser.

- **One small server** (Node 18+, no dependencies) scans your music folder,
  streams tracks, and keeps the house state in memory. Restart it and the
  house goes quiet; nothing is saved. That is the "ephemeral" part.
- **Any browser is a remote.** Open the page on a phone or laptop to see every
  room, start music or ambient sound, group rooms, set volume and sleep timers.
- **Any browser can be a speaker.** On a device in a room (an old tablet, a
  Raspberry Pi with Chromium in kiosk mode, a laptop plugged into an amp),
  choose "plays in Kitchen" and tap *Tap to start speaker* once. That device
  then plays whatever the Kitchen is set to.
- **Ambient sound is generated live** in each speaker with the Web Audio API
  (rain, ocean, wind, brown noise, drone), so it needs no recordings and never
  audibly loops.
- **Grouped rooms play in sync.** The server describes playback as wall-clock
  timestamps; each speaker estimates its clock offset from the server and
  keeps its audio on the shared timeline, nudging speed for small drift and
  seeking for large drift. In testing two speakers stayed within a few
  milliseconds of each other. A per-device latency offset compensates for
  Bluetooth or AV-receiver delay.

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

The library is read from the folder layout `Artist/Album/NN Title.ext`
(mp3, m4a, aac, flac, ogg, opus, wav, webm). If `ffprobe` is installed, a
track's real tags and duration replace the folder-derived ones the first time
it plays. Press *Rescan* after adding music.

## How it fits together

```
server.js        HTTP routes, Server-Sent Events push, media streaming (Range)
lib/library.js   folder scan, path-derived metadata, lazy ffprobe
lib/house.js     rooms, zones (groups of rooms), queue, playback timeline
public/app.js    remote UI, speaker mode, clock sync, drift correction
public/ambient.js  generated ambient scenes
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

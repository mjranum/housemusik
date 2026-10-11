'use strict';
// Starts the real server against generated demo tracks and drives it over HTTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let proc;
let tmp;

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/time`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}
const cmd = async (body) => (await fetch(`${base}/api/cmd`, { method: 'POST', body: JSON.stringify(body) })).json();
const getState = async () => (await fetch(`${base}/api/state`)).json();

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
  execFileSync('sh', [path.join(__dirname, 'make-demo-music.sh'), tmp]);
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MUSIC_DIR: tmp, ROOMS: 'Kitchen,Den' },
    stdio: 'ignore',
  });
  await waitUp();
  await new Promise((r) => setTimeout(r, 300)); // initial scan
});

after(() => {
  proc.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('library lists tracks with path-derived metadata', async () => {
  const { tracks } = await (await fetch(`${base}/api/library`)).json();
  assert.strictEqual(tracks.length, 5);
  const t = tracks.find((x) => x.title === 'Tone 440');
  assert.ok(t);
  assert.strictEqual(t.artist, 'Test Tones');
  assert.strictEqual(t.album, 'Chords');
});

test('media supports range requests and rejects unknown ids', async () => {
  const { tracks } = await (await fetch(`${base}/api/library`)).json();
  const full = await fetch(`${base}/media/${tracks[0].id}`);
  assert.strictEqual(full.status, 200);
  const size = Number(full.headers.get('content-length'));
  await full.arrayBuffer();
  const part = await fetch(`${base}/media/${tracks[0].id}`, { headers: { Range: 'bytes=100-199' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers.get('content-range'), `bytes 100-199/${size}`);
  assert.strictEqual((await part.arrayBuffer()).byteLength, 100);
  assert.strictEqual((await fetch(`${base}/media/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  assert.strictEqual((await fetch(`${base}/..%2Fserver.js`)).status, 404);
});

test('play, pause, seek, next, ambient, grouping, volume', async () => {
  const { tracks } = await (await fetch(`${base}/api/library`)).json();
  let s = await getState();
  const kitchen = s.rooms.find((r) => r.name === 'Kitchen').zone;
  const den = s.rooms.find((r) => r.name === 'Den').zone;
  assert.notStrictEqual(kitchen, den);

  await cmd({ cmd: 'play', zone: kitchen, trackIds: tracks.map((t) => t.id) });
  s = await getState();
  let z = s.zones.find((x) => x.id === kitchen);
  assert.strictEqual(z.playback.kind, 'track');
  assert.strictEqual(z.playback.trackId, tracks[0].id);
  assert.strictEqual(z.upNext.length, 4);

  await cmd({ cmd: 'pause', zone: kitchen });
  await cmd({ cmd: 'seek', zone: kitchen, seconds: 5 });
  z = (await getState()).zones.find((x) => x.id === kitchen);
  assert.strictEqual(z.playback.pausedAt, 5);

  await cmd({ cmd: 'next', zone: kitchen });
  z = (await getState()).zones.find((x) => x.id === kitchen);
  assert.strictEqual(z.playback.trackId, tracks[1].id);

  // Only the matching end report advances the queue.
  assert.strictEqual((await cmd({ cmd: 'ended', zone: kitchen, trackId: tracks[1].id, startedAt: 1 })).result, false);
  assert.strictEqual((await cmd({ cmd: 'ended', zone: kitchen, trackId: tracks[1].id, startedAt: z.playback.startedAt })).result, true);
  z = (await getState()).zones.find((x) => x.id === kitchen);
  assert.strictEqual(z.playback.trackId, tracks[2].id);

  await cmd({ cmd: 'ambient', zone: den, scene: 'rain' });
  assert.strictEqual((await cmd({ cmd: 'ambient', zone: den, scene: 'nope' })).error, 'unknown scene: nope');

  // Den joins the kitchen and picks up its music; the den's old zone goes away.
  await cmd({ cmd: 'join', room: 'Den', zone: kitchen });
  s = await getState();
  assert.strictEqual(s.zones.length, 1);
  assert.deepStrictEqual(s.zones[0].rooms, ['Kitchen', 'Den']);

  // Splitting the den off keeps it playing the same thing.
  await cmd({ cmd: 'leave', room: 'Den' });
  s = await getState();
  assert.strictEqual(s.zones.length, 2);
  const denZone = s.zones.find((x) => x.rooms.includes('Den'));
  assert.strictEqual(denZone.playback.trackId, tracks[2].id);

  await cmd({ cmd: 'volume', room: 'Den', value: 3 });
  assert.strictEqual((await getState()).rooms.find((r) => r.name === 'Den').volume, 1);

  await cmd({ cmd: 'sleep', zone: kitchen, minutes: 30 });
  assert.ok((await getState()).zones.find((x) => x.id === kitchen).sleepAt > Date.now());
  assert.strictEqual((await cmd({ cmd: 'bogus' })).error, 'unknown command: bogus');
});

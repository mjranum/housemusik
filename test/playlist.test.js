'use strict';
// Runs the server with a SQLite playlist table instead of a folder scan.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let proc;
let tmp;
let dbFile;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getLibrary = async () => (await (await fetch(`${base}/api/library`)).json());

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-db-'));
  const music = path.join(tmp, 'music');
  execFileSync('sh', [path.join(__dirname, 'make-demo-music.sh'), music]);
  dbFile = path.join(tmp, 'house.db');
  const db = new DatabaseSync(dbFile);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'config', 'playlist.sql'), 'utf8'));
  const ins = db.prepare('INSERT INTO playlist (position, path, title) VALUES (?, ?, ?)');
  ins.run(2, 'Test Tones/Chords/01 Tone 220.mp3', null);
  ins.run(1, path.join(music, 'Test Tones/Sweeps/01 Rising sweep.mp3'), 'Morning sweep'); // absolute path
  ins.run(3, 'Test Tones/missing.mp3', null);
  ins.run(4, 'Test Tones/Chords/01 Tone 220.mp3', null); // same file twice
  db.close();
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MUSIC_DIR: music,
      PLAYLIST_DB: dbFile, PLAYLIST_POLL_MS: '200', ROOMS: 'Kitchen',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/time`); break; } catch { await sleep(100); }
  }
  await sleep(400);
});

after(() => {
  proc.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('library comes from the table, in position order', async () => {
  const lib = await getLibrary();
  assert.strictEqual(lib.source, 'playlist');
  assert.deepStrictEqual(lib.tracks.map((t) => t.title), ['Morning sweep', 'Tone 220', 'Tone 220']);
  assert.notStrictEqual(lib.tracks[1].id, lib.tracks[2].id);
  const media = await fetch(`${base}/media/${lib.tracks[0].id}`);
  assert.strictEqual(media.status, 200);
  await media.arrayBuffer();
});

test('edits to the table are picked up without a restart', async () => {
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO playlist (position, path, title) VALUES (0, ?, ?)')
    .run('Test Tones/Chords/04 Tone 440.mp3', 'First now');
  db.close();
  await sleep(800);
  const lib = await getLibrary();
  assert.strictEqual(lib.tracks.length, 4);
  assert.strictEqual(lib.tracks[0].title, 'First now');
});

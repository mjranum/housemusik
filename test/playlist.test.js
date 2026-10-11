'use strict';
// Runs the server against a playlist in a scratch MariaDB database.
// Skipped when no MariaDB server is reachable with the current user's login.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseBatch } = require('../lib/db');

const DBNAME = `hm_test_${process.pid}`;
const sql = (q, db = '') => execFileSync('mariadb', ['--batch', `--execute=${q}`, ...(db ? [db] : [])], { encoding: 'utf8' });
let available = true;
try { sql('SELECT 1'); } catch { available = false; }

const PORT = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
let proc;
let tmp;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getLibrary = async () => (await (await fetch(`${base}/api/library`)).json());
const opts = { skip: available ? false : 'no MariaDB server reachable' };

test('batch output parsing handles NULL and escapes', () => {
  const rows = parseBatch('id\tpath\ttitle\n1\ta\\tb.mp3\tNULL\n2\tc\\\\d.mp3\tline\\nbreak\n');
  assert.deepStrictEqual(rows, [
    { id: '1', path: 'a\tb.mp3', title: null },
    { id: '2', path: 'c\\d.mp3', title: 'line\nbreak' },
  ]);
});

before(async () => {
  if (!available) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-db-'));
  const music = path.join(tmp, 'music');
  execFileSync('sh', [path.join(__dirname, 'make-demo-music.sh'), music]);
  sql(`CREATE DATABASE ${DBNAME}`);
  sql(fs.readFileSync(path.join(__dirname, '..', 'config', 'playlist-schema.sql'), 'utf8'), DBNAME);
  const abs = path.join(music, 'Test Tones/Sweeps/01 Rising sweep.mp3').replace(/'/g, "''");
  sql(`INSERT INTO playlist (position, path, title) VALUES
    (2, 'Test Tones/Chords/01 Tone 220.mp3', NULL),
    (1, '${abs}', 'Morning sweep'),
    (3, 'Test Tones/missing.mp3', NULL),
    (4, 'Test Tones/Chords/01 Tone 220.mp3', NULL)`, DBNAME);
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MUSIC_DIR: music,
      PLAYLIST_DB: DBNAME, PLAYLIST_POLL_MS: '200', ROOMS: 'Kitchen',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/time`); break; } catch { await sleep(100); }
  }
  await sleep(500);
});

after(() => {
  if (!available) return;
  proc.kill();
  sql(`DROP DATABASE IF EXISTS ${DBNAME}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('library comes from the playlist query, in order', opts, async () => {
  const lib = await getLibrary();
  assert.strictEqual(lib.source, 'playlist');
  assert.deepStrictEqual(lib.tracks.map((t) => t.title), ['Morning sweep', 'Tone 220', 'Tone 220']);
  assert.notStrictEqual(lib.tracks[1].id, lib.tracks[2].id);
  const media = await fetch(`${base}/media/${lib.tracks[0].id}`);
  assert.strictEqual(media.status, 200);
  await media.arrayBuffer();
});

test('edits to the table are picked up without a restart', opts, async () => {
  sql(`INSERT INTO playlist (position, path, title) VALUES (0, 'Test Tones/Chords/04 Tone 440.mp3', 'First now')`, DBNAME);
  await sleep(900);
  const lib = await getLibrary();
  assert.strictEqual(lib.tracks.length, 4);
  assert.strictEqual(lib.tracks[0].title, 'First now');
});

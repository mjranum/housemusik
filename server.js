'use strict';
// housemusik: whole-house ambient and music library playback.
// One small Node server (no dependencies) holds the house state in memory,
// streams the library, and pushes state to every browser over Server-Sent
// Events. Any browser can be a remote; a browser left open in a room and
// switched to "speaker" mode plays that room's audio.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Library } = require('./lib/library');
const { House } = require('./lib/house');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, 'music'));
const ROOMS = (process.env.ROOMS || 'Living Room,Kitchen,Bedroom,Office')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1 << 20;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const library = new Library(MUSIC_DIR);
const clients = new Set(); // { res, room }
const house = new House(ROOMS, library, broadcast);

function speakerCounts() {
  const counts = {};
  for (const c of clients) if (c.room) counts[c.room] = (counts[c.room] || 0) + 1;
  return counts;
}

let broadcastQueued = false;
function broadcast() {
  // Coalesce bursts of changes into one push.
  if (broadcastQueued) return;
  broadcastQueued = true;
  setImmediate(() => {
    broadcastQueued = false;
    const data = `event: state\ndata: ${JSON.stringify(house.snapshot(speakerCounts()))}\n\n`;
    for (const c of clients) c.res.write(data);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Commands the UI can send. Each maps onto a House method.
const COMMANDS = {
  play: (c) => house.play(c.zone, c.trackIds, c.index),
  enqueue: (c) => house.enqueue(c.zone, c.trackIds),
  ambient: (c) => house.ambient(c.zone, c.scene),
  pause: (c) => house.pause(c.zone),
  resume: (c) => house.resume(c.zone),
  seek: (c) => house.seek(c.zone, c.seconds),
  next: (c) => house.next(c.zone),
  prev: (c) => house.prev(c.zone),
  stop: (c) => house.stop(c.zone),
  ended: (c) => house.ended(c.zone, c.trackId, c.startedAt),
  sleep: (c) => house.sleep(c.zone, c.minutes),
  volume: (c) => house.volume(c.room, c.value),
  join: (c) => house.join(c.room, c.zone),
  leave: (c) => house.leave(c.room),
  groupAll: (c) => house.groupAll(c.zone),
};

function handleEvents(req, res, url) {
  const room = url.searchParams.get('speaker');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const client = { res, room: room && house.rooms.has(room) ? room : null };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
    if (client.room) broadcast();
  });
  // Send this client the current state now; others only need to hear about
  // it if the speaker count changed.
  res.write(`event: state\ndata: ${JSON.stringify(house.snapshot(speakerCounts()))}\n\n`);
  if (client.room) broadcast();
}

function handleMedia(req, res, id) {
  const track = library.get(id);
  if (!track) return sendJson(res, 404, { error: 'no such track' });
  const file = library.filePath(track);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'file missing' });
    const headers = {
      'Content-Type': library.contentType(track),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    };
    const range = req.headers.range;
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      if (m[1] === '') {
        start = Math.max(0, st.size - Number(m[2])); // suffix range
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1);
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

function handleStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'bad url' }); }
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/time') return sendJson(res, 200, { now: Date.now() });
    if (req.method === 'GET' && p === '/api/events') return handleEvents(req, res, url);
    if (req.method === 'GET' && p === '/api/state') return sendJson(res, 200, house.snapshot(speakerCounts()));
    if (req.method === 'GET' && p === '/api/library') {
      return sendJson(res, 200, { root: path.basename(MUSIC_DIR), tracks: library.list() });
    }
    if (req.method === 'POST' && p === '/api/rescan') {
      const count = await library.scan();
      return sendJson(res, 200, { tracks: count });
    }
    if (req.method === 'POST' && p === '/api/cmd') {
      const cmd = await readJson(req);
      const fn = COMMANDS[cmd && cmd.cmd];
      if (!fn) return sendJson(res, 400, { error: `unknown command: ${cmd && cmd.cmd}` });
      const result = fn(cmd);
      broadcast();
      return sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/media/')) {
      return handleMedia(req, res, p.slice('/media/'.length));
    }
    if (req.method === 'GET') return handleStatic(req, res, p);
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
});

library.scan().then((n) => {
  console.log(`housemusik: ${n} tracks in ${MUSIC_DIR}`);
}).catch((e) => console.error('library scan failed:', e.message));

server.listen(PORT, HOST, () => {
  console.log(`housemusik: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  rooms: ${ROOMS.join(', ')}`);
});

module.exports = { server, house, library };

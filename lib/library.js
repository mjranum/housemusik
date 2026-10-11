'use strict';
// Music library. Two sources:
//  - a playlist table in a local MariaDB database (PLAYLIST_DB), played in
//    the order the playlist query returns; or
//  - a folder scan, deriving artist/album/title from the folder layout
//    (Artist/Album/NN Title.ext). Tags and durations are
// filled in lazily with ffprobe when a track is first played, if it is installed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { queryRows } = require('./db');

const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

function trackId(relPath) {
  return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 12);
}

function titleFromFile(file) {
  const base = path.basename(file, path.extname(file));
  // Strip leading track numbers like "01 ", "01 - ", "1-03. ", "07_".
  return base.replace(/^\d{1,2}([-.]\d{1,3})?\s*[-._]?\s*/, '').trim() || base;
}

class Library {
  constructor(root, { db = null } = {}) {
    this.root = root;
    this.db = db; // MariaDB settings, or null for the folder scan
    this.version = 0; // bumps whenever the track list changes
    this.signature = '';
    this.skipped = [];
    this.tracks = new Map(); // id -> track
    this.scanning = null;
    this.ffprobe = null; // resolved lazily: path string or false
  }

  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (this.db ? this._loadDb() : this._scan()).finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async _scan() {
    const found = new Map();
    const seenDirs = new Set();
    const walk = async (dir) => {
      let real;
      try { real = await fs.promises.realpath(dir); } catch { return; }
      if (seenDirs.has(real)) return; // symlink loop guard
      seenDirs.add(real);
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          try {
            const st = await fs.promises.stat(full);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch { continue; }
        }
        if (isDir) {
          await walk(full);
        } else if (isFile && AUDIO_TYPES[path.extname(e.name).toLowerCase()]) {
          const rel = path.relative(this.root, full);
          const parts = rel.split(path.sep);
          const id = trackId(rel);
          const prev = this.tracks.get(id);
          found.set(id, prev || {
            id,
            rel,
            title: titleFromFile(e.name),
            album: parts.length >= 2 ? parts[parts.length - 2] : '',
            artist: parts.length >= 3 ? parts[parts.length - 3] : '',
            duration: null,
            probed: false,
          });
        }
      }
    };
    await walk(this.root);
    this._replace(found);
    return found.size;
  }

  _replace(found) {
    const sig = [...found.keys()].join(',');
    if (sig !== this.signature) {
      this.signature = sig;
      this.version++;
    }
    this.tracks = found;
  }

  // Read the playlist with the configured query. The query may return any
  // columns; these are used (only path is required):
  //   path      file path, absolute or relative to MUSIC_DIR
  //   id        stable row id (keeps queues intact when rows are reordered)
  //   title, artist, album   display text (falls back to tags / file name)
  // Rows play in the order the query returns them.
  async _loadDb() {
    const raw = await queryRows(this.db, this.db.query);
    const rows = raw.map((r, i) => ({ ...r, _rowid: r.id ?? i, _path: r.path ?? r.file ?? r.filename }));
    if (raw.length && rows[0]._path === undefined) {
      throw new Error('playlist query must return a "path" column (use AS path)');
    }
    const found = new Map();
    const skipped = [];
    for (const r of rows) {
      if (typeof r._path !== 'string' || !r._path) continue;
      const abs = path.resolve(this.root, r._path);
      if (!AUDIO_TYPES[path.extname(abs).toLowerCase()]) { skipped.push(r._path); continue; }
      try {
        if (!(await fs.promises.stat(abs)).isFile()) throw new Error();
      } catch { skipped.push(r._path); continue; }
      // Same file may appear twice in a playlist, so the row is part of the id.
      const id = trackId(`${abs}#${r._rowid}`);
      const prev = this.tracks.get(id);
      const parts = abs.split(path.sep);
      const t = prev || {
        id, rel: abs, abs, duration: null, probed: false,
        title: titleFromFile(abs),
        album: parts.length >= 2 ? parts[parts.length - 2] : '',
        artist: parts.length >= 3 ? parts[parts.length - 3] : '',
      };
      // Table values win over tags and file names.
      for (const k of ['title', 'artist', 'album']) {
        if (r[k] != null && r[k] !== '') { t[k] = String(r[k]); t[`${k}Fixed`] = true; }
      }
      found.set(id, t);
    }
    this.skipped = skipped;
    this._replace(found);
    return found.size;
  }

  get(id) {
    return this.tracks.get(id) || null;
  }

  // Absolute path for a known track id. Only ids produced by scan() resolve,
  // so request paths never reach the filesystem directly.
  filePath(track) {
    return track.abs || path.join(this.root, track.rel);
  }

  contentType(track) {
    return AUDIO_TYPES[path.extname(track.rel).toLowerCase()] || 'application/octet-stream';
  }

  list() {
    const out = [];
    for (const t of this.tracks.values()) {
      out.push({ id: t.id, title: t.title, album: t.album, artist: t.artist, duration: t.duration });
    }
    if (this.db) return out; // keep the table's order
    out.sort((a, b) =>
      a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || a.title.localeCompare(b.title));
    return out;
  }

  // Fill in duration and tags with ffprobe. Resolves to the track either way.
  probe(track) {
    if (!track || track.probed) return Promise.resolve(track);
    track.probed = true;
    return new Promise((resolve) => {
      const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', this.filePath(track)];
      execFile('ffprobe', args, { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve(track);
        try {
          const fmt = JSON.parse(stdout).format || {};
          const tags = {};
          for (const [k, v] of Object.entries(fmt.tags || {})) tags[k.toLowerCase()] = v;
          const d = parseFloat(fmt.duration);
          if (Number.isFinite(d)) track.duration = d;
          if (tags.title && !track.titleFixed) track.title = tags.title;
          if (tags.album && !track.albumFixed) track.album = tags.album;
          if ((tags.artist || tags.album_artist) && !track.artistFixed) track.artist = tags.artist || tags.album_artist;
        } catch { /* keep path-derived metadata */ }
        resolve(track);
      });
    });
  }
}

module.exports = { Library, AUDIO_TYPES };

'use strict';
// Music library: scans a folder of audio files and derives artist/album/title
// from the folder layout (Artist/Album/NN Title.ext). Tags and durations are
// filled in lazily with ffprobe when a track is first played, if it is installed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

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
  constructor(root) {
    this.root = root;
    this.tracks = new Map(); // id -> track
    this.scanning = null;
    this.ffprobe = null; // resolved lazily: path string or false
  }

  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this._scan().finally(() => { this.scanning = null; });
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
    this.tracks = found;
    return found.size;
  }

  get(id) {
    return this.tracks.get(id) || null;
  }

  // Absolute path for a known track id. Only ids produced by scan() resolve,
  // so request paths never reach the filesystem directly.
  filePath(track) {
    return path.join(this.root, track.rel);
  }

  contentType(track) {
    return AUDIO_TYPES[path.extname(track.rel).toLowerCase()] || 'application/octet-stream';
  }

  list() {
    const out = [];
    for (const t of this.tracks.values()) {
      out.push({ id: t.id, title: t.title, album: t.album, artist: t.artist, duration: t.duration });
    }
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
          if (tags.title) track.title = tags.title;
          if (tags.album) track.album = tags.album;
          if (tags.artist || tags.album_artist) track.artist = tags.artist || tags.album_artist;
        } catch { /* keep path-derived metadata */ }
        resolve(track);
      });
    });
  }
}

module.exports = { Library, AUDIO_TYPES };

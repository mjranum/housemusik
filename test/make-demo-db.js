'use strict';
// Build a playlist database from the audio files under a folder, in path order.
// Usage: node test/make-demo-db.js <music dir> <db file>
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [dir, file] = process.argv.slice(2);
if (!dir || !file) {
  console.error('usage: node test/make-demo-db.js <music dir> <db file>');
  process.exit(1);
}
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|webm)$/i.test(e.name)) files.push(path.relative(dir, full));
  }
})(dir);
files.sort();
const db = new DatabaseSync(file);
db.exec(fs.readFileSync(path.join(__dirname, '..', 'config', 'playlist.sql'), 'utf8'));
const insert = db.prepare('INSERT INTO playlist (position, path) VALUES (?, ?)');
files.forEach((f, i) => insert.run(i + 1, f));
db.close();
console.log(`wrote ${files.length} rows to ${file}`);

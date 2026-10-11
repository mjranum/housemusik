-- Playlist table housemusik reads when started with PLAYLIST_DB=<file>.
-- Only "path" is required. Rows play in "position" order (then insertion
-- order). Paths may be absolute or relative to MUSIC_DIR. title, artist and
-- album override the file's own tags when set.
--
-- Create a database:  sqlite3 housemusik.db < config/playlist.sql
CREATE TABLE IF NOT EXISTS playlist (
  id       INTEGER PRIMARY KEY,
  position INTEGER,
  path     TEXT NOT NULL,
  title    TEXT,
  artist   TEXT,
  album    TEXT
);

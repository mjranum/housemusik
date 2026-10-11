-- The query housemusik runs to get its playlist when PLAYLIST_DB is set.
-- Edit it to match your tables; changes apply on the next reload (a few
-- seconds), no restart needed.
--
-- It must return a column named "path" (absolute, or relative to MUSIC_DIR).
-- Optional columns: "id" (a stable row id), "title", "artist", "album".
-- Rows play in the order returned, so keep the ORDER BY.
SELECT id, path, title, artist, album
FROM playlist
ORDER BY position, id

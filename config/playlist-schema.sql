-- An example playlist table that works with the default playlist-query.sql.
-- Only needed if you don't already have a table; otherwise edit the query.
--   mariadb housemusik < config/playlist-schema.sql
CREATE TABLE IF NOT EXISTS playlist (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  position INT,
  path     VARCHAR(1024) NOT NULL,
  title    VARCHAR(255),
  artist   VARCHAR(255),
  album    VARCHAR(255)
) DEFAULT CHARSET = utf8mb4;

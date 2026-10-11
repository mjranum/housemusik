'use strict';
// Reads the playlist from MariaDB (or MySQL) by running the command-line
// client, so the server needs no database driver. Credentials come from the
// usual places the client already reads (~/.my.cnf, a defaults file, or the
// socket login for your user), or from DB_* settings.

const { execFile } = require('child_process');

// Undo the escaping the client applies in --batch mode.
function unescape(v) {
  return v.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', '0': '\0', '\\': '\\' }[c] ?? c));
}

function parseBatch(out) {
  const lines = out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return [];
  const cols = lines.shift().split('\t').map((c) => c.toLowerCase());
  return lines.map((line) => {
    const vals = line.split('\t');
    const row = {};
    cols.forEach((c, i) => {
      const v = vals[i];
      row[c] = v === undefined || v === 'NULL' ? null : unescape(v);
    });
    return row;
  });
}

function queryRows(opts, sql) {
  const args = [];
  if (opts.defaultsFile) args.push(`--defaults-extra-file=${opts.defaultsFile}`); // must come first
  if (opts.host) args.push(`--host=${opts.host}`);
  if (opts.port) args.push(`--port=${opts.port}`);
  if (opts.user) args.push(`--user=${opts.user}`);
  args.push('--batch', '--column-names', `--execute=${sql}`, opts.database);
  const env = { ...process.env };
  if (opts.password) env.MYSQL_PWD = opts.password; // kept off the command line
  return new Promise((resolve, reject) => {
    execFile(opts.client || 'mariadb', args, { env, timeout: 15000, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const why = err.code === 'ENOENT'
          ? `"${opts.client || 'mariadb'}" client not found; install mariadb-client or set DB_CLIENT`
          : (stderr || err.message).trim();
        return reject(new Error(why));
      }
      resolve(parseBatch(stdout));
    });
  });
}

module.exports = { queryRows, parseBatch };

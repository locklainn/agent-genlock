// The phone's Back up button. The bridge runs `genlock backup --all` (every project in the app,
// the same archive the Mac command writes, and a copy stays in ~/genlock-backups) and sends the
// archive back in file chunks marked kind "backup-file", so the phone saves it rather than
// showing it in the conversation.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chunksFor } from './files.mjs';
import { genlockHome } from './lib.mjs';

const CLI = process.env.GENLOCK_CLI || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/genlock.mjs');

/** Runs the backup; resolves to { file, bytes, projects } as `genlock backup --json` prints it. */
export function runBackup(home = genlockHome(), { out } = {}) {
  const env = { ...process.env, GENLOCK_HOME: home };
  delete env.GENLOCK_SESSION;
  const args = [CLI, 'backup', '--all', '--json', ...(out ? ['--out', out] : [])];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).replace(/^genlock: /, '').trim()));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

/** The messages answering a phone's backup request OF: the archive's chunks, each naming the request. */
export async function backupMessages(of, home, opts) {
  const r = await runBackup(home, opts);
  const buf = fs.readFileSync(r.file);
  const records = r.projects.reduce((n, p) => n + (p.records || 0), 0);
  const caption = `${records} records from ${r.projects.length} project${r.projects.length === 1 ? '' : 's'}`;
  return chunksFor(buf, { fid: `backup-${of}`, name: path.basename(r.file), mime: 'application/gzip', caption })
    .map((m) => ({ ...m, kind: 'backup-file', of }));
}

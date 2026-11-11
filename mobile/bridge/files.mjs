// Files between the phone and the laptop. They ride the same relay as the text, cut into chunks
// small enough for any WebSocket limit along the way, and are put back together at the far end.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { genlockHome } from './lib.mjs';

/** Raw bytes per chunk: 256 KB once base64'd, far under the relay's message limit. */
export const CHUNK = 192 * 1024;
/** Larger than this is refused rather than sent: the phone is not a file server. */
export const MAX_BYTES = 30 * 1024 * 1024;
/** An image over this is scaled down before it goes to the phone. */
const SHRINK_OVER = 1.5 * 1024 * 1024;

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', html: 'text/html',
};
export const mimeOf = (name) => TYPES[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';

/**
 * A file the Assistant is sending, ready to go: its bytes, name and type. A large still image is
 * scaled to 2048 px as a JPEG with macOS's sips, so a phone on mobile data is not sent 10 MB.
 */
export function prepareOutgoing(file, { shrink = process.platform === 'darwin' } = {}) {
  const name = path.basename(file);
  const mime = mimeOf(name);
  const size = fs.statSync(file).size;
  if (shrink && size > SHRINK_OVER && /^image\/(png|jpeg|heic|webp)$/.test(mime)) {
    const out = path.join(os.tmpdir(), `genlock-${randomUUID()}.jpg`);
    try {
      execFileSync('/usr/bin/sips', ['-Z', '2048', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', file, '--out', out], { stdio: 'ignore' });
      const buf = fs.readFileSync(out);
      return { buf, name: name.replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg' };
    } catch { /* fall through to the original */ } finally { fs.rmSync(out, { force: true }); }
  }
  if (size > MAX_BYTES) throw new Error(`${name} is ${Math.round(size / 1048576)} MB, over the ${MAX_BYTES / 1048576} MB limit.`);
  return { buf: fs.readFileSync(file), name, mime };
}

/** The messages that carry one file. All share `t`, so a phone that missed them can be caught up. */
export function chunksFor(buf, { fid = randomUUID(), name, mime, caption, turn, t = Date.now() } = {}) {
  const total = Math.max(1, Math.ceil(buf.length / CHUNK));
  const out = [];
  for (let seq = 0; seq < total; seq++) {
    out.push({
      kind: 'file', fid, seq, total, t, name, mime, size: buf.length,
      ...(seq === 0 && caption ? { caption } : {}), ...(turn ? { turn } : {}),
      data: buf.subarray(seq * CHUNK, (seq + 1) * CHUNK).toString('base64'),
    });
  }
  return out;
}

/** Puts chunks back together. add() returns the whole file once its last chunk is in. */
export class Assembler {
  constructor() { this.parts = new Map(); }

  add(msg) {
    const { fid, seq, total } = msg;
    if (!fid || !Number.isInteger(seq) || !Number.isInteger(total) || total < 1 || seq < 0 || seq >= total) return null;
    let p = this.parts.get(fid);
    if (!p) {
      p = { name: msg.name || 'file', mime: msg.mime || mimeOf(msg.name || ''), caption: msg.caption, chunks: new Array(total), got: 0, bytes: 0, at: Date.now() };
      this.parts.set(fid, p);
    }
    if (p.chunks[seq]) return null;
    const data = Buffer.from(String(msg.data || ''), 'base64');
    p.bytes += data.length;
    if (p.bytes > MAX_BYTES) { this.parts.delete(fid); throw new Error(`${p.name} is over the ${MAX_BYTES / 1048576} MB limit.`); }
    p.chunks[seq] = data;
    p.got++;
    // Half-sent files from a dropped connection are dropped after ten minutes.
    for (const [k, v] of this.parts) if (Date.now() - v.at > 600_000) this.parts.delete(k);
    if (p.got < total) return null;
    this.parts.delete(fid);
    return { fid, name: p.name, mime: p.mime, caption: p.caption, buf: Buffer.concat(p.chunks) };
  }
}

/** Where a file from the phone is kept on the laptop, so the Assistant can open it by path. */
// `home` is unset when the bridge runs as the launch agent: it falls back to Genlock's own folder, as lib.mjs does.
export const phoneFilesDir = (home = genlockHome()) => path.join(home || genlockHome(), 'phone', 'files');

export function saveIncoming(home = genlockHome(), { name, buf }) {
  const dir = phoneFilesDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(String(name || 'file')).replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${stamp}-${safe}`);
  fs.writeFileSync(file, buf);
  return file;
}

/** What the Assistant reads: the message, and where each attached file now is. */
export function withAttachments(text, files) {
  const said = String(text || '').trim();
  if (!files.length) return said;
  const list = files.map((f) => f).join(', ');
  const what = files.length === 1 ? 'a file' : `${files.length} files`;
  return `${said ? `${said} ` : ''}(TJ attached ${what} from the phone: ${list}. Open it with Read to see it.)`;
}

/**
 * Attachments: screenshots and files the user sends, kept with the ticket or goal they belong to.
 *
 *   genlock attach ID FILE [FILE ..] --why ".."      copy into the store and record it on ID
 *   genlock files [ID] [--json]                      what is stored, where, and how big
 *   genlock purge ID [N ..] --user-said ".."         delete one ticket's files (or just numbers N)
 *   genlock purge --done | --before YYYY-MM-DD --user-said ".."   delete in bulk
 *
 * The file is COPIED, so the original (a screenshot in a temp folder, an upload Claude Code
 * clears later) can vanish and the ticket still has it. Copies are named by content hash, so one
 * screenshot attached to three tickets is stored once. The store is .genlock/files/, ignored by
 * git and carried by `genlock backup`. Purging deletes the copy and records that it happened,
 * so a later reader sees "purged" rather than a dangling path. Without --user-said, purge only
 * lists what it would delete.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { die, emit, ensureStore, filesDir, parseDue, resolveId, shortName } from './store.mjs';
import { allTickets, loadTicket } from './tickets.mjs';
import { allGoals, loadGoal } from './goals.mjs';

function find(raw) {
  const g = resolveId(raw, 'G-', 'goal');
  if (g) return { id: g, rec: loadGoal(g), kind: 'goal' };
  const t = resolveId(raw, 'T-', 'ticket');
  if (t) return { id: t, rec: loadTicket(t), kind: 'task' };
  die(`no goal or ticket '${raw}' in this repository`);
  return null;
}

const label = (r) => `${shortName(r.id) || r.id} (${r.id})`;
const size = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const everything = () => [...allGoals().map((rec) => ({ rec, kind: 'goal' })), ...allTickets().map((rec) => ({ rec, kind: 'task' }))];

export function cmdAttach(a) {
  const [target, ...sources] = a._;
  if (!target || !sources.length) die('attach needs a ticket or goal and at least one file:  genlock attach T-XXXXX ~/Desktop/shot.png --why ".."');
  if (!a.why || a.why === true) die('attach requires --why: what is in the file, and what should the next reader look at?');
  const { id, rec } = find(target);
  ensureStore();
  const dir = filesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const src of sources) {
    const from = path.resolve(src);
    let st;
    try { st = fs.statSync(from); } catch { die(`no file at ${from}`); }
    if (!st.isFile()) die(`${from} is not a file`);
    const body = fs.readFileSync(from);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const name = path.basename(from);
    const safe = name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
    const stored = `${sha256.slice(0, 12)}-${safe}`;
    const dest = path.join(dir, stored);
    if (!fs.existsSync(dest)) {
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, dest);
    }
    const fid = randomBytes(3).toString('hex');
    emit(id, 'attach', { fid, name, stored, bytes: body.length, sha256, from, why: String(a.why).trim(), text: `attached ${name}` });
    console.log(`${label(rec)} keeps ${name} (${size(body.length)}) at ${dest}`);
  }
}

export function cmdFiles(a) {
  const rows = (a._[0] ? [find(a._[0])] : everything())
    .flatMap(({ rec, kind }) => (rec.files || []).map((f, i) => ({ id: rec.id, short: shortName(rec.id), kind, n: i + 1, ...f, path: path.join(filesDir(), f.stored) })));
  if (a.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  const live = rows.filter((r) => !r.purged);
  if (!rows.length) { console.log('Nothing attached.'); return; }
  for (const r of rows) {
    console.log(`${(r.short || r.id).padEnd(22)} ${String(r.n).padStart(2)}. ${r.purged ? `[purged ${r.purged.at.slice(0, 10)}] ${r.name}` : r.path}  ${r.purged ? '' : size(r.bytes)}`);
    if (!r.purged) console.log(`${' '.repeat(27)}${r.why}`);
  }
  const blobs = new Map(live.map((r) => [r.stored, r.bytes]));
  console.log(`\n${live.length} kept, ${size([...blobs.values()].reduce((s, b) => s + b, 0))} on disk in ${filesDir()}`);
}

export function cmdPurge(a) {
  const now = new Date().toISOString();
  let picked = [];
  if (a.done || a.before) {
    const before = a.before ? parseDue(a.before) : null;
    for (const { rec } of everything()) {
      if (a.done && rec.status !== 'done') continue;
      const fids = (rec.files || []).filter((f) => !f.purged && (!before || f.at.slice(0, 10) < before)).map((f) => f.fid);
      if (fids.length) picked.push({ rec, fids });
    }
  } else {
    const [target, ...nums] = a._;
    if (!target) die('purge needs a ticket or goal, --done, or --before YYYY-MM-DD:  genlock purge T-XXXXX --user-said ".."');
    const { rec } = find(target);
    const files = rec.files || [];
    const chosen = nums.length ? nums.map((n) => files[parseInt(n, 10) - 1] || die(`${rec.id} has no attachment ${n} (it has ${files.length})`)) : files;
    const fids = chosen.filter((f) => !f.purged).map((f) => f.fid);
    if (fids.length) picked.push({ rec, fids });
  }
  const files = picked.flatMap(({ rec, fids }) => rec.files.filter((f) => fids.includes(f.fid)).map((f) => ({ rec, f })));
  if (!files.length) { console.log('Nothing to purge.'); return; }
  if (!a.user_said || a.user_said === true) {
    console.log(`Would purge ${files.length} file(s), ${size(files.reduce((s, x) => s + x.f.bytes, 0))}:`);
    for (const { rec, f } of files) console.log(`  ${label(rec)}  ${f.name}`);
    die('purge deletes the stored copies for good; run it again with --user-said "THEIR WORDS"', 2);
  }
  const userSaid = String(a.user_said).trim();
  for (const { rec, fids } of picked) emit(rec.id, 'purge', { fids, user_said: userSaid, text: `purged ${fids.length} attachment(s)` });
  // A copy is shared by every attachment with the same content; delete it only when none still keeps it.
  const stillKept = new Set(everything().flatMap(({ rec }) => (rec.files || []).filter((f) => !f.purged).map((f) => f.stored)));
  let freed = 0;
  for (const stored of new Set(files.map((x) => x.f.stored))) {
    if (stillKept.has(stored)) continue;
    const p = path.join(filesDir(), stored);
    if (fs.existsSync(p)) { freed += fs.statSync(p).size; fs.rmSync(p); }
  }
  console.log(`Purged ${files.length} attachment(s) from ${picked.length} record(s); ${size(freed)} freed.`);
}

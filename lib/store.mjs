/**
 * The durable store. Records live in the repository, under .genlock/records/, and are
 * built so that two agents on two branches cannot produce a merge conflict:
 *
 *   - one file per record, so unrelated work never touches the same file;
 *   - random ids, so two branches never mint the same name for different things;
 *   - append-only JSON lines with git's built-in union merge, so a merge keeps both
 *     sides' lines. State is computed by replaying events, and an event's id makes
 *     replay idempotent, so a line that arrives twice counts once.
 *
 * Live coordination is NOT here. See claims.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const now = () => new Date().toISOString();

const tty = process.stdout.isTTY;
export const bold = (s) => (tty ? `\u001b[1m${s}\u001b[0m` : s);

export function die(msg, code = 1) {
  process.stderr.write(`genlock: ${String(msg).replace(/\s+$/, '')}\n`);
  process.exit(code);
}

export function refuse(header, problems, footer, code = 2) {
  process.stderr.write(`genlock: ${header}\n\n`);
  for (const [where, p] of problems) process.stderr.write(`  ${String(where).padEnd(18)}${p}\n`);
  if (footer) process.stderr.write(`\n${footer}\n`);
  process.exit(code);
}

export function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    }).replace(/\n$/, '');
  } catch { return null; }
}

let cachedRoot;
export function repoRoot() {
  if (cachedRoot) return cachedRoot;
  cachedRoot = git(['rev-parse', '--show-toplevel']) || process.cwd();
  return cachedRoot;
}

export const genlockDir = () => path.join(repoRoot(), '.genlock');
export const recordsDir = () => path.join(genlockDir(), 'records');

/** Who is acting. A Claude Code session has an id already; other agents set GENLOCK_SESSION. */
export const identity = () =>
  process.env.GENLOCK_SESSION || process.env.CLAUDE_CODE_SESSION_ID || null;

/** Writes the merge rule beside the records, so the protection arrives with the first record. */
export function ensureStore() {
  fs.mkdirSync(recordsDir(), { recursive: true });
  cachedDirs = null;
  const attrs = path.join(genlockDir(), '.gitattributes');
  if (!fs.existsSync(attrs)) {
    fs.writeFileSync(attrs,
      '# Written by genlock. Records are append-only; a merge keeps both sides\' lines.\n'
      + 'records/*.jsonl merge=union\n');
  }
  const ignore = path.join(genlockDir(), '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'live/\n');
}

/** Every worktree's records, so one board is visible from all of them before anything merges. */
let cachedDirs = null;
function allRecordDirs() {
  if (cachedDirs) return cachedDirs;
  const dirs = new Set([recordsDir()]);
  const out = git(['worktree', 'list', '--porcelain'], repoRoot());
  if (out) {
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) dirs.add(path.join(line.slice(9), '.genlock', 'records'));
    }
  }
  cachedDirs = [...dirs].filter((d) => fs.existsSync(d));
  return cachedDirs;
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7}|\|{7})/;
export const damaged = [];

export function readEvents(id) {
  const byId = new Map();
  for (const d of allRecordDirs()) {
    const f = path.join(d, `${id}.jsonl`);
    if (!fs.existsSync(f)) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      // A conflict marker carries no data, so it is skipped and every real line survives.
      if (!line.trim() || CONFLICT_MARKER.test(line)) return;
      try {
        const ev = JSON.parse(line);
        if (ev && ev.e) byId.set(ev.e, ev);
        else damaged.push(`${f}:${i + 1}`);
      } catch { damaged.push(`${f}:${i + 1}`); }
    });
  }
  return [...byId.values()].sort((a, b) =>
    (a.at < b.at ? -1 : a.at > b.at ? 1 : a.e < b.e ? -1 : 1));
}

export function emit(id, op, data = {}) {
  ensureStore();
  namesCache.clear();
  const events = readEvents(id);
  let ms = Date.now();
  // Events within one record keep their causal order even inside one millisecond.
  if (events.length) ms = Math.max(ms, Date.parse(events[events.length - 1].at) + 1);
  const ev = {
    e: randomBytes(6).toString('hex'), at: new Date(ms).toISOString(),
    by: identity() || 'unknown', op, ...data,
  };
  fs.appendFileSync(path.join(recordsDir(), `${id}.jsonl`), `${JSON.stringify(ev)}\n`);
  return ev;
}

export function listIds(prefix) {
  const ids = new Set();
  for (const d of allRecordDirs()) {
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.jsonl') && f.startsWith(prefix)) ids.add(f.slice(0, -6));
    }
  }
  return [...ids].sort();
}

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newId(prefix) {
  const existing = new Set(listIds(prefix));
  for (;;) {
    const id = prefix + [...randomBytes(5)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    if (!existing.has(id)) return id;
  }
}

/* ------------------------------------------------- short names, for people to say */

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its',
  'of', 'on', 'or', 'our', 'that', 'the', 'their', 'this', 'to', 'with']);
const wordsOf = (text) => String(text).toLowerCase().replace(/['’]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const meaningful = (text) => { const w = wordsOf(text); const m = w.filter((x) => !STOP_WORDS.has(x)); return m.length ? m : w; };

/** What a title or a spoken name becomes as a short name. */
export const slugify = (text) => wordsOf(text).join('-');

const namesCache = new Map();

/**
 * Every goal or ticket's short name, by id, for a person to say instead of a random id. It comes
 * from the title unless someone chose one. The oldest claims a name first, so replaying the same
 * records anywhere gives the same names.
 */
export function shortNames(prefix) {
  if (namesCache.has(prefix)) return namesCache.get(prefix);
  const recs = listIds(prefix).map((id) => {
    const events = readEvents(id);
    const titled = events.find((e) => e.title);
    const chosen = events.filter((e) => e.op === 'short').pop();
    const closed = events.some((e) => ['done', 'abandon', 'drop', 'reject'].includes(e.op));
    return { id, at: events[0]?.at || '', title: titled?.title || id, chosen: chosen?.short, closed };
  }).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  const taken = new Set(recs.filter((r) => r.chosen).map((r) => r.chosen));
  const names = new Map();
  for (const r of recs) {
    let name = r.chosen;
    if (!name) {
      const words = meaningful(r.title);
      for (let n = Math.min(3, words.length); n <= words.length && !name; n++) {
        const candidate = words.slice(0, n).join('-');
        if (!taken.has(candidate)) name = candidate;
      }
      for (let i = 2; !name; i++) {
        const candidate = `${words.slice(0, 3).join('-') || 'item'}-${i}`;
        if (!taken.has(candidate)) name = candidate;
      }
      taken.add(name);
    }
    names.set(r.id, { name, title: r.title, closed: r.closed });
  }
  namesCache.set(prefix, names);
  return names;
}

/** "billing-page", or the id itself for anything without a name. */
export const shortName = (id) => {
  const prefix = String(id).slice(0, 2);
  return (prefix === 'G-' || prefix === 'T-') ? shortNames(prefix).get(id)?.name || id : id;
};

function resolveName(raw, prefix, noun) {
  const names = shortNames(prefix);
  const want = slugify(raw);
  for (const [id, n] of names) if (n.name === want) return id;
  const words = meaningful(raw);
  if (!words.length) return null;
  // However it was said: every word they used appears in the name or the title.
  let hits = [...names].filter(([, n]) => {
    const known = new Set([...wordsOf(n.name), ...wordsOf(n.title)]);
    return words.every((w) => known.has(w));
  });
  const open = hits.filter(([, n]) => !n.closed);
  if (open.length) hits = open;
  if (hits.length === 1) return hits[0][0];
  if (hits.length > 1) die(`'${raw}' matches several ${noun}s: ${hits.map(([, n]) => n.name).join(', ')}`);
  return null;
}

/** Resolve an id by exact match or a unique prefix, or a goal or ticket by its short name or words from its title. */
export function resolveId(raw, prefix, noun) {
  const want = String(raw).trim().toUpperCase();
  const ids = listIds(prefix);
  if (ids.includes(want)) return want;
  const hits = ids.filter((i) => i.startsWith(want) || i.slice(prefix.length).startsWith(want));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) die(`'${raw}' matches several ${noun}s: ${hits.join(', ')}`);
  return (prefix === 'G-' || prefix === 'T-') ? resolveName(raw, prefix, noun) : null;
}

/** Uncommitted paths in this worktree, leaving out genlock's own records. */
export function dirtyFiles(cwd = repoRoot()) {
  const out = git(['status', '--porcelain', '-z', '-uall'], cwd);
  if (!out) return [];
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i].slice(0, 2);
    files.push(parts[i].slice(3));
    if (st[0] === 'R' || st[0] === 'C') i++;
  }
  return files.filter((f) => !f.startsWith('.genlock/'));
}

/* ------------------------------------------------- parts tickets and goals share */

export const emptyShared = () => ({ decisions: [], refs: [], forbids: [], due: null });

/** A date as YYYY-MM-DD, refusing the ones that only look real, such as 31 February. */
export function parseDue(raw) {
  if (raw === undefined || raw === null || raw === true) return null;
  const day = String(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) die(`a date must be YYYY-MM-DD, not '${day}'`);
  const ms = Date.parse(day);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) die(`'${day}' is not a real date`);
  return day;
}

/** Replay the ops a ticket and a goal have in common. True if this event was one. */
export function applyShared(rec, e) {
  switch (e.op) {
    case 'decide': {
      const d = { did: e.did || e.e, text: e.text, user_said: e.user_said || '', at: e.at, withdrawn: null };
      if (e.supersedes) {
        const old = rec.decisions.find((x) => x.did === e.supersedes);
        if (old) old.withdrawn = d.did;
      }
      rec.decisions.push(d);
      return true;
    }
    case 'ref': rec.refs.push({ path: e.path, why: e.why }); return true;
    case 'due': rec.due = e.due; return true;
    case 'forbid':
      rec.forbids.push({ fid: e.fid || e.e, text: e.text, lifted_by: e.lifted_by, lifted: null });
      return true;
    case 'unforbid': {
      const f = rec.forbids.find((x) => x.fid === e.fid);
      if (f) f.lifted = e.user_said;
      return true;
    }
    default: return false;
  }
}

export const liveForbids = (rec) => rec.forbids.filter((f) => !f.lifted);
export const liveDecisions = (rec) => rec.decisions.filter((d) => !d.withdrawn);

/** What every reader must see. A withdrawn decision shows only so nobody re-adds it. */
export function sharedLines(rec, indent = '  ') {
  const L = [];
  const forbids = liveForbids(rec);
  if (forbids.length) {
    L.push(`${indent}DO NOT:`);
    forbids.forEach((f, i) => L.push(`${indent}  ${i + 1}. ${f.text} (lifted only by: ${f.lifted_by})`));
  }
  if (rec.decisions.length) {
    L.push(`${indent}decisions:`);
    rec.decisions.forEach((d, i) => L.push(`${indent}  ${i + 1}. ${d.withdrawn ? '[WITHDRAWN, do not re-add] ' : ''}${d.text}`
      + `${d.user_said ? `  (user: "${d.user_said}")` : ''}`));
  }
  if (rec.refs.length) {
    L.push(`${indent}read:`);
    for (const r of rec.refs) L.push(`${indent}  ${r.path} — ${r.why}`);
  }
  return L;
}

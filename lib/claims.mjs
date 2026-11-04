/**
 * Live coordination: who is working on what, right now. This is the one thing that must
 * NOT be committed. A branch switch would change a claim's meaning, and a stale claim on
 * disk would block people forever. So it lives in the git common directory, which every
 * worktree of a repository shares and no checkout touches.
 *
 * A claim is a LEASE. It expires unless renewed, so a dead agent cannot block a live one.
 * Check-and-claim runs under a lock, because check-then-act is the race that "check before
 * you build" always loses when several agents check at the same moment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { die, git, repoRoot, genlockDir, identity, now } from './store.mjs';

const DEFAULT_TTL_MIN = 60;

export function liveDir() {
  const common = git(['rev-parse', '--git-common-dir'], repoRoot());
  const base = common
    ? path.join(path.resolve(repoRoot(), common), 'genlock')
    : path.join(genlockDir(), 'live');
  fs.mkdirSync(path.join(base, 'claims'), { recursive: true });
  return base;
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function withLock(fn) {
  const lock = path.join(liveDir(), 'lock');
  const start = Date.now();
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A lock older than 30s belongs to a process that died holding it.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.rmSync(lock, { force: true }); } catch { /* raced */ }
      if (Date.now() - start > 10000) die('timed out waiting for the coordination lock');
      sleepMs(25);
    }
  }
  // A refusal exits from inside fn, and `finally` does not run on process.exit.
  const unlock = () => fs.rmSync(lock, { force: true });
  process.once('exit', unlock);
  try { return fn(); } finally { process.removeListener('exit', unlock); unlock(); }
}

const claimFile = (key) => path.join(liveDir(), 'claims', `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

export function liveClaims() {
  const d = path.join(liveDir(), 'claims');
  const t = Date.now();
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; }
  }).filter((c) => c && Date.parse(c.expires) > t);
}

/* ------------------------------------------------------------- path geometry */

export function normalize(p) {
  let s = String(p).trim().replace(/\\/g, '/');
  if (path.isAbsolute(s)) s = path.relative(repoRoot(), s).replace(/\\/g, '/');
  return s.replace(/^\.\//, '').replace(/\/+$/, '');
}

const hasGlob = (p) => /[*?[\]{}]/.test(p);
const staticPrefix = (p) => {
  const out = [];
  for (const seg of p.split('/')) { if (hasGlob(seg)) break; out.push(seg); }
  return out;
};

/** Could these two patterns name a common file? Errs toward yes, which is the safe direction. */
export function overlaps(a, b) {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

function globToRegex(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      re += '.*'; i++;
      if (p[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Does this pattern cover this actual file? The guard uses this, so it must be exact. */
export function covers(pattern, file) {
  if (pattern === '' || pattern === '.') return true;
  if (!hasGlob(pattern)) return file === pattern || file.startsWith(`${pattern}/`);
  return globToRegex(pattern).test(file);
}

/* -------------------------------------------------------------------- claims */

/** Every way this set of paths and resources collides with a claim held by someone else. */
export function collisions({ paths = [], resources = [], key, session }) {
  const out = [];
  for (const c of liveClaims()) {
    if (c.key === key || (session && c.session === session)) continue;
    for (const p of paths) for (const q of c.paths) {
      if (overlaps(p, q)) out.push({ kind: 'path', mine: p, theirs: q, holder: c });
    }
    for (const r of resources) if (c.resources.includes(r)) {
      out.push({ kind: 'resource', mine: r, theirs: r, holder: c });
    }
  }
  return out;
}

export const describeCollision = (x) =>
  `${x.kind} '${x.mine}' collides with '${x.theirs}', held by ${x.holder.key} (session ${String(x.holder.session).slice(0, 8)}, until ${x.holder.expires.slice(11, 16)}Z)`;

export function writeClaim({ key, session, paths, resources, ttl, strict }) {
  const prior = readClaim(key);
  const claim = {
    key, session, paths, resources, strict: !!(strict || prior?.strict), root: repoRoot(),
    acquired: prior?.acquired || now(), ttl: ttl || prior?.ttl || DEFAULT_TTL_MIN,
    expires: new Date(Date.now() + (ttl || prior?.ttl || DEFAULT_TTL_MIN) * 60000).toISOString(),
  };
  const f = claimFile(key);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(claim, null, 2));
  fs.renameSync(tmp, f);
  return claim;
}

function readClaim(key) {
  try { return JSON.parse(fs.readFileSync(claimFile(key), 'utf8')); } catch { return null; }
}

export function releaseTicket(key) {
  try { withLock(() => fs.rmSync(claimFile(key), { force: true })); } catch { /* nothing to release */ }
}

export const claimFor = (key) => liveClaims().find((c) => c.key === key) || null;

export function cmdClaim(a) {
  const key = a._[0];
  if (!key) die('claim needs a ticket id or a name:  genlock claim T-XXXXX --path src/search --resource site-build');
  const session = identity();
  if (!session) die('no session identity, so a claim could belong to anyone. Set GENLOCK_SESSION.');
  const paths = (a.path || []).map(normalize);
  const resources = a.resource || [];
  if (!paths.length && !resources.length) die('claim needs at least one --path or --resource');
  for (const p of paths) if (p.startsWith('..')) die(`'${p}' is outside this repository`);

  const k = key.toUpperCase().startsWith('T-') ? key.toUpperCase() : key;
  withLock(() => {
    const hit = collisions({ paths, resources, key: k, session });
    if (hit.length) {
      process.stderr.write(`genlock: claim refused. Someone else is working there.\n\n`);
      for (const x of hit) process.stderr.write(`  - ${describeCollision(x)}\n`);
      process.stderr.write('\n  Do not wait on it and do not work around it. Pick other work, or '
        + 'record the need:\n  genlock note <their ticket> "what you need from them"\n');
      process.exit(4);
    }
    const prior = readClaim(k);
    const merge = (cur, add) => (a.replace ? add : [...new Set([...(cur || []), ...add])]);
    const live = prior && Date.parse(prior.expires) > Date.now() ? prior : null;
    const c = writeClaim({
      key: k, session, paths: merge(live?.paths, paths), resources: merge(live?.resources, resources),
      ttl: a.ttl ? parseInt(a.ttl, 10) : undefined,
    });
    console.log(`${k} holds ${[...c.paths, ...c.resources.map((r) => `resource:${r}`)].join(', ')} until ${c.expires.slice(11, 16)}Z`);
  });
}

export function cmdRelease(a) {
  const key = a._[0];
  if (!key) die('release needs a ticket id or a name');
  const k = key.toUpperCase().startsWith('T-') ? key.toUpperCase() : key;
  const c = readClaim(k);
  if (!c) { console.log(`${k} holds nothing.`); return; }
  const me = identity();
  if (c.session !== me && !a.reason)
    die(`${k} belongs to session ${String(c.session).slice(0, 8)}, not this one. Releasing another `
      + 'session\'s claim needs --reason, and only when that session is gone');
  releaseTicket(k);
  console.log(`${k} released${a.reason ? ` (${a.reason})` : ''}`);
}

export function cmdClaims(a) {
  const cs = liveClaims();
  if (a.json) { console.log(JSON.stringify(cs, null, 2)); return; }
  if (!cs.length) { console.log('nobody holds anything right now.'); return; }
  const me = identity();
  for (const c of cs) {
    console.log(`${c.session === me ? '*' : ' '} ${c.key}  until ${c.expires.slice(11, 16)}Z`
      + `  ${[...c.paths, ...c.resources.map((r) => `resource:${r}`)].join(', ')}`);
  }
}

/** Ask without taking. Exit 4 if any of this is held by someone else. */
export function cmdCheck(a) {
  const paths = (a.path || []).map(normalize);
  const resources = a.resource || [];
  if (!paths.length && !resources.length) die('check needs at least one --path or --resource');
  const hit = collisions({ paths, resources, session: identity() });
  if (!hit.length) { console.log('clear: nobody else holds any of that.'); return; }
  for (const x of hit) console.log(`  - ${describeCollision(x)}`);
  process.exit(4);
}

/* --------------------------------------------------------------------- guard */

/* What wrecks another agent's uncommitted work in a shared tree. A family of near-misses,
   not a security boundary: this is a seatbelt for a cooperating agent. */
const SHARED_TREE_HAZARD = new RegExp(
  '\\bgit\\s+('
  + 'stash(?!\\s+(list|show))'
  + '|clean\\b'
  + '|reset\\s+--hard'
  + '|checkout\\b(?!\\s+-b)'
  + '|switch\\b'
  + '|restore\\b'
  + '|add\\s+(-A|--all|\\.(\\s|$))'
  + '|commit\\s+(.*\\s)?-[a-zA-Z]*a[a-zA-Z]*\\b'
  + ')');

/**
 * Claude Code PreToolUse hook. Exit 2 blocks the tool call and shows stderr to the agent.
 * An internal failure exits 0: a bug in the guard must never stop all work.
 */
export function cmdGuard() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  try {
    const session = input.session_id || identity();
    const tool = input.tool_name;
    const ti = input.tool_input || {};
    const claims = liveClaims();
    const others = claims.filter((c) => c.session !== session);

    if (tool === 'Bash') {
      const here = others.filter((c) => c.root === repoRoot());
      if (here.length && SHARED_TREE_HAZARD.test(ti.command || '')) {
        process.stderr.write(`genlock: blocked. ${here.map((c) => c.key).join(', ')} is working in this same tree, `
          + 'and this git command can destroy or sweep up its uncommitted work. Stage files by '
          + 'path and commit by path instead.\n');
        process.exit(2);
      }
      return;
    }

    const raw = ti.file_path || ti.notebook_path;
    if (!raw) return;
    const file = normalize(raw);
    if (file.startsWith('..') || file.startsWith('.genlock/')) return;

    const held = others.find((c) => c.paths.some((p) => covers(p, file)));
    if (held) {
      process.stderr.write(`genlock: blocked. ${file} is held by ${held.key} (session `
        + `${String(held.session).slice(0, 8)}) until ${held.expires.slice(11, 16)}Z. Do not edit it and do `
        + `not wait for it. Do other work, or record the need: genlock note ${held.key} "what you need"\n`);
      process.exit(2);
    }

    const mine = claims.filter((c) => c.session === session);
    const strict = mine.find((c) => c.strict);
    if (strict && !mine.some((c) => c.paths.some((p) => covers(p, file)))) {
      process.stderr.write(`genlock: blocked. ${file} is outside what this spin-off declared. `
        + `Extend first, which is refused if someone holds it: genlock claim ${strict.key} --path ${file}\n`);
      process.exit(2);
    }
    // Working is the heartbeat: an active session's lease does not lapse under it.
    if (mine.length) withLock(() => { for (const c of mine) writeClaim(c); });
  } catch { /* fail open */ }
}

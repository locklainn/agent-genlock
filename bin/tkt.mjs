#!/usr/bin/env node
/**
 * tkt - a lightweight, agent-driven ticket store.
 *
 * Tickets are written BY agents, FOR agents. A human should never have to open one.
 * The tool exists for one mechanical refusal: `tkt done` will not accept a ticket
 * whose requirements lack recorded evidence. "Done" becomes a thing that is PROVED
 * rather than a thing that is asserted.
 *
 * Zero dependencies. Node 16+. Runs on macOS, Linux and Windows.
 * Storage: $TKT_HOME or ~/.tkt/<scope>/<ID>.json  -- never inside your repository.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';

/* ------------------------------------------------------------------ storage */

const home = () => process.env.TKT_HOME || path.join(os.homedir(), '.tkt');

function gitRoot() {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    return out.trim() || null;
  } catch { return null; }
}

function currentScope() {
  if (process.env.TKT_SCOPE) return process.env.TKT_SCOPE;
  const base = path.basename(gitRoot() || process.cwd());
  return base.replace(/[^A-Za-z0-9._-]/g, '-') || 'default';
}

function scopeDir(scope) {
  const d = path.join(home(), scope);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const configPath = () => (fs.mkdirSync(home(), { recursive: true }), path.join(home(), 'config.json'));

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch { return { prefixes: {} }; }
}

function writeJSON(target, obj) {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

/** A short, stable, human-typable id prefix per scope. */
function prefixFor(scope) {
  const cfg = readConfig();
  cfg.prefixes ||= {};
  if (cfg.prefixes[scope]) return cfg.prefixes[scope];
  const words = scope.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let cand = (words.length >= 2
    ? words.map((w) => w[0]).join('').slice(0, 4)
    : (words[0] || 'tkt').slice(0, 3)).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'TKT';
  const taken = new Set(Object.entries(cfg.prefixes).filter(([k]) => k !== scope).map(([, v]) => v));
  const base = cand;
  for (let n = 2; taken.has(cand); n++) cand = `${base}${n}`;
  cfg.prefixes[scope] = cand;
  writeJSON(configPath(), cfg);
  return cand;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const ticketPath = (scope, id) => path.join(scopeDir(scope), `${id}.json`);

function save(t) {
  t.updated = now();
  writeJSON(ticketPath(t.scope, t.id), t);
}

function allScopes() {
  if (!fs.existsSync(home())) return [];
  return fs.readdirSync(home(), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name).sort();
}

function loadIn(scope, id) {
  try { return JSON.parse(fs.readFileSync(ticketPath(scope, id), 'utf8')); }
  catch { return null; }
}

function ticketsIn(scope) {
  const d = scopeDir(scope);
  return fs.readdirSync(d).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp')).sort()
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

/** Resolve a ticket id. Bare numbers resolve within the current scope first. */
function find(id, scope) {
  id = String(id).trim();
  const scopes = scope ? [scope]
    : [currentScope(), ...allScopes().filter((s) => s !== currentScope())];
  if (/^\d+$/.test(id)) {
    for (const s of scopes) {
      const t = loadIn(s, `${prefixFor(s)}-${id.padStart(4, '0')}`);
      if (t) return t;
    }
    return null;
  }
  for (const s of scopes) { const t = loadIn(s, id.toUpperCase()); if (t) return t; }
  return null;
}

function nextId(scope) {
  const pre = prefixFor(scope);
  let n = 0;
  for (const t of ticketsIn(scope)) {
    const m = new RegExp(`^${pre}-(\\d+)$`).exec(t.id || '');
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return `${pre}-${String(n + 1).padStart(4, '0')}`;
}

/* -------------------------------------------------------------- clarity lint */

/* Words that describe a FEELING about the work rather than an observable state.
   A requirement may use one only if it also names something checkable. */
const VAGUE = [
  'improve', 'improved', 'better', 'best', 'cleaner', 'clean up', 'cleanup',
  'nicer', 'nice', 'properly', 'correctly', 'robust', 'robustly', 'solid',
  'handle', 'handles', 'support', 'supports', 'works', 'working', 'good',
  'fast', 'faster', 'performant', 'simple', 'simpler', 'polish', 'polished',
  'appropriate', 'appropriately', 'as needed', 'as necessary', 'make sense',
  'makes sense', 'sensible', 'reasonable', 'tidy', 'neat', 'streamline',
  'optimize', 'optimise', 'modernize', 'modernise', 'refactor', 'sane',
  'seamless', 'intuitive', 'user-friendly', 'etc', 'and so on', 'various',
  'some', 'stuff', 'things', 'fix up', 'look at', 'review',
];

/* Evidence that a requirement names something a machine or an eye can land on. */
const CONCRETE = [
  /\d/,                                  // any number
  /[\w./-]+\.[A-Za-z0-9]{1,6}\b/,        // a filename with an extension
  /\//,                                  // a path or a URL
  /`[^`]+`/, /"[^"]+"/, /'[^']+'/,       // a quoted literal
  /\b[A-Za-z_]\w*\(\)/,                  // a function call
  /\b(exits?|exit|returns?|equals?|matches|contains|prints?|emits?|refuses?|rejects?|renders?|resolves?|non-zero|zero|true|false|null|empty|present|absent|identical|byte-for-byte)\b/,
];

const CHECK_PREFIXES = ['manual:', 'file:', 'read:', 'eye:'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isConcrete = (text) => CONCRETE.some((p) => p.test(text.toLowerCase()));

/** Return a list of problems. An empty list means the requirement is usable. */
function lintRequirement(text, check) {
  const problems = [];
  text = (text || '').trim();
  check = (check || '').trim();
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length < 4)
    problems.push(`the requirement is ${words.length} words; say what must be TRUE, not what to do`);

  const hits = VAGUE.filter((v) => new RegExp(`\\b${esc(v)}\\b`).test(text.toLowerCase()));
  if (hits.length && !isConcrete(text))
    problems.push(`${hits.slice(0, 3).map((h) => `"${h}"`).join(', ')} describes a feeling, `
      + 'not an observable state, and nothing else here is checkable. Name the number, '
      + 'file, command or output that would settle it');

  if (!check)
    problems.push('no check. Give the command that proves it, or prefix a human check '
      + "with 'manual:' / 'file:' / 'eye:'. A requirement with no check is a wish");
  else if (check.split(/\s+/).length < 2 && !CHECK_PREFIXES.some((p) => check.toLowerCase().startsWith(p)))
    problems.push(`the check '${check}' is not runnable and is not marked manual:`);

  return problems;
}

function lintTitle(title) {
  const problems = [];
  title = (title || '').trim();
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 3) problems.push(`the title is ${words.length} words; name the outcome, not the verb`);
  if (/^(fix|update|change|improve|refactor|cleanup|clean up)\b.{0,12}$/i.test(title))
    problems.push(`'${title}' names an activity, not an outcome`);
  return problems;
}

/* ------------------------------------------------------------------- output */

const tty = process.stdout.isTTY;
const bold = (s) => (tty ? `\u001b[1m${s}\u001b[0m` : s);

function die(msg, code = 1) {
  process.stderr.write(`tkt: ${String(msg).replace(/\s+$/, '')}\n`);
  process.exit(code);
}

const GRILL = {
  observed: 'Observed, or derived? Cite the coordinate and the raw value.',
  cause: 'Is any cause stated here a measurement, or a hypothesis?',
  absence: 'Anything reported missing that my instrument only failed to match?',
  assumption: 'Which assumption here is mine, that nobody chose?',
  falsify: 'What one check, document or number would falsify this?',
};
const GRILL_KEYS = Object.keys(GRILL);

function summariseReqs(t) {
  const rs = t.requirements || [];
  if (!rs.length) return 'none';
  const c = {};
  for (const r of rs) c[r.state] = (c[r.state] || 0) + 1;
  // A waiver is NOT a proof, and the summary must never let the two read alike.
  const parts = [`${c.met || 0} of ${rs.length} proved`];
  if (c.waived) parts.push(`${c.waived} waived`);
  if (c.failed) parts.push(`${c.failed} FAILED`);
  return parts.join(', ');
}

function reqLine(r) {
  const mark = { open: '[ ]', met: '[x]', failed: '[!]', waived: '[~]' }[r.state];
  let s = `  ${mark} ${r.n}. ${r.text}`;
  if (r.check) s += `\n         check: ${r.check}`;
  if (r.evidence) s += `\n         ${r.state === 'waived' ? 'waived' : 'evidence'}: ${r.evidence}`;
  return s;
}

function render(t, withLog = false) {
  const L = [];
  L.push(`${bold(t.id)}  ${t.title}`);
  L.push(`  scope ${t.scope}   status ${t.status}   created ${t.created.slice(0, 10)}`);
  if (t.ask) L.push(`  ask: ${t.ask}`);
  if (t.blocked_reason) L.push(`  BLOCKED: ${t.blocked_reason}`);
  L.push('', `  requirements (${summariseReqs(t)})`);
  for (const r of t.requirements) L.push(reqLine(r));
  if (t.assumptions?.length) {
    L.push('', '  assumptions crossed');
    for (const a of t.assumptions) L.push(`  - ${a.text}`, `      breaks: ${a.breaks || 'not stated'}`);
  }
  const g = t.grill || {};
  if (GRILL_KEYS.some((k) => g[k])) {
    L.push('', '  grill');
    for (const k of GRILL_KEYS) if (g[k]) L.push(`  - ${(k + ':').padEnd(12)}${g[k]}`);
  }
  if (withLog && t.log?.length) {
    L.push('', '  log');
    for (const e of t.log) L.push(`  ${e.at.slice(0, 16).replace('T', ' ')}  ${e.kind.padEnd(8)} ${e.text}`);
  }
  return L.join('\n');
}

const logEvent = (t, kind, text) => (t.log ||= []).push({ at: now(), kind, text });

/* ----------------------------------------------------------------- commands */

function requireTicket(a, cmd) {
  const id = a._[0];
  if (!id) die(`${cmd} needs a ticket id`);
  const t = find(id, a.scope);
  if (!t) die(`no ticket '${id}' (looked in ${allScopes().join(', ') || 'nothing yet'})`);
  return t;
}

function pickReq(t, n) {
  const r = t.requirements.find((x) => x.n === n);
  if (!r) die(`${t.id} has no requirement ${n} (it has ${t.requirements.length})`);
  return r;
}

function pairs(a) {
  const reqs = a.r || [];
  const checks = (a.c || []).slice();
  if (checks.length > reqs.length)
    die(`more checks (${checks.length}) than requirements (${reqs.length})`);
  while (checks.length < reqs.length) checks.push('');
  return reqs.map((text, i) => [text, checks[i]]);
}

function refuse(header, problems, footer) {
  process.stderr.write(`tkt: ${header}\n\n`);
  for (const [where, p] of problems) process.stderr.write(`  ${where.padEnd(18)}${p}\n`);
  if (footer) process.stderr.write(`\n${footer}\n`);
  process.exit(2);
}

function cmdNew(a) {
  const title = a._[0];
  if (!title) die('new needs a title:  tkt new "the thing that will be true" -r ... -c ...');
  const rp = pairs(a);
  const problems = [];
  if (!a.loose) {
    for (const p of lintTitle(title)) problems.push(['title', p]);
    if (!rp.length) problems.push(['requirements',
      'a ticket with no requirements cannot be finished. Write what must be TRUE for '
      + 'this to be done, BEFORE starting -- one -r per requirement, each with a -c check']);
    rp.forEach(([text, check], i) => {
      for (const p of lintRequirement(text, check)) problems.push([`requirement ${i + 1}`, p]);
    });
  }
  if (problems.length) {
    refuse('refusing to open this ticket.', problems,
      '  A requirement is a statement that is either TRUE or FALSE once the work is\n'
      + '  finished, and a check is how you will find out which.\n'
      + '  Rewrite and try again, or --loose to bypass (which forfeits `tkt done`).');
  }

  const scope = a.scope || currentScope();
  const t = {
    id: nextId(scope), scope, title: title.trim(), ask: a.ask || '',
    status: 'open', loose: !!a.loose, created: now(), updated: now(),
    requirements: rp.map(([text, check], i) => ({
      n: i + 1, text: text.trim(), check: check.trim(), state: 'open', evidence: '', at: '',
    })),
    grill: Object.fromEntries(GRILL_KEYS.map((k) => [k, ''])),
    assumptions: [], log: [], blocked_reason: null,
  };
  logEvent(t, 'open', t.title);
  save(t);
  console.log(a.quiet ? t.id : render(t));
}

function cmdReq(a) {
  const t = requireTicket(a, 'req');
  const rp = pairs(a);
  if (!rp.length) die('req needs -r "what must be true" -c "how it is checked"');
  const problems = [];
  if (!t.loose) rp.forEach(([text, check], i) => {
    for (const p of lintRequirement(text, check)) problems.push([`new requirement ${i + 1}`, p]);
  });
  if (problems.length) refuse('refusing to add that requirement.', problems);
  let n = Math.max(0, ...t.requirements.map((r) => r.n));
  for (const [text, check] of rp) {
    t.requirements.push({ n: ++n, text: text.trim(), check: check.trim(), state: 'open', evidence: '', at: '' });
    logEvent(t, 'req', `${n}. ${text.trim()}`);
  }
  save(t);
  console.log(render(t));
}

function mark(a, state, field, verb) {
  const t = requireTicket(a, state);
  const num = a._[1];
  if (!/^\d+$/.test(String(num || '')))
    die(`${state} needs a requirement number:  tkt ${state} ${t.id} 2 --${field} "..."`);
  const r = pickReq(t, parseInt(num, 10));
  const ev = a[field];
  if (!ev || !String(ev).trim())
    die(`${state} requires --${field}: what did you OBSERVE that settles requirement ${r.n}?\n`
      + `     the check on it is: ${r.check || '(none recorded)'}`);
  r.state = state; r.evidence = String(ev).trim(); r.at = now();
  if (t.status === 'open') t.status = 'in_progress';
  logEvent(t, state, `${r.n}. ${verb} -- ${r.evidence}`);
  save(t);
  console.log(reqLine(r));
  console.log(`\n  ${t.id}: ${summariseReqs(t)}`);
}

function cmdStart(a) {
  const t = requireTicket(a, 'start');
  t.status = 'in_progress'; t.blocked_reason = null;
  logEvent(t, 'status', 'in_progress');
  save(t);
  console.log(`${t.id} in_progress -- ${summariseReqs(t)}`);
}

function withReason(a, cmd, status, kind, label) {
  const t = requireTicket(a, cmd);
  const why = a._.slice(1).join(' ').trim();
  if (!why) die(`${cmd} needs a reason:  tkt ${cmd} ${t.id} "..."`);
  if (status) t.status = status;
  if (status === 'blocked') t.blocked_reason = why;
  logEvent(t, kind, why);
  save(t);
  console.log(`${t.id} ${label} -- ${why}`);
}

function cmdAssume(a) {
  const t = requireTicket(a, 'assume');
  const text = a._.slice(1).join(' ').trim();
  if (!text) die(`assume needs the assumption:  tkt assume ${t.id} "..." --breaks "..."`);
  if (!a.breaks) die('assume requires --breaks: what goes wrong if the assumption is false?\n'
    + '     an assumption with no stated consequence cannot be weighed');
  (t.assumptions ||= []).push({ text, breaks: String(a.breaks).trim(), at: now() });
  logEvent(t, 'assume', `${text} -- breaks: ${a.breaks}`);
  save(t);
  console.log(`[ASSUMING] ${t.id} · ${text}`);
  console.log(`           wrong -> ${a.breaks}`);
}

function cmdGrill(a) {
  const t = requireTicket(a, 'grill');
  const g = (t.grill ||= Object.fromEntries(GRILL_KEYS.map((k) => [k, ''])));
  let given = false;
  for (const k of GRILL_KEYS) if (a[k]) { g[k] = String(a[k]).trim(); given = true; }
  if (!given) {
    console.log('  The five questions. Answer each with --<field> "..."\n');
    for (const k of GRILL_KEYS)
      console.log(`  --${k.padEnd(12)} ${(g[k] ? 'answered' : 'OPEN').padEnd(9)}${GRILL[k]}`);
    return;
  }
  g.at = now();
  logEvent(t, 'grill', GRILL_KEYS.filter((k) => g[k]).join(', '));
  save(t);
  const missing = GRILL_KEYS.filter((k) => !g[k]);
  console.log(`${t.id} grilled: ${5 - missing.length} of 5 answered.`);
  if (missing.length) console.log(`  still open: ${missing.join(', ')}`);
}

/** The one refusal this whole tool exists for. */
function cmdDone(a) {
  const t = requireTicket(a, 'done');
  const blockers = [];

  if (t.loose) blockers.push('this ticket was opened with --loose, so its requirements '
    + 'were never linted. It cannot be closed as done; reopen it properly');
  if (!t.requirements.length) blockers.push("no requirements. There is nothing here that 'done' could mean");

  for (const r of t.requirements.filter((r) => r.state === 'open'))
    blockers.push(`requirement ${r.n} is unproved: ${r.text}\n      its check: ${r.check || '(none)'}`
      + `\n      -> tkt met ${t.id} ${r.n} --evidence "what you observed"`);
  for (const r of t.requirements.filter((r) => r.state === 'failed'))
    blockers.push(`requirement ${r.n} FAILED and was never resolved: ${r.text}\n      ${r.evidence}`);

  const g = t.grill || {};
  const openG = GRILL_KEYS.filter((k) => !g[k]);
  if (openG.length && !a.skip_grill)
    blockers.push(`the grill is unanswered: ${openG.join(', ')}\n      -> tkt grill ${t.id}  (to see the questions)`);

  if (blockers.length) {
    process.stderr.write(`tkt: ${t.id} is NOT done.\n\n`);
    for (const b of blockers) process.stderr.write(`  - ${b}\n`);
    process.stderr.write('\n  Nothing may be reported complete while any of the above is true.\n');
    process.exit(3);
  }

  t.status = 'done'; t.closed = now();
  logEvent(t, 'done', summariseReqs(t));
  save(t);

  // Status reporting comes FROM the ticket, so the ticket writes the line.
  console.log(`[TASK-COMPLETE] ${t.id} · ${t.title}`);
  for (const r of t.requirements) {
    const tag = r.state === 'waived' ? 'waived' : 'proved';
    const how = r.state === 'waived' ? 'why' : 'by';
    console.log(`  ✓ ${r.text} — ${tag} (${how}: ${r.evidence})`);
  }
  if (g.falsify) {
    const tried = (g.observed || g.cause || '').trim();
    if (tried) console.log(`[GRILLED] ${tried}`);
    console.log(`          still unbroken: ${g.falsify}`);
  }
  for (const as of t.assumptions || [])
    console.log(`[ASSUMING] ${as.text} — wrong -> ${as.breaks || '?'}`);
}

function cmdShow(a) {
  const t = requireTicket(a, 'show');
  console.log(a.json ? JSON.stringify(t, null, 2) : render(t, true));
}

/** One line, for a [STATUS-UPDATE]. Status updates come FROM tickets. */
function cmdStatus(a) {
  const t = requireTicket(a, 'status');
  console.log(`[STATUS-UPDATE] ${t.id} · ${t.title} — ${t.status}, ${summariseReqs(t)}`);
}

function cmdList(a) {
  const scopes = a.all ? allScopes() : [a.scope || currentScope()];
  let want = null;
  if (a.open) want = new Set(['open', 'in_progress', 'blocked']);
  else if (a.status) want = new Set([String(a.status)]);
  const rows = [];
  for (const s of scopes) for (const t of ticketsIn(s))
    if (!want || want.has(t.status)) rows.push(t);
  if (!rows.length) {
    console.log(`no tickets${a.all ? '' : ` in scope '${a.scope || currentScope()}'`}.`);
    return;
  }
  rows.sort((x, y) => (x.scope + x.id).localeCompare(y.scope + y.id));
  const w = Math.max(...rows.map((t) => t.id.length));
  for (const t of rows) {
    const flag = { open: ' ', in_progress: '>', blocked: '!', done: '✓', abandoned: 'x' }[t.status] || '?';
    let line = `${flag} ${t.id.padEnd(w)}  ${t.status.padEnd(13)}${summariseReqs(t).padEnd(30)}${t.title}`;
    if (a.all) line += `   [${t.scope}]`;
    console.log(line);
  }
}

/** Lint candidate requirements without opening anything. */
function cmdLint(a) {
  const rp = pairs(a);
  if (!rp.length) {
    if (!a._.length) die('lint needs -r "..." -c "..." or a ticket id');
    const t = requireTicket(a, 'lint');
    let bad = 0;
    for (const r of t.requirements) {
      const ps = lintRequirement(r.text, r.check);
      if (!ps.length) continue;
      bad++;
      console.log(`  requirement ${r.n}: ${r.text}`);
      for (const p of ps) console.log(`      ${p}`);
    }
    console.log(`${t.id}: ${bad} of ${t.requirements.length} requirements are unclear.`);
    process.exit(bad ? 1 : 0);
  }
  let bad = 0;
  rp.forEach(([text, check], i) => {
    const ps = lintRequirement(text, check);
    if (!ps.length) { console.log(`  ${i + 1}. ok`); return; }
    bad++;
    console.log(`  ${i + 1}. ${text}`);
    for (const p of ps) console.log(`      ${p}`);
  });
  process.exit(bad ? 1 : 0);
}

function cmdScopes() {
  const ss = allScopes();
  if (!ss.length) return console.log('no scopes yet. `tkt new` in a repo creates one.');
  for (const s of ss) {
    const ts = ticketsIn(s);
    const open = ts.filter((t) => ['open', 'in_progress', 'blocked'].includes(t.status)).length;
    console.log(`${s.padEnd(28)}${prefixFor(s).padEnd(7)}${String(ts.length).padStart(3)} tickets, `
      + `${open} open${s === currentScope() ? '   <- here' : ''}`);
  }
}

/** Wire the protocol into this repo's agent instructions. Delegates to install.mjs. */
function cmdInstall() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, '..', 'install.mjs');
  if (!fs.existsSync(script))
    die(`the installer is not beside this copy of tkt (looked for ${script}).\n`
      + '     A single-file install has no protocol to write; get the package with\n'
      + '     `npx @locklainn/tkt install` or clone the repository.');
  const r = spawnSync(process.execPath, [script, ...rawArgs.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function cmdWhere() {
  console.log(home());
  console.log(`scope: ${currentScope()}   prefix: ${prefixFor(currentScope())}`);
}

/* -------------------------------------------------------------------- shell */

const USAGE = `tkt ${VERSION} -- agent-driven tickets. Requirements first; done is proved, not asserted.

  tkt new "TITLE" -r "REQ" -c "CHECK" [-r .. -c ..]   open one (refuses vague requirements)
  tkt list [--open] [--all] [--status S]              what is on the board
  tkt show ID [--json] | tkt status ID                read one | one line for a status update
  tkt start ID                                        mark in progress
  tkt req ID -r "REQ" -c "CHECK"                      add a requirement mid-flight
  tkt met ID N --evidence "WHAT YOU OBSERVED"         prove one
  tkt fail ID N --evidence ".." | tkt waive ID N --reason ".."
  tkt assume ID "WHAT" --breaks "WHAT IF WRONG"       record a fork you crossed
  tkt grill ID [--observed .. --cause .. --absence .. --assumption .. --falsify ..]
  tkt done ID                                         REFUSES unless every req is proved
  tkt block ID "WHY" | tkt abandon ID "WHY" | tkt note ID "WHAT"
  tkt lint -r ".." -c ".." | tkt lint ID              is this requirement checkable?
  tkt scopes | tkt where                               boards by repo | where state lives
  tkt install [--full|--global|--skill|--check]        write the protocol into this repo's agent file

Ids may be bare numbers (\`tkt done 7\`) inside their own repo.
Tickets live in $TKT_HOME or ~/.tkt, never in your repository.`;

const COMMANDS = {
  new: cmdNew, add: cmdNew,
  list: cmdList, ls: cmdList,
  show: cmdShow, cat: cmdShow,
  status: cmdStatus,
  start: cmdStart,
  req: cmdReq, reqs: cmdReq,
  met: (a) => mark(a, 'met', 'evidence', 'met'),
  pass: (a) => mark(a, 'met', 'evidence', 'met'),
  fail: (a) => mark(a, 'failed', 'evidence', 'FAILED'),
  waive: (a) => mark(a, 'waived', 'reason', 'waived'),
  assume: cmdAssume,
  grill: cmdGrill,
  done: cmdDone, close: cmdDone,
  block: (a) => withReason(a, 'block', 'blocked', 'blocked', 'BLOCKED'),
  abandon: (a) => withReason(a, 'abandon', 'abandoned', 'abandoned', 'abandoned'),
  note: (a) => withReason(a, 'note', null, 'note', 'noted'),
  lint: cmdLint,
  scopes: cmdScopes,
  where: cmdWhere,
  install: cmdInstall, init: cmdInstall,
};

const MULTI = new Set(['r', 'c']);
const FLAGS = new Set(['open', 'all', 'json', 'quiet', 'loose', 'skip-grill']);

function parse(argv) {
  const a = { _: [], r: [], c: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      let name = tok.slice(2); let val = null;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      const key = name.replace(/-/g, '_');
      if (FLAGS.has(name) && val === null) { a[key] = true; continue; }
      if (val === null) { val = argv[++i]; if (val === undefined) die(`--${name} needs a value`); }
      if (MULTI.has(name)) a[name].push(val); else a[key] = val;
    } else if (/^-[A-Za-z]/.test(tok)) {
      const name = tok.slice(1);
      if (!MULTI.has(name)) die(`unknown flag -${name}`);
      const val = argv[++i];
      if (val === undefined) die(`-${name} needs a value`);
      a[name].push(val);
    } else a._.push(tok);
  }
  return a;
}

const rawArgs = process.argv.slice(2);
const argv = rawArgs;
if (!argv.length || ['-h', '--help', 'help'].includes(argv[0])) { console.log(USAGE); process.exit(0); }
if (['-V', '--version', 'version'].includes(argv[0])) { console.log(VERSION); process.exit(0); }
const fn = COMMANDS[argv[0]];
if (!fn) die(`unknown command '${argv[0]}'. \`tkt help\` lists them.`);
// `install` forwards its arguments to the installer verbatim; its flags are not tkt's.
if (fn === cmdInstall) cmdInstall();
else fn(parse(argv.slice(1)));

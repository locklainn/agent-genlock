#!/usr/bin/env node
/* Every test here asserts a REFUSAL or a recorded fact. The tool's whole value is
   that it says no, so a suite that only checked the happy path would have no power
   to fail. Run: node tests/run.mjs */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TKT = path.join(HERE, '..', 'bin', 'tkt.mjs');
// The store and the working directory must be genuinely separate paths, or the
// "nothing is written into your repository" assertion below has no power to fail.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tkt-test-'));
const HOME = path.join(ROOT, 'store');
const CWD = path.join(ROOT, 'myproject');
fs.mkdirSync(HOME);
fs.mkdirSync(CWD);

let pass = 0; const fails = [];

function tkt(...args) {
  const r = spawnSync(process.execPath, [TKT, ...args], {
    cwd: CWD, encoding: 'utf8',
    env: { ...process.env, TKT_HOME: HOME, TKT_SCOPE: 'myproject' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}

function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${detail ? `\n      ${String(detail).split('\n')[0]}` : ''}`);
}

/* ---- the lint refuses what cannot be proved --------------------------------- */

let r = tkt('new', 'Fix search', '-r', 'make search better', '-c', '');
check('a vague requirement is refused', r.code === 2, r.all);
check('...and says which word is the problem', /"better" describes a feeling/.test(r.err), r.err);
check('...and says a check is missing', /A requirement with no check is a wish/.test(r.err), r.err);
check('...and names the title as an activity', /names an activity, not an outcome/.test(r.err), r.err);

r = tkt('new', 'The index rebuilds from an empty corpus');
check('a ticket with no requirements is refused', r.code === 2, r.all);
check('...for the stated reason', /cannot be finished/.test(r.err), r.err);

r = tkt('new', 'The index rebuilds from an empty corpus',
  '-r', 'the parser handles bad input', '-c', 'npm test');
check('"handle" with no observable is refused', r.code === 2, r.all);

r = tkt('new', 'The index rebuilds from an empty corpus',
  '-r', 'the parser handles bad input by returning null', '-c', 'npm test');
check('"handle" WITH an observable is allowed', r.code === 0, r.all);

r = tkt('lint', '-r', 'the results panel does not scroll sideways at 400px', '-c', 'eye: devtools');
check('a manual check is accepted when marked', r.code === 0, r.all);
r = tkt('lint', '-r', 'the results panel does not scroll sideways at 400px', '-c', 'devtools');
check('an unmarked one-word check is refused', r.code === 1, r.all);

/* ---- the done gate ---------------------------------------------------------- */

r = tkt('new', 'Search returns matches for stemmed words', '--ask', 'make search work for plurals',
  '-r', 'searching "budgets" returns the 12 documents containing "budget"', '-c', 'node t/search.mjs',
  '-r', 'the rebuild exits zero on an empty corpus', '-c', 'node build.mjs; echo $?');
check('a clear ticket opens', r.code === 0, r.all);
const ID = (/\b([A-Z]+-\d{4})\b/.exec(r.out) || [])[1];
check('...and gets an id', !!ID, r.out);
check('...and records the ask verbatim', /make search work for plurals/.test(r.out), r.out);

r = tkt('done', ID);
check('done with nothing proved is refused', r.code === 3, r.all);
check('...and names every unproved requirement', (r.err.match(/is unproved/g) || []).length === 2, r.err);
check('...and tells you the exact command to fix it', /tkt met .* --evidence/.test(r.err), r.err);

r = tkt('met', ID, '1');
check('met with no evidence is refused', r.code === 1, r.all);
check('...and reminds you of the check', /node t\/search\.mjs/.test(r.err), r.err);

r = tkt('met', ID, '9', '--evidence', 'x');
check('a requirement number that does not exist is refused', r.code === 1, r.all);

tkt('met', ID, '1', '--evidence', 'node t/search.mjs -> 12 hits');
tkt('met', ID, '2', '--evidence', 'node build.mjs; echo $? -> 0');
r = tkt('done', ID);
check('all requirements proved but no grill is still refused', r.code === 3, r.all);
check('...and names the open grill fields', /grill is unanswered.*observed/.test(r.err), r.err);

r = tkt('grill', ID);
check('grill with no arguments prints the five questions', (r.out.match(/OPEN/g) || []).length === 5, r.out);

tkt('grill', ID, '--observed', 'counted off the corpus by the test, not read off the UI',
  '--cause', 'no cause claimed', '--absence', 'nothing reported missing',
  '--assumption', 'porter stemming; I took the library default',
  '--falsify', 'a run against the full 1,422-document corpus');
r = tkt('done', ID);
check('done is accepted once everything is proved and grilled', r.code === 0, r.all);
check('...and prints the [TASK-COMPLETE] line itself', /^\[TASK-COMPLETE\]/m.test(r.out), r.out);
check('...naming the ticket', r.out.includes(ID), r.out);
check('...with each requirement and its evidence', /12 hits/.test(r.out) && /echo \$\? -> 0/.test(r.out), r.out);
check('...and the [GRILLED] residue', /^\[GRILLED\]/m.test(r.out) && /still unbroken/.test(r.out), r.out);

/* ---- a waiver is not a proof ------------------------------------------------ */

r = tkt('new', 'The results panel fits a phone',
  '-r', 'no horizontal scroll at a 400px viewport', '-c', 'eye: devtools at 400px');
const ID2 = (/\b([A-Z]+-\d{4})\b/.exec(r.out) || [])[1];
r = tkt('waive', ID2, '1');
check('a waiver without a reason is refused', r.code === 1, r.all);
tkt('waive', ID2, '1', '--reason', 'no 400px viewport on this machine');
r = tkt('list');
check('a waiver is reported separately from a proof', /0 of 1 proved, 1 waived/.test(r.out), r.out);
check('...and never as "1 of 1 proved"', !/1 of 1 proved(?!,)/.test(r.out), r.out);

/* ---- assumptions ------------------------------------------------------------ */

r = tkt('assume', ID2, 'fiscal years, not calendar');
check('an assumption with no consequence is refused', r.code === 1, r.all);
r = tkt('assume', ID2, 'fiscal years, not calendar', '--breaks', 'every figure shifts a year');
check('...and accepted with one', r.code === 0, r.all);
check('...printing the [ASSUMING] label', /^\[ASSUMING\]/m.test(r.out), r.out);

/* ---- a --loose ticket can never be closed as done -------------------------- */

r = tkt('new', 'Whatever', '--loose', '-r', 'better', '-c', '');
const ID3 = (/\b([A-Z]+-\d{4})\b/.exec(r.out) || [])[1];
check('--loose bypasses the lint', r.code === 0, r.all);
r = tkt('done', ID3);
check('...but forfeits done, as advertised', r.code === 3 && /--loose/.test(r.err), r.all);

/* ---- housekeeping ----------------------------------------------------------- */

r = tkt('status', ID2);
check('status emits a [STATUS-UPDATE] line', /^\[STATUS-UPDATE\]/.test(r.out), r.out);
r = tkt('block', ID2);
check('block without a reason is refused', r.code === 1, r.all);
r = tkt('show', ID, '--json');
check('show --json is parseable', (() => { try { return JSON.parse(r.out).id === ID; } catch { return false; } })(), r.out);
r = tkt('done', 'ZZZ-9999');
check('an unknown ticket is refused, not invented', r.code === 1 && /no ticket/.test(r.err), r.all);
r = tkt('frobnicate');
check('an unknown command is refused', r.code === 1, r.all);

check('nothing was written into the working directory',
  fs.readdirSync(CWD).length === 0, fs.readdirSync(CWD).join(', '));
check('tickets live under TKT_HOME',
  fs.existsSync(path.join(HOME, 'myproject', `${ID}.json`)));

/* ---- report ----------------------------------------------------------------- */

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`${pass} passed, ${fails.length} failed, ${pass + fails.length} total`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);

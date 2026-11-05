#!/usr/bin/env node
/* Almost every test here asserts a REFUSAL or a recorded fact, because the tool's value is
   that it says no. The merge and race tests use real git merges and real parallel
   processes, since those are the claims a mock could not falsify. Run: node tests/run.mjs */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'genlock.mjs');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-test-')));
const CWD = path.join(ROOT, 'repo');
fs.mkdirSync(CWD);

let pass = 0; const fails = [];

const baseEnv = { ...process.env, GENLOCK_TERMINAL: 'print', HOME: ROOT, USERPROFILE: ROOT };
delete baseEnv.CLAUDE_CODE_SESSION_ID;

function run(cwd, session, args, input) {
  const env = { ...baseEnv };
  if (session) env.GENLOCK_SESSION = session; else delete env.GENLOCK_SESSION;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env, input });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}
const g = (...args) => run(CWD, 'parent', args);
const as = (session, ...args) => run(CWD, session, args);

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${detail ? `\n      ${String(detail).split('\n').slice(0, 3).join(' | ')}` : ''}`);
}

const idOf = (r) => (/\b(T-[0-9A-Z]{5})\b/.exec(r.out) || [])[1];
const goalOf = (r) => (/\b(G-[0-9A-Z]{5})\b/.exec(r.out) || [])[1];
const qOf = (r) => (/\b(Q-[0-9A-Z]{5})\b/.exec(r.out) || [])[1];

git(CWD, 'init', '-q', '-b', 'main');
git(CWD, 'config', 'user.email', 't@example.com');
git(CWD, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(CWD, 'README'), 'x\n');
git(CWD, 'add', '.');
git(CWD, 'commit', '-qm', 'init');

const grill = (id) => g('grill', id, '--observed', 'counted', '--cause', 'none claimed', '--absence', 'none',
  '--assumption', 'library default', '--falsify', 'a full run');

/* ---- the lint refuses what cannot be proved --------------------------------- */

let r = g('new', 'Fix search', '-r', 'make search better', '-c', '');
check('a vague requirement is refused', r.code === 2, r.all);
check('...and says which word is the problem', /"better" describes a feeling/.test(r.err), r.err);
check('...and says a check is missing', /A requirement with no check is a wish/.test(r.err), r.err);
check('...and names the title as an activity', /names an activity, not an outcome/.test(r.err), r.err);

r = g('new', 'The index rebuilds from an empty corpus');
check('a ticket with no requirements is refused', r.code === 2 && /cannot be finished/.test(r.err), r.all);

r = g('new', 'The index rebuilds from an empty corpus', '-r', 'the parser handles bad input', '-c', 'npm test');
check('"handle" with no observable is refused', r.code === 2, r.all);
r = g('new', 'The index rebuilds from an empty corpus', '-r', 'the parser handles bad input by returning null', '-c', 'npm test');
check('"handle" WITH an observable is allowed', r.code === 0, r.all);

r = g('lint', '-r', 'the results panel does not scroll sideways at 400px', '-c', 'eye: devtools');
check('a manual check is accepted when marked', r.code === 0, r.all);
r = g('lint', '-r', 'the results panel does not scroll sideways at 400px', '-c', 'devtools');
check('an unmarked one-word check is refused', r.code === 1, r.all);

/* ---- the done gate ---------------------------------------------------------- */

r = g('new', 'Search returns matches for stemmed words', '--ask', 'make search work for plurals',
  '-r', 'searching "budgets" returns the 12 documents containing "budget"', '-c', 'node t/search.mjs',
  '-r', 'the rebuild exits zero on an empty corpus', '-c', 'node build.mjs; echo $?');
const ID = idOf(r);
check('a clear ticket opens with an id', r.code === 0 && !!ID, r.all);
check('...and records the ask verbatim', /make search work for plurals/.test(r.out), r.out);

r = g('done', ID);
check('done with nothing proved is refused', r.code === 3, r.all);
check('...and names every unproved requirement', (r.err.match(/is unproved/g) || []).length === 2, r.err);
check('...and gives the exact command to fix it', /genlock met .* --evidence/.test(r.err), r.err);

r = g('met', ID, '1');
check('met with no evidence is refused', r.code === 1 && /node t\/search\.mjs/.test(r.err), r.all);
r = g('met', ID, '9', '--evidence', 'x');
check('a requirement number that does not exist is refused', r.code === 1, r.all);

g('met', ID, '1', '--evidence', 'node t/search.mjs -> 12 hits');
g('met', ID, '2', '--evidence', 'node build.mjs; echo $? -> 0');
r = g('done', ID);
check('all proved but no grill is still refused', r.code === 3 && /grill is unanswered.*observed/.test(r.err), r.all);
r = g('grill', ID);
check('grill with no arguments prints the five questions', (r.out.match(/OPEN/g) || []).length === 5, r.out);
grill(ID);
r = g('done', ID);
check('done is accepted once proved and grilled', r.code === 0, r.all);
check('...and prints [TASK-COMPLETE] with the evidence', /^\[TASK-COMPLETE\]/m.test(r.out) && /12 hits/.test(r.out), r.out);
check('...and [GRILLED]', /^\[GRILLED\]/m.test(r.out) && /still unbroken/.test(r.out), r.out);

r = g('req', ID, '-r', 'the rebuild exits zero when a file is locked', '-c', 'node build.mjs --locked');
check('a new requirement reopens a closed ticket', /status in_progress/.test(r.out), r.out);

/* ---- waivers, assumptions, loose ------------------------------------------- */

r = g('new', 'The results panel fits a phone', '-r', 'no horizontal scroll at a 400px viewport', '-c', 'eye: devtools at 400px');
const ID2 = idOf(r);
r = g('waive', ID2, '1');
check('a waiver without a reason is refused', r.code === 1, r.all);
g('waive', ID2, '1', '--reason', 'no 400px viewport on this machine');
r = g('list');
check('a waiver is reported separately from a proof', /0 of 1 proved, 1 waived/.test(r.out), r.out);

r = g('assume', ID2, 'fiscal years, not calendar');
check('an assumption with no consequence is refused', r.code === 1, r.all);
r = g('assume', ID2, 'fiscal years, not calendar', '--breaks', 'every figure shifts a year');
check('...and accepted with one, printing [ASSUMING]', r.code === 0 && /^\[ASSUMING\]/m.test(r.out), r.all);

r = g('new', 'Whatever', '--loose', '-r', 'better', '-c', '');
const ID3 = idOf(r);
r = g('done', ID3);
check('--loose forfeits done', r.code === 3 && /--loose/.test(r.err), r.all);

r = g('status', ID2);
check('status emits [STATUS-UPDATE]', /^\[STATUS-UPDATE\]/.test(r.out), r.out);
r = g('block', ID2);
check('block without a reason is refused', r.code === 1, r.all);
r = g('show', ID, '--json');
check('show --json is parseable', (() => { try { return JSON.parse(r.out).id === ID; } catch { return false; } })(), r.out);
r = g('done', 'T-ZZZZZ');
check('an unknown ticket is refused, not invented', r.code === 1 && /no ticket/.test(r.err), r.all);
r = g('frobnicate');
check('an unknown command is refused', r.code === 1, r.all);
check('records live in the repository', fs.existsSync(path.join(CWD, '.genlock', 'records', `${ID}.jsonl`)));
g('abandon', ID2, 'test over'); g('abandon', ID3, 'test over'); grill(ID);
g('met', ID, '3', '--evidence', 'locked build -> 0'); g('done', ID);

/* ---- merges: two branches, the same ticket, no conflict ---------------------- */

git(CWD, 'add', '.');
git(CWD, 'commit', '-qm', 'records');

r = g('new', 'Two branches both write to one ticket', '-r', 'a merge keeps events from both branches', '-c', 'git merge a b');
const MT = idOf(r);
git(CWD, 'add', '.'); git(CWD, 'commit', '-qm', 'open');
git(CWD, 'switch', '-qc', 'side');
g('note', MT, 'from side');
g('req', MT, '-r', 'the side branch requirement exits zero', '-c', 'node side.mjs');
const sideNew = idOf(g('new', 'A ticket born on the side branch', '-r', 'the side ticket exits zero', '-c', 'node s.mjs'));
git(CWD, 'add', '.'); git(CWD, 'commit', '-qm', 'side');
git(CWD, 'switch', '-q', 'main');
g('note', MT, 'from main');
g('met', MT, '1', '--evidence', 'merged');
const mainNew = idOf(g('new', 'A ticket born on the main branch', '-r', 'the main ticket exits zero', '-c', 'node m.mjs'));
git(CWD, 'add', '.'); git(CWD, 'commit', '-qm', 'main');

r = (() => { const m = git(CWD, 'merge', '--no-edit', 'side'); return { code: m.code, out: m.out }; })();
check('a real git merge of one ticket from two branches does not conflict', r.code === 0, r.out);
const merged = JSON.parse(g('show', MT, '--json').out);
const notes = merged.log.filter((e) => e.kind === 'note').map((e) => e.text);
check('...and keeps both sides\' events', notes.includes('from side') && notes.includes('from main'), notes);
check('...and a proof still lands on the requirement it was for',
  merged.requirements[0].state === 'met' && merged.requirements[1].state === 'open', JSON.stringify(merged.requirements));
check('...and both new tickets survive with distinct ids',
  sideNew !== mainNew && !!g('show', sideNew, '--json').out && !!g('show', mainNew, '--json').out);

git(CWD, 'switch', '-qc', 'r1'); g('note', MT, 'r1 note'); git(CWD, 'add', '.'); git(CWD, 'commit', '-qm', 'r1');
git(CWD, 'switch', '-q', 'main'); g('note', MT, 'main note'); git(CWD, 'add', '.'); git(CWD, 'commit', '-qm', 'm');
git(CWD, 'switch', '-q', 'r1');
r = git(CWD, 'rebase', 'main');
check('a real rebase across the same ticket does not conflict', r.code === 0, r.out);
git(CWD, 'switch', '-q', 'main'); git(CWD, 'merge', '-q', '--ff-only', 'r1');

const recFile = path.join(CWD, '.genlock', 'records', `${MT}.jsonl`);
const countBefore = JSON.parse(g('show', MT, '--json').out).log.length;
const original = fs.readFileSync(recFile, 'utf8');
fs.writeFileSync(recFile, `<<<<<<< HEAD\n${original}=======\n${original.split('\n')[0]}\n>>>>>>> side\n`);
r = g('show', MT, '--json');
check('conflict markers and duplicate lines lose nothing and double nothing',
  JSON.parse(r.out).log.length === countBefore, r.all);
fs.writeFileSync(recFile, `${original}not json at all\n`);
r = g('doctor');
check('a genuinely damaged record line is reported, not silently dropped', /unreadable record line/.test(r.out), r.out);
fs.writeFileSync(recFile, original);

/* ---- worktrees share a board before anything merges -------------------------- */

const WT = path.join(ROOT, 'wt');
git(CWD, 'worktree', 'add', '-q', '-b', 'wt-branch', WT);
const wtTicket = idOf(run(WT, 'other', ['new', 'A ticket written in a worktree', '-r', 'the worktree ticket exits zero', '-c', 'node w.mjs']));
r = g('show', wtTicket);
check('a ticket written in another worktree is visible here, uncommitted', r.code === 0, r.all);
run(WT, 'other', ['claim', wtTicket, '--path', 'wt/only']);
r = g('claim', 'mine', '--path', 'wt/only/file.js');
check('a claim in another worktree still collides here', r.code === 4, r.all);
run(WT, 'other', ['release', wtTicket]);
git(CWD, 'worktree', 'remove', '--force', WT);

/* ---- claims ------------------------------------------------------------------ */

r = run(CWD, null, ['claim', 'x', '--path', 'a']);
check('a claim with no session identity is refused', r.code === 1 && /identity/.test(r.err), r.all);
r = g('claim', 'x');
check('a claim of nothing is refused', r.code === 1, r.all);
r = g('claim', 'x', '--path', '../outside');
check('a claim outside the repository is refused', r.code === 1, r.all);

g('claim', 'alpha', '--path', 'src/search', '--resource', 'site-build');
r = as('other', 'claim', 'beta', '--path', 'src/search/index.js');
check('a path inside a held directory is refused', r.code === 4 && /alpha/.test(r.err), r.all);
r = as('other', 'claim', 'beta', '--resource', 'site-build');
check('a held resource is refused', r.code === 4, r.all);
r = as('other', 'claim', 'beta', '--path', 'src/*.js');
check('an overlapping glob is refused', r.code === 4, r.all);
r = as('other', 'claim', 'beta', '--path', 'docs');
check('a separate path is granted', r.code === 0, r.all);
r = as('other', 'check', '--path', 'src/search');
check('check reports a collision without taking', r.code === 4, r.all);

r = as('other', 'release', 'alpha');
check('releasing another session\'s claim without a reason is refused', r.code === 1, r.all);

const claimPath = path.join(CWD, '.git', 'genlock', 'claims', 'alpha.json');
const held = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
fs.writeFileSync(claimPath, JSON.stringify({ ...held, expires: new Date(Date.now() - 1000).toISOString() }));
r = as('other', 'claim', 'gamma', '--path', 'src/search');
check('an expired claim blocks nobody, so a dead agent cannot hold work', r.code === 0, r.all);
fs.writeFileSync(claimPath, JSON.stringify(held));
as('other', 'release', 'gamma');

const race = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((res) => {
  const p = spawn(process.execPath, [CLI, 'claim', `racer${i}`, '--path', 'contested'], {
    cwd: CWD, env: { ...baseEnv, GENLOCK_SESSION: `racer${i}` }, stdio: 'ignore',
  });
  p.on('close', res);
})));
check('8 parallel claims on one path: exactly one wins', race.filter((c) => c === 0).length === 1, race.join(','));
for (let i = 0; i < 8; i++) run(CWD, `racer${i}`, ['release', `racer${i}`]);

/* ---- the guard ---------------------------------------------------------------- */

const guard = (session, tool, input) => run(CWD, null, ['guard'], JSON.stringify({
  session_id: session, tool_name: tool, tool_input: input,
}));

r = guard('other', 'Edit', { file_path: path.join(CWD, 'src/search/a.js') });
check('the guard blocks an edit to another session\'s file', r.code === 2 && /alpha/.test(r.err), r.all);
r = guard('parent', 'Edit', { file_path: path.join(CWD, 'src/search/a.js') });
check('...and allows the holder', r.code === 0, r.all);
r = guard('other', 'Write', { file_path: path.join(CWD, 'free/a.js') });
check('...and allows an unclaimed file', r.code === 0, r.all);
r = guard('other', 'Edit', { file_path: path.join(CWD, '.genlock/records/x.jsonl') });
check('...and never blocks its own records', r.code === 0, r.all);
r = guard('other', 'Bash', { command: 'git stash' });
check('...and blocks git stash while another session works in this tree', r.code === 2, r.all);
for (const c of ['git checkout -- x', 'git add -A', 'git clean -fd', 'git reset --hard', 'git commit -am x', 'git switch main']) {
  r = guard('other', 'Bash', { command: c });
  check(`...and blocks: ${c}`, r.code === 2, r.all);
}
for (const c of ['git status', 'git add src/x.js', 'git stash list', 'git commit -m x -- docs/a.md', 'ls -a']) {
  r = guard('other', 'Bash', { command: c });
  check(`...and allows: ${c}`, r.code === 0, r.all);
}
r = run(CWD, null, ['guard'], 'not json');
check('a guard that cannot read its input fails open', r.code === 0, r.all);
as('other', 'release', 'beta');
r = guard('parent', 'Bash', { command: 'git stash' });
check('...and allows those commands once nobody else is working', r.code === 0, r.all);
g('release', 'alpha');

/* ---- goals ------------------------------------------------------------------- */

const FRESH = path.join(ROOT, 'fresh');
fs.mkdirSync(FRESH);
git(FRESH, 'init', '-q', '-b', 'main');
git(FRESH, 'config', 'user.email', 't@example.com');
git(FRESH, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(FRESH, 'f'), 'x\n'); git(FRESH, 'add', '.'); git(FRESH, 'commit', '-qm', 'i');
const f = (...args) => run(FRESH, 'parent', args);
const deliver2 = (who) => run(FRESH, null, ['deliver'], JSON.stringify({ session_id: who })).out;
const fAs = (s, ...args) => run(FRESH, s, args);

r = f('orient');
check('orient tells the agent not to stop for a goal', /Do not stop to ask/.test(r.out) && /goal add/.test(r.out), r.out);
r = f('goal', 'add', 'Ship the search rewrite');
check('setting a goal without the user\'s words is refused', r.code === 1 && /--user-said/.test(r.err), r.all);
r = f('goal', 'propose', 'Ship the docs');
check('proposing a goal without a reason is refused', r.code === 1, r.all);

r = f('goal', 'propose', 'Ship the docs', '--why', 'three tickets touched them');
const PG = goalOf(r);
check('a proposal prints the question to ask', /Want me to track it/.test(r.out), r.out);
r = f('orient');
check('...stays out of active goals but is surfaced', /No goals recorded/.test(r.out) && /Proposed goals/.test(r.out), r.out);
r = f('goal', 'accept', PG);
check('...and cannot be accepted without the user\'s words', r.code === 1, r.all);
f('goal', 'reject', PG, '--user-said', 'not now');

f('goal', 'none', '--user-said', 'no goals for this repo');
check('after "none", orient stops asking', !/No goals recorded/.test(f('orient').out));

r = f('goal', 'add', 'Ship the search rewrite', '--user-said', 'get search done');
const G1 = goalOf(r);
check('a goal set in the user\'s words prints [STATUS-UPDATE]', /^\[STATUS-UPDATE\]/.test(r.out), r.out);
const T1 = idOf(f('new', 'Stemming matches plural search words', '-r', 'searching "budgets" returns 12 hits', '-c', 'node s.mjs', '--goal', G1));
r = f('goal', 'status', G1);
check('goal progress is counted from tickets', /0 of 1 tickets done/.test(r.out), r.out);
r = f('goal', 'done', G1, '--evidence', 'x', '--user-said', 'y');
check('closing a goal with an open ticket is refused', r.code === 3 && new RegExp(T1).test(r.err), r.all);
f('goal', 'next', G1, 'wire up stemming');
f('goal', 'next', G1, 'write the docs');
r = f('goal', 'next', G1, '--done', '1');
check('finishing a next thing renumbers the rest', /1\. write the docs/.test(r.out) && !/stemming/.test(r.out), r.out);
r = f('goal', 'next', G1, '--done', '9');
check('finishing a next thing that does not exist is refused', r.code === 1, r.all);
r = f('new', 'A ticket for a goal that is not there', '-r', 'the ghost ticket exits zero', '-c', 'node g.mjs', '--goal', 'G-ZZZZZ');
check('linking a new ticket to an unknown goal is refused', r.code === 1, r.all);

/* ---- checkpoint and continue -------------------------------------------------- */

r = f('checkpoint');
check('checkpoint refuses when a ticket has no latest', r.code === 3 && /has no latest/.test(r.err), r.all);
f('update', T1, 'index built, tests pending');
f('assume', T1, 'porter stemming', '--breaks', 'plural matching');
r = f('checkpoint');
check('...and when the latest is older than the work', r.code === 3 && /older than its last work/.test(r.err), r.all);
f('update', T1, 'assumed porter stemming; tests pending');
r = f('checkpoint');
check('...and when next things predate the work', r.code === 3 && /next things predate/.test(r.err), r.all);
f('goal', 'next', G1, '--still-right');
fs.writeFileSync(path.join(FRESH, 'wip.js'), 'x\n');
r = f('checkpoint');
check('...and when uncommitted files are unexplained', r.code === 3 && /wip\.js/.test(r.err), r.all);

f('claim', T1, '--path', 'src');
r = f('checkpoint', '--uncommitted', 'wip.js is a half-written test');
check('checkpoint passes once everything is current', r.code === 0 && /Safe to clear context/.test(r.out), r.all);
check('...and prints [TASK-COMPLETE]', /^\[TASK-COMPLETE\]/m.test(r.out), r.out);
check('...and releases this session\'s claims', !/src/.test(f('claims').out));

r = fAs('newsession', 'continue');
check('a new session\'s continue finds the checkpointed goal', r.code === 0 && r.out.includes(G1), r.all);
check('...with the next things', /write the docs/.test(r.out), r.out);
check('...and the ticket\'s latest', /assumed porter stemming/.test(r.out), r.out);
check('...and the note about uncommitted work', /half-written test/.test(r.out), r.out);
check('...and the files uncommitted right now', /wip\.js/.test(r.out), r.out);
check('...and warns that records are not sources', /not sources/.test(r.out), r.out);

f('goal', 'add', 'A second goal nobody checkpointed', '--user-said', 'also this');
r = fAs('newsession', 'continue');
check('the checkpointed goal still wins over a newer one', r.code === 0 && r.out.includes(G1), r.all);
fAs('s3', 'decide', G1, 'stem with porter', '--user-said', 'use porter');
r = fAs('s3', 'continue', G1);
check('a decision on a goal reads back with the user\'s words', /use porter/.test(r.out), r.out);

/* ---- what real handoffs carry ------------------------------------------------- */

const LG = goalOf(f('goal', 'add', 'Hold what real handoffs hold', '--user-said', 'port them'));
const LT = idOf(f('new', 'Journal pages tie to the printed totals', '-r', 'every journal page ties to its printed total', '-c', 'node tie.mjs', '--goal', LG));

r = f('update', LT, 'x'.repeat(601));
check('a latest long enough to be a document is refused', r.code === 1 && /handoff document in disguise/.test(r.err), r.all);
r = f('ref', LT, 'notes/findings/X.md');
check('a ref with no reason is refused', r.code === 1 && /--why/.test(r.err), r.all);
f('ref', LG, 'notes/findings/X.md', '--why', 'what is established and what is a guess');

r = f('forbid', LG, 'do not retry under another name');
check('a stop nobody can lift is refused', r.code === 1 && /--lifted-by/.test(r.err), r.all);
f('forbid', LG, 'do not retry under another name', '--lifted-by', 'TJ');
const LF = fAs('s9', 'orient').out;
check('a hard stop reaches a new session at orient', /DO NOT: do not retry under another name/.test(LF), LF);
r = f('unforbid', LG, '1');
check('lifting a stop without their words is refused', r.code === 1, r.all);
r = fAs('s9', 'continue', LG);
check('continue carries the stop', /do not retry under another name/.test(r.out), r.out);
check('...and the pointer to findings', /notes\/findings\/X\.md/.test(r.out), r.out);
f('unforbid', LG, '1', '--user-said', 'ok retry it');
check('a lifted stop no longer shows', !/DO NOT: do not retry/.test(fAs('s9', 'orient').out));

f('decide', LG, 'rule D applies', '--user-said', 'use D');
f('decide', LG, 'rule D removed', '--user-said', 'drop D', '--supersedes', '1');
r = fAs('s9', 'continue', LG);
check('a withdrawn decision stays visible, so nobody re-adds it', /WITHDRAWN, do not re-add\] rule D applies/.test(r.out), r.out);
r = f('decide', LG, 'x', '--supersedes', '9');
check('withdrawing a decision that does not exist is refused', r.code === 1, r.all);

r = f('goal', 'next', LG, 'file by the window', '--due', 'soon');
check('a deadline that is not a date is refused', r.code === 1, r.all);
const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
f('goal', 'next', LG, 'file by the window', '--due', soon);
f('goal', 'next', LG, 'missed one', '--due', past);
r = fAs('s9', 'orient');
check('a deadline surfaces at orient with days left', /Deadlines:/.test(r.out) && /in 5 day\(s\)/.test(r.out), r.out);
check('...and a missed one says OVERDUE', /OVERDUE by 5 day\(s\)/.test(r.out), r.out);
f('goal', 'next', LG, '--done', '2');
f('goal', 'next', LG, 'first thing');
r = f('goal', 'next', LG, '--move', '2', '--to', '1');
check('next things can be reordered', /1\. first thing/.test(r.out), r.out);

r = f('ask', 'user', 'names in the wages file: publish or mask?', '--about', LG);
const UQ = qOf(r);
check('a question for the user is listed at orient', new RegExp(`Waiting on the user[\\s\\S]*${UQ}`).test(fAs('s9', 'orient').out));
check('...and is not delivered to a session as its own to answer', deliver2('s9') === '');
r = f('answer', UQ, 'mask');
check('answering for the user without their words is refused', r.code === 1 && /--user-said/.test(r.err), r.all);
f('answer', UQ, 'mask', '--user-said', 'mask them');
r = fAs('s9', 'continue', LG);
check('their answer is carried forward', /The user has answered/.test(r.out) && /-> mask/.test(r.out), r.out);
check('...and leaves the waiting list', !/Waiting on the user/.test(fAs('s9', 'orient').out));

f('block', LT, 'waiting for the export');
r = f('start', LT);
check('a blocked ticket cannot be silently restarted', r.code === 1 && /--because/.test(r.err), r.all);
r = f('start', LT, '--because', 'export arrived 4 Nov');
check('...and restarts with what changed', r.code === 0 && /unblocked: export arrived/.test(f('show', LT).out), r.all);

r = f('hazard', LT, 'a dead agent left comparison-sets.csv');
check('a hazard with no way to check it is refused', r.code === 1 && /--verify/.test(r.err), r.all);
f('hazard', LT, 'a dead agent left comparison-sets.csv', '--verify', 'read the file; check project-six rows');
check('a hazard shows at orient', /1 hazard\(s\) left behind/.test(fAs('s9', 'orient').out));
check('...and in full at continue', /check project-six rows/.test(fAs('s9', 'continue', LT).out));
r = f('hazard', LT, '--clear', '1');
check('clearing a hazard without evidence is refused', r.code === 1, r.all);
f('hazard', LT, '--clear', '1', '--evidence', 'file has 21 rows, project-six present');
check('...and clears with it', !/hazard\(s\) left behind/.test(fAs('s9', 'orient').out));

f('goal', 'update', LG, 'tie-out moved 3 pages to 5');
r = fAs('s9', 'continue', LG);
check('goal updates show at continue', /tie-out moved 3 pages to 5/.test(r.out), r.out);
check('...and the open ticket\'s log', /waiting for the export/.test(r.out), r.out);
f('assume', LT, 'fiscal years', '--breaks', 'figures shift'); f('decide', LT, 'keep the three grades');
f('met', LT, '1', '--evidence', 'tie.mjs -> 12 of 12');
f('grill', LT, '--observed', 'o', '--cause', 'c', '--absence', 'a', '--assumption', 'as', '--falsify', 'f');
f('done', LT);
r = fAs('s9', 'continue', LG);
check('a closed ticket\'s decisions and assumptions are not lost', /keep the three grades/.test(r.out) && /assumed: fiscal years/.test(r.out), r.out);

r = f('goal', 'park', LG);
check('parking with nothing to wait on is refused', r.code === 1 && /--waiting-on/.test(r.err), r.all);
f('goal', 'park', LG, '--waiting-on', 'TJ: revive or retire');
r = fAs('s9', 'orient');
check('a parked goal reads as parked, not stale', /Parked goals:/.test(r.out) && /waiting on: TJ: revive or retire/.test(r.out), r.out);
check('...and a deadline on it still surfaces', /Deadlines:/.test(r.out), r.out);
f('forbid', LG, 'no student names', '--lifted-by', 'TJ');
r = fAs('s9', 'orient');
check('a parked goal\'s hard stop still prints at orient', /DO NOT: no student names/.test(r.out), r.out);
check('...and orient says how to read a parked goal in full', /parked or not: genlock continue GOAL/.test(r.out), r.out);
check('continue reads a parked goal by id', /PARKED, waiting on/.test(fAs('s9', 'continue', LG).out));
f('goal', 'unpark', LG);
f('goal', 'park', LG, '--waiting-on', 'TJ');
r = f('goal', 'list');
check('a parked goal stays on the goal list', /parked/.test(r.out), r.out);

/* ---- questions between sessions ----------------------------------------------- */

fAs('worker', 'start', T1);
r = fAs('asker', 'ask', T1, 'which stemmer did you choose?');
const Q1 = qOf(r);
check('a question gets an id and tells the asker not to wait', !!Q1 && /Do not wait/.test(r.out), r.all);

const deliver = (s) => run(FRESH, null, ['deliver'], JSON.stringify({ session_id: s }));
r = deliver('worker');
check('the hook delivers the question to the ticket\'s owner', /which stemmer/.test(r.out) && /PostToolUse/.test(r.out), r.all);
check('...as valid hook JSON', (() => { try { return !!JSON.parse(r.out).hookSpecificOutput.additionalContext; } catch { return false; } })(), r.out);
r = deliver('worker');
check('...once only', r.out === '', r.out);
r = deliver('bystander');
check('...and not to anyone else', r.out === '', r.out);
fAs('worker', 'answer', Q1, 'porter');
r = deliver('asker');
check('the answer is delivered back to the asker', /porter/.test(r.out), r.all);
check('...and an answered question leaves the owner\'s inbox', /nothing for you/.test(fAs('worker', 'inbox').out));

/* ---- spin-offs ---------------------------------------------------------------- */

const SP = path.join(ROOT, 'sp');
fs.mkdirSync(SP);
git(SP, 'init', '-q', '-b', 'main');
git(SP, 'config', 'user.email', 't@example.com');
git(SP, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(SP, 'f'), 'x\n'); git(SP, 'add', '.'); git(SP, 'commit', '-qm', 'i');
const s = (...args) => run(SP, 'parent', args);

const PT = idOf(s('new', 'Search returns plural matches', '-r', 'searching "budgets" returns 12 hits', '-c', 'node s.mjs'));
const prop = (extra) => s('spinoff', 'propose', 'Footer links reach the archive', '--parent', PT,
  '--why', 'came up mid-thread', '--context', 'links are in src/footer',
  '--needs', 'none', '--blocks', 'none', ...extra);

r = s('spinoff', 'propose', 'Footer links reach the archive', '--parent', PT);
check('a proposal missing its declarations is refused', r.code === 2 && /--path/.test(r.err) && /--needs/.test(r.err) && /--blocks/.test(r.err), r.all);

r = prop(['--path', 'src/footer']);
const S1 = idOf({ out: r.out });
check('a parent that declared nothing makes it NOT SAFE, not safe by default', r.code === 4 && /has not declared/.test(r.out), r.all);
check('...and the ticket still exists', s('show', S1).code === 0);
r = s('spinoff', 'launch', S1, '--user-said', 'yes');
check('...and it cannot launch', r.code === 4, r.all);

s('claim', PT, '--path', 'src/search', '--resource', 'site-build');
r = s('spinoff', 'check', S1);
check('once the parent declares separate paths, it is SAFE', r.code === 0 && /SAFE to offer/.test(r.out), r.all);
check('...and prints the offer to make', /I can kick off a spinoff/.test(r.out), r.out);

r = s('spinoff', 'amend', S1, '--path', 'src/search/ui');
check('overlapping the parent\'s paths is NOT SAFE', r.code === 4 && /src\/search/.test(r.out), r.all);
r = s('spinoff', 'amend', S1, '--path', 'src/footer', '--resource', 'site-build');
check('sharing the parent\'s resource is NOT SAFE', r.code === 4 && /resource/.test(r.out), r.all);
s('claim', 'tmp', '--path', 'x'); s('release', 'tmp');

r = prop(['--path', 'src/other', '--needs', 'the parser it is writing']);
check('needing the parent\'s unfinished work is NOT SAFE', r.code === 4 && /would start and then wait/.test(r.out), r.all);
r = prop(['--path', 'src/other2', '--blocks', 'the result']);
check('leaving the parent waiting on it is NOT SAFE', r.code === 4 && /stop and wait/.test(r.out), r.all);

fs.mkdirSync(path.join(SP, 'dirty')); fs.writeFileSync(path.join(SP, 'dirty/a.js'), 'x\n');
r = prop(['--path', 'dirty']);
check('uncommitted changes in its paths are NOT SAFE', r.code === 4 && /uncommitted/.test(r.out), r.all);
fs.rmSync(path.join(SP, 'dirty'), { recursive: true });

r = prop(['--path', 'src/footer2']);
const S2 = idOf({ out: r.out });
check('a separate spin-off is SAFE', r.code === 0, r.all);
r = s('start', S2);
check('a spin-off cannot start before it has requirements', r.code === 1 && /no requirements yet/.test(r.err), r.all);
check('...and cannot be done', s('done', S2).code === 3);

r = s('spinoff', 'launch', S2);
check('launching without the user\'s yes is refused', r.code === 1 && /--user-said/.test(r.err), r.all);
check('...and takes no claim', !/footer2/.test(s('claims').out));

run(SP, 'intruder', ['claim', 'other', '--path', 'src/footer2']);
r = s('spinoff', 'launch', S2, '--user-said', 'yes do it');
check('launch re-checks: a claim taken since the offer stops it', r.code === 4, r.all);
run(SP, 'intruder', ['release', 'other']);

r = s('spinoff', 'launch', S2, '--user-said', 'yes do it');
check('launch takes the claim on a yes', r.code === 0 && /footer2/.test(s('claims').out), r.all);
const startSh = (/(?:sh '|-File ")([^'"]+start\.(?:sh|ps1))/.exec(r.out) || [])[1];
check('...and writes a start script', !!startSh && fs.existsSync(startSh), r.out);
const scriptText = startSh ? fs.readFileSync(startSh, 'utf8') : '';
const session = (/--session-id '([^']+)'/.exec(scriptText) || [])[1];
check('...starting the child under a fixed session id', !!session, scriptText);
const promptText = fs.readFileSync(path.join(path.dirname(startSh), 'prompt.txt'), 'utf8');
check('...whose prompt names its ticket and what it holds', promptText.includes(S2) && /src\/footer2/.test(promptText), promptText);
const shown = JSON.parse(s('show', S2, '--json').out);
check('...and the user\'s yes is on record', shown.spinoff.user_said === 'yes do it', JSON.stringify(shown.spinoff));
check('...and the child owns the ticket', shown.owner === session, shown.owner);
r = s('spinoff', 'launch', S2, '--user-said', 'again');
check('a running spin-off cannot be launched twice', r.code === 1 && /already running/.test(r.err), r.all);
check('the parent records the spin-off', /spun off/.test(s('show', PT).out));

const sg = (who, file) => run(SP, null, ['guard'], JSON.stringify({ session_id: who, tool_name: 'Edit', tool_input: { file_path: path.join(SP, file) } }));
check('the child may edit what it holds', sg(session, 'src/footer2/a.js').code === 0);
r = sg(session, 'README.md');
check('the child is blocked outside what it declared', r.code === 2 && /outside what this spin-off declared/.test(r.err), r.all);
r = sg(session, 'src/search/a.js');
check('the child is blocked from the parent\'s paths', r.code === 2, r.all);
r = sg('parent', 'src/footer2/a.js');
check('the parent is blocked from the child\'s paths', r.code === 2, r.all);
r = sg('parent', 'README.md');
check('the parent is not held to a declared list', r.code === 0, r.all);

/* ---- spin-offs inside the app ---------------------------------------------------- */

const APPCH = path.join(ROOT, 'app-channel');
const propApp = prop(['--path', 'src/appside']);
const S3 = idOf({ out: propApp.out });
const appLaunch = spawnSync(process.execPath, [CLI, 'spinoff', 'launch', S3, '--user-said', 'yes please'], {
  cwd: SP, encoding: 'utf8', env: { ...baseEnv, GENLOCK_SESSION: 'parent', GENLOCK_APP_CHANNEL: APPCH },
});
const spawnFile = path.join(APPCH, `spawn-${S3}.json`);
check('inside the app, launch asks for a pane instead of a window', appLaunch.status === 0 && fs.existsSync(spawnFile) && /new pane/.test(appLaunch.stdout), appLaunch.stdout + appLaunch.stderr);
const spawnReq = JSON.parse(fs.readFileSync(spawnFile, 'utf8'));
check('...naming the ticket, and a session that holds the claim', spawnReq.ticket === S3 && JSON.parse(s('claims', '--json').out).some((c) => c.session === spawnReq.session && c.key === S3), JSON.stringify(spawnReq));
check('...with the handoff prompt', spawnReq.prompt.includes(`genlock continue ${S3}`), spawnReq.prompt);
const noYes = spawnSync(process.execPath, [CLI, 'spinoff', 'launch', S2, '--worktree'], { cwd: SP, encoding: 'utf8', env: { ...baseEnv, GENLOCK_SESSION: 'parent', GENLOCK_APP_CHANNEL: APPCH } });
check('...and still needs the user\'s yes', noYes.status === 1 && /--user-said/.test(noYes.stderr), noYes.stderr);

/* ---- MCP ---------------------------------------------------------------------- */

function mcp(cwd, session, messages) {
  const input = messages.map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n';
  const res = spawnSync(process.execPath, [CLI, 'mcp'], { cwd, encoding: 'utf8', input, env: { ...baseEnv, GENLOCK_SESSION: session } });
  return res.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const call = (id, name, args = {}) => ({ id, method: 'tools/call', params: { name, arguments: args } });
const replies = mcp(FRESH, 'mcp-session', [
  { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  { method: 'notifications/initialized' },
  { id: 2, method: 'tools/list' },
  call(3, 'goals_list'),
  call(4, 'goal_add', { title: 'Added over MCP', user_said: 'please' }),
  call(5, 'ticket_done', { id: T1 }),
  call(6, 'no_such_tool'),
  { id: 7, method: 'nonsense' },
]);
const byId = Object.fromEntries(replies.map((x) => [x.id, x]));
check('MCP: initialize names the server', byId[1]?.result?.serverInfo?.name === 'genlock', JSON.stringify(byId[1]));
check('MCP: a notification gets no reply', replies.length === 7, replies.length);
const tools = byId[2]?.result?.tools || [];
for (const need of ['orient', 'goals_list', 'goal_add', 'goal_next', 'ticket_update', 'checkpoint', 'continue_work', 'ask_session', 'spinoff_propose', 'spinoff_launch']) {
  check(`MCP: lists ${need}`, tools.some((t) => t.name === need));
}
check('MCP: answers "what are the goals"', byId[3]?.result?.content[0].text.includes('Ship the search rewrite'), JSON.stringify(byId[3]));
check('MCP: writes reach the shared records', /Added over MCP/.test(f('goal', 'list').out));
check('MCP: a refusal comes back as a tool error, with the reason',
  byId[5]?.result?.isError === true && /NOT done/.test(byId[5].result.content[0].text), JSON.stringify(byId[5]));
check('MCP: an unknown tool is an error', byId[6]?.result?.isError === true);
check('MCP: an unknown method is an error', byId[7]?.error?.code === -32601);

/* ---- install: each module stands alone ---------------------------------------- */

const IN = path.join(ROOT, 'inst');
fs.mkdirSync(IN);
git(IN, 'init', '-q', '-b', 'main');
const inst = (...args) => run(IN, 'x', ['install', ...args]);
const agents = () => fs.readFileSync(path.join(IN, 'AGENTS.md'), 'utf8');

r = inst('--only', 'labels');
check('--only labels installs', r.code === 0, r.all);
check('...with no dependency on the CLI', !/genlock/.test(agents().replace(/<!--.*?-->/g, '')), agents());
inst('--only', 'goals');
check('--only goals replaces the block rather than appending', !/TASK-COMPLETE/.test(agents()) && /goal add/.test(agents()), agents());
check('...and pulls in no ticket rules', !/genlock done/.test(agents()), agents());
r = inst('--only', 'spinoffs');
check('a module pulls in what it depends on', /including tickets/.test(r.out) && /genlock done/.test(agents()), r.out);
check('...once only', (agents().match(/BEGIN genlock/g) || []).length === 1);
r = inst('--only', 'nonsense');
check('an unknown module is refused', r.code === 1, r.all);

fs.writeFileSync(path.join(IN, 'AGENTS.md'), '# Mine\n\nkeep this\n');
inst();
check('existing instructions are left alone', /keep this/.test(agents()), agents());

fs.mkdirSync(path.join(IN, '.claude'), { recursive: true });
fs.writeFileSync(path.join(IN, '.claude/settings.json'), JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
inst('--hooks'); inst('--hooks');
const st = JSON.parse(fs.readFileSync(path.join(IN, '.claude/settings.json'), 'utf8'));
check('--hooks keeps existing settings', st.model === 'x' && st.hooks.Stop.length === 1, JSON.stringify(st));
check('--hooks is idempotent', st.hooks.PreToolUse.length === 1 && st.hooks.SessionStart.length === 1 && st.hooks.PostToolUse.length === 1, JSON.stringify(st.hooks));
inst('--mcp');
const mc = JSON.parse(fs.readFileSync(path.join(IN, '.mcp.json'), 'utf8'));
check('--mcp registers the server', mc.mcpServers.genlock.args.includes('mcp'), JSON.stringify(mc));
r = run(IN, 'x', ['doctor']);
check('doctor sees the hook once installed', /guard hook in/.test(r.out), r.out);
inst('--skill');
check('--skill installs each module\'s skill', ['ticketed-work', 'goals', 'continuity', 'coordination', 'reviews', 'spinoffs', 'status-labels']
  .every((n) => fs.existsSync(path.join(IN, '.claude/skills', n, 'SKILL.md'))));

/* ---- reviews and the snapshot --------------------------------------------------- */

const RV = path.join(ROOT, 'rv');
fs.mkdirSync(RV);
git(RV, 'init', '-q', '-b', 'main');
git(RV, 'config', 'user.email', 't@example.com');
git(RV, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(RV, 'seed'), 'x\n'); git(RV, 'add', '.'); git(RV, 'commit', '-qm', 'i');
const rv = (...args) => run(RV, 'rv', args);
const snap = () => JSON.parse(rv('snapshot').out);

let sn = snap();
check('snapshot in an unused repository says so, and writes nothing',
  sn.initialized === false && sn.goals.length === 0 && git(RV, 'status', '--porcelain').out === '' && !fs.existsSync(path.join(RV, '.git', 'genlock')), JSON.stringify(sn));
check('...and needs no current goal or ticket', sn.current_goal === null && sn.last_ticket === null);

fs.mkdirSync(path.join(RV, 'docs'));
fs.writeFileSync(path.join(RV, 'docs', 'plan.md'), 'plan\n');
const GA = goalOf(rv('goal', 'add', 'First goal to work through', '--user-said', 'x'));
const GB = goalOf(rv('goal', 'add', 'Second goal to work through', '--user-said', 'x'));
const TA = idOf(rv('new', 'First goal has a ticket open', '-r', 'the first check exits zero', '-c', 'node a.mjs', '--goal', GA));
rv('goal', 'next', GB, 'Pay the bill', '--due', new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
rv('update', TA, 'half done');

r = rv('review', 'docs/plan.md');
check('a review with no question is refused', r.code === 1 && /--why/.test(r.err), r.all);
r = rv('review', 'docs/nothing.md', '--why', 'x');
check('a review of a file that is not there is refused', r.code === 1 && /no file/.test(r.err), r.all);
r = rv('review', 'docs/plan.md', '--why', 'Is section 2 right?', '--about', GA);
const RID = (/\b(R-[0-9A-Z]{5})\b/.exec(r.out) || [])[1];
check('a review is recorded', r.code === 0 && !!RID, r.all);
rv('review', 'docs/plan.md', '--why', 'Is section 3 right too?');
check('asking again about one file does not list it twice', snap().reviews.filter((x) => x.status === 'open').length === 1);
rv('review', 'https://example.com/report', '--why', 'Does this read well?');
r = run(path.join(RV, 'docs'), 'rv', ['review', 'plan.md', '--why', 'From a subfolder?']);
check('a path from a subfolder resolves to the same file', snap().reviews.filter((x) => x.path === 'docs/plan.md').length === 1 && r.code === 0, r.all);
check('orient lists what is waiting for review', /Waiting for the user to review/.test(rv('orient').out));

sn = snap();
check('snapshot: the current goal is the one with the latest ticket activity', sn.current_goal === GA, sn.current_goal);
rv('goal', 'update', GB, 'moved on to the bill');
check('...and follows the work to another goal', snap().current_goal === GB, snap().current_goal);
sn = snap();
check('snapshot: the last ticket worked', sn.last_ticket === TA, sn.last_ticket);
const sa = sn.goals.find((x) => x.id === GB);
check('snapshot: next things with days until due', sa.next[0].days_until === 3, JSON.stringify(sa.next));
const st0 = sn.tickets.find((x) => x.id === TA);
check('snapshot: a ticket has its latest', st0.latest.text === 'half done', JSON.stringify(st0));
check('snapshot: progress is counted', sn.goals.find((x) => x.id === GA).progress.total === 1);
rv('claim', TA, '--path', 'src');
check('snapshot: live claims', snap().claims[0].paths[0] === 'src');
rv('release', TA);
r = rv('review', 'done', RID, '--note', 'looks right');
sn = snap();
check('a finished review stays on record but stops being open', sn.reviews.find((x) => x.id === RID).status === 'reviewed' && !/plan\.md/.test(rv('review', 'list').out), JSON.stringify(sn.reviews));
const beforeSnap = git(RV, 'status', '--porcelain').out;
rv('snapshot');
check('snapshot writes nothing', git(RV, 'status', '--porcelain').out === beforeSnap);

const mr = mcp(RV, 'mcp-session', [call(1, 'review_request', { path: 'seed', why: 'Over MCP?' }), call(2, 'reviews_list')]);
check('MCP: review_request reaches the list', /seed/.test(mr[1].result.content[0].text), JSON.stringify(mr));

/* ---- voice --------------------------------------------------------------------- */

const VOICE = path.join(ROOT, 'voice-channel');
const voiceRun = (args, input, extra = {}) => {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: RV, encoding: 'utf8', input, env: { ...baseEnv, GENLOCK_APP_CHANNEL: VOICE, ...extra } });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
};
r = rv('say', 'hello');
check('say with no channel says nobody is listening, and does not fail', r.code === 0 && /Nobody is listening/.test(r.out), r.all);
r = voiceRun(['say']);
check('say with nothing to say is refused', r.code === 1);
const statusBeforeVoice = git(RV, 'status', '--porcelain').out;
fs.mkdirSync(VOICE, { recursive: true });
fs.writeFileSync(path.join(VOICE, 'pending'), '');
r = voiceRun(['voice-check'], '{}');
check('stopping after a dictated message without speaking is sent back', r.code === 2 && /genlock say/.test(r.err), r.err);
fs.writeFileSync(path.join(VOICE, 'pending'), '');
r = voiceRun(['voice-check'], '{"stop_hook_active":true}');
check('...but only once, so it can never trap a session', r.code === 0, r.err);
r = voiceRun(['voice-check'], '{}');
check('a turn that was not dictated stops freely', r.code === 0, r.err);
fs.writeFileSync(path.join(VOICE, 'pending'), '');
r = voiceRun(['say', 'the', 'build', 'passed']);
const said = fs.readdirSync(VOICE).filter((x) => x.startsWith('say-'));
check('say hands over one whole message', r.code === 0 && said.length === 1 && JSON.parse(fs.readFileSync(path.join(VOICE, said[0]), 'utf8')).text === 'the build passed', said.join());
check('...and clears the pending turn', !fs.existsSync(path.join(VOICE, 'pending')));
r = voiceRun(['voice-check'], '{}');
check('...so stopping is then free', r.code === 0, r.err);
check('voice writes nothing to the repository', git(RV, 'status', '--porcelain').out === statusBeforeVoice);

/* ---- telling the app what a session is doing ------------------------------------ */

const stateOf = () => JSON.parse(fs.readFileSync(path.join(VOICE, 'state.json'), 'utf8'));
r = voiceRun(['session-state'], '{"hook_event_name":"UserPromptSubmit"}');
check('a prompt means working', r.code === 0 && stateOf().state === 'working', r.err);
r = voiceRun(['session-state'], '{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}');
check('a Claude Code notification means waiting, with its message', stateOf().state === 'waiting' && /permission/.test(stateOf().message), r.err);
voiceRun(['session-state'], '{"hook_event_name":"PostToolUse"}');
check('a tool finishing means working again', stateOf().state === 'working');
voiceRun(['session-state'], '{"hook_event_name":"Stop","last_assistant_message":"All   done\\nhere"}');
check('stopping means done, with a tidy summary', stateOf().state === 'done' && stateOf().message === 'All done here', JSON.stringify(stateOf()));
voiceRun(['session-state'], '{"hook_event_name":"UserPromptSubmit"}');
fs.writeFileSync(path.join(VOICE, 'pending'), '');
r = voiceRun(['session-state'], '{"hook_event_name":"Stop"}');
check('a dictated turn with no spoken reply is sent back and not called done', r.code === 2 && stateOf().state === 'working' && /genlock say/.test(r.err), r.err);
fs.writeFileSync(path.join(VOICE, 'pending'), '');
r = voiceRun(['session-state'], '{"hook_event_name":"Stop","stop_hook_active":true}');
check('...only once, then it is done', r.code === 0 && stateOf().state === 'done', r.err);
r = rv('session-state');
check('with no app listening it does nothing', r.code === 0, r.all);

/* ---- first contact: setup, reads leave no trace ------------------------------- */

const SETUP = path.join(ROOT, 'setup');
fs.mkdirSync(SETUP);
git(SETUP, 'init', '-q', '-b', 'main');
git(SETUP, 'config', 'user.email', 't@example.com');
git(SETUP, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(SETUP, 'CLAUDE.md'), '# Mine\n');
git(SETUP, 'add', '.'); git(SETUP, 'commit', '-qm', 'i');
const sx = (...args) => run(SETUP, 'x', args);

for (const cmd of [['orient'], ['goal', 'list'], ['list'], ['claims'], ['inbox'], ['where'], ['doctor'], ['help'], ['guide']]) sx(...cmd);
run(SETUP, null, ['guard'], JSON.stringify({ session_id: 'x', tool_name: 'Edit', tool_input: { file_path: path.join(SETUP, 'a') } }));
run(SETUP, null, ['deliver'], JSON.stringify({ session_id: 'x' }));
check('reading leaves no trace in the working tree', git(SETUP, 'status', '--porcelain').out === '', git(SETUP, 'status', '--porcelain').out);
check('...or in .git', !fs.existsSync(path.join(SETUP, '.git', 'genlock')));
const NOGIT = path.join(ROOT, 'nogit');
fs.mkdirSync(NOGIT);
run(NOGIT, 'x', ['orient']);
check('...or in a folder that is not a repository', fs.readdirSync(NOGIT).length === 0, fs.readdirSync(NOGIT).join());

r = sx('install', '--check');
check('--check writes nothing', git(SETUP, 'status', '--porcelain').out === '', r.all);

r = sx('guide');
check('guide covers public repositories', /genlock init --private/.test(r.out), r.out);
check('...and bringing notes across', /do not convert them in bulk/.test(r.out), r.out);
check('help starts with how to begin', /START HERE[\s\S]*genlock init/.test(sx('help').out));

r = sx('init');
check('init without a choice about records is refused', r.code === 1 && /--private/.test(r.err) && /--shared/.test(r.err), r.all);
check('...and writes nothing', git(SETUP, 'status', '--porcelain').out === '');
r = sx('init', '--help');
check('--help never runs the command', r.code === 0 && /START HERE/.test(r.out) && git(SETUP, 'status', '--porcelain').out === '', r.all);
r = sx('goal', 'add', 'Should not exist', '--user-said', 'x', '-h');
check('...on any command', /START HERE/.test(r.out) && !fs.existsSync(path.join(SETUP, '.genlock')), r.all);
r = sx('init', '--check');
check('init --check needs no choice and writes nothing', r.code === 0 && git(SETUP, 'status', '--porcelain').out === '', r.all);
r = sx('init', '--shared');
check('init runs', r.code === 0, r.all);
check('...sets up rules, hooks, server and skills', /BEGIN genlock/.test(fs.readFileSync(path.join(SETUP, 'CLAUDE.md'), 'utf8'))
  && fs.existsSync(path.join(SETUP, '.claude', 'settings.json')) && fs.existsSync(path.join(SETUP, '.mcp.json'))
  && fs.existsSync(path.join(SETUP, '.claude', 'skills', 'goals', 'SKILL.md')), r.all);
check('...says what to do next', /genlock doctor/.test(r.out), r.out);
check('...and tools can see it is set up, before any record exists', JSON.parse(sx('snapshot').out).initialized === true, sx('snapshot').out);
check('...with the merge rule already in place', /merge=union/.test(fs.readFileSync(path.join(SETUP, '.genlock', '.gitattributes'), 'utf8')));
r = sx('doctor');
check('doctor passes after init', r.code === 0, r.all);
const initOnce = fs.readFileSync(path.join(SETUP, 'CLAUDE.md'), 'utf8');
sx('init', '--shared');
check('init twice changes nothing', fs.readFileSync(path.join(SETUP, 'CLAUDE.md'), 'utf8') === initOnce);

r = sx('init', '--private');
check('--private excludes records from git', r.code === 0 && /\.genlock\//.test(fs.readFileSync(path.join(SETUP, '.git', 'info', 'exclude'), 'utf8')), r.all);
sx('goal', 'add', 'A private goal for this test', '--user-said', 'x');
check('...so a record never shows as a change', !/\.genlock/.test(git(SETUP, 'status', '--porcelain', '-uall').out), git(SETUP, 'status', '--porcelain', '-uall').out);
r = sx('sync');
check('...sync explains rather than failing oddly', r.code === 1 && /private/.test(r.err), r.all);
check('...doctor says so', /records are private/.test(sx('doctor').out));

if (process.platform !== 'win32') {
  const LINK = path.join(ROOT, 'link-to-setup');
  fs.symlinkSync(SETUP, LINK);
  sx('claim', 'held', '--path', 'src');
  r = run(SETUP, null, ['guard'], JSON.stringify({ session_id: 'other', tool_name: 'Edit', tool_input: { file_path: path.join(LINK, 'src', 'new.js') } }));
  check('the guard sees through a symlinked path, as with /tmp on macOS', r.code === 2, r.all);
  sx('release', 'held');
}

/* ---- sync --------------------------------------------------------------------- */

fs.writeFileSync(path.join(FRESH, 'staged.js'), 'x\n');
git(FRESH, 'add', 'staged.js');
r = f('sync');
const committed = git(FRESH, 'show', '--name-only', '--format=', 'HEAD').out;
check('sync commits the records', r.code === 0 && /\.genlock\//.test(committed), r.all + committed);
check('...and nothing another agent had staged', !/staged\.js/.test(committed), committed);
check('...and nothing is pushed or swept', /Nothing was pushed/.test(r.out) && /A {2}staged\.js/.test(git(FRESH, 'status', '--porcelain').out), r.out);
r = f('sync');
check('a second sync has nothing to do', /nothing new/.test(r.out), r.all);

/* ---- report ------------------------------------------------------------------- */

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`${pass} passed, ${fails.length} failed, ${pass + fails.length} total`);
for (const x of fails) console.log(`  FAIL  ${x}`);
process.exit(fails.length ? 1 : 0);

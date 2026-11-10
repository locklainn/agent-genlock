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
// Run from a session inside the app, these would reach the live app and open real spin-offs in it.
delete baseEnv.GENLOCK_APP_CHANNEL;
delete baseEnv.GENLOCK_SESSION;
delete baseEnv.CLAUDE_CODE_SESSION_ID;
// Run from inside Claude Code, every claim would name that real, running agent. 0 names none.
baseEnv.GENLOCK_AGENT_PID = '0';

function run(cwd, session, args, input, extra = {}) {
  const env = { ...baseEnv, ...extra };
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

/* ---- task claims: start claims the ticket, and a gone agent lets go ------------ */

const newT = (title) => idOf(g('new', title, '-r', `${title} exits zero`, '-c', 'node t.mjs'));
const KA = newT('Task claim alpha');
r = g('start', KA);
check('start claims the ticket for this session', r.code === 0 && /claimed/.test(r.out), r.all);
r = as('other', 'start', KA);
check('a second live session\'s start is refused, naming the holder', r.code === 4 && /held by session parent/.test(r.err), r.all);
r = as('other', 'claim', KA, '--path', 'elsewhere');
check('...and so is claiming paths under that ticket', r.code === 4, r.all);
r = as('other', 'rank', 'tasks');
check('rank marks the ticket TAKEN for another session', /TAKEN by session parent/.test(r.out), r.all);
r = g('rank', 'tasks');
check('...and as this session\'s own for the holder', /this session is on it/.test(r.out), r.all);
r = as('other', 'orient');
check('orient marks it TAKEN too', /TAKEN by session parent/.test(r.out), r.all);
r = as('other', 'start', KA, '--take-over');
check('a take-over without the user\'s words is refused', r.code === 4, r.all);
r = as('other', 'start', KA, '--take-over', '--user-said', 'take alpha, the other one is stuck');
check('a take-over with the user\'s words goes through', r.code === 0 && /taken over/.test(r.out), r.all);
r = g('show', KA);
check('...and the take-over is on the record', /taken over from session parent/.test(r.out), r.all);

// An agent that is alive holds its ticket past its lease; once it is gone the ticket is free at once.
const agent = spawn('sleep', ['60'], { stdio: 'ignore' });
await new Promise((res) => setTimeout(res, 150));
const KB = newT('Task claim beta');
r = run(CWD, 'agentB', ['start', KB], undefined, { GENLOCK_AGENT_PID: String(agent.pid) });
const tbFile = path.join(CWD, '.git', 'genlock', 'claims', `${KB}.json`);
const tb = JSON.parse(fs.readFileSync(tbFile, 'utf8'));
check('a claim records its agent\'s pid and start time', tb.agent?.pid === agent.pid && !!tb.agent?.started, JSON.stringify(tb));
fs.writeFileSync(tbFile, JSON.stringify({ ...tb, expires: new Date(Date.now() - 60000).toISOString() }));
r = as('other', 'start', KB);
check('a running agent holds its ticket even past its lease', r.code === 4 && new RegExp(`pid ${agent.pid} running`).test(r.err), r.all);
r = as('other', 'claims');
check('claims says the agent is running', new RegExp(`pid ${agent.pid} running`).test(r.out), r.all);
agent.kill('SIGKILL');
await new Promise((res) => agent.on('exit', res));
r = as('other', 'claims');
check('a killed agent\'s claim is gone from claims at once', !r.out.includes(KB), r.all);
check('...and its file is cleared', !fs.existsSync(tbFile));
r = as('other', 'start', KB);
check('...so another session can start the ticket', r.code === 0, r.all);

// A session that closes cleanly releases everything it holds.
as('ender', 'claim', 'ender-work', '--path', 'ender/dir');
const KC = newT('Task claim gamma');
as('ender', 'start', KC);
r = run(CWD, null, ['session-end'], JSON.stringify({ session_id: 'ender', hook_event_name: 'SessionEnd' }));
check('session-end releases every claim of the ending session', r.code === 0 && /ender-work/.test(r.out) && new RegExp(KC).test(r.out), r.all);
r = as('other', 'claims');
check('...and they are gone', !/ender/.test(r.out) && !r.out.includes(KC), r.all);
for (const id of [KA, KB, KC]) { as('other', 'release', id, '--reason', 'test cleanup'); g('abandon', id, 'test cleanup'); }

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
const S4 = idOf({ out: prop(['--path', 'src/relayside']).out });
const grantAt = (dir, action, at = Date.now()) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'relay-yes.json'), JSON.stringify({ user_said: 'yes, launch it', for: action, at })); };
const relayLaunch = (...extra) => spawnSync(process.execPath, [CLI, 'spinoff', 'launch', S4, ...extra], { cwd: SP, encoding: 'utf8', env: { ...baseEnv, GENLOCK_SESSION: 'parent', GENLOCK_APP_CHANNEL: APPCH } });
let rl = relayLaunch('--relayed');
check('launch --relayed with no yes relayed is refused', rl.status !== 0 && /no yes has been relayed/.test(rl.stderr) && !fs.existsSync(path.join(APPCH, `spawn-${S4}.json`)), rl.stderr);
grantAt(APPCH, 'swap');
rl = relayLaunch('--relayed');
check('...and a yes relayed for a swap does not license a launch', rl.status !== 0 && /was for swap/.test(rl.stderr), rl.stderr);
grantAt(APPCH, 'launch');
rl = relayLaunch('--relayed');
const s4log = [path.join(SP, '.genlock', 'records', `${S4}.jsonl`), path.join(SP, '.git', 'genlock', 'records', `${S4}.jsonl`)].find((x) => fs.existsSync(x));
const s4events = s4log ? fs.readFileSync(s4log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
check('launch --relayed with a yes relayed for it opens the pane', rl.status === 0 && fs.existsSync(path.join(APPCH, `spawn-${S4}.json`)), rl.stdout + rl.stderr);
check('...records the user\'s words and that the Assistant relayed them', s4events.some((e) => e.op === 'spinoff' && e.fields?.state === 'launched' && e.fields.user_said === 'yes, launch it' && e.fields.relayed_by === 'assistant'), JSON.stringify(s4events.slice(-3)));
check('...and uses the yes up', !fs.existsSync(path.join(APPCH, 'relay-yes.json')));

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
check('...but not the opt-in phone-builds skill, or its rule', !fs.existsSync(path.join(IN, '.claude/skills/phone-builds')) && !/phone\.sh/.test(agents()), agents());
inst('--with', 'phone', '--skill');
check('--with phone adds the phone rule to the rest and copies the skill with its templates folder',
  /phone\.sh --device/.test(agents()) && /goal add/.test(agents()) && fs.existsSync(path.join(IN, '.claude/skills/phone-builds/templates/phone.sh')), agents());

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
check('snapshot: a ticket has a recent feed, newest first, at most 4', Array.isArray(st0.recent) && st0.recent.length <= 4 && st0.recent[0].kind === 'update' && st0.recent[0].text === 'half done'
  && st0.recent.every((x, i, a) => !i || a[i - 1].at >= x.at), JSON.stringify(st0.recent));
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
voiceRun(['session-state'], '{"hook_event_name":"UserPromptSubmit","session_id":"conv-1"}');
check('a report names the conversation, so the app can resume it', stateOf().session === 'conv-1', JSON.stringify(stateOf()));
voiceRun(['session-state'], '{"hook_event_name":"UserPromptSubmit","transcript_path":"/tmp/t.jsonl"}');
check('...and where its transcript is', stateOf().transcript === '/tmp/t.jsonl', JSON.stringify(stateOf()));
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
voiceRun(['session-state'], '{"hook_event_name":"Stop","last_assistant_message":"Fire calls is in"}');
voiceRun(['session-state'], '{"hook_event_name":"Notification","message":"Claude is waiting for your input"}');
check('an idle reminder leaves a finished turn alone', stateOf().state === 'done' && stateOf().message === 'Fire calls is in', JSON.stringify(stateOf()));
voiceRun(['session-state'], '{"hook_event_name":"UserPromptSubmit"}');
voiceRun(['session-state'], '{"hook_event_name":"Notification","notification_type":"idle_prompt","message":"x"}');
check('an idle reminder ends a turn that never reported ending', stateOf().state === 'done');

/* ---- replies and questions back to the Assistant -------------------------------- */

{
  const relays = () => fs.readdirSync(VOICE).filter((f) => f.startsWith('relay-') && f.endsWith('.json')).sort()
    .map((f) => ({ f, ...JSON.parse(fs.readFileSync(path.join(VOICE, f), 'utf8')) }));
  const clear = () => { for (const x of relays()) fs.rmSync(path.join(VOICE, x.f)); };
  clear();
  voiceRun(['session-state'], '{"hook_event_name":"Stop","last_assistant_message":"Not asked by the Assistant"}');
  check('a turn nobody relayed to sends nothing back', relays().length === 0);
  fs.writeFileSync(path.join(VOICE, 'awaiting-reply.json'), '{}');
  voiceRun(['session-state'], '{"hook_event_name":"UserPromptSubmit"}');
  voiceRun(['session-state'], '{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}');
  check('a session the Assistant told something reports a prompt it is stuck on', relays().length === 1 && relays()[0].kind === 'waiting' && /permission/.test(relays()[0].text));
  clear();
  const long = `Line one\nLine two ${'x'.repeat(300)}`;
  voiceRun(['session-state'], JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: long }));
  check('...and its whole final reply when the turn ends, not the 160-character summary', relays().length === 1 && relays()[0].kind === 'reply' && relays()[0].text === long, JSON.stringify(relays()));
  check('...once: the session no longer owes a reply', !fs.existsSync(path.join(VOICE, 'awaiting-reply.json')));
  voiceRun(['session-state'], '{"hook_event_name":"Stop","last_assistant_message":"a later turn"}');
  check('...so a later turn is not sent again', relays().length === 1);
  clear();
  fs.writeFileSync(path.join(VOICE, 'awaiting-reply.json'), '{}');
  voiceRun(['session-state'], JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'y'.repeat(7000) }));
  check('a very long reply is cut, saying so', relays()[0].text.length < 6200 && /cut at 6000/.test(relays()[0].text));
  clear();
  r = voiceRun(['ask', 'user', 'Ship it today?']);
  const qid = (/\b(Q-[0-9A-Z]{5})\b/.exec(r.out) || [])[1];
  check('a question for the user reaches the Assistant too, with its id', !!qid && relays().length === 1 && relays()[0].kind === 'question' && relays()[0].question === qid && relays()[0].text === 'Ship it today?', JSON.stringify(relays()));
  clear();
  voiceRun(['ask', 'user', 'From the Assistant'], undefined, { GENLOCK_APP_PROJECTS: '/x/projects.json' });
  check('...but not one the Assistant asks itself', relays().length === 0);
  r = voiceRun(['answer', qid, 'yes', '--user-said', 'yes ship it']);
  check('the answer goes back with genlock answer', r.code === 0 && /answered/.test(r.out), r.out + r.err);
  // A Subassistant told this session something: the reply names it, so the app routes it there.
  clear();
  fs.writeFileSync(path.join(VOICE, 'awaiting-reply.json'), JSON.stringify({ at: Date.now(), from: '/ch/sub-a' }));
  voiceRun(['session-state'], '{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}');
  check('a prompt a session is stuck on goes to the Subassistant that asked', relays().length === 1 && relays()[0].to === '/ch/sub-a', JSON.stringify(relays()));
  clear();
  r = voiceRun(['ask', 'user', 'Which colour?']);
  check('...and so does a question it asks meanwhile', relays().length === 1 && relays()[0].kind === 'question' && relays()[0].to === '/ch/sub-a', JSON.stringify(relays()));
  clear();
  voiceRun(['session-state'], '{"hook_event_name":"Stop","last_assistant_message":"done for sub"}');
  check('...and its reply, once', relays().length === 1 && relays()[0].kind === 'reply' && relays()[0].to === '/ch/sub-a' && !fs.existsSync(path.join(VOICE, 'awaiting-reply.json')), JSON.stringify(relays()));
  clear();
  fs.writeFileSync(path.join(VOICE, 'awaiting-reply.json'), '{}');
  voiceRun(['session-state'], '{"hook_event_name":"Stop","last_assistant_message":"for tally"}');
  check('a reply Tally asked for names no Subassistant', relays().length === 1 && relays()[0].to === undefined);
  clear();
  fs.writeFileSync(path.join(VOICE, 'awaiting-reply.json'), '{}');
  voiceRun(['session-state'], '{"hook_event_name":"Stop","last_assistant_message":"sub reports up"}', { GENLOCK_APP_PROJECTS: '/x/projects.json', GENLOCK_APP_SCOPE: '/x/proj' });
  check('a Subassistant Tally delegated to reports its reply up', relays().length === 1 && relays()[0].text === 'sub reports up', JSON.stringify(relays()));
  clear();
  fs.writeFileSync(path.join(VOICE, 'awaiting-reply.json'), '{}');
  voiceRun(['session-state'], '{"hook_event_name":"Stop","last_assistant_message":"tally"}', { GENLOCK_APP_PROJECTS: '/x/projects.json' });
  check('...but Tally, at the top, reports to nobody', relays().length === 0);
  // A Subassistant holds its reply to Tally until the sessions it told have answered.
  clear();
  fs.writeFileSync(path.join(VOICE, 'awaiting-reply.json'), '{}');
  fs.writeFileSync(path.join(VOICE, 'owed-tok-q'), String(Date.now()));
  const subStop = (msg) => voiceRun(['session-state'], JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: msg }), { GENLOCK_APP_PROJECTS: '/x/projects.json', GENLOCK_APP_SCOPE: '/x/proj' });
  subStop('Passed it on');
  check('a Subassistant waiting on a session does not reply to Tally yet', relays().length === 0 && fs.existsSync(path.join(VOICE, 'awaiting-reply.json')));
  fs.writeFileSync(path.join(VOICE, 'owed-tok-q'), String(Date.now() - 31 * 60000));
  subStop('Both done');
  check('...and replies once it is no longer owed anything (or the wait is stale)', relays().length === 1 && relays()[0].text === 'Both done', JSON.stringify(relays()));
  fs.rmSync(path.join(VOICE, 'owed-tok-q'), { force: true });
  clear();
  const SUBDIR = path.join(path.dirname(VOICE), 'sub-paid');
  fs.mkdirSync(SUBDIR, { recursive: true });
  fs.writeFileSync(path.join(SUBDIR, `owed-${path.basename(VOICE)}`), String(Date.now()));
  fs.writeFileSync(path.join(VOICE, 'awaiting-reply.json'), JSON.stringify({ at: Date.now(), from: SUBDIR }));
  voiceRun(['session-state'], '{"hook_event_name":"Stop","last_assistant_message":"answered the sub"}');
  check('a session answering a Subassistant clears what it owed', !fs.existsSync(path.join(SUBDIR, `owed-${path.basename(VOICE)}`)));
  clear();
  fs.rmSync(path.join(VOICE, 'awaiting-reply.json'), { force: true });
}

/* ---- what a session is blocked on ----------------------------------------------- */

{
  const w = (name) => path.join(VOICE, name);
  const json = (name) => JSON.parse(fs.readFileSync(w(name), 'utf8'));
  voiceRun(['session-state'], '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sleep 60","description":"Run the slow tests"}}');
  check('a tool call starting records what the session is waiting on, labelled by its description', json('wait-tool.json').label === 'Run the slow tests');
  check('...and does not change what the session reports', stateOf().state !== 'holding');
  voiceRun(['session-state'], '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"description":"Watch the build"},"tool_response":{"backgroundTaskId":"bg1"}}');
  check('the call finishing clears it', !fs.existsSync(w('wait-tool.json')));
  check('a background task it started is remembered', json('wait-bg.json')[0].id === 'bg1' && json('wait-bg.json')[0].label === 'Watch the build');
  const transcript = w('t.jsonl');
  fs.writeFileSync(transcript, '{"x":1}\n');
  voiceRun(['session-state'], JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript }));
  check('ending the turn with it still running is holding, not done', stateOf().state === 'holding', JSON.stringify(stateOf()));
  fs.appendFileSync(transcript, JSON.stringify({ c: '<task-id>bg1</task-id>\n<output-file>/x</output-file>\n<status>completed</status>' }) + '\n');
  voiceRun(['session-state'], JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript }));
  check('once the transcript reports it finished, the turn is done', stateOf().state === 'done' && !fs.existsSync(w('wait-bg.json')), JSON.stringify(stateOf()));
  r = voiceRun(['wait', 'build', 'queue', '--queued']);
  const decl = fs.readdirSync(VOICE).filter((x) => x.startsWith('wait-decl-'));
  check('genlock wait declares a wait, keyed by its caller', r.code === 0 && decl.length === 1 && json(decl[0]).label === 'build queue' && json(decl[0]).kind === 'queued', r.err + decl.join());
  voiceRun(['wait', '--clear']);
  check('...and --clear ends it', !fs.readdirSync(VOICE).some((x) => x.startsWith('wait-decl-')));
  r = voiceRun(['wait', 'testing', 'the', 'town', '--state', 'testing']);
  const st = fs.readdirSync(VOICE).filter((x) => x.startsWith('wait-decl-'));
  check('genlock wait --state keeps the state and the agent\'s own text', r.code === 0 && st.length === 1 && json(st[0]).kind === 'testing' && json(st[0]).explicit === true && json(st[0]).label === 'testing the town', r.err + st.join());
  voiceRun(['wait', '--clear']);
  r = voiceRun(['wait', 'x', '--state', 'bogus']);
  check('genlock wait refuses a state the app does not know', r.code !== 0 && /unknown state/.test(r.err) && !fs.readdirSync(VOICE).some((x) => x.startsWith('wait-decl-')), r.err);
  fs.writeFileSync(w('wait-decl-999999.json'), '{"label":"old","kind":"running","since":1,"pid":999999}');
  voiceRun(['session-state'], '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{}}');
  check('a declared wait whose caller has gone ends at the next tool call', !fs.existsSync(w('wait-decl-999999.json')));
  voiceRun(['session-state'], '{"hook_event_name":"PostToolUse","tool_name":"Read"}');
}
{
  const r2 = g('wait', 'anything');
  check('genlock wait outside an app session does nothing and succeeds, so scripts can always call it', r2.code === 0, r2.err);
}

/* ---- the status line in app sessions -------------------------------------------- */

{
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-cfg-'));
  const ran = path.join(cfg, 'ran.json');
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `cat > "${ran}"; echo own line` } }));
  const usage = path.join(path.dirname(VOICE), 'usage.json');
  fs.rmSync(usage, { force: true });
  const input = '{"session_id":"s","rate_limits":{"five_hour":{"used_percentage":19,"resets_at":1762600800},"seven_day":{"used_percentage":38,"resets_at":1762900000}}}';
  r = voiceRun(['status-line'], input, { CLAUDE_CONFIG_DIR: cfg });
  check('the status line prints nothing in an app session', r.code === 0 && r.out === '', r.out + r.err);
  const u = fs.existsSync(usage) ? JSON.parse(fs.readFileSync(usage, 'utf8')) : {};
  check('...and saves the usage beside the channels for the app', u.session?.used === 19 && u.weekly?.resetsAt === 1762900000, JSON.stringify(u));
  check("...and still runs the user's own status line on the same input", fs.existsSync(ran) && fs.readFileSync(ran, 'utf8') === input);
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ statusLine: { command: 'genlock status-line' } }));
  r = voiceRun(['status-line'], '{}', { CLAUDE_CONFIG_DIR: cfg });
  check('...but never runs itself as the user\'s', r.code === 0 && r.out === '', r.err);
}
voiceRun(['session-state'], '{"hook_event_name":"UserPromptSubmit"}');
r = rv('session-state');
check('with no app listening it does nothing', r.code === 0, r.all);

/* ---- a session working off the record is told, out of sight, to take a task ---- */

const quiet = { GENLOCK_SESSION: '', CLAUDE_CODE_SESSION_ID: '', GENLOCK_APP_PROJECTS: '' };
const hook = (event, extra = {}, env = {}) => voiceRun(['session-state'], JSON.stringify({ hook_event_name: event, session_id: 'nudge-1', ...extra }), { ...quiet, ...env });
const nudged = (res) => { try { return /no task recorded/.test(JSON.parse(res.out).hookSpecificOutput.additionalContext); } catch { return false; } };
hook('UserPromptSubmit');
r = hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'seed' } });
check('reads are not nudged', r.code === 0 && r.out === '', r.out);
r = hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'cd /x && genlock new "t"' } });
check('genlock commands are not nudged', r.out === '', r.out);
r = hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'seed' } }, { GENLOCK_APP_PROJECTS: '/projects' });
check('the Assistant is never nudged', r.out === '', r.out);
r = hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'seed' } });
check('an untracked edit is nudged', r.code === 0 && nudged(r) && JSON.parse(r.out).hookSpecificOutput.hookEventName === 'PostToolUse', r.out + r.err);
check('...and the app still hears it is working', stateOf().state === 'working');
r = hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'make' } });
check('once per turn: a second change in the same turn is silent', r.out === '', r.out);
hook('UserPromptSubmit');
r = hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'make' } });
check('once per turn: the next prompt re-arms it', nudged(r), r.out);
const NT = idOf(run(RV, 'nudge-1', ['new', 'The nudge stays quiet for a session on a task', '--loose']));
hook('UserPromptSubmit');
r = hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'seed' } });
check('a session with a task is not nudged', NT && r.out === '', `${NT} ${r.out}`);
r = voiceRun(['session-state'], JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit' }), { ...quiet });
check('...nor one with no session id at all', r.out === '', r.out);
run(RV, 'nudge-1', ['abandon', NT, '--because', 'test done']);

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

/* ---- ranking and due dates ---------------------------------------------------- */
{

const RK = path.join(ROOT, 'rank');
fs.mkdirSync(RK);
git(RK, 'init', '-q');
git(RK, 'config', 'user.email', 't@e.st');
git(RK, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(RK, 'f'), 'x\n'); git(RK, 'add', '.'); git(RK, 'commit', '-qm', 'i');
const k = (...args) => run(RK, 'ranker', args);
const task = (title, ...extra) => idOf(k('new', title, '-r', `${title} returns 200`, '-c', 'node t.mjs', ...extra));
const goalId = (r) => (/\b(G-[0-9A-Z]{5})\b/.exec(r.out) || [])[1];
const snapR = () => JSON.parse(k('snapshot').out);
const taskOrder = () => snapR().tickets.filter((t) => t.rank).sort((a, b) => a.rank - b.rank).map((t) => t.id);

const TA = task('Alpha page loads'); const TB = task('Beta page loads'); const TC = task('Gamma page loads');
check('things rank in the order they arrive', taskOrder().join() === [TA, TB, TC].join(), taskOrder().join());
const TD = task('Delta page loads');
check('a new thing joins at the bottom', taskOrder().at(-1) === TD);

r = k('rank', TC, '--to', '1');
check('moving to the top', r.code === 0 && taskOrder().join() === [TC, TA, TB, TD].join(), r.all);
k('rank', TC, '--to', '3');
check('moving down lands in the place asked for', taskOrder().join() === [TA, TB, TC, TD].join(), taskOrder().join());
k('rank', TA, '--to', '99');
check('a place past the end means last', taskOrder().at(-1) === TA, taskOrder().join());
k('rank', TA, '--before', TB);
check('moving before another', taskOrder().join() === [TA, TB, TC, TD].join(), taskOrder().join());
const TE = task('Epsilon page loads');
check('a thing created after a move still joins at the bottom', taskOrder().at(-1) === TE);

const ranksOf = () => snapR().tickets.filter((t) => t.rank).map((t) => t.rank).sort((a, b) => a - b).join();
check('places are 1 to n with no ties or gaps', ranksOf() === '1,2,3,4,5', ranksOf());

r = k('rank', TA); check('rank with no place is refused', r.code !== 0 && /--to/.test(r.err), r.all);
r = k('rank', TA, '--to', '0'); check('place 0 is refused', r.code !== 0, r.all);
r = k('rank', TA, '--before', TA); check('before itself is refused', r.code !== 0, r.all);
r = k('rank', 'T-NOPE', '--to', '1'); check('an unknown id is refused', r.code !== 0, r.all);

// Two agents on two branches rank at once, and git's union merge keeps both sides' lines.
const RANKING = path.join(RK, '.genlock', 'records', 'ranking.jsonl');
const sharedLog = fs.readFileSync(RANKING, 'utf8');
k('rank', TD, '--to', '1'); const sideA = fs.readFileSync(RANKING, 'utf8').slice(sharedLog.length);
fs.writeFileSync(RANKING, sharedLog);
k('rank', TE, '--to', '1'); const sideB = fs.readFileSync(RANKING, 'utf8').slice(sharedLog.length);
fs.writeFileSync(RANKING, sharedLog + sideB + sideA);
const mergedOne = taskOrder().join();
fs.writeFileSync(RANKING, sharedLog + sideA + sideB);
check('a merge gives one order whichever side came first', taskOrder().join() === mergedOne, `${taskOrder().join()} vs ${mergedOne}`);
check('...and still no ties', ranksOf() === '1,2,3,4,5', ranksOf());

r = k('abandon', TB, 'not needed');
check('abandoning works here', r.code === 0, r.all);
check('closing a thing closes the gap', ranksOf() === '1,2,3,4', ranksOf());
check('a closed thing has no place', snapR().tickets.find((t) => t.id === TB).rank === null);
r = k('rank', TB, '--to', '1'); check('a closed thing cannot be ranked', r.code !== 0 && /closed/.test(r.err), r.all);

r = k('list', '--open');
check('the list shows the order', r.out.indexOf(taskOrder()[0]) < r.out.indexOf(taskOrder()[1]) && /#1 /.test(r.out), r.out);

const GA2 = goalId(k('goal', 'add', 'First goal', '--user-said', 'yes'));
const GB2 = goalId(k('goal', 'add', 'Second goal', '--user-said', 'yes', '--due', '2099-01-02'));
k('rank', GB2, '--to', '1');
r = k('goal', 'list');
check('goals have their own order', r.out.indexOf(GB2) < r.out.indexOf(GA2) && /#1 /.test(r.out), r.out);
check('goal add takes a due date', /due 2099-01-02/.test(r.out), r.out);
r = k('rank', GB2, '--before', TA); check('a goal cannot go before a task', r.code !== 0, r.all);
r = k('rank'); check('rank alone shows both orders', /Goals/.test(r.out) && /Tasks/.test(r.out), r.out);

r = k('due', TA, '2099-03-04');
const dueT = () => snapR().tickets.find((t) => t.id === TA);
check('a task takes a due date', r.code === 0 && dueT().due === '2099-03-04' && dueT().days_until > 0, r.all);
check('...shown in the list and on the ticket', /due 2099-03-04/.test(k('list').out) && /due 2099-03-04/.test(k('show', TA).out));
k('due', GA2, '2099-05-06');
check('a goal takes one too', snapR().goals.find((x) => x.id === GA2).due === '2099-05-06');
check('...shown on the goal', /due 2099-05-06/.test(k('goal', 'show', GA2).out));
r = k('due', TA, '2026-02-31'); check('a date that only looks real is refused', r.code !== 0 && /not a real date/.test(r.err), r.all);
r = k('due', TA, 'tomorrow'); check('a date in another format is refused', r.code !== 0, r.all);
r = k('due', TA, '--clear');
check('a due date can be cleared', r.code === 0 && dueT().due === null, r.all);
const TF = task('Zeta page loads', '--due', '2099-07-08');
check('new takes a due date', snapR().tickets.find((t) => t.id === TF).due === '2099-07-08');
r = k('new', 'Eta page loads', '-r', 'Eta page returns 200', '-c', 'node t.mjs', '--due', 'soon');
check('...and refuses a bad one', r.code !== 0, r.all);
k('due', GA2, '2099-05-06');
check('orient lists goals by rank', k('orient').out.indexOf(GB2) < k('orient').out.indexOf(GA2), k('orient').out);
const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
k('due', TC, soon);
check('orient warns of a task due soon', /Deadlines:[\s\S]*Gamma page loads/.test(k('orient').out), k('orient').out);

}

/* ---- short names --------------------------------------------------------------- */
{
  const SN = path.join(ROOT, 'names');
  fs.mkdirSync(SN);
  git(SN, 'init', '-q'); git(SN, 'config', 'user.email', 't@e.st'); git(SN, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(SN, 'f'), 'x\n'); git(SN, 'add', '.'); git(SN, 'commit', '-qm', 'i');
  const n = (...args) => run(SN, 'namer', args);
  const gid = (x) => (/\b(G-[0-9A-Z]{5})\b/.exec(x.out) || [])[1];
  const G1 = gid(n('goal', 'add', 'Ship the billing page', '--user-said', 'yes'));
  const T1 = idOf(n('new', 'Refund button works', '-r', 'Refund button returns 200', '-c', 'node t.mjs', '--goal', G1));
  const T2 = idOf(n('new', 'Refund button shows a receipt', '-r', 'Receipt page returns 200', '-c', 'node t.mjs'));
  const T3 = idOf(n('new', 'Refund button works', '-r', 'Second button returns 200', '-c', 'node t.mjs', '--loose'));
  const list = n('list').out;
  check('a task has a short name from its title, shown first', new RegExp(`refund-button-works \\(${T1}\\)`).test(list), list);
  check('...without filler words', /ship-billing-page/.test(n('goal', 'list').out), n('goal', 'list').out);
  check('...and no two share one', /refund-button-shows/.test(list) && /refund-button-works-2/.test(list), list);
  const sn = JSON.parse(n('snapshot').out);
  check('short names reach other tools', sn.goals[0].short === 'ship-billing-page' && sn.tickets.find((t) => t.id === T1).short === 'refund-button-works', JSON.stringify(sn.goals[0]));

  r = n('show', 'refund-button-shows');
  check('a short name works where an id goes', r.code === 0 && r.out.includes(T2), r.all);
  r = n('show', 'Refund Button Shows');
  check('...however it is said', r.code === 0 && r.out.includes(T2), r.all);
  r = n('show', 'receipt');
  check('...and so do words from the title', r.code === 0 && r.out.includes(T2), r.all);
  r = n('show', 'refund');
  check('several matches are named, not guessed', r.code !== 0 && /several/.test(r.err) && /refund-button-shows/.test(r.err), r.all);
  r = n('show', 'zebra');
  check('no match is still refused', r.code !== 0, r.all);
  r = n('continue', 'billing page');
  check('continue takes a goal by name', r.code === 0 && r.out.includes(G1), r.all);
  r = n('continue', 'receipt');
  check('continue takes a task by name', r.code === 0 && r.out.includes(T2), r.all);
  r = n('goal', 'show', 'billing');
  check('goal commands take names', r.code === 0 && r.out.includes(G1), r.all);
  r = n('rank', 'receipt', '--to', '1');
  check('rank takes names', r.code === 0 && r.out.indexOf(T2) < r.out.indexOf(T1), r.all);
  r = n('due', 'receipt', '2099-01-01');
  check('due takes names', r.code === 0, r.all);
  r = n('rank', 'refund', '--to', '1');
  check('a command will not act on an ambiguous name', r.code !== 0 && /several/.test(r.err), r.all);

  r = n('short', T3, 'second try');
  check('a name can be chosen', r.code === 0 && /second-try/.test(n('list').out) && n('show', 'second try').out.includes(T3), r.all);
  r = n('short', T2, 'second try');
  check('...but not one already in use', r.code !== 0 && /already/.test(r.err), r.all);
  r = n('short', T2, 'T-ABCDE');
  check('...or one that looks like an id', r.code !== 0, r.all);
  n('abandon', T2, 'not needed');
  n('abandon', T3, 'not needed');
  r = n('show', 'refund');
  check('a closed thing gives way to an open one with the same words', r.code === 0 && r.out.includes(T1), r.all);
  check('the same records give the same names', n('list').out === n('list').out);
  check('the agents are told', /Say short names, never ids/.test(fs.readFileSync(path.join(path.dirname(CLI), '..', 'agent', 'goals.md'), 'utf8')));
}

/* ---- the assistant ------------------------------------------------------------- */
{
  const AS = path.join(ROOT, 'assistant');
  const CH = path.join(AS, 'voice');
  const PA = path.join(AS, 'alpha'); const PB = path.join(AS, 'beta');
  for (const d of [CH, PA, PB]) fs.mkdirSync(d, { recursive: true });
  for (const d of [PA, PB]) {
    git(d, 'init', '-q'); git(d, 'config', 'user.email', 't@e.st'); git(d, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(d, 'f'), 'x\n'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'i');
  }
  const asEnv = (args) => {
    const env = { ...baseEnv, GENLOCK_APP_PROJECTS: path.join(AS, 'projects.json'), GENLOCK_APP_CHANNELS: CH };
    const x = spawnSync(process.execPath, [CLI, ...args], { cwd: AS, encoding: 'utf8', env });
    return { code: x.status, out: x.stdout || '', err: x.stderr || '', all: (x.stdout || '') + (x.stderr || '') };
  };
  r = run(AS, 'someone', ['overview']);
  check('overview only works in the Assistant', r.code !== 0 && /Assistant/.test(r.err), r.all);
  r = run(AS, 'someone', ['tell', 'alpha', 'hello']);
  check('a project agent cannot tell another what to do', r.code !== 0, r.all);

  fs.writeFileSync(path.join(AS, 'projects.json'), JSON.stringify([
    { path: PB, tier: 'later' }, { path: PA, tier: 'today' }, { path: path.join(AS, 'gone'), tier: 'soon' },
  ]));
  fs.writeFileSync(path.join(AS, 'sessions.json'), JSON.stringify({ open: [{ project: PA, token: 'tok-a' }] }));
  fs.mkdirSync(path.join(CH, 'tok-a'));
  fs.writeFileSync(path.join(CH, 'tok-a', 'state.json'), JSON.stringify({ state: 'waiting', message: 'May I run the migration?', at: Date.now() }));
  const pa = (...args) => run(PA, 'pa', args);
  const GX = (/\b(G-[0-9A-Z]{5})\b/.exec(pa('goal', 'add', 'Launch the site', '--user-said', 'yes').out) || [])[1];
  pa('new', 'Checkout page loads', '-r', 'Checkout page returns 200', '-c', 'node t.mjs', '--due', '2099-01-01', '--goal', GX);
  pa('ask', 'user', 'Which colour for the button?');

  r = asEnv(['overview']);
  check('overview puts TODAY first', r.code === 0 && r.out.indexOf('alpha') < r.out.indexOf('beta'), r.all);
  check('...skips a folder that has gone', !/gone/.test(r.out), r.out);
  check('...says a session needs the user, and what it said', /NEEDS THE USER/.test(r.out) && /May I run the migration/.test(r.out), r.out);
  check('...and nothing but sessions: no goals, tasks, due dates or questions', !/top goal|top task|Launch the site|Checkout page|DUE|Which colour|WAITING ON THE USER|TO REVIEW/.test(r.out), r.out);
  check('...and names a project with no session in a line', /No session open: beta/.test(r.out), r.out);
  const full = asEnv(['overview', 'alpha']);
  check('overview PROJECT still shows its goals, tasks and questions', /Launch the site/.test(full.out) && /Checkout page loads/.test(full.out) && /WAITING ON THE USER: Which colour/.test(full.out), full.out);

  r = asEnv(['overview']);
  check('looking again prints only that nothing changed', /Nothing has changed/.test(r.out) && /Unchanged: alpha/.test(r.out) && !/top goal/.test(r.out), r.out);
  pa('new', 'Search page loads', '-r', 'Search page returns 200', '-c', 'node t.mjs');
  fs.writeFileSync(path.join(CH, 'tok-a', 'state.json'), JSON.stringify({ state: 'done', message: 'The migration ran.', at: Date.now() }));
  r = asEnv(['overview']);
  check('a project that changed is shown again', /alpha/.test(r.out) && /The migration ran/.test(r.out), r.out);
  const quiet = asEnv(['overview', '--all']);
  check('--all shows everything regardless', /alpha/.test(quiet.out) && /The migration ran/.test(quiet.out) && !/Unchanged: alpha/.test(quiet.out), quiet.out);
  pa('ask', 'user', `${'A very long question '.repeat(30)}end`);
  r = asEnv(['overview']);
  check('a long line is clipped', r.out.split('\n').every((l) => l.length < 200) && !/end$/m.test(r.out), r.out);
  r = asEnv(['overview', 'alpha']);
  check('one project gives the full detail', /goal #1: \S+: Launch the site/.test(r.out) && /task #1/.test(r.out) && /due 2099-01-01/.test(r.out) && /Which colour/.test(r.out), r.out);
  r = asEnv(['overview', 'nope']);
  check('an unknown project is refused', r.code !== 0 && /alpha/.test(r.err), r.all);

  r = run(AS, 'someone', ['at', 'alpha', 'list']);
  check('a project agent cannot change another project', r.code !== 0 && /Assistant/.test(r.err), r.all);
  const TN = idOf(asEnv(['at', 'alpha', 'new', 'Cart page loads', '-r', 'Cart page returns 200', '-c', 'node t.mjs']));
  check('the Assistant can add a task to a project', !!TN && /Cart page loads/.test(pa('list').out), TN);
  r = asEnv(['at', 'alpha', 'rank', TN, '--to', '1']);
  check('...rank it', r.code === 0 && pa('rank', 'tasks').out.indexOf(TN) < pa('rank', 'tasks').out.indexOf('Checkout'), r.all);
  r = asEnv(['at', 'alpha', 'due', TN, '2099-02-03']);
  check('...and date it', r.code === 0 && /2099-02-03/.test(pa('show', TN).out), r.all);
  r = asEnv(['at', 'alpha', 'done', TN]);
  check('...but not call it done, which is for whoever did the work', r.code !== 0 && /does not run/.test(r.err), r.all);
  r = asEnv(['at', 'beta', 'list']);
  check('...and it refuses a project not set up, rather than set it up by accident', r.code !== 0 && !fs.existsSync(path.join(PB, '.genlock')), r.all);
  r = asEnv(['at', 'nope', 'list']);
  check('...or an unknown one', r.code !== 0 && /alpha/.test(r.err), r.all);

  fs.writeFileSync(path.join(AS, 'sessions.json'), JSON.stringify({ open: [{ project: PA, token: 'tok-a' }] }));
  asEnv(['overview']);
  const later = spawnSync(process.execPath, [CLI, 'overview'], { cwd: AS, encoding: 'utf8',
    env: { ...baseEnv, GENLOCK_APP_PROJECTS: path.join(AS, 'projects.json'), GENLOCK_APP_CHANNELS: CH, GENLOCK_SESSION: 'a-new-conversation' } });
  check('a new conversation gets everything, not "unchanged"', /^alpha \(.*\), (NO CHANGE|CHANGED)/m.test(later.stdout) && !/Unchanged: alpha/.test(later.stdout), later.stdout);
  check('...but still knows what changed since the last status, across the clear', /alpha \(\w+\), NO CHANGE since the last status/.test(later.stdout), later.stdout);
  check('...and asks for every project in the status, changed or not', /Report each one in your status, changed or not/.test(later.stdout), later.stdout);
  // A Subassistant scoped to alpha looks; Tally's own record of what it last reported must not move.
  const tallySeen = fs.readFileSync(path.join(AS, 'assistant-seen.json'), 'utf8');
  fs.writeFileSync(path.join(CH, 'tok-a', 'state.json'), JSON.stringify({ state: 'working', message: 'Seen only by the Subassistant.', at: Date.now() }));
  const sub = spawnSync(process.execPath, [CLI, 'overview'], { cwd: AS, encoding: 'utf8',
    env: { ...baseEnv, GENLOCK_APP_PROJECTS: path.join(AS, 'projects.json'), GENLOCK_APP_CHANNELS: CH, GENLOCK_APP_SCOPE: PA, GENLOCK_SESSION: 'a-sub' } });
  check('a Subassistant\'s status keeps its own record of what it reported', /Seen only by the Subassistant/.test(sub.stdout)
    && fs.readFileSync(path.join(AS, 'assistant-seen.json'), 'utf8') === tallySeen, sub.stdout);
  const tallyNext = spawnSync(process.execPath, [CLI, 'overview'], { cwd: AS, encoding: 'utf8',
    env: { ...baseEnv, GENLOCK_APP_PROJECTS: path.join(AS, 'projects.json'), GENLOCK_APP_CHANNELS: CH, GENLOCK_SESSION: 'tally-again' } });
  check('...so Tally still reports that project as changed', /alpha \(\w+\), CHANGED since the last status/.test(tallyNext.stdout), tallyNext.stdout);

  r = run(AS, 'someone', ['name', 'Juno']);
  check('a project agent cannot name the Assistant', r.code !== 0, r.all);
  r = asEnv(['name', 'Juno']);
  check('the Assistant takes a name', r.code === 0 && fs.readFileSync(path.join(AS, 'Assistant', 'name.txt'), 'utf8').trim() === 'Juno', r.all);
  r = asEnv(['name', 'a name that goes on far too long to fit']);
  check('...of a sensible length', r.code !== 0, r.all);

  r = run(AS, 'someone', ['remember', 'x', 'y']);
  check('a project agent cannot use the Assistant notes', r.code !== 0, r.all);
  r = asEnv(['remembered']);
  check('nothing saved yet', /Nothing saved/.test(r.out), r.all);
  r = asEnv(['remember', 'Billing plan', 'Ship invoices before refunds, because of the audit.']);
  check('remember saves outside the conversation', r.code === 0 && /Saved/.test(r.out), r.all);
  check('...which lists by title', /Billing plan/.test(asEnv(['remembered']).out));
  r = asEnv(['remembered', 'AUDIT']);
  check('...and finds by any word, in full', /Ship invoices before refunds/.test(r.out), r.out);
  check('...and says when nothing matches', /Nothing saved mentions/.test(asEnv(['remembered', 'zebra']).out));

  const OWN = path.join(AS, 'own-channel');
  fs.mkdirSync(OWN);
  const TR = path.join(AS, 'transcript.jsonl');
  fs.writeFileSync(TR, 'small\n');
  fs.writeFileSync(path.join(OWN, 'state.json'), JSON.stringify({ state: 'done', at: Date.now(), transcript: TR }));
  const own = (args) => {
    const x = spawnSync(process.execPath, [CLI, ...args], { cwd: AS, encoding: 'utf8',
      env: { ...baseEnv, GENLOCK_APP_PROJECTS: path.join(AS, 'projects.json'), GENLOCK_APP_CHANNELS: CH, GENLOCK_APP_CHANNEL: OWN } });
    return { code: x.status, out: x.stdout || '', err: x.stderr || '', all: (x.stdout || '') + (x.stderr || '') };
  };
  check('a short conversation gets no nudge', !/grown long/.test(own(['overview', '--all']).out));
  fs.writeFileSync(TR, Buffer.alloc(300 * 1024, 120));
  check('a long one is told to clear at the end of this turn', /grown long.*clear-context/.test(own(['overview', '--all']).out));
  // Opening a fresh session on a project, from the Assistant.
  const opens = () => fs.readdirSync(OWN).filter((f) => f.startsWith('open-') && f.endsWith('.json'));
  r = run(AS, 'someone', ['open', 'alpha']);
  check('a project agent cannot open sessions', r.code !== 0 && !opens().length, r.all);
  r = asEnv(['open', 'alpha']);
  check('open needs the Assistant\'s own channel', r.code !== 0 && !opens().length, r.all);
  r = own(['open', 'nope']);
  check('open refuses an unknown project and names the real ones', r.code !== 0 && /alpha/.test(r.err) && !opens().length, r.all);
  r = own(['open', 'ALPHA', '--prompt', 'continue billing page']);
  const req = opens().length === 1 ? JSON.parse(fs.readFileSync(path.join(OWN, opens()[0]), 'utf8')) : {};
  check('open leaves a request for the app, with the project and prompt', r.code === 0 && req.project === PA && req.prompt === 'continue billing page', r.all);
  for (const f of opens()) fs.rmSync(path.join(OWN, f));
  r = own(['open', 'beta']);
  const bare = opens().length === 1 ? JSON.parse(fs.readFileSync(path.join(OWN, opens()[0]), 'utf8')) : {};
  check('...and with no prompt, an empty session', r.code === 0 && bare.project === PB && bare.prompt === null, r.all);
  for (const f of opens()) fs.rmSync(path.join(OWN, f));

  r = own(['clear-context']);
  check('clearing needs a handoff', r.code !== 0, r.all);
  check('...and nothing clears until it asks', !fs.existsSync(path.join(OWN, 'clear-context.json')));
  r = own(['clear-context', 'Focused', 'on', 'billing']);
  const ask = JSON.parse(fs.readFileSync(path.join(OWN, 'clear-context.json'), 'utf8'));
  check('asking leaves the handoff for the app', r.code === 0 && /^Focused on billing/.test(ask.handoff), r.all);
  const savedAt = (/saved at (\S+)\./.exec(ask.handoff) || [])[1];
  check('...with a saved copy of the whole conversation', !!savedAt && fs.statSync(savedAt).size === 300 * 1024, ask.handoff);

  r = asEnv(['tell', 'ALPHA', 'please', 'run', 'it']);
  const told = fs.readdirSync(path.join(CH, 'tok-a')).filter((f) => f.startsWith('tell-'));
  check('tell leaves a message for the app to type in', r.code === 0 && told.length === 1
    && JSON.parse(fs.readFileSync(path.join(CH, 'tok-a', told[0]), 'utf8')).text === 'please run it', r.all);
  r = asEnv(['tell', 'beta', 'hello']);
  check('tell refuses a project with no session', r.code !== 0 && /no session/.test(r.err), r.all);
  r = asEnv(['tell', 'nope', 'hello']);
  check('tell refuses an unknown project and names the real ones', r.code !== 0 && /alpha/.test(r.err), r.all);
  r = run(AS, 'someone', ['tell', 'alpha', 'swap now', '--relay-yes', 'yes']);
  check('a project session cannot relay a yes', r.code !== 0 && !fs.existsSync(path.join(CH, 'tok-a', 'relay-yes.json')), r.all);
  r = asEnv(['tell', 'alpha', 'swap now', '--relay-yes', 'yes', '--for', 'everything']);
  check('tell --for names a real action', r.code !== 0 && /swap, launch/.test(r.err) && !fs.existsSync(path.join(CH, 'tok-a', 'relay-yes.json')), r.all);
  for (const f of fs.readdirSync(path.join(CH, 'tok-a')).filter((x) => x.startsWith('tell-'))) fs.rmSync(path.join(CH, 'tok-a', f));
  r = asEnv(['tell', 'alpha', 'Swap to the next goal', '--relay-yes', 'yeah go ahead and swap', '--for', 'swap']);
  const rg = JSON.parse(fs.readFileSync(path.join(CH, 'tok-a', 'relay-yes.json'), 'utf8'));
  const rt = fs.readdirSync(path.join(CH, 'tok-a')).filter((f) => f.startsWith('tell-'));
  const rtext = rt.length === 1 ? JSON.parse(fs.readFileSync(path.join(CH, 'tok-a', rt[0]), 'utf8')).text : '';
  check('the Assistant relays a yes: a grant in that session\'s channel, in the user\'s words', r.code === 0 && rg.user_said === 'yeah go ahead and swap' && rg.for === 'swap', r.all + JSON.stringify(rg));
  check('...and the message tells the session to use --relayed', /--relayed/.test(rtext) && /yeah go ahead and swap/.test(rtext), rtext);

  // The sweep: every session, spin-offs included, and what would tidy each one.
  r = run(AS, 'someone', ['sweep']);
  check('sweep only works in the Assistant', r.code !== 0 && /Assistant/.test(r.err), r.all);
  const TP = idOf(pa('new', 'Proved but open task', '-r', 'The proved page returns 200', '-c', 'node t.mjs'));
  pa('start', TP); pa('met', TP, '1', '--evidence', 'node t.mjs -> 200');
  const TS = idOf(run(PA, 'spin', ['new', 'Side page loads', '-r', 'The spin page returns 200', '-c', 'node t.mjs']));
  run(PA, 'spin', ['start', TS]); run(PA, 'spin', ['met', TS, '1', '--evidence', 'node t.mjs -> 200']); run(PA, 'spin', ['grill', TS, '--observed', 'node t.mjs -> 200', '--cause', 'measured', '--absence', 'n/a', '--assumption', 'none', '--falsify', 'a non-200']); run(PA, 'spin', ['done', TS]);
  const TO = idOf(run(PA, 'gone-session', ['new', 'Left behind page loads', '-r', 'The left page returns 200', '-c', 'node t.mjs']));
  run(PA, 'gone-session', ['start', TO]);
  fs.writeFileSync(path.join(AS, 'sessions.json'), JSON.stringify({
    open: [
      { project: PA, token: 'tok-a' },
      { project: PA, token: 'tok-s', spawn: { ticket: TS, session: 'spin', title: 'Side page loads', project: PA, prompt: 'x' } },
      { project: PA, token: 'tok-x', slot: 'abc123' },
    ],
    conversations: {},
  }));
  fs.writeFileSync(path.join(CH, 'tok-a', 'state.json'), JSON.stringify({ state: 'waiting', message: 'Shall I deploy?', at: Date.now(), session: 'pa' }));
  for (const t of ['tok-s', 'tok-x']) fs.mkdirSync(path.join(CH, t), { recursive: true });
  fs.writeFileSync(path.join(CH, 'tok-s', 'state.json'), JSON.stringify({ state: 'done', message: 'Finished.', at: Date.now() - 60000, session: 'spin' }));
  fs.writeFileSync(path.join(CH, 'tok-x', 'state.json'), JSON.stringify({ state: 'done', message: 'ok', at: Date.now() - 20 * 3600000, session: 'idle-one' }));
  r = asEnv(['sweep']);
  check('sweep lists every session the same way, a spawned one too', r.code === 0 && /\[main\] session:/.test(r.out)
    && new RegExp(`\\[${TS}\\] session:`).test(r.out) && /\[\+abc123\] session:/.test(r.out) && !/spin-off|extra session/.test(r.out), r.all);
  check('...with state and idle time', /NEEDS THE USER, last active 0m ago/.test(r.out) && /last active 20h ago/.test(r.out), r.out);
  check('...and the task it owns with its proof count', /Proved but open task \(in_progress, 1 of 1 proved\)/.test(r.out), r.out);
  check('...suggests answering a session that waits', /SUGGEST: it is waiting on the user/.test(r.out), r.out);
  check('...suggests running done on a task that is fully proved', new RegExp(`SUGGEST: every requirement of \\S+ is proved.*genlock done ${TP}`).test(r.out), r.out);
  check('...suggests closing a spin-off whose task is done, never swapping it onto the next goal', /SUGGEST: its task is finished: it can close/.test(r.out) && !/next goal/.test(r.out), r.out);
  check('...suggests closing a session idle for hours with no task', /SUGGEST: idle 20h with no task: close it/.test(r.out), r.out);
  check('...leaves out work in progress whose session is gone', !/Left behind|no open session owns it/.test(r.out), r.out);
  check('...counts what it found and changes nothing', /3 sessions open, \d+ suggestions\. Nothing has been changed/.test(r.out), r.out);
  r = asEnv(['sweep', '--orphans']);
  check('sweep --orphans flags work in progress whose session is gone', /SUGGEST: \S+ \(Left behind.*no open session owns it/.test(r.out), r.out);

  // The overview counts every open session and names each by its task, spawned ones included.
  fs.writeFileSync(path.join(CH, 'tok-a', 'state.json'), JSON.stringify({ state: 'working', at: Date.now(), session: 'pa' }));
  fs.writeFileSync(path.join(CH, 'tok-x', 'state.json'), JSON.stringify({ state: 'working', at: Date.now(), session: 'idle-one' }));
  r = asEnv(['overview', '--all']);
  check('overview counts every session by state', /^ {2}3 sessions: 2 working, 1 finished$/m.test(r.out), r.out);
  check('...lists all three, each by its task', (r.out.match(/^ {2}session on /gm) || []).length === 3
    && /session on \S+ \(Proved but open task\): working now/.test(r.out) && /session on \S+, finished: finished its last turn/.test(r.out)
    && /session on no task recorded: working now/.test(r.out), r.out);
  check('...and none is called a spin-off', !/spin-?off/i.test(r.out), r.out);
  r = asEnv(['overview', 'alpha']);
  check('one project shows the same count', /^ {2}3 sessions: 2 working, 1 finished$/m.test(r.out), r.out);
  const QA = (/\b(Q-[0-9A-Z]{5})\b/.exec(pa('ask', 'user', 'Answered already?').out) || [])[1];
  for (const f of ['old.md', 'new.md']) fs.writeFileSync(path.join(PA, f), 'x\n');
  const RV = (/\b(R-[0-9A-Z]{5})\b/.exec(pa('review', 'old.md', '--why', 'Already looked at?').out) || [])[1];
  pa('review', 'new.md', '--why', 'Is the new page right?');
  let before = asEnv(['overview', 'alpha']).out;
  const waiting = (out) => (out.match(/WAITING ON THE USER: /g) || []).length;
  check('an open question and review wait on the user', /Answered already/.test(before) && /2 to review/.test(before), before);
  pa('answer', QA, 'yes', '--user-said', 'yes'); pa('review', 'done', RV);
  r = asEnv(['overview', 'alpha']);
  check('...an answered question no longer does', !!QA && waiting(r.out) === waiting(before) - 1 && !/Answered already/.test(r.out), r.out);
  check('...nor a review marked done, while the open one stays', !!RV && /1 to review/.test(r.out), r.out);
  check('a status overview carries neither', !/Answered already|to review|TO REVIEW/i.test(asEnv(['overview', '--all']).out));

  // Routing by task: a project with several sessions is never guessed at.
  for (const t of ['tok-a', 'tok-s', 'tok-x']) for (const f of fs.readdirSync(path.join(CH, t)).filter((x) => x.startsWith('tell-'))) fs.rmSync(path.join(CH, t, f));
  const tells = (t) => fs.readdirSync(path.join(CH, t)).filter((f) => f.startsWith('tell-')).length;
  r = asEnv(['tell', 'alpha', 'which one gets this']);
  check('tell PROJECT with several sessions refuses', r.code !== 0 && tells('tok-a') + tells('tok-s') + tells('tok-x') === 0, r.all);
  check('...and lists each session by its task', /\[main\] on \S+ \(Proved but open task\)/.test(r.err) && new RegExp(`\\[${TS}\\]`).test(r.err) && /\[\+abc123\], no task recorded/.test(r.err), r.err);
  r = asEnv(['tell', TP, 'run done']);
  check('tell TASK reaches the session that owns it, not another', r.code === 0 && tells('tok-a') === 1 && tells('tok-s') === 0 && tells('tok-x') === 0, r.all);
  check('...and marks that session as owing the Assistant its reply', fs.existsSync(path.join(CH, 'tok-a', 'awaiting-reply.json')) && !fs.existsSync(path.join(CH, 'tok-x', 'awaiting-reply.json')));
  const shortTS = JSON.parse(pa('snapshot').out).tickets.find((t) => t.id === TS).short;
  r = asEnv(['tell', shortTS, 'wrap up']);
  check('...by its short name too', r.code === 0 && tells('tok-s') === 1, r.all);
  r = asEnv(['tell', 'alpha', 'run done', '--session', shortTS]);
  check('--session takes a task short name', r.code === 0 && tells('tok-s') === 2, r.all);
  r = asEnv(['tell', TO, 'pick it up']);
  check('tell TASK with no session working on it refuses and says how to open one', r.code !== 0 && /genlock open alpha/.test(r.err), r.all);
  r = asEnv(['tell', 'no-such-thing', 'hi']);
  check('tell an unknown name lists the projects', r.code !== 0 && /alpha/.test(r.err) && /beta/.test(r.err), r.all);

  r = asEnv(['tell', 'alpha', 'run done', '--session', TS]);
  check('tell can reach a spin-off by its task', r.code === 0 && fs.readdirSync(path.join(CH, 'tok-s')).some((f) => f.startsWith('tell-')), r.all);
  r = asEnv(['close', 'alpha', TS]);
  check('close needs the user\'s yes', r.code !== 0 && /user's yes/.test(r.err) && !fs.existsSync(path.join(CH, 'tok-s', 'close.json')), r.all);
  r = asEnv(['close', 'alpha', '+nope', '--user-said', 'yes']);
  check('close refuses a session that does not exist and names the open ones', r.code !== 0 && /main/.test(r.err) && /\+abc123/.test(r.err), r.all);
  fs.writeFileSync(path.join(CH, 'tok-x', 'state.json'), JSON.stringify({ state: 'working', at: Date.now() }));
  r = asEnv(['close', 'alpha', '+abc123', '--user-said', 'yes']);
  check('close refuses a session that is working', r.code !== 0 && /working/.test(r.err) && !fs.existsSync(path.join(CH, 'tok-x', 'close.json')), r.all);
  r = asEnv(['close', 'alpha', TS, '--user-said', 'yes close the side one']);
  check('close leaves a request for the app', r.code === 0 && fs.existsSync(path.join(CH, 'tok-s', 'close.json')), r.all);
  check('...carrying the user\'s words', JSON.parse(fs.readFileSync(path.join(CH, 'tok-s', 'close.json'), 'utf8')).user_said === 'yes close the side one');
  r = run(AS, 'someone', ['close', 'alpha', TS]);
  check('a project agent cannot close sessions', r.code !== 0, r.all);

  // A project's Subassistant: scoped to its project, and Tally delegates to it.
  const sessionsFile = path.join(AS, 'sessions.json');
  const savedSessions = fs.readFileSync(sessionsFile, 'utf8');
  const withSub = JSON.parse(savedSessions);
  withSub.open.push({ project: PA, slot: 'assistant', token: 'tok-sub' });
  fs.writeFileSync(sessionsFile, JSON.stringify(withSub));
  const SUB = path.join(CH, 'tok-sub');
  fs.mkdirSync(SUB, { recursive: true });
  const subEnv = (args) => {
    const env = { ...baseEnv, GENLOCK_APP_PROJECTS: path.join(AS, 'projects.json'), GENLOCK_APP_CHANNELS: CH, GENLOCK_APP_SCOPE: PA, GENLOCK_APP_CHANNEL: SUB };
    const x = spawnSync(process.execPath, [CLI, ...args], { cwd: PA, encoding: 'utf8', env });
    return { code: x.status, out: x.stdout || '', err: x.stderr || '', all: (x.stdout || '') + (x.stderr || '') };
  };
  for (const t of ['tok-a', 'tok-s', 'tok-x']) for (const f of fs.readdirSync(path.join(CH, t)).filter((x) => x.startsWith('tell-') || x === 'awaiting-reply.json')) fs.rmSync(path.join(CH, t, f));
  r = subEnv(['overview', '--all']);
  check('a Subassistant\'s overview shows only its project', r.code === 0 && /alpha/.test(r.out) && !/beta/.test(r.out), r.out);
  r = subEnv(['tell', 'beta', 'hello']);
  check('a Subassistant cannot tell another project anything', r.code !== 0 && /only in alpha/.test(r.err), r.all);
  r = subEnv(['at', 'beta', 'list']);
  check('...nor change its records', r.code !== 0 && /only in alpha/.test(r.err), r.all);
  r = subEnv(['open', 'beta']);
  check('...nor open a session there', r.code !== 0 && /only in alpha/.test(r.err), r.all);
  r = subEnv(['tell', TP, 'run done']);
  const aw = (t) => { try { return JSON.parse(fs.readFileSync(path.join(CH, t, 'awaiting-reply.json'), 'utf8')); } catch { return null; } };
  check('a Subassistant tells its sessions directly', r.code === 0 && tells('tok-a') === 1 && tells('tok-sub') === 0, r.all);
  check('...and the reply is marked to come back to it, not Tally', aw('tok-a')?.from === SUB && fs.existsSync(path.join(SUB, 'owed-tok-a')), JSON.stringify(aw('tok-a')));
  r = subEnv(['sweep']);
  check('...and does not list itself as a session to sweep', r.code === 0 && !/\+assistant/.test(r.out), r.out);
  fs.rmSync(path.join(CH, 'tok-a', 'awaiting-reply.json'));
  for (const f of fs.readdirSync(path.join(CH, 'tok-a')).filter((x) => x.startsWith('tell-'))) fs.rmSync(path.join(CH, 'tok-a', f));
  r = asEnv(['tell', TP, 'run done']);
  const subTold = fs.readdirSync(SUB).filter((f) => f.startsWith('tell-'));
  const subText = subTold.length === 1 ? JSON.parse(fs.readFileSync(path.join(SUB, subTold[0]), 'utf8')).text : '';
  check('Tally\'s tell to a project with a Subassistant goes to the Subassistant', r.code === 0 && tells('tok-a') === 0 && /^\[from Tally\] For alpha \[main\]/.test(subText) && /run done/.test(subText), r.all + subText);
  check('...which owes Tally the reply', !!aw('tok-sub') && !aw('tok-sub').from && !fs.existsSync(path.join(CH, 'tok-a', 'awaiting-reply.json')));
  r = asEnv(['tell', 'alpha', 'swap', '--session', TS, '--relay-yes', 'yes swap it', '--for', 'swap']);
  const relayText = fs.readdirSync(SUB).filter((f) => f.startsWith('tell-')).map((f) => JSON.parse(fs.readFileSync(path.join(SUB, f), 'utf8')).text).join('|');
  check('...with the user\'s yes as their words to relay on, not a grant to the Subassistant', r.code === 0 && /--relay-yes "yes swap it" --for swap/.test(relayText) && !fs.existsSync(path.join(SUB, 'relay-yes.json')), relayText);
  r = asEnv(['sweep']);
  check('Tally\'s sweep does not list Subassistants as sessions', r.code === 0 && !/\+assistant/.test(r.out), r.out);
  fs.writeFileSync(sessionsFile, savedSessions);
}

/* ---- completing goals ---------------------------------------------------------- */

{
  const repo = path.join(ROOT, 'completing');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  const f = (...args) => run(repo, 'parent', args);
  f('init', '--with-agents-md');
  let r = f('goal', 'completed');
  check('no completed goals says so', r.code === 0 && /no completed goals/.test(r.out), r.all);
  const add = (title) => (/\b(G-[0-9A-Z]{5})\b/.exec(f('goal', 'add', title, '--user-said', 'yes').all) || [])[1];
  const first = add('Ship the billing page');
  const second = add('Rewrite the importer');
  check('completing needs evidence', f('goal', 'done', first, '--user-said', 'y').code !== 0);
  r = f('goal', 'done', first, '--evidence', 'it is live', '--user-said', 'finished');
  check('a goal completes', r.code === 0, r.all);
  check('completing twice is refused', f('goal', 'done', first, '--evidence', 'x', '--user-said', 'y').code !== 0);
  f('goal', 'done', second, '--evidence', 'merged', '--user-said', 'finished');
  r = f('goal', 'completed');
  check('completed lists when and what showed it', /\d{4}-\d\d-\d\d .*billing/i.test(r.out) && /evidence: it is live/.test(r.out), r.all);
  check('completed is newest first', r.out.indexOf('importer') < r.out.indexOf('billing'), r.out);
  let snap = JSON.parse(f('snapshot').out);
  let goal = snap.goals.find((x) => x.id === first);
  check('snapshot carries the finish', goal.status === 'done' && !!goal.completed_at && goal.evidence === 'it is live' && goal.rank === null, JSON.stringify(goal));
  check('reopening needs the user', f('goal', 'reopen', first).code !== 0);
  r = f('goal', 'reopen', first, '--user-said', 'not finished after all');
  check('a completed goal reopens', r.code === 0, r.all);
  snap = JSON.parse(f('snapshot').out);
  goal = snap.goals.find((x) => x.id === first);
  check('reopened goal is active and ranked again', goal.status === 'active' && goal.completed_at === null && goal.evidence === null && goal.rank === 1, JSON.stringify(goal));
  check('reopening an active goal is refused', f('goal', 'reopen', first, '--user-said', 'y').code !== 0);
  r = f('goal', 'done', 'billing page', '--evidence', 'live now', '--user-said', 'done');
  check('reopened goal completes by its name', r.code === 0, r.all);
}

/* ---- naming what you create ---------------------------------------------------- */

{
  const repo = path.join(ROOT, 'naming');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  const f = (...args) => run(repo, 'parent', args);
  f('init', '--with-agents-md');
  const req = ['-r', 'the refund button exists on the page', '-c', 'manual: look at it'];
  let r = f('new', 'What the refund button actually does today', ...req);
  check('an unnamed task says to name it', /Give it a real one: genlock short T-/.test(r.out), r.all);
  r = f('new', 'The invoice export handles every currency we bill', '--short', 'invoice export', ...req);
  check('a task can be named as it opens', r.code === 0 && /invoice-export/.test(r.out), r.all);
  check('...with no nudge', !/Give it a real one/.test(r.out), r.all);
  r = f('new', 'Another export of the invoices for the auditors', '--short', 'invoice export', ...req);
  check('a taken name refuses before anything is created', r.code !== 0 && /already/.test(r.err), r.all);
  let snap = JSON.parse(f('snapshot').out);
  check('the refused task was not created', snap.tickets.length === 2, JSON.stringify(snap.tickets.map((t) => t.title)));
  check('snapshot says which names were chosen', snap.tickets.find((t) => t.short === 'invoice-export').named === true && snap.tickets.find((t) => t.short !== 'invoice-export').named === false);
  r = f('goal', 'add', 'Everyone gets paid on time every month', '--user-said', 'yes', '--short', 'payroll');
  check('a goal can be named as it is set', /goal payroll /.test(r.out) && !/Give it a real one/.test(r.out), r.all);
  r = f('goal', 'add', 'Refunds settle within two days', '--user-said', 'yes');
  check('an unnamed goal says to name it', /Give it a real one: genlock short G-/.test(r.out), r.all);
  r = f('goal', 'propose', 'A public status page for outages', '--why', 'asked twice', '--short', 'status page');
  check('a proposed goal can be named', /status-page/.test(f('goal', 'list', '--all').out), r.all);
  check('the agents are told to name things', /--short "NAME"/.test(fs.readFileSync(path.join(path.dirname(CLI), '..', 'agent', 'tickets.md'), 'utf8')));
}

/* ---- follow-ups and swapping in a fresh session --------------------------------- */

{
  const repo = path.join(ROOT, 'swaps');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  const me = (...args) => run(repo, 'swapper', args);
  const other = (...args) => run(repo, 'other', args);
  const req = ['-r', 'the refund button exists on the page', '-c', 'manual: look at it'];
  me('init', '--private');
  let r = me('followups');
  check('a session that started nothing has no follow-ups', r.code === 0 && /Nothing this session identified/.test(r.out), r.all);

  const G = goalOf(me('goal', 'add', 'Refunds settle within two days', '--user-said', 'yes', '--short', 'refunds'));
  const T = idOf(me('new', 'The refund button refunds the whole order', '--goal', G, ...req));
  me('start', T);
  const OT = idOf(other('new', 'The invoice export lists every currency', ...req));
  const P = goalOf(me('goal', 'propose', 'A public status page for outages', '--why', 'asked twice'));
  const Q = qOf(me('ask', 'user', 'Should partial refunds be allowed?', '--about', G));
  me('claim', T, '--path', 'src/refunds');
  r = me('spinoff', 'propose', 'The refund email names the amount', '--parent', T, '--why', 'separate', '--context', 'x',
    '--path', 'src/email', '--needs', 'none', '--blocks', 'none');
  const S = idOf(r);

  let fu = JSON.parse(me('followups', '--json').out);
  check('follow-ups list the goals it added and proposed', fu.goals.map((x) => x.id).sort().join() === [G, P].sort().join(), JSON.stringify(fu.goals));
  check('...the tasks it opened', fu.tickets.some((x) => x.id === T), JSON.stringify(fu.tickets));
  check('...but not another session\'s', !fu.tickets.some((x) => x.id === OT) && !JSON.parse(other('followups', '--json').out).goals.length);
  check('...the spin-off it proposed, and whether it is safe to launch', fu.spinoffs.some((x) => x.id === S && x.state === 'proposed' && x.safe === true), JSON.stringify(fu.spinoffs));
  check('...a spin-off is not listed again as a task', !fu.tickets.some((x) => x.id === S));
  check('...its questions to the user', fu.questions.some((x) => x.id === Q), JSON.stringify(fu.questions));
  check('...and requirements it has not proved', fu.unproved.some((x) => x.ticket === T && x.n === 1), JSON.stringify(fu.unproved));
  r = me('followups');
  check('...readably, with names rather than ids', /refunds: Refunds settle/.test(r.out) && /safe to launch/.test(r.out), r.out);
  me('answer', Q, 'Yes', '--user-said', 'yes');
  check('an answered question is no longer a follow-up', !JSON.parse(me('followups', '--json').out).questions.length);
  const snap = JSON.parse(me('snapshot').out);
  check('snapshot carries each session\'s follow-ups', snap.followups.swapper?.tickets.some((x) => x.id === T)
    && snap.followups.other?.tickets.some((x) => x.id === OT), JSON.stringify(Object.keys(snap.followups || {})));

  const CHAN = path.join(ROOT, 'swap-channel');
  const inApp = (args) => {
    const x = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...baseEnv, GENLOCK_SESSION: 'swapper', GENLOCK_APP_CHANNEL: CHAN } });
    return { code: x.status, out: x.stdout || '', err: x.stderr || '', all: (x.stdout || '') + (x.stderr || '') };
  };
  const asked = () => fs.existsSync(path.join(CHAN, 'swap.json'));
  r = inApp(['swap', 'refunds']);
  check('a swap needs no yes: it saves tokens, so it goes straight to the checkpoint check', r.code === 3 && !/user's yes/.test(r.err) && !asked(), r.all);
  r = inApp(['swap', 'refunds', '--user-said', 'yes, swap']);
  check('a swap refuses while a fresh session would be missing something', r.code === 3 && r.err.includes(`${T} has no latest`) && !asked(), r.all);
  me('update', T, 'Button wired, not yet proved');
  me('goal', 'next', G, 'Prove the refund button');
  r = inApp(['swap', 'nothing-like-this', '--user-said', 'yes']);
  check('a swap refuses a goal that is not there', r.code !== 0 && !asked(), r.all);
  check('before the swap this session holds a claim on its task', me('claims').out.includes(T), me('claims').out);
  r = inApp(['swap', 'refunds', '--user-said', 'yes, swap', '--uncommitted', 'none of mine']);
  check('a swap passes once everything is current', r.code === 0 && /fresh session on refunds/.test(r.out), r.all);
  const sw = asked() ? JSON.parse(fs.readFileSync(path.join(CHAN, 'swap.json'), 'utf8')) : {};
  check('...and asks the app for a fresh session that continues the goal', sw.goal === G && sw.prompt?.includes(`genlock continue ${G}`) && sw.user_said === 'yes, swap', JSON.stringify(sw));
  const projectLog = [path.join(repo, '.genlock', 'records', 'project.jsonl'), path.join(repo, '.git', 'genlock', 'records', 'project.jsonl')].find((x) => fs.existsSync(x));
  const recorded = fs.readFileSync(projectLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('...with a checkpoint and the user\'s words on record', recorded.some((e) => e.op === 'checkpoint') && recorded.some((e) => e.op === 'swap' && e.user_said === 'yes, swap' && e.goal === G));
  const handedT = JSON.parse(fs.readFileSync(projectLog.replace('project.jsonl', `${T}.jsonl`), 'utf8').trim().split('\n').at(-1) || '{}');
  check('a swap hands each open task it owned to the fresh session', handedT.op === 'handoff' && handedT.goal === G && sw.tickets?.includes(T), JSON.stringify(handedT) + JSON.stringify(sw.tickets));
  check('...releases its claim on it', !me('claims').out.includes(T), me('claims').out);
  check('...and the opening prompt tells the fresh session to take it', sw.prompt?.includes('genlock start ID') && sw.prompt.includes(T), sw.prompt);
  check('...and to begin at once, not ask the user whether to start', /begin on it at once/.test(sw.prompt) && !/ask the user whether to begin/.test(sw.prompt), sw.prompt);
  check('...a task another session owns is not handed', !sw.tickets?.includes(OT), JSON.stringify(sw.tickets));
  const fresh = (...args) => run(repo, 'fresh-one', args);
  r = fresh('start', T);
  check('the fresh session starts the handed task and owns it', r.code === 0 && /owner: fresh-one/.test(fresh('show', T).out), r.all + fresh('show', T).out);

  // A yes the Assistant relayed, for when the user is on the phone and cannot type in this pane.
  fs.rmSync(path.join(CHAN, 'swap.json'));
  const grant = (action, at = Date.now()) => fs.writeFileSync(path.join(CHAN, 'relay-yes.json'), JSON.stringify({ user_said: 'yes swap it', for: action, at }));
  r = inApp(['swap', 'refunds', '--relayed', '--uncommitted', 'none of mine']);
  check('swap --relayed with no yes relayed is refused', r.code !== 0 && /no yes has been relayed/.test(r.err) && !asked(), r.all);
  grant('launch');
  r = inApp(['swap', 'refunds', '--relayed', '--uncommitted', 'none of mine']);
  check('...as is one relayed for something else', r.code !== 0 && /was for launch/.test(r.err) && !asked(), r.all);
  grant('swap', Date.now() - 3 * 3600 * 1000);
  r = inApp(['swap', 'refunds', '--relayed', '--uncommitted', 'none of mine']);
  check('...or one hours old', r.code !== 0 && /two hours old/.test(r.err) && !asked(), r.all);
  grant('swap');
  r = inApp(['swap', 'refunds', '--relayed', '--user-said', 'yes', '--uncommitted', 'none of mine']);
  check('...or --relayed with --user-said too', r.code !== 0 && /not both/.test(r.err) && !asked(), r.all);
  me('update', T, 'Button wired, relayed swap next');
  me('goal', 'next', G, '--still-right');
  r = inApp(['swap', 'refunds', '--relayed', '--uncommitted', 'none of mine']);
  const rsw = asked() ? JSON.parse(fs.readFileSync(path.join(CHAN, 'swap.json'), 'utf8')) : {};
  check('swap --relayed with a yes relayed for it swaps', r.code === 0 && rsw.user_said === 'yes swap it' && rsw.relayed_by === 'assistant', r.all + JSON.stringify(rsw));
  const relog = fs.readFileSync(projectLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('...records the user\'s words and that the Assistant relayed them', relog.some((e) => e.op === 'swap' && e.user_said === 'yes swap it' && e.relayed_by === 'assistant'));
  check('...and uses the yes up', !fs.existsSync(path.join(CHAN, 'relay-yes.json')));
  r = me('swap', 'refunds', '--relayed', '--uncommitted', 'none of mine');
  check('outside the app --relayed is refused', r.code !== 0 && /Genlock app/.test(r.err), r.all);
  me('update', T, 'Still the same');
  me('goal', 'next', G, '--still-right');
  r = me('swap', 'refunds', '--user-said', 'ok', '--uncommitted', 'none of mine');
  check('outside the app a swap says what the user runs instead', r.code === 0 && /run \/clear, then say "continue refunds"/.test(r.out), r.all);

  // Done work closes on the user's word, rather than swapping onto the next goal.
  const closeAsked = () => fs.existsSync(path.join(CHAN, 'close.json'));
  r = inApp(['close', '--self']);
  check('close --self needs the user\'s word', r.code !== 0 && /user's word/.test(r.err) && !closeAsked(), r.all);
  me('start', T);
  me('update', T, 'Proved and finished');
  me('goal', 'next', G, '--still-right');
  fs.writeFileSync(path.join(repo, 'stray.txt'), 'x');
  r = inApp(['close', '--self', '--user-said', 'great, you can close']);
  check('close --self refuses while the records would lose something', r.code === 3 && !closeAsked(), r.all);
  r = inApp(['close', '--self', '--user-said', 'great, you can close', '--uncommitted', 'stray.txt is scratch']);
  const cl = closeAsked() ? JSON.parse(fs.readFileSync(path.join(CHAN, 'close.json'), 'utf8')) : {};
  check('close --self passes once everything is current, and asks the app to close this session', r.code === 0 && cl.by === 'self' && cl.user_said === 'great, you can close', r.all + JSON.stringify(cl));
  const closeLog = fs.readFileSync(projectLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('...with the user\'s words on record', closeLog.some((e) => e.op === 'close' && e.user_said === 'great, you can close'));
  r = me('close', '--self', '--user-said', 'ok', '--uncommitted', 'stray.txt is scratch');
  check('outside the app close --self says the user closes it by hand', r.code === 0 && /\/exit/.test(r.out), r.all);

  // A project session opens a fresh session itself, in its own project, with no yes.
  const BASE = path.join(ROOT, 'app-channels');
  const SELF = path.join(BASE, 'self');
  const seat = (name, o) => { fs.mkdirSync(path.join(BASE, name), { recursive: true }); fs.writeFileSync(path.join(BASE, name, 'session.json'), JSON.stringify(o)); };
  seat('self', { project: repo });
  seat('sub', { project: repo, slot: 'assistant' });
  seat('elsewhere', { project: path.join(ROOT, 'other-project') });
  const proj = (args, env = {}) => {
    const x = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...baseEnv, GENLOCK_SESSION: 'swapper', GENLOCK_APP_CHANNEL: SELF, ...env } });
    return { code: x.status, out: x.stdout || '', err: x.stderr || '', all: (x.stdout || '') + (x.stderr || '') };
  };
  const reqs = () => fs.readdirSync(SELF).filter((f) => f.startsWith('open-') && f.endsWith('.json')).map((f) => {
    const o = JSON.parse(fs.readFileSync(path.join(SELF, f), 'utf8')); fs.rmSync(path.join(SELF, f)); return o;
  });
  r = proj(['open', 'some-other-project', '--prompt', 'do it']);
  check('a project session cannot open a session in another project', r.code !== 0 && /only in its own project/.test(r.err) && !reqs().length, r.all);
  r = proj(['open']);
  check('...and an open with no prompt and no handoff is refused', r.code !== 0 && /--prompt/.test(r.err) && !reqs().length, r.all);
  r = proj(['open', '--prompt', 'Start ticket T-X: the opening cutscene']);
  let req2 = reqs();
  check('a project session opens one beside it in its own project, with no yes', r.code === 0 && req2.length === 1 && req2[0].project === repo
    && req2[0].prompt === 'Start ticket T-X: the opening cutscene' && req2[0].handoff === false && !fs.existsSync(path.join(SELF, 'close.json')), r.all + JSON.stringify(req2));
  check('...counting its own project\'s sessions, not a Subassistant or another project\'s', /\(2 of at most 4\)/.test(r.out), r.out);
  seat('two', { project: repo }); seat('three', { project: repo }); seat('four', { project: repo });
  r = proj(['open', '--prompt', 'more work']);
  check('...and is refused at the cap, pointing at a handoff instead', r.code !== 0 && /cap is 4/.test(r.err) && /--handoff/.test(r.err) && !reqs().length, r.all);
  me('start', T, '--take-over', '--user-said', 'take it back');
  check('(this session owns the task again before handing off)', /owner: swapper/.test(me('show', T).out), me('show', T).out);
  r = proj(['open', '--handoff']);
  check('a handoff refuses while a fresh session would be missing something', r.code === 3 && !reqs().length && !fs.existsSync(path.join(SELF, 'close.json')), r.all);
  me('update', T, 'Handing off: refund button next');
  me('goal', 'next', G, '--still-right');
  r = proj(['open', '--handoff', '--uncommitted', 'stray.txt is scratch']);
  req2 = reqs();
  const hc = fs.existsSync(path.join(SELF, 'close.json')) ? JSON.parse(fs.readFileSync(path.join(SELF, 'close.json'), 'utf8')) : {};
  check('a handoff goes through at the cap, with no yes, and closes this session', r.code === 0 && req2.length === 1 && req2[0].handoff === true && hc.by === 'self', r.all + JSON.stringify(req2) + JSON.stringify(hc));
  check('...its prompt hands over the task and says to begin at once', req2[0]?.prompt.includes(T) && /genlock start ID/.test(req2[0].prompt) && /begin on it at once/.test(req2[0].prompt), req2[0]?.prompt);
  const hlog = fs.readFileSync(projectLog.replace('project.jsonl', `${T}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('...and the task is handed off and its claim released', hlog.at(-1).op === 'handoff' && !me('claims').out.includes(T), JSON.stringify(hlog.at(-1)));
  r = run(repo, 'swapper', ['open', '--prompt', 'carry on'], undefined, { GENLOCK_TERMINAL: 'print' });
  const started = (r.out.match(/sh '([^']+start\.sh)'/) || [])[1];
  check('outside the app, open starts claude in a terminal or prints the command to', r.code === 0 && started && /claude -n .* "\$\(cat .*prompt\.txt/.test(fs.readFileSync(started, 'utf8')), r.all);
}

/* ---- report ------------------------------------------------------------------- */

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`${pass} passed, ${fails.length} failed, ${pass + fails.length} total`);
for (const x of fails) console.log(`  FAIL  ${x}`);
process.exit(fails.length ? 1 : 0);

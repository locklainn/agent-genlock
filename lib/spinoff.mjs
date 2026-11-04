/**
 * Spin-offs: move a tangent into its own session without the two getting in each other's
 * way. Three stages, because each answers a different question:
 *
 *   propose  Is there a tangent worth moving, and can it be shown to be separate? Records
 *            the ticket either way, so the work is never lost.
 *   launch   Did the user say yes? Re-checks, takes the claim and opens a terminal in one
 *            locked step, because the check may have gone stale while the user thought.
 *   park     Not now. The ticket stays.
 *
 * The safety check fails closed. "Nothing collides" only means something if the parent has
 * declared what it is doing, so an undeclared parent is a refusal rather than a pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { die, emit, refuse, dirtyFiles, repoRoot, resolveId, identity } from './store.mjs';
import { lintTitle } from './lint.mjs';
import { LATEST_MAX, loadTicket, openTicket, requireTicket, OPEN_STATES } from './tickets.mjs';
import {
  claimFor, collisions, describeCollision, liveDir, normalize, overlaps, withLock, writeClaim, releaseTicket,
} from './claims.mjs';

const isNone = (v) => /^none\.?$/i.test(String(v || '').trim());

/** Every reason this cannot be shown to be separate. Empty means safe to offer. */
export function safetyProblems(t) {
  const s = t.spinoff || {};
  const problems = [];
  const parent = t.parent ? loadTicket(t.parent) : null;
  const parentDone = parent && !OPEN_STATES.has(parent.status);

  if (!s.paths?.length) problems.push('it declares no paths, so nothing shows it stays out of the way');

  if (!s.parent_idle && !parentDone) {
    if (!parent) problems.push('no parent ticket, and no --parent-idle saying the parent session is writing nothing');
    else if (!claimFor(parent.id))
      problems.push(`the parent ${parent.id} has not declared what it is touching, so "no overlap" `
        + `would prove nothing. First: genlock claim ${parent.id} --path ...`);
  }

  if (!isNone(s.needs) && !parentDone)
    problems.push(`it needs the parent's unfinished work (${s.needs}), so it would start and then wait`);
  if (!isNone(s.blocks))
    problems.push(`the parent needs its result (${s.blocks}), so the parent would stop and wait for it`);

  for (const c of collisions({ paths: s.paths || [], resources: s.resources || [], key: t.id }))
    problems.push(describeCollision(c));

  const dirty = dirtyFiles().filter((f) => (s.paths || []).some((p) => overlaps(p, f)));
  if (dirty.length)
    problems.push(`uncommitted changes are already in its paths: ${dirty.slice(0, 5).join(', ')}`);

  return problems;
}

function printVerdict(t, problems) {
  if (!problems.length) {
    console.log(`SAFE to offer. ${t.id} stays out of the parent's way.`);
    console.log('Ask the user, in one line, and launch only on a yes:');
    console.log(`  "I can kick off a spinoff so you can work from there: ${t.title}."`);
    console.log(`Then: genlock spinoff launch ${t.id} --user-said "..."   or   genlock spinoff park ${t.id} "why"`);
    return;
  }
  console.log(`NOT SAFE to run alongside this session. ${t.id} is recorded but cannot launch yet:`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log('Do not offer a launch. Tell the user the ticket is parked and why, or narrow it:');
  console.log(`  genlock spinoff amend ${t.id} --path ... --needs none --blocks none`);
}

function propose(a) {
  const title = a._[1];
  if (!title) die('spinoff propose needs a title:  genlock spinoff propose "the outcome" --parent T-XXXXX ...');
  const problems = lintTitle(title).map((p) => ['title', p]);
  if (!a.why) problems.push(['--why', 'why this is worth its own session rather than a line in this one']);
  if (!a.path?.length) problems.push(['--path', 'what the spin-off will touch. Repeat for each path or glob']);
  if (a.needs === undefined) problems.push(['--needs', "what it needs from the parent's unfinished work, or \"none\""]);
  if (a.blocks === undefined) problems.push(['--blocks', 'what the parent needs from it before it can continue, or "none"']);
  if (!a.parent && !a.parent_idle) problems.push(['--parent', 'the ticket this came from, or --parent-idle if this session is writing nothing']);
  if (!a.context) problems.push(['--context', 'what the new agent needs to know that the goal and parent ticket do not say']);
  if (a.context && String(a.context).length > LATEST_MAX)
    problems.push(['--context', `${String(a.context).length} characters; the limit is ${LATEST_MAX}. Point at files with \`genlock ref\` on the new ticket`]);
  if (problems.length) refuse('refusing to propose this spin-off.', problems);

  let parent = null;
  if (a.parent) {
    parent = resolveId(a.parent, 'T-', 'ticket');
    if (!parent) die(`no parent ticket '${a.parent}' in this repository`);
  }
  const goal = parent ? loadTicket(parent).goal : null;
  const t0 = openTicket({ title, draft: true, goal, parent, owner: 'unassigned' });
  emit(t0.id, 'spinoff', {
    fields: {
      state: 'proposed', why: String(a.why).trim(), paths: a.path.map(normalize),
      resources: a.resource || [], needs: a.needs, blocks: a.blocks, parent_idle: !!a.parent_idle,
    },
  });
  emit(t0.id, 'update', { text: String(a.context).trim() });
  for (const d of a.decisions || []) emit(t0.id, 'decide', { text: d });
  if (parent) emit(parent, 'note', { text: `spun off ${t0.id}: ${title}` });

  const t = loadTicket(t0.id);
  const unsafe = safetyProblems(t);
  printVerdict(t, unsafe);
  if (unsafe.length) process.exit(4);
}

function requireSpinoff(a, cmd) {
  a._.shift();
  const t = requireTicket(a, `spinoff ${cmd}`);
  if (!t.spinoff) die(`${t.id} is not a spin-off`);
  return t;
}

function check(a) {
  const t = requireSpinoff(a, 'check');
  const unsafe = safetyProblems(t);
  printVerdict(t, unsafe);
  if (unsafe.length) process.exit(4);
}

function amend(a) {
  const t = requireSpinoff(a, 'amend');
  const fields = {};
  if (a.path?.length) fields.paths = a.path.map(normalize);
  if (a.resource?.length) fields.resources = a.resource;
  if (a.needs !== undefined) fields.needs = a.needs;
  if (a.blocks !== undefined) fields.blocks = a.blocks;
  if (!Object.keys(fields).length) die('amend needs --path, --resource, --needs or --blocks');
  emit(t.id, 'spinoff', { fields });
  const after = loadTicket(t.id);
  const unsafe = safetyProblems(after);
  printVerdict(after, unsafe);
  if (unsafe.length) process.exit(4);
}

function park(a) {
  const t = requireSpinoff(a, 'park');
  const why = a._.slice(1).join(' ').trim();
  if (!why) die(`park needs a reason:  genlock spinoff park ${t.id} "..."`);
  emit(t.id, 'spinoff', { fields: { state: 'parked', parked_because: why } });
  console.log(`${t.id} parked -- ${why}\nThe ticket stays. Later: genlock spinoff check ${t.id}`);
}

/* -------------------------------------------------------------------- launch */

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function promptFor(t, session) {
  const s = t.spinoff;
  return [
    `You are a spin-off session for ticket ${t.id}: ${t.title}.`,
    `Another agent${t.parent ? ` (ticket ${t.parent})` : ''} is still working in this repository, so stay out of its way.`,
    '',
    `Start here: run \`genlock continue ${t.id}\`. It is a claim about the repository, not a source, so check anything load-bearing.`,
    `Then write the requirements, because this ticket has none yet: \`genlock req ${t.id} -r "..." -c "..."\`.`,
    '',
    `You hold: ${[...s.paths, ...(s.resources || []).map((r) => `resource:${r}`)].join(', ')}.`,
    `To touch anything else, extend first with \`genlock claim ${t.id} --path ...\`. If that is refused, someone holds it: do not wait and do not work around it. Record what you need with \`genlock note\` and carry on with what you can.`,
    '',
    'Stage and commit by path only. Do not use git stash, git checkout, git switch, git restore, git clean, git reset --hard, git add -A or git commit -a: other uncommitted work is in this tree.',
    `Keep the ticket's latest current with \`genlock update ${t.id} "..."\`. When it is finished, \`genlock done ${t.id}\` must pass before you call it done.`,
    '',
    'Now say in one or two lines what you are picking up, and ask the user whether to begin.',
  ].join('\n');
}

const WINDOWS = process.platform === 'win32';
const psq = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Writes a script for this platform that starts the session, and returns how to run it. */
function writeLauncher(t, session, a) {
  const dir = path.join(liveDir(), 'spinoffs', t.id);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // The new terminal may not have genlock on PATH, and the prompt depends on it.
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
  const promptFile = path.join(dir, 'prompt.txt');
  fs.writeFileSync(promptFile, promptFor(t, session));
  const claude = process.env.GENLOCK_CLAUDE_CMD || 'claude';
  const name = `${t.id} ${t.title}`.slice(0, 60);

  if (WINDOWS) {
    fs.writeFileSync(path.join(bin, 'genlock.cmd'), `@"${process.execPath}" "${cli}" %*\r\n`);
    const script = path.join(dir, 'start.ps1');
    fs.writeFileSync(script, [
      `Set-Location -LiteralPath ${psq(repoRoot())}`,
      `$env:PATH = ${psq(`${bin};`)} + $env:PATH`,
      `$env:GENLOCK_SESSION = ${psq(session)}`,
      `& ${claude} --session-id ${psq(session)} -n ${psq(name)}${a.worktree ? ` -w ${psq(t.id)}` : ''} (Get-Content -Raw -LiteralPath ${psq(promptFile)})`,
      '',
    ].join('\r\n'));
    return { script, command: `powershell -NoExit -ExecutionPolicy Bypass -File "${script}"` };
  }

  const shim = path.join(bin, 'genlock');
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(cli)} "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const script = path.join(dir, 'start.sh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `cd ${shq(repoRoot())} || exit 1`,
    `export PATH=${shq(bin)}:"$PATH"`,
    `export GENLOCK_SESSION=${shq(session)}`,
    `exec ${claude} --session-id ${shq(session)} -n ${shq(name)}${a.worktree ? ` -w ${shq(t.id)}` : ''} "$(cat ${shq(promptFile)})"`,
    '',
  ].join('\n'));
  fs.chmodSync(script, 0o755);
  return { script, command: `sh ${shq(script)}` };
}

const onPath = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;

/** Returns true if a window opened. Anywhere it cannot, the command is printed instead. */
function openTerminal({ script, command }) {
  const how = process.env.GENLOCK_TERMINAL || { darwin: process.env.TERM_PROGRAM === 'iTerm.app' ? 'iterm' : 'terminal', win32: 'windows', linux: 'linux' }[process.platform] || 'print';
  const asApple = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    if (how === 'terminal') {
      execFileSync('osascript', ['-e', `tell application "Terminal" to do script "${asApple}"`,
        '-e', 'tell application "Terminal" to activate'], { stdio: 'ignore', timeout: 15000 });
      return true;
    }
    if (how === 'iterm') {
      execFileSync('osascript', ['-e', `tell application "iTerm" to create window with default profile command "${asApple}"`,
        '-e', 'tell application "iTerm" to activate'], { stdio: 'ignore', timeout: 15000 });
      return true;
    }
    if (how === 'windows') {
      execFileSync('cmd', ['/c', 'start', '', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script],
        { stdio: 'ignore', timeout: 15000 });
      return true;
    }
    if (how === 'linux') {
      const terminals = [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xterm', '-e']];
      const found = terminals.find(([bin]) => onPath(bin));
      if (!found) return false;
      spawn(found[0], [found[1], 'sh', script], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
  } catch { /* fall through to printing the command */ }
  return false;
}

function hooksInstalled() {
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    try { if (fs.readFileSync(path.join(repoRoot(), f), 'utf8').includes('guard')) return true; } catch { /* absent */ }
  }
  try {
    return fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8').includes('genlock');
  } catch { return false; }
}

function launch(a) {
  const t = requireSpinoff(a, 'launch');
  const said = String(a.user_said || '').trim();
  if (!said)
    die('launch requires --user-said: the user\'s own yes. Launching opens a window and spends their\n'
      + '     usage in parallel, so it is their call. Offer it and wait for an answer.');
  if (t.spinoff.state === 'launched') {
    if (claimFor(t.id)) die(`${t.id} is already running, as session ${t.spinoff.session}`);
    // The earlier session has lapsed, so this launch takes the ticket over.
  }
  if (!OPEN_STATES.has(t.status)) die(`${t.id} is ${t.status}; there is nothing to launch`);

  const session = randomUUID();
  // Check and claim together: anything else can slip in between the two.
  withLock(() => {
    const unsafe = safetyProblems(t);
    if (unsafe.length) {
      printVerdict(t, unsafe);
      process.exit(4);
    }
    writeClaim({
      key: t.id, session, paths: t.spinoff.paths, resources: t.spinoff.resources || [], strict: true,
    });
  });

  const launcher = writeLauncher(t, session, a);
  const opened = openTerminal(launcher);
  emit(t.id, 'spinoff', { fields: { state: 'launched', session, user_said: said, launched_by: identity() || 'unknown' } });
  emit(t.id, 'assign', { owner: session });

  if (!hooksInstalled())
    console.log('WARNING: the guard hook is not installed here, so its claims are honour-system. `genlock install --hooks`.');
  if (opened) console.log(`[STATUS-UPDATE] ${t.id} launched in a new terminal window. Its paths are claimed.`);
  else console.log(`${t.id} is claimed. No window could be opened from here. Run this in a terminal:\n  ${launcher.command}`);
}

const SUBS = { propose, check, amend, park, launch };

export function cmdSpinoff(a) {
  const sub = a._[0];
  if (!SUBS[sub]) die('spinoff needs one of: propose check amend park launch');
  SUBS[sub](a);
}

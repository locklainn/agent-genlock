#!/usr/bin/env node
/* Session requests are confirmed, and fall back when nobody confirms them. A swap, an open, a
   handoff and a spin-off launch each wait for the app's receipt; when the app refuses or never
   answers, genlock takes the request back and opens the session in a terminal window itself,
   without asking anyone. A fake app (a second process) plays the Mac app's part.
   Run: node tests/receipts.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-receipts-test-')));
const REPO = path.join(ROOT, 'repo');
const OTHER = path.join(ROOT, 'other');
const VOICE = path.join(ROOT, 'voice');
const CHAN = path.join(VOICE, 'me');
const TERM = path.join(ROOT, 'terminal.log');
for (const d of [REPO, OTHER, CHAN]) fs.mkdirSync(d, { recursive: true });
for (const d of [REPO, OTHER]) spawnSync('git', ['init', '-q'], { cwd: d });
fs.writeFileSync(path.join(CHAN, 'session.json'), JSON.stringify({ project: REPO }));
fs.writeFileSync(path.join(ROOT, 'projects.json'), JSON.stringify([{ path: REPO }, { path: OTHER }]));

const env = { ...process.env, HOME: ROOT, GENLOCK_HOME: path.join(ROOT, 'app'), GENLOCK_SESSION: 'swapper', GENLOCK_AGENT_PID: '0',
  GENLOCK_TERMINAL: 'print', GENLOCK_RECEIPT_MS: '700', GENLOCK_SESSION_CAP: '12' };
delete env.CLAUDE_CODE_SESSION_ID; delete env.GENLOCK_APP_CHANNEL; delete env.GENLOCK_APP_PROJECTS;

const g = (args, extra = {}, cwd = REPO) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const ok = (args, extra) => { const r = g(args, extra); assert.equal(r.code, 0, `${args.join(' ')}\n${r.all}`); return r.out; };
const inApp = (args, extra = {}) => g(args, { GENLOCK_APP_CHANNEL: CHAN, ...extra });
const files = () => fs.readdirSync(CHAN).filter((f) => f !== 'session.json');
const clean = () => { for (const f of files()) fs.rmSync(path.join(CHAN, f), { force: true }); fs.rmSync(TERM, { force: true }); };
const recorded = () => (fs.existsSync(TERM) ? fs.readFileSync(TERM, 'utf8') : '');
const scriptOf = (log) => fs.readFileSync(/sh '([^']+)'/.exec(log)[1], 'utf8');
const closeJSON = () => (fs.existsSync(path.join(CHAN, 'close.json')) ? JSON.parse(fs.readFileSync(path.join(CHAN, 'close.json'), 'utf8')) : null);

/**
 * Plays the app: answers each request in CHAN as MODE says. ok: opens (removes open/spawn files,
 * leaves swap.json as the app does until the turn ends) and writes a receipt. cap / refuse: says
 * no. silent-take: takes the file and writes nothing, like an app from before receipts.
 */
function fakeApp(mode) {
  const code = `
    const fs = require('fs'), path = require('path');
    const [chan, mode] = process.argv.slice(1);
    const seen = new Set();
    setInterval(() => {
      for (const f of fs.readdirSync(chan)) {
        if (!/^(open-|spawn-).*\\.json$/.test(f) && f !== 'swap.json') continue;
        let req; try { req = JSON.parse(fs.readFileSync(path.join(chan, f), 'utf8')); } catch { continue; }
        if (seen.has(req.id)) continue;
        seen.add(req.id);
        if (f !== 'swap.json') fs.rmSync(path.join(chan, f), { force: true });
        if (mode === 'silent-take') continue;
        const r = mode === 'ok' ? { ok: true } : mode === 'cap' ? { ok: false, why: 'repo already has 12 open (the cap is 12).', code: 'cap' } : { ok: false, why: 'not one of your projects on disk' };
        fs.writeFileSync(path.join(chan, 'receipt-' + req.id + '.json'), JSON.stringify(r));
      }
    }, 50);`;
  const p = spawn(process.execPath, ['-e', code, CHAN, mode], { stdio: 'ignore' });
  return () => p.kill();
}

let T;
test('set up: a goal and a task this session owns', () => {
  ok(['goal', 'add', 'Refunds settle in a day', '--short', 'refunds', '--user-said', 'refunds']);
  T = /\b(T-[0-9A-Z]{5})\b/.exec(ok(['new', 'The refund button refunds the last order', '--short', 'button', '--goal', 'refunds', '-r', 'clicking the refund button refunds the last order', '-c', 'manual: click it']))[1];
  ok(['start', T]);
  ok(['update', T, 'Button wired']);
});

const owned = () => { ok(['start', T, '--take-over', '--user-said', 'mine again']); ok(['update', T, 'Button wired, carrying on']); };

test('swap: the app hears it at once, so it waits for the turn to end, and nothing falls back', async () => {
  clean(); owned();
  const stop = fakeApp('ok');
  try {
    const r = inApp(['swap', 'refunds', '--uncommitted', 'none']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /When this turn ends the app opens a fresh session on refunds/);
    assert.ok(files().includes('swap.json'), 'the request stays for the app to act on at turn end');
    assert.equal(recorded(), '', 'no terminal window');
    assert.ok(!files().some((f) => f.startsWith('receipt-')), 'genlock consumed its receipt');
  } finally { stop(); }
});

test('swap with no app answering: taken back, opened in a terminal window, and this tab told to close', () => {
  clean(); owned();
  const r = inApp(['swap', 'refunds', '--uncommitted', 'none'], { GENLOCK_TERMINAL: `record:${TERM}` });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /did not answer within 1s/);
  assert.ok(!files().includes('swap.json'), 'the request was withdrawn, so a late app cannot swap as well');
  const script = scriptOf(recorded());
  assert.ok(script.includes(`cd '${REPO}'`) && /claude -n 'refunds'/.test(script), script);
  assert.match(fs.readFileSync(script.match(/cat '([^']+prompt\.txt)'/)[1], 'utf8'), new RegExp(`genlock continue G-`));
  assert.equal(closeJSON()?.by, 'self', 'the app may close the old tab: the fresh one exists');
  assert.match(r.out, /Terminal window/);
});

test('swap with no app and no window either: the old session stays and the agent gets the command', () => {
  clean(); owned();
  const r = inApp(['swap', 'refunds', '--uncommitted', 'none']);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /No window could be opened either, so this conversation stays open/);
  assert.match(r.out, /sh '.*start\.sh'/);
  assert.equal(closeJSON(), null, 'nothing closes when nothing opened');
});

test('open --prompt: opened by the app, no fallback', () => {
  clean();
  const stop = fakeApp('ok');
  try {
    const r = inApp(['open', '--prompt', 'look at the refund copy']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /a fresh session is opening on repo beside this one/);
    assert.equal(recorded(), '');
  } finally { stop(); }
});

test('open --prompt refused at the cap: no fallback around the user\'s cap, and the agent is told to ask', () => {
  clean();
  const stop = fakeApp('cap');
  try {
    const r = inApp(['open', '--prompt', 'look at the refund copy'], { GENLOCK_TERMINAL: `record:${TERM}` });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /the cap is 12/);
    assert.match(r.out, /--over-cap/);
    assert.equal(recorded(), '', 'the cap is the user\'s rule: no window opened around it');
  } finally { stop(); }
});

test('open --prompt refused for another reason: opened in a terminal window instead', () => {
  clean();
  const stop = fakeApp('refuse');
  try {
    const r = inApp(['open', '--prompt', 'look at the refund copy'], { GENLOCK_TERMINAL: `record:${TERM}` });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /the app refused it: not one of your projects/);
    assert.ok(scriptOf(recorded()).includes(`cd '${REPO}'`));
    assert.equal(closeJSON(), null, 'a plain open never closes the asker');
  } finally { stop(); }
});

test('open --prompt with no app: withdrawn and opened in a terminal window', () => {
  clean();
  const r = inApp(['open', '--prompt', 'look at the refund copy'], { GENLOCK_TERMINAL: `record:${TERM}` });
  assert.equal(r.code, 0, r.all);
  assert.ok(!files().some((f) => f.startsWith('open-')), 'withdrawn');
  assert.ok(scriptOf(recorded()).includes(`cd '${REPO}'`));
});

test('open OTHER --prompt with no app opens the window in the other project, not this one', () => {
  clean();
  const r = inApp(['open', 'other', '--prompt', 'start the other thing'], { GENLOCK_TERMINAL: `record:${TERM}`, GENLOCK_APP_PROJECTS: '' });
  assert.equal(r.code, 0, r.all);
  assert.ok(scriptOf(recorded()).includes(`cd '${OTHER}'`), recorded());
});

test('an app from before receipts takes the file and says nothing: counted as opened', () => {
  clean();
  const stop = fakeApp('silent-take');
  try {
    const r = inApp(['open', '--prompt', 'look at the refund copy'], { GENLOCK_TERMINAL: `record:${TERM}` });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /is opening/);
    assert.equal(recorded(), '');
  } finally { stop(); }
});

test('handoff: closes this session only once the app has opened the fresh one', () => {
  clean(); owned();
  const stop = fakeApp('ok');
  try {
    const r = inApp(['open', '--handoff', '--uncommitted', 'none']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /A fresh session opened on repo/);
    assert.equal(closeJSON()?.why, 'handoff');
  } finally { stop(); }
});

test('handoff with no app and no window: this session is not closed, and the agent gets the command', () => {
  clean(); owned();
  const r = inApp(['open', '--handoff', '--uncommitted', 'none']);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /No window could be opened either, so this session stays open/);
  assert.equal(closeJSON(), null);
});

test('handoff with no app: the fresh session opens in a terminal window carrying the task, then this one may close', () => {
  clean(); owned();
  const r = inApp(['open', '--handoff', '--uncommitted', 'none'], { GENLOCK_TERMINAL: `record:${TERM}` });
  assert.equal(r.code, 0, r.all);
  const script = scriptOf(recorded());
  assert.match(fs.readFileSync(script.match(/cat '([^']+prompt\.txt)'/)[1], 'utf8'), new RegExp(T));
  assert.equal(closeJSON()?.why, 'replaced');
});

test('spinoff launch with no app: the yes already given opens it in a terminal window, not asked again', () => {
  clean(); owned();
  ok(['claim', T, '--path', 'src/refunds']);
  const S = /\b(T-[0-9A-Z]{5})\b/.exec(ok(['spinoff', 'propose', 'Refund email copy reads well', '--parent', T, '--why', 'separate',
    '--context', 'write the email copy', '--path', 'emails/', '--needs', 'none', '--blocks', 'none']))[1];
  const r = inApp(['spinoff', 'launch', S, '--user-said', 'yes go'], { GENLOCK_TERMINAL: `record:${TERM}` });
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /did not answer/);
  assert.match(r.out, /opened in a Terminal window instead/);
  assert.ok(!files().some((f) => f.startsWith('spawn-')), 'withdrawn');
  assert.ok(recorded().length > 0);
});

test('spinoff launch: the app opens it, no fallback', () => {
  clean();
  const S = /\b(T-[0-9A-Z]{5})\b/.exec(ok(['spinoff', 'propose', 'Refund receipt PDF renders', '--parent', T, '--why', 'separate',
    '--context', 'render the pdf', '--path', 'pdf/', '--needs', 'none', '--blocks', 'none']))[1];
  const stop = fakeApp('ok');
  try {
    const r = inApp(['spinoff', 'launch', S, '--user-said', 'yes go'], { GENLOCK_TERMINAL: `record:${TERM}` });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /opening in a new pane/);
    assert.equal(recorded(), '');
  } finally { stop(); }
});

test('the Assistant\'s open (what the phone uses) falls back the same way when no app answers', () => {
  clean();
  const ASST = path.join(VOICE, 'assistant');
  fs.mkdirSync(ASST, { recursive: true });
  const r = g(['open', 'other', '--prompt', 'pick up the other thing'], { GENLOCK_APP_CHANNEL: ASST, GENLOCK_APP_PROJECTS: path.join(ROOT, 'projects.json'), GENLOCK_APP_CHANNELS: VOICE, GENLOCK_TERMINAL: `record:${TERM}` }, ROOT);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /did not answer/);
  assert.ok(!fs.readdirSync(ASST).some((f) => f.startsWith('open-')), 'withdrawn');
  assert.ok(scriptOf(recorded()).includes(`cd '${OTHER}'`), recorded());
});

test('the Assistant\'s open: the app confirms it, no fallback', () => {
  clean();
  const ASST = path.join(VOICE, 'assistant');
  const code = `const fs=require('fs'),p=require('path');const c=process.argv[1];setInterval(()=>{for(const f of fs.readdirSync(c)){if(!/^open-.*\\.json$/.test(f))continue;const q=JSON.parse(fs.readFileSync(p.join(c,f),'utf8'));fs.rmSync(p.join(c,f));fs.writeFileSync(p.join(c,'receipt-'+q.id+'.json'),JSON.stringify({ok:true}));}},50);`;
  const app = spawn(process.execPath, ['-e', code, ASST], { stdio: 'ignore' });
  try {
    const r = g(['open', 'other', '--prompt', 'pick up the other thing'], { GENLOCK_APP_CHANNEL: ASST, GENLOCK_APP_PROJECTS: path.join(ROOT, 'projects.json'), GENLOCK_APP_CHANNELS: VOICE, GENLOCK_TERMINAL: `record:${TERM}` }, ROOT);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Opening a fresh session on other/);
    assert.equal(recorded(), '');
  } finally { app.kill(); }
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

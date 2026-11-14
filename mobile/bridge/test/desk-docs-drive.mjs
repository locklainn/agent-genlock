#!/usr/bin/env node
// Focus Mode with documents (T-N4PYG), driven like desk-drive.mjs: the real app off screen, a real
// bridge, a fake Tally. Tally replies with three steps: one carrying two documents, one carrying a
// link, one plain update. A step that shows an asset must never move on by itself (TJ: "it should be
// a manual Click to go through that step"); the plain update still moves on with its countdown.
//   node mobile/bridge/test/desk-docs-drive.mjs [path/to/Genlock binary]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../bridge.mjs';
import { deskFile } from '../desk.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = process.argv[2] || path.resolve(here, '../../../app/.build/debug/Genlock');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-docs-drive-'));
const home = path.join(out, 'home');
const channel = path.join(home, 'voice', 'TOKEN-A');
fs.mkdirSync(channel, { recursive: true });
fs.mkdirSync(path.join(home, 'Assistant'));
const transcript = path.join(home, 'conv.jsonl');
fs.writeFileSync(transcript, '{"type":"system"}\n');
fs.writeFileSync(path.join(channel, 'state.json'), JSON.stringify({ state: 'done', transcript }));
fs.writeFileSync(path.join(home, 'projects.json'), '[]');
fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [{ project: path.join(home, 'Assistant'), token: 'TOKEN-A' }] }));

class FakeSocket { constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 0); } send() {} close() {} }
const bridge = startBridge({ relay: 'http://127.0.0.1:1', room: 'ab'.repeat(16), secret: 'cd'.repeat(32) },
  { home, snap: async () => ({}), pollMs: 100, WebSocketImpl: FakeSocket, speak: null, desk: true, wake: () => {} });
await bridge.desk.ready;

const docA = path.join(out, 'plan.pdf'); const docB = path.join(out, 'notes.md');
fs.writeFileSync(docA, '%PDF-1.4\n%fake\n'); fs.writeFileSync(docB, '# Notes\n');
const shot = (n) => path.join(out, `${n}.png`);
const state = (n) => path.join(out, `${n}.json`);
const steps = [
  { wait: 2 }, { deskOpen: true }, { wait: 2 }, { deskSay: 'send me the docs' },
  // The reply lands at ~6s; arrival, then the walk on the documents step.
  { wait: 14 }, { deskSnap: shot('1-docs') }, { deskState: state('1-docs') },
  // Far past any countdown: still on the documents step.
  { wait: 8 }, { deskState: state('2-docs-later') },
  { deskNext: true }, { wait: 10 }, { deskSnap: shot('3-link') }, { deskState: state('3-link') },
  { deskNext: true }, { wait: 12 }, { deskState: state('4-after-update') },
  { deskClose: true }, { quit: true },
];
const drive = path.join(out, 'drive.json');
fs.writeFileSync(drive, JSON.stringify(steps));
const store = path.join(out, 'store', 'projects.json');
fs.mkdirSync(path.dirname(store), { recursive: true });
fs.writeFileSync(store, '[]');

const proc = spawn(app, [], { env: { ...process.env, GENLOCK_APP_DRIVE: drive, GENLOCK_APP_STORE: store, GENLOCK_DESK_FILE: deskFile(home), GENLOCK_DESK_QUIET: '1' }, stdio: 'ignore' });

const t0 = Date.now();
let replied = false;
const items = [
  { project: 'genlock', task: 'phone documents', say: 'Two documents for you.', files: [docA, { path: docB, name: 'the notes' }] },
  { project: 'genlock', task: 'site', say: 'The page is live at https://example.com/page' },
  { project: 'budget', task: 'minutes', say: 'Minutes for the 12th are filed.' },
];
const timer = setInterval(() => {
  for (const f of fs.readdirSync(channel).filter((f) => f.startsWith('tell-')).sort()) {
    const text = JSON.parse(fs.readFileSync(path.join(channel, f), 'utf8')).text;
    fs.renameSync(path.join(channel, f), path.join(out, f));
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: `u-${f}`, message: { content: text } }) + '\n');
    if (!replied) {
      replied = true;
      setTimeout(() => fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text:
        'Docs.\n\n```items\n' + JSON.stringify(items) + '\n```' }] } }) + '\n'), Math.max(0, 6000 - (Date.now() - t0)));
    }
  }
}, 200);

const code = await new Promise((res) => { proc.on('exit', res); setTimeout(() => { proc.kill(); res('timeout'); }, 90000); });
clearInterval(timer);
bridge.stop();
const read = (n) => { try { return JSON.parse(fs.readFileSync(state(n), 'utf8')); } catch { return null; } };
const st = Object.fromEntries(['1-docs', '2-docs-later', '3-link', '4-after-update'].map((n) => [n, read(n)]));
console.log(JSON.stringify({ app: code, out, st: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v && { pending: v.pending, walked: v.walked, phase: v.phase, active: v.active }])) }, null, 2));
const checks = {
  'the documents step is up and waiting for a click': st['1-docs']?.pending[0] === 'm1-0' && st['1-docs']?.phase === 'waiting',
  'it is still there long after any countdown': st['2-docs-later']?.pending[0] === 'm1-0' && st['2-docs-later']?.walked.length === 0,
  'next moves to the link step, which also waits': st['3-link']?.pending[0] === 'm1-1' && st['3-link']?.phase === 'waiting',
  'the plain update moves on by itself': st['4-after-update']?.pending.length === 0 && st['4-after-update']?.walked.length === 3,
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ok  ' : 'FAIL'} ${k}`);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);

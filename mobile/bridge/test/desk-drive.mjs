#!/usr/bin/env node
// End to end for the Mac Phone window (T-WXFPX): a real bridge with its desk on a throwaway Genlock
// home and a fake Tally transcript; the built Mac app driven off screen (GENLOCK_APP_DRIVE, its own
// store and channels, so the running app and its sessions are untouched). Tally replies with a
// question and an update; the window walks them; the question is answered; the answer must reach
// Tally's channel in the phone's answer format.
//   node mobile/bridge/test/desk-drive.mjs [path/to/Genlock binary]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../bridge.mjs';
import { deskFile } from '../desk.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = process.argv[2] || path.resolve(here, '../../../app/.build/debug/Genlock');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-drive-'));
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

const shot = (n) => path.join(out, `${n}.png`);
const state = (n) => path.join(out, `${n}.json`);
const steps = [
  { wait: 2 }, { snapshot: shot('main-before') }, { report: state('main-before') }, { deskOpen: true }, { wait: 3 }, { deskState: state('0-open') }, { deskSnap: shot('0-thread') },
  { deskSay: 'what needs me?' }, { wait: 3 }, { deskState: state('1-sent') },
  // The reply lands here (written by this script at ~9s): arrival, then the walk.
  { wait: 5 }, { deskSnap: shot('2-arrival') }, { deskState: state('2-arrival') },
  { wait: 4 }, { deskSnap: shot('3-walk') }, { deskState: state('3-walk') },
  { deskAnswer: 'Yes, ship it' }, { wait: 1 }, { deskSnap: shot('4-next') }, { deskState: state('4-next') },
  { deskNext: true }, { wait: 3 }, { deskState: state('5-done') }, { deskSnap: shot('5-dash') }, { wait: 6 }, { deskSnap: shot('6-atwork') },
  { deskClose: true }, { wait: 1 }, { snapshot: shot('main-after') }, { report: state('main-after') }, { quit: true },
];
const drive = path.join(out, 'drive.json');
fs.writeFileSync(drive, JSON.stringify(steps));
const store = path.join(out, 'store', 'projects.json');
fs.mkdirSync(path.dirname(store), { recursive: true });
fs.writeFileSync(store, '[]');

const proc = spawn(app, [], { env: { ...process.env, GENLOCK_APP_DRIVE: drive, GENLOCK_APP_STORE: store, GENLOCK_DESK_FILE: deskFile(home), GENLOCK_DESK_QUIET: '1' }, stdio: 'ignore' });

// Tally, played by this script: when the desk's message reaches the channel, it answers with items.
const t0 = Date.now();
let replied = false, answers = null;
const timer = setInterval(() => {
  const tells = fs.readdirSync(channel).filter((f) => f.startsWith('tell-')).sort();
  for (const f of tells) {
    const text = JSON.parse(fs.readFileSync(path.join(channel, f), 'utf8')).text;
    fs.renameSync(path.join(channel, f), path.join(out, f));
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: `u-${f}`, message: { content: text } }) + '\n');
    if (!replied) {
      replied = true;
      setTimeout(() => fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text:
        'Two things.\n\n```items\n[{"project":"genlock","task":"phone view","kind":"question","say":"The Mac Phone window is built.","ask":"Ship it?","options":["Yes, ship it","Not yet"]},'
        + '{"project":"budget","task":"minutes","say":"Minutes for the 12th are filed."}]\n```' }] } }) + '\n'), Math.max(0, 9000 - (Date.now() - t0)));
    } else if (/Answers from the phone walk-through/.test(text)) {
      answers = text;
    }
  }
}, 200);

const code = await new Promise((res) => { proc.on('exit', res); setTimeout(() => { proc.kill(); res('timeout'); }, 60000); });
clearInterval(timer);
bridge.stop();
const read = (n) => { try { return JSON.parse(fs.readFileSync(state(n), 'utf8')); } catch { return null; } };
const report = { app: code, out, answers, states: Object.fromEntries(['0-open', '1-sent', '2-arrival', '3-walk', '4-next', '5-done'].map((n) => [n, read(n)])) };
console.log(JSON.stringify(report, null, 2));
// The main window's layout and routing, which a Phone window must not disturb. Pixels and tool
// paths are not compared: the background animates and boot finishes resolving tools meanwhile.
const MAIN = ['route', 'visible', 'focused', 'panes', 'tabLabels', 'cards', 'running', 'active', 'emptyProject', 'needing'];
const pick = (n) => { try { const r = JSON.parse(fs.readFileSync(state(n), 'utf8')); return JSON.stringify(MAIN.map((k) => r[k])); } catch { return null; } };
const sameReport = pick('main-before') !== null && pick('main-before') === pick('main-after');
console.log(`main window state identical before and after the Phone window (${MAIN.join(', ')}): ${sameReport}`);
const ok = sameReport && answers && /\[phone\] Answers from the phone walk-through: \(1\) genlock \/ phone view - asked "Ship it\?": Yes, ship it \(2\) budget \/ minutes: heard/.test(answers);
console.log(ok ? 'PASS: the answers reached Tally in the phone format' : 'FAIL');
process.exit(ok ? 0 : 1);

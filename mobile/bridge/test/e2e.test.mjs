// End to end against the real relay code, run locally with `wrangler dev`:
// fake Genlock home with an Assistant channel and transcript; the real bridge; a fake phone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../bridge.mjs';
import { relayKey } from '../lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(here, '../../relay');
const PORT = 8799;
const RELAY = `http://127.0.0.1:${PORT}`;

let wrangler, home, bridge, transcript, channel;
const pairing = { relay: RELAY, room: 'ab'.repeat(16), secret: 'cd'.repeat(32) };
const phoneURL = (key = relayKey(pairing.secret)) => `ws://127.0.0.1:${PORT}/room/${pairing.room}?role=phone&key=${key}`;

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function phone(url = phoneURL()) {
  const ws = new WebSocket(url);
  const got = [];
  ws.onmessage = (e) => got.push(JSON.parse(e.data));
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const closed = new Promise((res) => { ws.onclose = res; });
  return { ws, got, opened, closed, send: (m) => ws.send(JSON.stringify({ id: crypto.randomUUID(), t: Date.now(), ...m })) };
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-phone-'));
  const assistant = path.join(home, 'Assistant');
  const project = path.join(home, 'proj');
  fs.mkdirSync(assistant);
  fs.mkdirSync(project);
  channel = path.join(home, 'voice', 'TOKEN-A');
  fs.mkdirSync(channel, { recursive: true });
  fs.mkdirSync(path.join(home, 'voice', 'TOKEN-P'));
  transcript = path.join(home, 'conv.jsonl');
  fs.writeFileSync(transcript, '{"type":"system"}\n');
  fs.writeFileSync(path.join(channel, 'state.json'), JSON.stringify({ state: 'done', transcript }));
  fs.writeFileSync(path.join(home, 'voice', 'TOKEN-P', 'state.json'), JSON.stringify({ state: 'working', message: 'building the thing' }));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ path: project, tier: 'today' }]));
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [
    { project: assistant, token: 'TOKEN-A' },
    { project, token: 'TOKEN-P' },
  ] }));

  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', path.join(home, 'relay-state')], { cwd: relayDir, stdio: 'ignore' });
  await waitFor(async () => { try { return (await fetch(RELAY)).ok; } catch { return false; } }, 60000);

  const snap = async () => ({ goals: [{ rank: 1, status: 'active', short: 'g', title: 'The goal' }],
    tickets: [{ id: 'T-1', rank: 1, short: 't', title: 'The task' }], questions_for_user: [{ text: 'Which one?' }] });
  bridge = startBridge(pairing, { home, snap, pollMs: 100 });
});

after(() => {
  bridge?.stop();
  wrangler?.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a phone without the pairing key is refused', async () => {
  // Wait until the bridge has registered the room, so the refusal is about the key.
  const ok = phone();
  await ok.opened;
  await waitFor(() => ok.got.find((m) => m.kind === 'state' && m.laptop === 'online'));
  ok.ws.close();

  const bad = await fetch(`${RELAY}/room/${pairing.room}?role=phone&key=${'0'.repeat(64)}`);
  assert.equal(bad.status, 401);
  const none = await fetch(`${RELAY}/room/${pairing.room}?role=phone`);
  assert.equal(none.status, 401);
  const p = phone(phoneURL('0'.repeat(64)));
  await assert.rejects(p.opened);
});

test('dictated text reaches the Assistant, and its reply reaches the phone', async () => {
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello', lastSeen: Date.now() });
  p.send({ kind: 'say', text: 'what is  on today?' });

  const file = await waitFor(() => fs.readdirSync(channel).find((n) => n.startsWith('tell-') && n.endsWith('.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(channel, file), 'utf8')), { text: '[phone] what is on today?' });
  await waitFor(() => p.got.find((m) => m.kind === 'ack'));

  // The app typed it in; the Assistant answers in two blocks of one message.
  fs.appendFileSync(transcript, [
    { type: 'user', message: { content: '[phone] what is on today?' }, uuid: 'u1' },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Two things.' }], stop_reason: null } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use' }, { type: 'text', text: 'The goal, then the task.' }], stop_reason: 'end_turn' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const reply = await waitFor(() => p.got.find((m) => m.kind === 'reply'));
  assert.equal(reply.text, 'Two things.\n\nThe goal, then the task.');
  assert.ok(!p.got.find((m) => m.kind === 'prompt'), 'the phone\'s own prompt is not echoed back');
  p.ws.close();
});

test('the phone gets a status snapshot of every project with a session open', async () => {
  const p = phone();
  await p.opened;
  p.send({ kind: 'status' });
  const s = await waitFor(() => p.got.find((m) => m.kind === 'status'));
  assert.equal(s.projects.length, 1);
  const [proj] = s.projects;
  assert.equal(proj.name, 'proj');
  assert.equal(proj.sessions[0].state, 'working');
  assert.equal(proj.sessions[0].said, 'building the thing');
  // Sessions only: no top task or questions from the project's records.
  assert.ok(!('topTask' in proj) && !('waiting' in proj));
  p.ws.close();
});

test('a phone that was away catches up on replies it missed', async () => {
  const before = Date.now() - 60000;
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello', lastSeen: before });
  await waitFor(() => p.got.find((m) => m.kind === 'reply' && m.text.startsWith('Two things.')));
  p.ws.close();
});

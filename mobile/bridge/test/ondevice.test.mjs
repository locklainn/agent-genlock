// A phone that makes the Genlock voice itself: the bridge tells it each item's project voice and
// sends it no clips, so no speech crosses the network. A phone without the model still gets clips.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBridge } from '../bridge.mjs';

const pairing = { relay: 'http://127.0.0.1:1', room: 'ab'.repeat(16), secret: 'cd'.repeat(32) };
const homes = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A Genlock home with an Assistant whose conversation the test writes; a relay socket that records what is sent. */
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-ondevice-'));
  homes.push(home);
  const channel = path.join(home, 'voice', 'TOKEN-A');
  fs.mkdirSync(channel, { recursive: true });
  fs.mkdirSync(path.join(home, 'Assistant'));
  const transcript = path.join(home, 'conv.jsonl');
  fs.writeFileSync(transcript, '{"type":"system"}\n');
  fs.writeFileSync(path.join(channel, 'state.json'), JSON.stringify({ state: 'done', transcript }));
  fs.writeFileSync(path.join(home, 'projects.json'), '[]');
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [{ project: path.join(home, 'Assistant'), token: 'TOKEN-A' }] }));
  const sent = [];
  let sock;
  class FakeSocket {
    constructor() { sock = this; this.readyState = 1; setTimeout(() => this.onopen?.(), 0); }
    send(s) { sent.push(JSON.parse(s)); }
    close() {}
  }
  const asked = [];
  const speak = async function* (ask) { asked.push(ask); yield { i: 0, text: ask.text, seconds: 1, audio: Buffer.from('x') }; };
  const voiceFor = ({ project }) => (project === 'ghostlight' ? { parts: [['bm_lewis', 1]], speed: 1 } : { parts: [['af_sarah', 1]], speed: 1.1 });
  const bridge = startBridge(pairing, { home, snap: async () => ({}), pollMs: 50, WebSocketImpl: FakeSocket, speak, voiceFor });
  const phone = (m) => sock.onmessage({ data: JSON.stringify({ id: crypto.randomUUID(), t: Date.now(), ...m }) });
  const reply = () => fs.appendFileSync(transcript, `${[
    { type: 'user', message: { content: '[phone] news?' }, uuid: 'u1' },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Two things.\n\n```items\n'
      + '[{"project":"genlock","task":"voice","say":"The phone speaks now."},{"project":"ghostlight","task":"show","say":"Lights are up."}]\n```' }], stop_reason: 'end_turn' } },
  ].map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { bridge, sent, asked, phone, reply, opened: () => waitFor(() => sock) };
}

test("each reply item carries its project's voice", async () => {
  const s = setup();
  await s.opened();
  s.phone({ kind: 'hello', lastSeen: Date.now(), ondevice: true });
  s.reply();
  const r = await waitFor(() => s.sent.find((m) => m.kind === 'reply'));
  s.bridge.stop();
  assert.equal(r.items.length, 2, JSON.stringify(r));
  assert.deepEqual(r.items.map((it) => it.voice), [{ parts: [['af_sarah', 1]], speed: 1.1 }, { parts: [['bm_lewis', 1]], speed: 1 }]);
});

test('a phone that voices itself is sent no clips, and nothing is spoken on the Mac', async () => {
  const s = setup();
  await s.opened();
  s.phone({ kind: 'hello', lastSeen: Date.now(), ondevice: true });
  s.reply();
  await waitFor(() => s.sent.find((m) => m.kind === 'reply'));
  await new Promise((r) => setTimeout(r, 300));
  s.bridge.stop();
  assert.equal(s.sent.filter((m) => m.kind === 'clip').length, 0);
  assert.equal(s.asked.length, 0);
});

test('a phone without the voice model still gets clips from the Mac', async () => {
  const s = setup();
  await s.opened();
  s.phone({ kind: 'hello', lastSeen: Date.now() });
  s.reply();
  await waitFor(() => s.sent.filter((m) => m.kind === 'clip' && m.done).length >= 2);
  s.bridge.stop();
  assert.ok(s.asked.length >= 2);
});

test("the arrival screen's line is voiced with the reply, before its items, in the hub's voice", async () => {
  const s = setup();
  await s.opened();
  s.phone({ kind: 'hello', lastSeen: Date.now() });
  s.reply();
  await waitFor(() => s.sent.find((m) => m.kind === 'clip' && m.item === 'arrive:Two updates.' && m.done));
  s.bridge.stop();
  assert.deepEqual(s.asked[0], { text: 'Two updates.', project: '', format: 'm4a' });
});

test('a line the bridge did not voice is made when the phone asks for it with its text', async () => {
  const s = setup();
  await s.opened();
  s.phone({ kind: 'clips', item: 'arrive:Three updates.', text: 'Three updates.' });
  await waitFor(() => s.sent.find((m) => m.kind === 'clip' && m.item === 'arrive:Three updates.' && m.done));
  s.bridge.stop();
});

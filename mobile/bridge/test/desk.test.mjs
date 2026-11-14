// The desk: the Mac app's Phone window joins the bridge on 127.0.0.1 and gets what the phone gets.
// Its own messages reach Tally like the phone's; their ack and start go to it alone, and the reply
// to one shows on the phone without being walked there.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBridge } from '../bridge.mjs';
import { deskFile } from '../desk.mjs';

const pairing = { relay: 'http://127.0.0.1:1', room: 'ab'.repeat(16), secret: 'cd'.repeat(32) };
const cleanup = [];
after(() => { for (const f of cleanup) f(); });

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-desk-'));
  const channel = path.join(home, 'voice', 'TOKEN-A');
  fs.mkdirSync(channel, { recursive: true });
  fs.mkdirSync(path.join(home, 'Assistant'));
  const transcript = path.join(home, 'conv.jsonl');
  fs.writeFileSync(transcript, '{"type":"system"}\n');
  fs.writeFileSync(path.join(channel, 'state.json'), JSON.stringify({ state: 'done', transcript }));
  fs.writeFileSync(path.join(home, 'projects.json'), '[]');
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [{ project: path.join(home, 'Assistant'), token: 'TOKEN-A' }] }));
  const phoneGot = [];
  let sock;
  class FakeSocket {
    constructor() { sock = this; this.readyState = 1; setTimeout(() => this.onopen?.(), 0); }
    send(s) { phoneGot.push(JSON.parse(s)); }
    close() {}
  }
  const bridge = startBridge(pairing, { home, snap: async () => ({}), pollMs: 40, WebSocketImpl: FakeSocket, speak: null, desk: true, wake: () => {} });
  cleanup.push(() => { bridge.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const append = (...lines) => fs.appendFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { home, channel, bridge, phoneGot, append, phone: (m) => sock.onmessage({ data: JSON.stringify({ id: crypto.randomUUID(), t: Date.now(), ...m }) }) };
}

/** A desk client the way the Mac app is one: reads desk.json, follows /events, posts to /send. */
async function deskClient(home, { lastSeen = 0, token } = {}) {
  const info = JSON.parse(fs.readFileSync(deskFile(home), 'utf8'));
  const got = [];
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${info.port}/events?token=${token ?? info.token}&lastSeen=${lastSeen}`, { signal: ac.signal });
  if (res.status === 200) {
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const ev = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of ev.split('\n')) if (line.startsWith('data: ')) got.push(JSON.parse(line.slice(6)));
          }
        }
      } catch {}
    })();
  }
  cleanup.push(() => ac.abort());
  const send = (m) => fetch(`http://127.0.0.1:${info.port}/send`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` }, body: JSON.stringify(m) }).then((r) => r.json());
  return { status: res.status, got, send, info };
}

test('desk.json is private, and a wrong token is refused', async () => {
  const s = setup();
  await s.bridge.desk.ready;
  assert.equal(fs.statSync(deskFile(s.home)).mode & 0o777, 0o600);
  const bad = await deskClient(s.home, { token: 'nope' });
  assert.equal(bad.status, 401);
});

test('the desk gets state and grid on hello, and the replies the phone gets', async () => {
  const s = setup();
  await s.bridge.desk.ready;
  const d = await deskClient(s.home);
  await d.send({ kind: 'hello' });
  await waitFor(() => d.got.some((m) => m.kind === 'state') && d.got.some((m) => m.kind === 'grid'));
  // A phone message and its reply: both ends see the reply, both walk it.
  s.phone({ kind: 'hello', lastSeen: Date.now() });
  s.append({ type: 'user', uuid: 'u1', message: { content: '[phone] news?' } },
    { type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'One thing.\n\n```items\n[{"project":"genlock","task":"desk","say":"Built."}]\n```' }] } });
  const r = await waitFor(() => d.got.find((m) => m.kind === 'reply'));
  assert.equal(r.items[0].say, 'Built.');
  assert.equal(r.walk, undefined);
  const p = s.phoneGot.find((m) => m.kind === 'reply');
  assert.equal(p.walk, undefined);
});

test("a desk message reaches Tally as the phone's would; its reply is walked on the desk, not on the phone", async () => {
  const s = setup();
  await s.bridge.desk.ready;
  const d = await deskClient(s.home);
  await d.send({ kind: 'hello' });
  const { id } = await d.send({ id: 'desk-1', kind: 'say', answers: [{ item: 'r-0', project: 'genlock', task: 'desk', ask: 'Ship it?', answer: 'yes' }], left: 0 });
  assert.equal(id, 'desk-1');
  const tell = await waitFor(() => fs.readdirSync(s.channel).find((f) => f.startsWith('tell-')));
  const body = JSON.parse(fs.readFileSync(path.join(s.channel, tell), 'utf8'));
  assert.match(body.text, /^\[phone\] Answers from the phone walk-through: \(1\) genlock \/ desk - asked "Ship it\?": yes/);
  await waitFor(() => d.got.some((m) => m.kind === 'ack' && m.of === 'desk-1'));
  assert.ok(!s.phoneGot.some((m) => m.kind === 'ack' && m.of === 'desk-1'), 'the ack is the desk\'s alone');
  // The phone is told TJ carried on elsewhere.
  assert.ok(s.phoneGot.some((m) => m.kind === 'moved'));
  // Tally picks it up and answers.
  s.append({ type: 'user', uuid: 'u9', message: { content: body.text } },
    { type: 'assistant', message: { id: 'm9', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Shipping.' }] } });
  const started = await waitFor(() => d.got.find((m) => m.kind === 'started' && m.of === 'desk-1'));
  assert.ok(started);
  assert.ok(!s.phoneGot.some((m) => m.kind === 'started' && m.of === 'desk-1'));
  const r = await waitFor(() => d.got.find((m) => m.kind === 'reply' && m.reOf === 'desk-1'));
  assert.equal(r.origin, 'desk');
  assert.equal(r.walk, undefined);
  const p = await waitFor(() => s.phoneGot.find((m) => m.kind === 'reply' && m.reOf === 'desk-1'));
  assert.equal(p.walk, false);
  assert.equal(p.origin, 'desk');
});

test('a desk that was closed catches up on replies after its lastSeen', async () => {
  const s = setup();
  await s.bridge.desk.ready;
  const first = await deskClient(s.home);
  s.append({ type: 'user', uuid: 'u1', message: { content: '[phone] news?' } },
    { type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Missed this.' }] } });
  await waitFor(() => first.got.find((m) => m.kind === 'reply'));
  const later = await deskClient(s.home, { lastSeen: Date.now() - 60_000 });
  const r = await waitFor(() => later.got.find((m) => m.kind === 'reply'));
  assert.equal(r.text, 'Missed this.');
  const none = await deskClient(s.home, { lastSeen: Date.now() + 1000 });
  await new Promise((r2) => setTimeout(r2, 150));
  assert.ok(!none.got.some((m) => m.kind === 'reply'));
});

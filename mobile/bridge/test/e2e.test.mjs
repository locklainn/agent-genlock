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
  bridge = startBridge(pairing, { home, snap, pollMs: 100, speak: null });
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
  // The phone hears which of its messages the Assistant picked up.
  const said = p.got.find((m) => m.kind === 'ack');
  const started = p.got.find((m) => m.kind === 'started');
  assert.equal(started?.of, said.of);
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

test('the phone asks for a sprint report and gets the document the Mac reads', async () => {
  const p = phone();
  await p.opened;
  p.send({ kind: 'sprint', sprint: 'previous' });
  const s = await waitFor(() => p.got.find((m) => m.kind === 'sprint'));
  assert.equal(s.report.range.kind, 'sprint');
  assert.equal(s.report.range.offset, -1);
  assert.ok(Array.isArray(s.report.projects) && s.report.sprints.length === 12);
  p.send({ kind: 'sprint', sprint: 'whenever' });
  const bad = await waitFor(() => p.got.find((m) => m.kind === 'error' && /not current, previous/.test(m.text)));
  assert.ok(bad);
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

// Files both ways. Real bytes, several chunks, through the real relay.
const bigBytes = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 255; return b; };
const reassemble = (msgs) => Buffer.concat(msgs.sort((a, b) => a.seq - b.seq).map((m) => Buffer.from(m.data, 'base64')));

test('a file the Assistant sends with SendUserFile reaches the phone whole', async () => {
  const src = path.join(home, 'concept.bin.png');
  const bytes = bigBytes(500_000); // three chunks; under the shrink size, so sent as is
  fs.writeFileSync(src, bytes);
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello', lastSeen: Date.now() });
  await waitFor(() => p.got.find((m) => m.kind === 'state'));
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'm9', content: [
    { type: 'tool_use', id: 'toolu_X', name: 'SendUserFile', input: { files: [src], caption: 'Front door, option A' } }] } }) + '\n');
  const chunks = await waitFor(() => { const c = p.got.filter((m) => m.kind === 'file'); return c.length && c.length === c[0].total ? c : null; });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].name, 'concept.bin.png');
  assert.equal(chunks[0].mime, 'image/png');
  assert.equal(chunks.find((c) => c.seq === 0).caption, 'Front door, option A');
  assert.ok(reassemble(chunks).equals(bytes));
  p.ws.close();
});

test('a phone that was in the background gets the file when it comes back', async () => {
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello', lastSeen: Date.now() - 600_000 });
  const chunks = await waitFor(() => { const c = p.got.filter((m) => m.kind === 'file' && m.fid === 'toolu_X-0'); return c.length === 3 ? c : null; });
  assert.equal(chunks[0].total, 3);
  p.ws.close();
});

test('a photo from the phone is saved on the laptop and the Assistant is told its path', async () => {
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello', lastSeen: Date.now() });
  const photo = bigBytes(450_000);
  const fid = 'phone-file-1';
  const n = Math.ceil(photo.length / 192000);
  for (let seq = 0; seq < n; seq++) {
    p.send({ kind: 'file', fid, seq, total: n, name: 'IMG 2041.jpg', mime: 'image/jpeg', data: photo.subarray(seq * 192000, (seq + 1) * 192000).toString('base64') });
  }
  await waitFor(() => p.got.find((m) => m.kind === 'file-ack' && m.of === fid));
  for (const f of fs.readdirSync(channel)) if (f.startsWith('tell-')) fs.rmSync(path.join(channel, f));
  p.send({ kind: 'say', text: 'what do you think of this', files: [fid] });
  const tell = await waitFor(() => fs.readdirSync(channel).find((f) => f.startsWith('tell-') && f.endsWith('.json')));
  const text = JSON.parse(fs.readFileSync(path.join(channel, tell), 'utf8')).text;
  const saved = text.match(/(\/\S+IMG_2041\.jpg)/)?.[1];
  assert.ok(saved, text);
  assert.match(text, /^\[phone\] what do you think of this \(TJ attached a file from the phone: /);
  assert.ok(fs.readFileSync(saved).equals(photo));
  await waitFor(() => p.got.find((m) => m.kind === 'ack'));
  p.ws.close();
});

test('a say naming an attachment that never arrived is refused, so the phone can retry', async () => {
  const p = phone();
  await p.opened;
  p.send({ kind: 'say', text: 'see this', files: ['never-sent'], id: 'say-missing' });
  const err = await waitFor(() => p.got.find((m) => m.kind === 'error' && m.of === 'say-missing'));
  assert.match(err.text, /did not arrive whole/);
  p.ws.close();
});

test('a reply with an items block reaches the phone as tagged items, the block cut from its text', async () => {
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello', lastSeen: Date.now() });
  const items = [{ project: 'genlock', task: 'phone digest', kind: 'question', say: 'Built.', ask: 'Ship it?' }, { project: 'budget', task: 'pages', say: 'Done.' }];
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'm-items', content: [{ type: 'text', text: 'Shown.\n\n```items\n' + JSON.stringify(items) + '\n```' }], stop_reason: 'end_turn' } }) + '\n');
  const reply = await waitFor(() => p.got.find((m) => m.kind === 'reply' && m.turn === 'm-items'));
  assert.equal(reply.text, 'Shown.');
  assert.deepEqual(reply.items.map((i) => [i.id, i.project, i.task, i.kind]), [['m-items-0', 'genlock', 'phone digest', 'question'], ['m-items-1', 'budget', 'pages', 'update']]);
  p.ws.close();
});

test('a review item sends each image to the phone as a file and names it on the item by that file id', async () => {
  const a = path.join(home, 'door-a.png'); const b = path.join(home, 'door-b.png');
  fs.writeFileSync(a, bigBytes(1000)); fs.writeFileSync(b, bigBytes(2000));
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello', lastSeen: Date.now() });
  const items = [{ project: 'nightmaremode', task: 'side door', say: 'Two door options.', ask: 'Which reads better?', images: [a, { path: b, caption: 'option B' }] }];
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'm-rev', content: [{ type: 'text', text: 'Review these.\n\n```items\n' + JSON.stringify(items) + '\n```' }], stop_reason: 'end_turn' } }) + '\n');
  const reply = await waitFor(() => p.got.find((m) => m.kind === 'reply' && m.turn === 'm-rev'));
  assert.deepEqual(reply.items[0].images, [{ fid: 'm-rev-0-img0', name: 'door-a.png', path: a }, { fid: 'm-rev-0-img1', name: 'door-b.png', path: b, caption: 'option B' }]);
  const fids = await waitFor(() => { const f = new Set(p.got.filter((m) => m.kind === 'file').map((m) => m.fid)); return f.has('m-rev-0-img0') && f.has('m-rev-0-img1') ? f : null; });
  assert.ok(fids.size >= 2);
  p.ws.close();
});

test('an item with documents sends each to the phone as a file, whole, and names it on the item by that file id', async () => {
  const docs = ['plan.pdf', 'notes.md', 'sheet.csv'].map((n) => path.join(home, n));
  docs.forEach((d, i) => fs.writeFileSync(d, bigBytes(300_000 * (i + 1))));
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello', lastSeen: Date.now() });
  const items = [{ project: 'genlock', task: 'phone documents', say: 'Three documents.', files: [docs[0], { path: docs[1], name: 'the notes' }, docs[2]] }];
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'm-doc', content: [{ type: 'text', text: 'Docs.\n\n```items\n' + JSON.stringify(items) + '\n```' }], stop_reason: 'end_turn' } }) + '\n');
  const reply = await waitFor(() => p.got.find((m) => m.kind === 'reply' && m.turn === 'm-doc'));
  assert.deepEqual(reply.items[0].files, [
    { fid: 'm-doc-0-file0', name: 'plan.pdf', path: docs[0], mime: 'application/pdf' },
    { fid: 'm-doc-0-file1', name: 'notes.md', path: docs[1], mime: 'text/markdown', caption: 'the notes' },
    { fid: 'm-doc-0-file2', name: 'sheet.csv', path: docs[2], mime: 'text/csv' },
  ]);
  // Every chunk of every document arrives, and puts back to the bytes on the Mac.
  for (const [k, d] of docs.entries()) {
    const fid = `m-doc-0-file${k}`;
    // A file can come twice (the outbox replays to a phone that just said hello): one copy of each chunk.
    const parts = await waitFor(() => { const c = new Map(p.got.filter((m) => m.kind === 'file' && m.fid === fid).map((m) => [m.seq, m])); return c.size && c.size === c.values().next().value.total ? [...c.values()] : null; });
    const buf = Buffer.concat(parts.sort((x, y) => x.seq - y.seq).map((m) => Buffer.from(m.data, 'base64')));
    assert.ok(buf.equals(fs.readFileSync(d)), `${fid} arrives whole`);
  }
  p.ws.close();
});

test('a walk\'s answers reach the Assistant as one message, each labelled with its project and task', async () => {
  const p = phone();
  await p.opened;
  for (const f of fs.readdirSync(channel)) if (f.startsWith('tell-')) fs.rmSync(path.join(channel, f));
  p.send({ kind: 'say', text: '', left: 1, answers: [
    { item: 'a-0', project: 'genlock', task: 'phone digest', ask: 'Ship it?', answer: 'yes' },
    { item: 'a-1', project: 'budget', task: 'pages', skipped: true },
    { item: 'a-2', project: 'budget', task: 'audit', answer: 'next week' },
  ] });
  await waitFor(() => p.got.find((m) => m.kind === 'ack'));
  const tells = fs.readdirSync(channel).filter((f) => f.startsWith('tell-') && f.endsWith('.json'));
  assert.equal(tells.length, 1, 'one message for the whole walk');
  const text = JSON.parse(fs.readFileSync(path.join(channel, tells[0]), 'utf8')).text;
  assert.match(text, /^\[phone\] Answers from the phone walk-through: \(1\) genlock \/ phone digest - asked "Ship it\?": yes \(2\) budget \/ pages: skipped/);
  assert.match(text, /\(3\) budget \/ audit: next week 1 more item is still unheard/);
  p.ws.close();
});

test('TJ typing to the Assistant at the laptop moves the phone on: a mark live and on every hello, the reply not walked', async () => {
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello', lastSeen: Date.now() });
  await waitFor(() => p.got.find((m) => m.kind === 'state'));
  const at = Date.now();
  fs.appendFileSync(transcript, [
    { type: 'user', uuid: 'lap1', timestamp: new Date(at).toISOString(), message: { content: 'what about the budget site?' } },
    { type: 'assistant', message: { id: 'mlap', content: [{ type: 'text', text: 'It shipped.' }], stop_reason: 'end_turn' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const moved = await waitFor(() => p.got.find((m) => m.kind === 'moved'));
  assert.equal(moved.at, at);
  const reply = await waitFor(() => p.got.find((m) => m.kind === 'reply' && m.turn === 'mlap'));
  assert.equal(reply.walk, false, 'read at the laptop: shown on the phone, not walked');
  p.ws.close();
  await p.closed;

  // A phone that was away hears the mark when it comes back.
  const later = phone();
  await later.opened;
  later.send({ kind: 'hello', lastSeen: Date.now() });
  const again = await waitFor(() => later.got.find((m) => m.kind === 'moved'));
  assert.equal(again.at, at);
  later.ws.close();
});

test('the phone gets the Mac grid view live: pushed on each change, closed when the app is gone', async () => {
  const file = path.join(home, 'phone', 'grid.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = (kind, headline, extra = {}) => ({ key: 'proj', title: 'billing page', running: true, status: { kind, headline, task: 'Billing page' }, ...extra });
  const write = (pid, sessions) => fs.writeFileSync(file, JSON.stringify({ pid, projects: [{ id: '/p', name: 'proj', sessions }] }));
  write(process.pid, [row('working', 'Working on')]);
  const p = phone();
  await p.opened;
  p.send({ kind: 'hello' });
  const first = await waitFor(() => p.got.find((m) => m.kind === 'grid' && m.mac === 'open'));
  assert.equal(first.projects[0].sessions[0].status.kind, 'working');
  assert.equal(first.projects[0].sessions[0].title, 'billing page');

  const t0 = Date.now();
  write(process.pid, [row('needsYou', 'Needs you', { attention: 'waiting', phase: 'waiting' })]);
  const moved = await waitFor(() => p.got.find((m) => m.kind === 'grid' && m.projects[0]?.sessions[0]?.status.kind === 'needsYou'), 3000);
  assert.equal(moved.projects[0].sessions[0].attention, 'waiting');
  assert.ok(Date.now() - t0 < 3000, 'reached the phone within 3 seconds');
  // Nothing changed: nothing more is pushed.
  const count = p.got.filter((m) => m.kind === 'grid').length;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(p.got.filter((m) => m.kind === 'grid').length, count);

  // The app that wrote it quit: its sessions are not shown as live.
  write(999999, [row('working', 'Working on')]);
  const gone = await waitFor(() => p.got.find((m) => m.kind === 'grid' && m.mac === 'closed'), 3000);
  assert.deepEqual(gone.projects, []);
  p.ws.close();
});

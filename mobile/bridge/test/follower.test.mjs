// The transcript follower tells the phone when its message reaches the Assistant ("started"),
// reports prompts typed at the laptop, and each finished reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranscriptFollower } from '../lib.mjs';

test('a [phone] prompt fires onPhone, not onPrompt; a reply follows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follower-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'old', message: { role: 'user', content: '[phone] history' } }) + '\n');
  const got = [];
  const f = new TranscriptFollower(() => file, {
    onPhone: (e) => got.push(['phone', e.turn]),
    onPrompt: (e) => got.push(['prompt', e.text]),
    onReply: (e) => got.push(['reply', e.text]),
  });
  f.poll(); // starts at the end: history is not replayed
  const add = (e) => fs.appendFileSync(file, JSON.stringify(e) + '\n');
  add({ type: 'user', uuid: 'u1', message: { role: 'user', content: '[phone] hello there' } });
  add({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'typed at the laptop' } });
  add({ type: 'api-request-blob', message: { role: 'user', content: '[phone] hello there' } });
  add({ type: 'assistant', uuid: 'a1', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi.' }] } });
  f.poll();
  assert.deepEqual(got, [['phone', 'u1'], ['prompt', 'typed at the laptop'], ['reply', 'Hi.']]);
});

test('a phone message sent mid-turn (a queued command) also fires onPhone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follower-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, '');
  const got = [];
  const f = new TranscriptFollower(() => file, { onPhone: (e) => got.push(['phone', e.turn]), onPrompt: (e) => got.push(['prompt', e.text]) });
  f.poll();
  fs.appendFileSync(file, JSON.stringify({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: '[phone] hi' } }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'attachment', uuid: 'q2', attachment: { type: 'queued_command', prompt: 'typed at the desk' } }) + '\n');
  f.poll();
  // Typed at the desk mid-turn is TJ moving on at the laptop, like any laptop prompt.
  assert.deepEqual(got, [['phone', 'q1'], ['prompt', 'typed at the desk']]);
});

test('prompts are sorted by source: [relay] and system text are not TJ, [voice] and wrapped text are judged inside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follower-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, '');
  const got = [];
  const f = new TranscriptFollower(() => file, {
    onPhone: (e) => got.push(['phone', e.turn]),
    onPrompt: (e) => got.push(['prompt', e.text]),
    onMoved: (e) => got.push(['moved', e.at]),
    onReply: (e) => got.push(['reply', e.text, e.answers]),
  });
  f.poll();
  const add = (e) => fs.appendFileSync(file, JSON.stringify(e) + '\n');
  const user = (uuid, content, ts) => add({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content } });
  const reply = (id, text) => add({ type: 'assistant', uuid: id, message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  user('r1', '[relay] 1 report from project sessions.', '2026-11-12T10:00:00.000Z');
  reply('m1', 'A session finished.');
  user('p1', '\n\n<pasted_content id="50aa">\n[phone] a long one from the phone', '2026-11-12T10:01:00.000Z');
  reply('m2', 'Phone answer.');
  user('t1', '<task-notification>\n<task-id>x</task-id>', '2026-11-12T10:02:00.000Z');
  user('v1', '[voice] what is next', '2026-11-12T10:03:00.000Z');
  reply('m3', 'Laptop answer.');
  f.poll();
  assert.deepEqual(got, [
    ['reply', 'A session finished.', 'relay'],
    ['phone', 'p1'], ['reply', 'Phone answer.', 'phone'],
    ['prompt', 'what is next'], ['moved', Date.parse('2026-11-12T10:03:00.000Z')], ['reply', 'Laptop answer.', 'laptop'],
  ]);
});

test('the moved-on mark is read from history when following starts, without reporting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follower-'));
  const file = path.join(dir, 't.jsonl');
  const lines = [
    { type: 'user', uuid: 'a', timestamp: '2026-11-12T09:00:00.000Z', message: { role: 'user', content: 'typed earlier' } },
    { type: 'user', uuid: 'b', timestamp: '2026-11-12T09:30:00.000Z', message: { role: 'user', content: '[phone] then the phone' } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const got = [];
  const f = new TranscriptFollower(() => file, { onPrompt: (e) => got.push(e), onMoved: (e) => got.push(e), onPhone: (e) => got.push(e) });
  f.poll();
  assert.deepEqual(got, []);
  assert.equal(f.mark, Date.parse('2026-11-12T09:00:00.000Z'));
  assert.equal(f.lastSource, 'phone');
});

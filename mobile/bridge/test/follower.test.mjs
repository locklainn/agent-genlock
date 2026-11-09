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

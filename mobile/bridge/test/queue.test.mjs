// A message sent while the Assistant is closed is kept, and the app is woken to start it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverToAssistant, assistantInbox, TranscriptFollower } from '../lib.mjs';

test('with the Assistant closed, a message waits in the inbox and the app is woken', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-queue-'));
  let woken = 0;
  const r = deliverToAssistant('what is left on billing?', home, { wake: () => woken++ });
  assert.equal(r.queued, true);
  assert.equal(woken, 1);
  const body = JSON.parse(fs.readFileSync(path.join(assistantInbox(home), r.name), 'utf8'));
  assert.equal(body.text, '[phone] what is left on billing?');
});

test('with the Assistant open, it goes straight to its channel and nothing is woken', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-queue-'));
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [{ project: path.join(home, 'Assistant'), token: 'tok' }] }));
  let woken = 0;
  const r = deliverToAssistant('hi', home, { wake: () => woken++ });
  assert.equal(r.queued, false);
  assert.equal(woken, 0);
  assert.ok(fs.existsSync(path.join(home, 'voice', 'tok', r.name)));
});

test('the conversation started for a queued message is read from its first turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-queue-'));
  const file = path.join(dir, 't.jsonl');
  let current = null;
  const got = [];
  const f = new TranscriptFollower(() => current, { onPhone: (e) => got.push(e.turn), onReply: (e) => got.push(e.text) });
  f.poll();
  f.readNextFromStart = true;
  fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: '[phone] hi' } }) + '\n');
  current = file;
  f.poll();
  assert.deepEqual(got, ['u1']);
});

test('a file from the phone is saved even when the bridge runs with no home given (the launch agent)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-files-'));
  const was = process.env.GENLOCK_HOME;
  process.env.GENLOCK_HOME = home;
  try {
    const { saveIncoming } = await import('../files.mjs');
    const file = saveIncoming(undefined, { name: 'photo-ab.jpg', buf: Buffer.from('jpeg bytes') });
    assert.ok(file.startsWith(path.join(home, 'phone', 'files')), file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'jpeg bytes');
  } finally {
    if (was === undefined) delete process.env.GENLOCK_HOME; else process.env.GENLOCK_HOME = was;
  }
});

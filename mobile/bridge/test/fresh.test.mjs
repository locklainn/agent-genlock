// A status update from the phone starts the Assistant on a fresh conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendToAssistant, isStatusRequest } from '../lib.mjs';

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-fresh-'));
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [{ project: path.join(home, 'Assistant'), token: 'tok' }] }));
  return home;
}
const tell = (home, name) => JSON.parse(fs.readFileSync(path.join(home, 'voice', 'tok', name), 'utf8'));

test('the Status update button, sent as plain text, is marked fresh', () => {
  const home = fakeHome();
  const t = tell(home, sendToAssistant('Status update: what changed since you last told me', home));
  assert.equal(t.fresh, true);
  assert.match(t.text, /^\[phone\] Status update/);
});

test('saying "status update" counts too, but ordinary talk does not', () => {
  assert.ok(isStatusRequest('  status update please'));
  assert.ok(!isStatusRequest('give me the status of billing'));
  const home = fakeHome();
  assert.equal(tell(home, sendToAssistant('rank billing first', home)).fresh, undefined);
});

test('an explicit fresh flag wins', () => {
  const home = fakeHome();
  assert.equal(tell(home, sendToAssistant('start over', home, { fresh: true })).fresh, true);
});

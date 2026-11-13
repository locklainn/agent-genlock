#!/usr/bin/env node
/* Attachments: a file sent to a ticket is copied into .genlock/files/, survives the original
   being deleted, shows on the ticket, stays out of git, rides in backups, and is purged only on
   the user's word. Run: node tests/attach.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-attach-test-')));
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-attach-out-')));
const env = { ...process.env, HOME: ROOT, GENLOCK_HOME: path.join(ROOT, 'app'), GENLOCK_SESSION: 'attacher',
  GENLOCK_AGENT_PID: '0', GENLOCK_TERMINAL: 'print', GENLOCK_BACKUP_DIR: path.join(OUT, 'backups') };
delete env.CLAUDE_CODE_SESSION_ID; delete env.GENLOCK_APP_CHANNEL;
spawnSync('git', ['init', '-q'], { cwd: ROOT });

const g = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, all: r.stdout + r.stderr };
};
const ok = (...args) => { const r = g(...args); assert.equal(r.code, 0, `${args.join(' ')}\n${r.all}`); return r.out; };
const store = path.join(ROOT, '.genlock', 'files');
const shot = (name, body) => { const p = path.join(OUT, name); fs.writeFileSync(p, body); return p; };

ok('new', 'The header clears the menu', '--short', 'header', '-r', 'The header no longer overlaps the menu', '-c', 'manual: look');
ok('new', 'The footer sits low', '--short', 'footer', '-r', 'The footer sits below the fold', '-c', 'manual: look');

test('attach copies the file, so the ticket keeps it after the original is gone', () => {
  const src = shot('Screenshot 2026-11-13.png', 'PNGDATA-header');
  ok('attach', 'header', src, '--why', 'the overlap TJ saw');
  fs.rmSync(src);
  const [stored] = fs.readdirSync(store);
  assert.match(stored, /^[0-9a-f]{12}-Screenshot_2026-11-13\.png$/);
  assert.equal(fs.readFileSync(path.join(store, stored), 'utf8'), 'PNGDATA-header');
  assert.notEqual(g('attach', 'header', path.join(OUT, 'nope.png'), '--why', 'x').code, 0, 'a missing file is refused');
  assert.notEqual(g('attach', 'header', shot('a.txt', 'a')).code, 0, '--why is required');
});

test('show lists the stored path, readable by a later process', () => {
  const shown = ok('show', 'header');
  const [stored] = fs.readdirSync(store);
  assert.ok(shown.includes(path.join(store, stored)), shown);
  assert.match(shown, /the overlap TJ saw/);
  assert.match(ok('files'), /1 kept/);
});

test('the store is ignored by git and carried by backup', () => {
  const [stored] = fs.readdirSync(store);
  const ign = spawnSync('git', ['check-ignore', '-q', path.join(store, stored)], { cwd: ROOT });
  assert.equal(ign.status, 0, 'git ignores .genlock/files/');
  const r = ok('backup');
  const archive = r.match(/(\S+\.tar\.gz)/)[1];
  const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout;
  assert.match(list, new RegExp(`\\.genlock/files/${stored.replace('.', '\\.')}`));
});

test('one file on two tickets is stored once and survives purging one of them', () => {
  const src = shot('same.png', 'SHARED');
  ok('attach', 'header', src, '--why', 'shared shot');
  ok('attach', 'footer', src, '--why', 'shared shot');
  assert.equal(fs.readdirSync(store).filter((f) => f.endsWith('same.png')).length, 1);
  ok('purge', 'footer', '--user-said', 'purge the footer files');
  assert.equal(fs.readdirSync(store).filter((f) => f.endsWith('same.png')).length, 1, 'header still keeps it');
  assert.match(ok('show', 'footer'), /same\.png — purged/);
});

test('purge refuses without the user\'s word, then deletes and records it', () => {
  const dry = g('purge', 'header');
  assert.notEqual(dry.code, 0);
  assert.match(dry.all, /Would purge 2 file/);
  assert.equal(fs.readdirSync(store).length, 2, 'nothing deleted on a refusal');
  ok('purge', 'header', '--user-said', 'ok purge them');
  assert.deepEqual(fs.readdirSync(store), []);
  const shown = ok('show', 'header');
  assert.match(shown, /Screenshot 2026-11-13\.png — purged \d{4}-\d{2}-\d{2}/);
  assert.match(ok('purge', 'header', '--user-said', 'again'), /Nothing to purge/);
});

test('purge --before takes only older attachments', () => {
  ok('attach', 'footer', shot('new.png', 'NEW'), '--why', 'today');
  assert.match(ok('purge', '--before', '2000-01-01', '--user-said', 'x'), /Nothing to purge/);
  assert.match(ok('purge', '--before', '2999-01-01', '--user-said', 'clear old'), /Purged 1 attachment/);
});

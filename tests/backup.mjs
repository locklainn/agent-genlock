#!/usr/bin/env node
/* Backups: one archive holds every record, restores into an empty folder as the same goals and
   tasks, and never overwrites records unless told to, saving them first when it does.
   Run: node tests/backup.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-backup-test-')));
const OUT = path.join(ROOT, 'backups');
const env = { ...process.env, HOME: ROOT, GENLOCK_HOME: path.join(ROOT, 'app'), GENLOCK_BACKUP_DIR: OUT, GENLOCK_SESSION: 'tester', GENLOCK_AGENT_PID: '0' };
delete env.CLAUDE_CODE_SESSION_ID; delete env.GENLOCK_APP_CHANNEL;

const g = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, all: r.stdout + r.stderr };
};
const repo = (name) => {
  const d = path.join(ROOT, name);
  fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: d });
  return d;
};
const records = (d) => fs.readdirSync(path.join(d, '.genlock', 'records')).sort();
const archiveFrom = (out) => out.match(/to (\S+\.tar\.gz)/)[1];

const A = repo('alpha');
g(A, 'goal', 'add', 'Ship the alpha', '--user-said', 'ship it');
g(A, 'new', 'Alpha task', '-r', 'it works', '-c', 'node -e 0');
g(A, 'new', 'Second task', '-r', 'also works', '-c', 'node -e 0');

test('backup holds every record file, and restores into an empty folder as the same goals and tasks', () => {
  const b = g(A, 'backup');
  assert.equal(b.code, 0, b.all);
  const file = archiveFrom(b.out);
  assert.ok(file.startsWith(OUT));
  const entries = spawnSync('tar', ['tzf', file], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /\/records\/.+\.jsonl$/.test(l));
  assert.equal(entries.length, records(A).length);

  const E = repo('empty');
  const r = g(E, 'restore', file);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(records(E), records(A));
  assert.equal(g(E, 'goal', 'list', '--all').out, g(A, 'goal', 'list', '--all').out);
  assert.equal(g(E, 'list').out, g(A, 'list').out);
});

test('restore refuses over existing records, and --force saves them before replacing', () => {
  const file = archiveFrom(g(A, 'backup').out);
  const B = repo('beta');
  const made = g(B, 'new', 'Beta only task', '-r', 'the beta project keeps its own records on disk', '-c', 'node -e 0');
  assert.equal(made.code, 0, made.all);
  const before = records(B);
  const refused = g(B, 'restore', file);
  assert.equal(refused.code, 4, refused.all);
  assert.match(refused.all, /Nothing was changed/);
  assert.deepEqual(records(B), before);

  const forced = g(B, 'restore', file, '--force');
  assert.equal(forced.code, 0, forced.all);
  const saved = forced.out.match(/saved in (\S+\.tar\.gz)/)[1];
  assert.deepEqual(records(B), records(A));
  // The replaced records are in the safety backup, and come back from it.
  const C = repo('gamma');
  assert.equal(g(C, 'restore', saved).code, 0);
  assert.deepEqual(records(C), before);
});

test('--all takes every project in the app, and restore asks which one', () => {
  const B = path.join(ROOT, 'beta');
  fs.mkdirSync(env.GENLOCK_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.GENLOCK_HOME, 'projects.json'), JSON.stringify([{ path: A }, { path: B }, { path: path.join(ROOT, 'gone') }]));
  const b = g(A, 'backup', '--all');
  assert.equal(b.code, 0, b.all);
  const file = archiveFrom(b.out);
  const D = repo('delta');
  const ask = g(D, 'restore', file);
  assert.notEqual(ask.code, 0);
  assert.match(ask.all, /alpha, beta/);
  assert.equal(g(D, 'restore', file, '--project', 'alpha').code, 0);
  assert.deepEqual(records(D), records(A));
});

test('a file that is not a genlock backup is refused', () => {
  const junk = path.join(ROOT, 'junk.tar.gz');
  fs.writeFileSync(path.join(ROOT, 'x.txt'), 'x');
  spawnSync('tar', ['czf', junk, 'x.txt'], { cwd: ROOT });
  const r = g(repo('eps'), 'restore', junk);
  assert.notEqual(r.code, 0);
  assert.match(r.all, /not a genlock backup/);
});

process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

#!/usr/bin/env node
/* Tags and metadata: set on goals and tasks, read back from the records by a later process
   (as a later session would), and the filed/unfiled pair that tracks what reached NextLevel.
   Run: node tests/tags.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-tags-test-')));
const env = { ...process.env, HOME: ROOT, GENLOCK_HOME: path.join(ROOT, 'app'), GENLOCK_SESSION: 'tagger', GENLOCK_AGENT_PID: '0', GENLOCK_TERMINAL: 'print' };
delete env.CLAUDE_CODE_SESSION_ID; delete env.GENLOCK_APP_CHANNEL;
spawnSync('git', ['init', '-q'], { cwd: ROOT });

const g = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, all: r.stdout + r.stderr };
};
const ok = (...args) => { const r = g(...args); assert.equal(r.code, 0, `${args.join(' ')}\n${r.all}`); return r.out; };

function finish(short) {
  ok('start', short);
  ok('met', short, '1', '--evidence', 'opened localhost:3000 and saw it');
  ok('grill', short, '--observed', 'seen at localhost:3000', '--cause', 'new', '--absence', 'mobile unchecked',
    '--assumption', 'one page', '--falsify', 'reload shows nothing');
  ok('done', short);
}

ok('goal', 'add', 'Ship the dashboard', '--user-said', 'ship the dashboard');
ok('new', 'Draw the chart', '--short', 'chart', '-r', 'The chart renders on the dashboard page', '-c', 'manual: open the page');
ok('new', 'Add the legend', '--short', 'legend', '-r', 'The legend names every series on the chart', '-c', 'manual: open the page');
ok('new', 'Export to CSV', '--short', 'export', '-r', 'The export button downloads every row as CSV', '-c', 'manual: click it');

test('tags and metadata are added, removed, and read back by a later process', () => {
  ok('tag', 'chart', '#UI', 'charts');
  ok('tag', 'chart', '--remove', 'charts');
  ok('meta', 'chart', 'owner', 'design', 'team');
  ok('meta', 'chart', 'pr', '42');
  ok('meta', 'chart', 'pr', '--clear');
  const shown = ok('show', 'chart');
  assert.match(shown, /tags: #ui$/m);
  assert.match(shown, /meta: owner=design team$/m);
  assert.doesNotMatch(shown.match(/^\s*meta: .*$/m)[0], /pr=/, "a cleared key leaves the current metadata");
  const snap = JSON.parse(ok('snapshot'));
  const t = snap.tickets.find((x) => x.short === 'chart');
  assert.deepEqual(t.tags, ['ui']);
  assert.deepEqual(t.meta, { owner: 'design team' });
  assert.equal(ok('meta', 'chart', 'owner').trim(), 'design team');
  assert.match(ok('tagged', 'ui'), /chart/);
  // A goal takes them the same way.
  ok('tag', 'dashboard', 'q4');
  assert.deepEqual(JSON.parse(ok('snapshot')).goals[0].tags, ['q4']);
});

test('bad tags and keys are refused', () => {
  assert.notEqual(g('tag', 'chart', 'has space').code, 0);
  assert.notEqual(g('meta', 'chart', 'Bad Key!', 'x').code, 0);
});

test('filed marks finished work with the tag and event id; unfiled lists only what is left', () => {
  finish('chart');
  finish('legend');
  let un = JSON.parse(ok('unfiled', '--json'));
  assert.deepEqual(un.map((r) => r.short).sort(), ['chart', 'legend'], 'done tasks only; the open one is not listed');

  const refused = g('filed', 'export', '--event', 'claude-dev-abc1234');
  assert.notEqual(refused.code, 0);
  assert.match(refused.all, /only finished work is filed/);

  ok('filed', 'chart', 'legend', '--event', 'claude-dev-abc1234');
  const t = JSON.parse(ok('snapshot')).tickets.find((x) => x.short === 'chart');
  assert.ok(t.tags.includes('filed:nextlevel'));
  assert.equal(t.meta['nextlevel.event'], 'claude-dev-abc1234');
  assert.match(t.meta['nextlevel.filed_at'], /^\d{4}-\d{2}-\d{2}T/);
  // The record itself carries it, so it survives the session that filed it.
  const file = fs.readFileSync(path.join(ROOT, '.genlock', 'records', `${t.id}.jsonl`), 'utf8');
  assert.match(file, /filed:nextlevel/);
  assert.match(file, /claude-dev-abc1234/);

  un = JSON.parse(ok('unfiled', '--json'));
  assert.deepEqual(un, []);
  assert.match(ok('unfiled'), /all finished work is filed to nextlevel/);

  finish('export');
  assert.deepEqual(JSON.parse(ok('unfiled', '--json')).map((r) => r.short), ['export']);
  // Another destination is tracked separately.
  assert.equal(JSON.parse(ok('unfiled', '--to', 'changelog', '--json')).length, 3);
});

test('overview shows a task\'s tags, and counts finished work not yet filed', () => {
  const app = path.join(ROOT, 'app');
  fs.mkdirSync(path.join(app, 'voice'), { recursive: true });
  fs.writeFileSync(path.join(app, 'projects.json'), JSON.stringify([{ path: ROOT, tier: 'active' }]));
  ok('new', 'Theme the dashboard', '--short', 'theme', '-r', 'The dashboard follows the dark theme setting', '-c', 'manual: toggle it');
  ok('start', 'theme');
  ok('tag', 'theme', 'design');
  const r = spawnSync(process.execPath, [CLI, 'overview', path.basename(ROOT)], { cwd: ROOT, encoding: 'utf8',
    env: { ...env, GENLOCK_APP_PROJECTS: path.join(app, 'projects.json'), GENLOCK_APP_CHANNELS: path.join(app, 'voice') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /task #\d+: theme: .*#design/);
  assert.match(r.stdout, /1 finished not filed to nextlevel/);
});

process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

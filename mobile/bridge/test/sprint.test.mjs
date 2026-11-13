// The sprint report the phone asks the bridge for is the one the Mac app reads from
// `genlock sprint --all --json`: built from a real project's records, through the real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sprintReport } from '../lib.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin/genlock.mjs');

test('the bridge returns exactly what the Mac app reads, with a task finished this sprint', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gl-sprint-home-')));
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  const env = { ...process.env, HOME: home, GENLOCK_HOME: home, GENLOCK_TERMINAL: 'print', GENLOCK_AGENT_PID: '0', GENLOCK_SESSION: 'sprint-test' };
  delete env.GENLOCK_APP_CHANNEL; delete env.CLAUDE_CODE_SESSION_ID;
  const g = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: proj, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout; };
  spawnSync('git', ['init', '-q'], { cwd: proj });
  g('init', '--private');
  g('new', 'Ship the widget', '--short', 'widget', '-r', 'The widget renders on the page', '-c', 'manual: open the page and see it');
  g('start', 'widget');
  g('met', 'widget', '1', '--evidence', 'opened localhost:3000, widget visible top-left');
  g('grill', 'widget', '--observed', 'widget seen at localhost:3000', '--cause', 'none, it is new', '--absence', 'not checked on mobile',
    '--assumption', 'one page only', '--falsify', 'reload shows no widget');
  g('done', 'widget');
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ path: proj }]));
  fs.writeFileSync(path.join(home, 'sprint.json'), JSON.stringify({ weekly_reset: 'mon 00:00 UTC' }));

  const viaBridge = await sprintReport(home, { sprint: 'current' });
  const viaMac = JSON.parse(g('sprint', '--all', '--json', '--sprint', 'current'));
  assert.deepEqual(viaBridge, viaMac, 'phone and Mac read the same document');
  assert.equal(viaBridge.reset.confirmed, true);
  assert.equal(viaBridge.totals.tasks, 1);
  assert.equal(viaBridge.projects[0].name, 'proj');
  assert.equal(viaBridge.projects[0].tasks[0].name, 'Widget');
  assert.equal(viaBridge.sprints[0].done, 1, 'the picker counts it under the current sprint');

  const last = await sprintReport(home, { sprint: 'previous' });
  assert.equal(last.totals.tasks, 0, 'last week holds nothing');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await sprintReport(home, { from: today, to: today })).range.kind, 'dates');
  await assert.rejects(sprintReport(home, { sprint: 'whenever' }), /not current, previous/);
});

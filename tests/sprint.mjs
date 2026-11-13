#!/usr/bin/env node
/* Sprints: one week from one Claude weekly reset to the next, cut from ONE setting. These pin
   the boundaries to the setting (and only to it), across a DST change, and the picker's
   selectors. Run: node tests/sprint.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseReset, sprintAt, pickSprint, dateRange, buildReport, sprintDocument, zoned } from '../lib/sprint.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
process.env.GENLOCK_DISPLAY_ZONE = 'America/Los_Angeles';
const reset = (t) => ({ text: t, ...parseReset(t) });
const at = (iso) => Date.parse(iso);

test('the setting reads day, time and zone, and refuses anything else', () => {
  assert.deepEqual(parseReset('thu 17:00 America/Los_Angeles'), { day: 4, hour: 17, minute: 0, zone: 'America/Los_Angeles' });
  assert.deepEqual(parseReset('Wednesday 5pm America/Halifax'), { day: 3, hour: 17, minute: 0, zone: 'America/Halifax' });
  assert.deepEqual(parseReset('sat 12am UTC'), { day: 6, hour: 0, minute: 0, zone: 'UTC' });
  for (const bad of ['', 'someday 17:00', 'thu 25:00', 'thu 17:00 Mars/Olympus', 'thu']) assert.throws(() => parseReset(bad), bad);
});

test('a sprint starts at the last reset and ends at the next, in the reset\'s zone', () => {
  const r = reset('thu 17:00 America/Los_Angeles');
  // Friday 13 Nov 2026, 10:00 UTC = 02:00 PST: the sprint began Thu 12 Nov 17:00 PST = 13 Nov 01:00 UTC.
  const s = sprintAt(at('2026-11-13T10:00:00Z'), r);
  assert.equal(s.start, '2026-11-13T01:00:00.000Z');
  assert.equal(s.end, '2026-11-20T01:00:00.000Z');
  assert.equal(s.id, '2026-11-12');
  assert.equal(s.label, 'Nov 12 – Nov 19');
  // A reset kept in UTC still reads in the viewer's clock: Fri 03:00 UTC is Thu 22:00 Eastern.
  const utc = sprintAt(at('2026-11-13T10:00:00Z'), reset('fri 03:00 UTC'), 0, 'America/New_York');
  assert.equal(utc.start, '2026-11-13T03:00:00.000Z');
  assert.equal(utc.label, 'Nov 12 – Nov 19');
  // A minute before the reset is still last week; the reset instant itself opens the new one.
  assert.equal(sprintAt(at('2026-11-13T00:59:00Z'), r).id, '2026-11-05');
  assert.equal(sprintAt(at('2026-11-13T01:00:00Z'), r).id, '2026-11-12');
  // The same instant under a different setting cuts differently: the boundary is the setting's.
  assert.equal(sprintAt(at('2026-11-13T10:00:00Z'), reset('mon 00:00 UTC')).start, '2026-11-09T00:00:00.000Z');
});

test('sprints tile across a daylight-saving change, with no gap and no overlap', () => {
  const r = reset('sun 12:00 America/New_York');
  const now = at('2026-11-10T12:00:00Z'); // after DST ended on Sun 1 Nov 2026
  const cur = sprintAt(now, r, 0), prev = sprintAt(now, r, -1), older = sprintAt(now, r, -2);
  assert.equal(prev.end, cur.start);
  assert.equal(older.end, prev.start);
  assert.equal(older.start, '2026-10-25T16:00:00.000Z', 'noon EDT');
  assert.equal(prev.start, '2026-11-01T17:00:00.000Z', 'noon EST, an hour later in UTC');
  assert.equal(zoned(2026, 11, 1, 12, 0, 'America/New_York'), at('2026-11-01T17:00:00Z'));
});

test('the picker: current, previous, -N, a date inside a sprint, and a date range', () => {
  const r = reset('thu 17:00 America/Los_Angeles');
  const now = at('2026-11-13T10:00:00Z');
  assert.equal(pickSprint('current', now, r).id, '2026-11-12');
  assert.equal(pickSprint(undefined, now, r).id, '2026-11-12');
  assert.equal(pickSprint('previous', now, r).id, '2026-11-05');
  assert.equal(pickSprint('-3', now, r).id, '2026-10-22');
  assert.equal(pickSprint('2026-10-30', now, r).id, '2026-10-29', 'a Friday falls in the sprint that began the Thursday before');
  assert.equal(pickSprint('2026-10-30', now, r).offset, -2);
  assert.throws(() => pickSprint('lastish', now, r));
  const d = dateRange('2026-11-01', '2026-11-03', r);
  assert.equal(d.start, '2026-11-01T07:00:00.000Z');
  assert.equal(d.end, '2026-11-04T08:00:00.000Z', 'through the end of the 3rd, PST');
  assert.throws(() => dateRange('2026-11-05', '2026-11-01', r));
});

test('the report holds only tasks done inside the range, under their goals, newest first', () => {
  const range = { start: '2026-11-13T01:00:00.000Z', end: '2026-11-20T01:00:00.000Z' };
  const snap = {
    goals: [{ id: 'G-1', short: 'billing', named: true, title: 'Billing works', status: 'done', completed_at: '2026-11-14T00:00:00Z' }],
    tickets: [
      { id: 'T-1', short: 'refunds', named: true, title: 'Refunds', status: 'done', closed: '2026-11-13T02:00:00Z', goal: 'G-1', summary: '2 of 2 proved' },
      { id: 'T-2', short: 'invoices', named: true, title: 'Invoices', status: 'done', closed: '2026-11-15T02:00:00Z', goal: null },
      { id: 'T-3', title: 'Before', status: 'done', closed: '2026-11-13T00:59:00Z' },
      { id: 'T-4', title: 'At the end', status: 'done', closed: '2026-11-20T01:00:00.000Z' },
      { id: 'T-5', title: 'Dropped', status: 'abandoned', closed: '2026-11-14T00:00:00Z' },
      { id: 'T-6', title: 'Open', status: 'in_progress', closed: null },
    ],
  };
  const [p] = buildReport([{ name: 'proj', path: '/p', snap }, { name: 'quiet', path: '/q', snap: { goals: [], tickets: [] } }], range);
  assert.deepEqual(p.tasks.map((t) => t.id), ['T-2', 'T-1']);
  assert.equal(p.tasks[1].goal.name, 'Billing');
  assert.equal(p.tasks[0].goal, null);
  assert.deepEqual(p.goals_done.map((g) => g.id), ['G-1']);
  assert.equal(buildReport([{ name: 'quiet', path: '/q', snap: { goals: [], tickets: [] } }], range).length, 0, 'a project with nothing done is left out');
});

test('the document reads the one setting from sprint.json, and says when it is not set', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-sprint-'));
  const now = at('2026-11-13T10:00:00Z');
  const none = await sprintDocument({ home, now, snap: () => null });
  assert.equal(none.reset.confirmed, false);
  fs.writeFileSync(path.join(home, 'sprint.json'), JSON.stringify({ weekly_reset: 'thu 17:00 America/Los_Angeles' }));
  const doc = await sprintDocument({ home, now, snap: () => null, weeks: 4 });
  assert.equal(doc.reset.confirmed, true);
  assert.equal(doc.range.start, '2026-11-13T01:00:00.000Z');
  assert.equal(doc.range.current, true);
  assert.deepEqual(doc.sprints.map((s) => s.id), ['2026-11-12', '2026-11-05', '2026-10-29', '2026-10-22']);
});

test('genlock sprint --set-reset writes the one value, and refuses a bad one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-sprint-'));
  const env = { ...process.env, GENLOCK_HOME: home, HOME: home, GENLOCK_TERMINAL: 'print' };
  const ok = spawnSync(process.execPath, [CLI, 'sprint', '--set-reset', 'Wednesday 5pm America/Halifax'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'sprint.json'), 'utf8')), { weekly_reset: 'wed 17:00 America/Halifax' });
  const bad = spawnSync(process.execPath, [CLI, 'sprint', '--set-reset', 'someday'], { env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'sprint.json'), 'utf8')), { weekly_reset: 'wed 17:00 America/Halifax' }, 'unchanged');
});

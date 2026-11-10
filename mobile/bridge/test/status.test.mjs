// The Status tab's Tasks view: project -> goal -> tasks, built only from records, never from what a session said.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { status } from '../lib.mjs';

test('status carries only what open sessions are doing: what they hold, or just finished', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-status-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-proj-'));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ path: proj, tier: 'today' }]));
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [{ project: proj, slot: 'a1', token: 'TOK' }] }));
  fs.mkdirSync(path.join(home, 'voice', 'TOK'), { recursive: true });
  fs.writeFileSync(path.join(home, 'voice', 'TOK', 'state.json'), JSON.stringify({ state: 'working', message: 'AGENT PROSE', session: 'S1' }));
  const now = Date.parse('2026-11-10T12:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3600e3).toISOString();
  const t = (id, status, extra = {}) => ({ id, short: id.toLowerCase(), named: true, title: id, status, rank: status === 'done' ? null : 1, goal: 'G-1', summary: 'none', latest: null, updated: hoursAgo(1), ...extra });
  const snap = async () => ({
    goals: [
      { id: 'G-1', short: 'billing', named: true, title: 'Billing works', status: 'active', rank: 1, progress: { done: 1, total: 3 } },
      { id: 'G-2', short: 'idle-goal', named: true, title: 'Nothing moving', status: 'active', rank: 2, progress: { done: 0, total: 1 } },
      { id: 'G-3', short: 'shipped', named: true, title: 'Shipped', status: 'done', completed_at: hoursAgo(3), progress: { done: 2, total: 2 } },
    ],
    tickets: [
      t('REFUNDS', 'in_progress', { owner: 'S1', summary: '2 of 4 proved', latest: { text: 'refund API wired', at: hoursAgo(2) } }),
      t('STALE', 'in_progress', { updated: hoursAgo(100) }),
      t('INVOICES', 'open'),
      t('WAITING', 'open', { goal: 'G-2' }),
      t('OLD', 'done', { closed: hoursAgo(30), owner: 'S1' }),
      ...[1, 2, 3, 4, 5, 6].map((h) => t(`DONE${h}`, 'done', { closed: hoursAgo(h), owner: 'S1' })),
      t('GONE', 'done', { closed: hoursAgo(1), owner: 'S-ENDED' }),
      t('STRAY', 'in_progress', { goal: null }),
    ],
    questions_for_user: [],
  });
  const [p] = await status(home, snap, now);
  assert.deepEqual(p.goals.map((g) => g.title), ['Billing'], 'a goal no open session works on is left out, finished or not');
  const [g] = p.goals;
  assert.equal(g.status, 'active');
  assert.deepEqual([g.done, g.total], [1, 3]);
  assert.deepEqual(g.tasks.map((x) => x.name), ['Refunds', 'Done1', 'Done2', 'Done3', 'Done4', 'Done5'],
    'what a session drives first, then the five newest it finished; unheld, old and ended sessions\' work left out');
  assert.equal(g.tasks[0].latest, 'refund API wired');
  assert.equal(g.tasks[0].proof, '2 of 4 proved');
  assert.equal(g.tasks[0].who, 'Session 1', 'the session whose agent owns it');
  // No backlog of any kind: open tasks, in-progress work no session holds, top goal/task, due, questions.
  for (const k of ['backlog', 'topGoal', 'topTask', 'openTasks', 'waiting', 'blocked', 'due']) assert.ok(!(k in p), `no ${k}`);
  for (const name of ['Stray', 'Stale', 'Invoices', 'Waiting', 'Gone']) assert.ok(!JSON.stringify(p).includes(`"${name}"`), `${name} left out`);
  assert.ok(!JSON.stringify(p.goals).includes('AGENT PROSE'));
});

test('a project with no session open is not in status, even with fresh in-progress work', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-status-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-proj-'));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ path: proj, tier: 'today' }]));
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [] }));
  const now = Date.parse('2026-11-10T12:00:00Z');
  const snap = async () => ({ goals: [], questions_for_user: [], tickets: [
    { id: 'T-1', short: 'fresh', named: true, title: 'Fresh', status: 'in_progress', rank: 1, goal: null, owner: 'GONE', summary: 'none', updated: '2026-11-10T11:59:00Z' }] });
  assert.deepEqual(await status(home, snap, now), []);
});

test('an open task a session holds counts as current', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-status-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-proj-'));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ path: proj, tier: 'today' }]));
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [{ project: proj, spawn: { ticket: 'T-9', session: 'S9' }, token: 'C' }] }));
  fs.mkdirSync(path.join(home, 'voice', 'C'), { recursive: true });
  fs.writeFileSync(path.join(home, 'voice', 'C', 'state.json'), JSON.stringify({ state: 'working', session: 'S9' }));
  const snap = async () => ({ goals: [], tickets: [{ id: 'T-9', short: 'spun', named: true, title: 'Spun off', status: 'open', rank: 1, goal: null, summary: 'none', updated: '2026-01-01T00:00:00Z' }], questions_for_user: [] });
  const [p] = await status(home, snap);
  assert.deepEqual(p.goals.map((g) => g.tasks.map((x) => x.name)), [['Spun']]);
});

test('each session carries its title, goal and task, not just an id', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-status-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-proj-'));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ path: proj, tier: 'today' }]));
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [
    { project: proj, token: 'A' }, { project: proj, slot: 'assistant', token: 'B' }, { project: proj, spawn: { ticket: 'T-9', session: 'S9' }, token: 'C' }] }));
  for (const [tok, sess] of [['A', 'S1'], ['B', 'S2'], ['C', 'S9']]) {
    fs.mkdirSync(path.join(home, 'voice', tok), { recursive: true });
    fs.writeFileSync(path.join(home, 'voice', tok, 'state.json'), JSON.stringify({ state: 'working', session: sess }));
  }
  const snap = async () => ({
    goals: [{ id: 'G-1', short: 'billing', named: true, title: 'Billing works', status: 'active', rank: 1, progress: { done: 1, total: 3 } }],
    tickets: [
      { id: 'T-1', short: 'refund-api', named: true, title: 'Refunds post', status: 'in_progress', rank: 1, goal: 'G-1', owner: 'S1', summary: '2 of 4 proved', latest: { text: 'refund API wired', at: '2026-11-09T10:00:00Z' } },
      { id: 'T-9', short: 'spun', named: true, title: 'Spun off', status: 'open', rank: 2, goal: null, owner: null, summary: 'none' },
    ],
    questions_for_user: [],
  });
  const [p] = await status(home, snap);
  const [a, b, c] = p.sessions;
  assert.equal(a.title, 'Refund api', 'its task, named as the Mac names it');
  assert.deepEqual(a.goal, { title: 'Billing', done: 1, total: 3 });
  assert.equal(a.work.status, 'in_progress');
  assert.equal(a.work.proof, '2 of 4 proved');
  assert.equal(a.work.latest, 'refund API wired');
  assert.equal(b.title, 'Assistant');
  assert.equal(b.work, null);
  assert.equal(c.title, 'Spun', 'a spun-off session is named by its ticket');
  assert.equal(c.goal, null);
});

test('a session that named itself with genlock title is shown by that name, ahead of its task', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-status-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-proj-'));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ path: proj, tier: 'today' }]));
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [{ project: proj, token: 'A' }, { project: proj, slot: 'a2', token: 'B' }] }));
  for (const [tok, sess] of [['A', 'S1'], ['B', 'S2']]) {
    fs.mkdirSync(path.join(home, 'voice', tok), { recursive: true });
    fs.writeFileSync(path.join(home, 'voice', tok, 'state.json'), JSON.stringify({ state: 'working', session: sess }));
  }
  fs.writeFileSync(path.join(home, 'voice', 'B', 'title.json'), JSON.stringify({ title: 'Test timing', at: 1 }));
  const snap = async () => ({ goals: [], tickets: [
    { id: 'T-2', short: 'telemetry', named: true, title: 'Telemetry', status: 'in_progress', rank: 1, goal: null, owner: 'S2', summary: 'none' }], questions_for_user: [] });
  const [p] = await status(home, snap);
  assert.deepEqual(p.sessions.map((s) => s.title), ['Session 1', 'Test timing']);
  assert.equal(p.goals[0].tasks[0].who, 'Test timing', 'the task names its holder by the same name');
});

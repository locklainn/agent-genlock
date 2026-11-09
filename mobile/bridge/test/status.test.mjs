// The Status tab's Tasks view: project -> goal -> tasks, built only from records, never from what a session said.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { status } from '../lib.mjs';

test('status carries goals with their open tasks, holder and latest, and no session prose in them', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-status-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-proj-'));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ path: proj, tier: 'today' }]));
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ open: [{ project: proj, slot: 'a1', token: 'TOK' }] }));
  fs.mkdirSync(path.join(home, 'voice', 'TOK'), { recursive: true });
  fs.writeFileSync(path.join(home, 'voice', 'TOK', 'state.json'), JSON.stringify({ state: 'working', message: 'AGENT PROSE', session: 'S1' }));
  const snap = async () => ({
    goals: [{ id: 'G-1', short: 'billing', named: true, title: 'Billing works', status: 'active', rank: 1, progress: { done: 1, total: 3 } }],
    tickets: [
      { id: 'T-1', short: 'refunds', named: true, title: 'Refunds post', status: 'in_progress', rank: 2, goal: 'G-1', owner: 'S1', summary: '2 of 4 proved', latest: { text: 'refund API wired', at: '2026-11-09T10:00:00Z' }, updated: '2026-11-09T10:00:00Z' },
      { id: 'T-2', short: 'invoices', named: true, title: 'Invoices', status: 'open', rank: 1, goal: 'G-1', owner: null, summary: 'none', latest: null, updated: '2026-11-08T10:00:00Z' },
      { id: 'T-3', short: 'stray', named: true, title: 'Stray', status: 'open', rank: 3, goal: null, summary: 'none', latest: null, updated: '2026-11-08T10:00:00Z' },
      { id: 'T-4', short: 'old', named: true, title: 'Old', status: 'done', rank: null, goal: 'G-1', summary: '1 of 1 proved', updated: '2026-11-01T10:00:00Z' },
    ],
    questions_for_user: [],
  });
  const [p] = await status(home, snap);
  const [g, loose] = p.goals;
  assert.equal(g.title, 'billing: Billing works');
  assert.deepEqual([g.done, g.total], [1, 3]);
  assert.deepEqual(g.tasks.map((t) => t.title), ['refunds: Refunds post', 'invoices: Invoices'], 'in progress first, done left out');
  assert.equal(g.tasks[0].latest, 'refund API wired');
  assert.equal(g.tasks[0].proof, '2 of 4 proved');
  assert.equal(g.tasks[0].who, 'Session 1', 'the session whose agent owns it');
  assert.equal(g.tasks[1].who, null);
  assert.equal(loose.title, 'No goal');
  assert.deepEqual(loose.tasks.map((t) => t.title), ['stray: Stray']);
  assert.ok(!JSON.stringify(p.goals).includes('AGENT PROSE'));
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

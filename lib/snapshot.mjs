/**
 * Everything about a repository's work as one JSON document, for tools that show it, such
 * as the Mac app. It is the only supported way to read records from outside this package,
 * so their format stays free to change. It writes nothing.
 */

import fs from 'node:fs';
import { dirtyFiles, identity, liveForbids, readEvents, recordsDir, repoRoot, shortName, hasChosenName } from './store.mjs';
import { allTickets, OPEN_STATES, summariseReqs } from './tickets.mjs';
import { allGoals, daysUntil, goalsSkipped, openNext, progress } from './goals.mjs';
import { liveClaims } from './claims.mjs';
import { userQuestions } from './ask.mjs';
import { allReviews } from './reviews.mjs';
import { rankedGoals, rankedTasks } from './rank.mjs';
import { allFollowups } from './followups.mjs';

// Raised whenever the app comes to rely on something new, so it can say the CLI is too old
// rather than fail quietly.
const SNAPSHOT_FORMAT = 3;

const shared = (r) => ({
  forbids: liveForbids(r).map((f) => ({ text: f.text, lifted_by: f.lifted_by })),
  decisions: r.decisions.map((d) => ({ text: d.text, user_said: d.user_said, withdrawn: !!d.withdrawn })),
  refs: r.refs,
});

const dated = (r) => ({ due: r.due, days_until: r.due ? daysUntil(r.due) : null });

// What a glance at a task needs: its last few moves, newest first. No assumptions, grills or
// notes, which are the agent's working, not the task's progress.
const FEED = { update: 'update', met: 'proved', failed: 'failed', waived: 'waived', status: 'started', blocked: 'blocked', done: 'done', abandoned: 'abandoned', handoff: 'handed off', open: 'opened' };
const recent = (t) => t.log.filter((l) => FEED[l.kind]).slice(-4).reverse()
  .map((l) => ({ kind: FEED[l.kind], text: String(l.kind === 'status' ? '' : l.text || '').slice(0, 300), at: l.at }));

const ticketView = (t, rank) => ({
  rank, ...dated(t), short: shortName(t.id), named: hasChosenName(t.id), id: t.id, title: t.title, status: t.status, goal: t.goal, owner: t.owner, parent: t.parent,
  created: t.created, updated: t.updated, closed: t.closed, summary: summariseReqs(t),
  latest: t.latest ? { text: t.latest.text, at: t.latest.at } : null,
  recent: recent(t),
  blocked_reason: t.status === 'blocked' ? t.blocked_reason : null,
  requirements: t.requirements.map((r) => ({ n: r.n, text: r.text, state: r.state, evidence: r.evidence })),
  hazards: t.hazards.filter((h) => !h.cleared).map((h) => ({ what: h.what, verify: h.verify })),
  ...shared(t),
});

export function cmdSnapshot() {
  const initialized = fs.existsSync(recordsDir());
  const tickets = allTickets();
  const lastActivity = (g) => [g.updated, ...tickets.filter((t) => t.goal === g.id).map((t) => t.updated)].sort().pop();

  const allG = allGoals();
  const goalRank = new Map(rankedGoals(allG).map((g) => [g.id, g.rank]));
  const taskRank = new Map(rankedTasks(tickets).map((t) => [t.id, t.rank]));

  const goals = allG.map((g) => {
    const p = progress(g, tickets);
    return {
      rank: goalRank.get(g.id) ?? null, ...dated(g), short: shortName(g.id), named: hasChosenName(g.id), id: g.id, title: g.title, status: g.status, why: g.why, done_when: g.done_when, waiting_on: g.waiting_on,
      completed_at: g.completed_at || null, evidence: g.evidence || null,
      created: g.created, updated: g.updated, last_activity: lastActivity(g),
      progress: { done: p.done, total: p.total, blocked: tickets.filter((t) => t.goal === g.id && t.status === 'blocked').length },
      next: openNext(g).map((n) => ({ n: n.n, text: n.text, due: n.due, days_until: n.due ? daysUntil(n.due) : null })),
      updates: g.updates.slice(-10),
      ...shared(g),
    };
  });

  const active = goals.filter((g) => g.status === 'active').sort((a, b) => b.last_activity.localeCompare(a.last_activity));
  const worked = tickets.filter((t) => t.status !== 'draft').sort((a, b) => b.updated.localeCompare(a.updated));
  const checkpoints = readEvents('project').filter((e) => e.op === 'checkpoint');
  const cp = checkpoints[checkpoints.length - 1];

  console.log(JSON.stringify({
    format: SNAPSHOT_FORMAT,
    root: repoRoot(),
    initialized,
    goals_declined: goalsSkipped(),
    me: identity(),
    current_goal: active[0]?.id || null,
    last_ticket: worked[0]?.id || null,
    goals,
    tickets: tickets.map((t) => ticketView(t, taskRank.get(t.id) ?? null)),
    open_tickets: tickets.filter((t) => OPEN_STATES.has(t.status)).map((t) => t.id),
    questions_for_user: userQuestions().filter((q) => !q.answer).map((q) => ({ id: q.id, text: q.text, about: q.about, at: q.at })),
    reviews: allReviews().sort((a, b) => (b.updated || '').localeCompare(a.updated || '')),
    claims: liveClaims().map((c) => ({ key: c.key, session: c.session, paths: c.paths, resources: c.resources, expires: c.expires })),
    last_checkpoint: cp ? { at: cp.at, goals: cp.goals, uncommitted: cp.uncommitted } : null,
    uncommitted: dirtyFiles().length,
    // Per session id: what it identified and has not finished.
    followups: allFollowups(),
  }, null, 2));
}

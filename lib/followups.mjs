/**
 * Follow-up work: what one session identified and has not finished. Computed from the `by`
 * on every event, so it is exactly that session's, never a guess. It is what a session reads
 * out before offering to swap itself for a fresh one, and what the user reads before closing.
 */

import { die, identity, listIds, readEvents, shortName } from './store.mjs';
import { allTickets, OPEN_STATES } from './tickets.mjs';
import { allGoals, goalIsOpen } from './goals.mjs';
import { userQuestions } from './ask.mjs';
import { safetyProblems } from './spinoff.mjs';

const openedBy = (id) => readEvents(id)[0]?.by || null;

/** Everything `session` started that is still open. Empty lists when it left nothing behind. */
export function followupsFor(session, tickets = allTickets(), goals = allGoals()) {
  const out = { goals: [], tickets: [], spinoffs: [], questions: [], unproved: [] };
  if (!session) return out;
  for (const g of goals) {
    if (!goalIsOpen(g)) continue;
    const started = readEvents(g.id).find((e) => e.op === 'add' || e.op === 'propose');
    if (started?.by !== session) continue;
    out.goals.push({ id: g.id, short: shortName(g.id), title: g.title, status: g.status });
  }
  for (const t of tickets) {
    if (!OPEN_STATES.has(t.status)) continue;
    const s = t.spinoff;
    // A spin-off this session proposed is its follow-up even though the ticket names it as opener.
    if (s && (s.launched_by === session || (openedBy(t.id) === session && s.state !== 'launched'))) {
      const state = s.state || 'proposed';
      const entry = { id: t.id, short: shortName(t.id), title: t.title, state };
      if (state === 'proposed') entry.safe = safetyProblems(t).length === 0;
      out.spinoffs.push(entry);
      continue;
    }
    const mineToProve = t.owner === session || (!t.owner || t.owner === 'unassigned') && openedBy(t.id) === session;
    if (openedBy(t.id) === session || mineToProve) {
      out.tickets.push({ id: t.id, short: shortName(t.id), title: t.title, status: t.status });
    }
    if (mineToProve) {
      for (const r of t.requirements.filter((x) => x.state === 'open' || x.state === 'failed'))
        out.unproved.push({ ticket: t.id, n: r.n, text: r.text, state: r.state });
    }
  }
  for (const q of userQuestions()) {
    if (!q.answer && q.from === session) out.questions.push({ id: q.id, text: q.text, about: q.about });
  }
  return out;
}

export const followupCount = (f) => f.goals.length + f.tickets.length + f.spinoffs.length + f.questions.length;

/** Every session that has left something open, for the app. */
export function allFollowups() {
  const tickets = allTickets();
  const goals = allGoals();
  const sessions = new Set();
  for (const id of [...listIds('T-'), ...listIds('G-'), ...listIds('Q-')]) {
    for (const e of readEvents(id)) if (e.by && e.by !== 'unknown') sessions.add(e.by);
  }
  const out = {};
  for (const s of sessions) {
    const f = followupsFor(s, tickets, goals);
    if (followupCount(f) || f.unproved.length) out[s] = f;
  }
  return out;
}

export function followupLines(f) {
  const L = [];
  const label = (x) => `${x.short || x.id}: ${x.title}`;
  if (f.goals.length) L.push('Goals added or proposed:', ...f.goals.map((g) => `  ${label(g)}${g.status === 'active' ? '' : ` (${g.status})`}`));
  if (f.tickets.length) L.push('Tasks still open:', ...f.tickets.map((t) => `  ${label(t)} (${t.status.replace('_', ' ')})`));
  if (f.spinoffs.length) {
    L.push('Spin-offs:', ...f.spinoffs.map((s) => `  ${label(s)} (${s.state === 'proposed' ? (s.safe ? 'proposed, safe to launch' : 'proposed, not safe yet') : s.state})`));
  }
  if (f.questions.length) L.push('Questions waiting on the user:', ...f.questions.map((q) => `  ${q.id}: ${q.text}`));
  if (f.unproved.length) L.push('Requirements not yet proved:', ...f.unproved.map((r) => `  ${r.ticket} #${r.n}${r.state === 'failed' ? ' FAILED' : ''}: ${r.text}`));
  return L;
}

export function cmdFollowups(a) {
  const session = a.session || identity();
  if (!session) die('no session identity, so nothing is known to be yours. Set GENLOCK_SESSION, or pass --session ID.');
  const f = followupsFor(session);
  if (a.json) { console.log(JSON.stringify(f, null, 2)); return; }
  const L = followupLines(f);
  console.log(L.length ? L.join('\n') : 'Nothing this session identified is left open.');
}

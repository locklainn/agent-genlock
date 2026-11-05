/**
 * Continuity: picking work back up, whether the next reader is another agent or this one
 * after a cleared context. There is no separate document to go stale. Goals say what is
 * next, tickets say what just happened, and everything live is read when it is asked for.
 *
 *   orient      what a session should know as it starts
 *   checkpoint  refuses until the records are current, so context can be cleared safely
 *   continue    everything needed to carry on with a goal or ticket
 */

import { die, dirtyFiles, emit, identity, liveForbids, readEvents, resolveId, sharedLines } from './store.mjs';
import { allTickets, loadTicket, render, OPEN_STATES, summariseReqs } from './tickets.mjs';
import { allGoals, daysUntil, goalLine, goalsSkipped, loadGoal, nextLine, openNext, progress } from './goals.mjs';
import { covers, liveClaims, releaseTicket } from './claims.mjs';
import { inboxFor, userQuestions } from './ask.mjs';
import { openReviews } from './reviews.mjs';

const WORK_KINDS = new Set(['req', 'met', 'failed', 'waived', 'assume', 'grill', 'status', 'blocked', 'open']);
const DEADLINE_WINDOW = 30;
const held = (c) => [...c.paths, ...c.resources.map((r) => `resource:${r}`)].join(', ');

/** The ticket's own last piece of real work, which its `latest` has to be newer than. */
const lastWork = (t) => t.log.filter((e) => WORK_KINDS.has(e.kind)).map((e) => e.at).sort().pop() || t.created;
const lastActivity = (t) => [lastWork(t), t.latest?.at, t.closed].filter(Boolean).sort().pop();

const uncommittedNobodyHolds = (me) => {
  const others = liveClaims().filter((c) => c.session !== me);
  return dirtyFiles().filter((f) => !others.some((c) => c.paths.some((p) => covers(p, f))));
};

function lastCheckpoint() {
  const cps = readEvents('project').filter((e) => e.op === 'checkpoint');
  return cps[cps.length - 1] || null;
}

function inboxLines(me) {
  const { questions, answers } = inboxFor(me);
  const L = [];
  if (questions.length) {
    L.push('', 'Questions for you (genlock answer ID "..."):');
    for (const q of questions) L.push(`  ${q.id}: ${q.text}`);
  }
  if (answers.length) {
    L.push('', 'Answers to your questions:');
    for (const q of answers) L.push(`  ${q.id}: ${q.text} -> ${q.answer}`);
  }
  return L;
}

export function cmdOrient() {
  const tickets = allTickets();
  const goals = allGoals();
  const active = goals.filter((g) => g.status === 'active');
  const proposed = goals.filter((g) => g.status === 'proposed');
  const open = tickets.filter((t) => OPEN_STATES.has(t.status));
  const claims = liveClaims();
  const me = identity();
  const L = ['genlock orient'];

  if (active.length) {
    L.push('', 'Goals:');
    for (const g of active) {
      L.push(`  ${goalLine(g, tickets)}`);
      for (const n of openNext(g)) L.push(`    next ${nextLine(n)}`);
      for (const f of liveForbids(g)) L.push(`    DO NOT: ${f.text}`);
    }
  } else if (!goalsSkipped()) {
    L.push('', 'NO GOALS KNOWN for this repository. Before starting work that spans more than a question, '
      + 'ask the user what they are trying to get done, then record it: genlock goal add "..." --user-said "...". '
      + 'If they would rather not: genlock goal none --user-said "...".');
  }
  const parked = goals.filter((g) => g.status === 'parked');
  if (parked.length) {
    L.push('', 'Parked goals:');
    for (const g of parked) {
      L.push(`  ${g.id}  ${g.title} — waiting on: ${g.waiting_on}`);
      // A hard stop outlives parking: this is the goal someone returns to without context.
      for (const f of liveForbids(g)) L.push(`    DO NOT: ${f.text}`);
    }
  }
  const dated = [...active, ...parked].flatMap((g) => openNext(g).filter((n) => n.due).map((n) => ({ g, n })))
    .sort((x, y) => x.n.due.localeCompare(y.n.due)).filter(({ n }) => daysUntil(n.due) <= DEADLINE_WINDOW);
  if (dated.length) {
    L.push('', 'Deadlines:', ...dated.map(({ g, n }) => `  ${g.id}  ${nextLine(n)}`));
  }
  const forUser = userQuestions().filter((q) => !q.answer);
  if (forUser.length) {
    L.push('', 'Waiting on the user. Raise these when it fits; do not decide them yourself:');
    for (const q of forUser) L.push(`  ${q.id}${q.about ? ` (${q.about})` : ''}: ${q.text}`);
  }
  const toReview = openReviews();
  if (toReview.length) {
    L.push('', 'Waiting for the user to review:', ...toReview.map((r) => `  ${r.id}  ${r.path} — ${r.why}`));
  }
  if (proposed.length) {
    L.push('', 'Proposed goals awaiting the user:', ...proposed.map((g) => `  ${g.id}  ${g.title}`));
  }
  if (open.length) {
    L.push('', 'Open tickets:');
    for (const t of open) {
      L.push(`  ${t.id}  ${t.status.padEnd(12)}${summariseReqs(t).padEnd(18)}${t.title}`);
      if (t.latest) L.push(`    latest: ${t.latest.text}`);
      for (const f of liveForbids(t)) L.push(`    DO NOT: ${f.text}`);
      const haz = t.hazards.filter((h) => !h.cleared).length;
      if (haz) L.push(`    ${haz} hazard(s) left behind: genlock show ${t.id}`);
    }
  }
  const others = claims.filter((c) => c.session !== me);
  if (others.length) {
    L.push('', 'Other sessions working here right now. Stay out of these:');
    for (const c of others) L.push(`  ${c.key}: ${held(c)}`);
  }
  L.push(...inboxLines(me));
  if (active.length || parked.length) {
    L.push('', 'This is a summary. Next things, decisions and files to read for any goal, parked or not: genlock continue GOAL');
  }
  console.log(L.join('\n'));
}

/** What this session is responsible for bringing up to date. */
function mine(me, tickets) {
  const open = tickets.filter((t) => OPEN_STATES.has(t.status));
  if (!me) return open;
  return open.filter((t) => t.owner === me || t.log.some((e) => e.by === me));
}

export function cmdCheckpoint(a) {
  const me = identity();
  const tickets = allTickets();
  const myTickets = mine(me, tickets);
  const goalIds = new Set(myTickets.map((t) => t.goal).filter(Boolean));
  for (const t of tickets) if (t.goal && me && t.log.some((e) => e.by === me)) goalIds.add(t.goal);
  for (const g of allGoals()) if (me && g.touched_by.includes(me)) goalIds.add(g.id);

  const gaps = [];
  for (const t of myTickets) {
    if (!t.latest) gaps.push(`${t.id} has no latest.\n      -> genlock update ${t.id} "what just happened, and where it stands"`);
    else if (lastWork(t) > t.latest.at) gaps.push(`${t.id}'s latest is older than its last work.\n      -> genlock update ${t.id} "..."`);
    if (!t.goal && !goalsSkipped()) gaps.push(`${t.id} belongs to no goal, so "continue the goal" cannot find it.\n      -> genlock link ${t.id} GOAL  (or ask the user for a goal)`);
  }
  const goals = [...goalIds].map(loadGoal).filter((g) => g && g.status === 'active');
  for (const g of goals) {
    const linked = tickets.filter((t) => t.goal === g.id);
    const openHere = linked.filter((t) => OPEN_STATES.has(t.status));
    const newest = linked.map(lastActivity).filter(Boolean).sort().pop();
    if (!openNext(g).length && !openHere.length)
      gaps.push(`${g.id} has no next things and no open tickets. Add what comes next, or ask the user whether it is finished.\n      -> genlock goal next ${g.id} "..."`);
    else if (newest && newest > g.next_touched)
      gaps.push(`${g.id}'s next things predate its latest work.\n      -> genlock goal next ${g.id} "..."  |  --done N  |  --still-right`);
  }
  const dirty = uncommittedNobodyHolds(me);
  if (dirty.length && !a.uncommitted)
    gaps.push(`${dirty.length} uncommitted file(s) nobody has explained: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}.\n      -> say what they are with --uncommitted "..."`);

  if (gaps.length) {
    process.stderr.write(`genlock: not ready to clear context. A fresh session would be missing:\n\n`);
    for (const g of gaps) process.stderr.write(`  - ${g}\n`);
    process.exit(3);
  }

  emit('project', 'checkpoint', {
    goals: goals.map((g) => g.id), tickets: myTickets.map((t) => t.id),
    uncommitted: a.uncommitted || '', dirty,
  });
  // This session is ending, and its claims should not hold anyone up until they lapse.
  if (me) for (const c of liveClaims().filter((x) => x.session === me)) releaseTicket(c.key);

  console.log(`[TASK-COMPLETE] checkpoint: ${goals.length} goal(s), ${myTickets.length} open ticket(s) current, ${dirty.length} uncommitted file(s) noted.`);
  for (const g of goals) console.log(`  ${g.id} ${g.title} — ${progress(g, tickets).line}`);
  console.log('Safe to clear context. Then say: "let\'s continue the goal we were working on".');
  console.log('Records are on disk but not committed: `genlock sync` commits them.');
}

function chooseGoal(raw) {
  if (raw) {
    const id = resolveId(raw, 'G-', 'goal');
    if (!id) die(`no goal '${raw}' in this repository`);
    return loadGoal(id);
  }
  const active = allGoals().filter((g) => g.status === 'active');
  const cp = lastCheckpoint();
  const fromCp = cp ? active.filter((g) => cp.goals.includes(g.id)) : [];
  if (fromCp.length === 1) return fromCp[0];
  const parked = allGoals().filter((g) => g.status === 'parked');
  const pool = fromCp.length ? fromCp : active;
  if (pool.length === 1) return pool[0];
  if (!pool.length && parked.length === 1) return parked[0];
  if (!pool.length && !parked.length) die('no active goal to continue. `genlock orient` shows what is here; ask the user what they want to get done.');
  const tickets = allTickets();
  console.log('More than one goal could be meant. Read one with `genlock continue GOAL`; if you are picking up work, ask the user which:');
  for (const g of [...pool, ...parked]) console.log(`  ${g.status === 'parked' ? 'parked ' : ''}${goalLine(g, tickets)}`);
  process.exit(4);
}

function liveSection(cp) {
  const me = identity();
  const L = [];
  if (cp?.uncommitted) L.push('', `At the last checkpoint, uncommitted work was: ${cp.uncommitted}`);
  const dirty = dirtyFiles();
  if (dirty.length) L.push('', 'Uncommitted right now:', ...dirty.slice(0, 20).map((f) => `  ${f}`));
  const others = liveClaims().filter((c) => c.session !== me);
  if (others.length) {
    L.push('', 'Other sessions working here right now. Stay out of these:');
    for (const c of others) L.push(`  ${c.key}: ${held(c)}`);
  }
  L.push(...inboxLines(me));
  return L;
}

const SOURCE_WARNING = 'These records are claims about the repository, not sources. Check anything load-bearing before acting on it.';

export function cmdContinue(a) {
  const raw = a._[0];
  const cp = lastCheckpoint();
  const ticketId = raw && String(raw).toUpperCase().startsWith('T-') ? resolveId(raw, 'T-', 'ticket') : null;
  if (raw && String(raw).toUpperCase().startsWith('T-') && !ticketId) die(`no ticket '${raw}' in this repository`);

  if (ticketId) {
    const t = loadTicket(ticketId);
    const L = [SOURCE_WARNING, '', render(t, true)];
    if (t.spinoff?.why) L.push('', `Why this was spun off: ${t.spinoff.why}`);
    if (t.parent) {
      const p = loadTicket(t.parent);
      if (p) L.push('', `Spun off from ${p.id}: ${p.title} (${p.status})${p.latest ? `\n  latest: ${p.latest.text}` : ''}`);
    }
    if (t.goal) {
      const g = loadGoal(t.goal);
      if (g) {
        L.push('', `Goal ${g.id}: ${g.title} — ${progress(g).line}`);
        for (const n of openNext(g)) L.push(`  next ${nextLine(n)}`);
        L.push(...sharedLines(g));
      }
    }
    console.log([...L, ...liveSection(cp)].join('\n'));
    return;
  }

  const g = chooseGoal(raw);
  const tickets = allTickets().filter((t) => t.goal === g.id);
  const L = [SOURCE_WARNING, '', `Goal ${g.id}: ${g.title}`, `  ${g.status}, ${progress(g).line}`];
  if (g.why) L.push(`  why: ${g.why}`);
  if (g.done_when) L.push(`  done when: ${g.done_when}`);
  const next = openNext(g);
  if (g.waiting_on) L.push(`  PARKED, waiting on: ${g.waiting_on}`);
  L.push('', next.length ? 'Next things:' : 'No next things recorded.');
  for (const n of next) L.push(`  ${nextLine(n)}`);
  const shared = sharedLines(g);
  if (shared.length) L.push('', ...shared);
  const waiting = userQuestions().filter((q) => !q.answer && (q.about === g.id || tickets.some((t) => t.id === q.about)));
  if (waiting.length) {
    L.push('', 'Waiting on the user:', ...waiting.map((q) => `  ${q.id}: ${q.text}`));
  }
  const answered = userQuestions().filter((q) => q.answer && (q.about === g.id || tickets.some((t) => t.id === q.about)));
  if (answered.length) {
    L.push('', 'The user has answered:', ...answered.map((q) => `  ${q.text} -> ${q.answer}`));
  }
  if (g.updates.length) {
    L.push('', 'Goal updates:', ...g.updates.slice(-10).map((u) => `  ${u.at.slice(0, 10)}  ${u.text}`));
  }
  const open = tickets.filter((t) => OPEN_STATES.has(t.status));
  if (open.length) L.push('', 'Open tickets:');
  for (const t of open) L.push('', render(t, true));
  const closed = tickets.filter((t) => !OPEN_STATES.has(t.status));
  if (closed.length) {
    L.push('', 'Closed tickets:');
    for (const t of closed) {
      L.push(`  ${t.id} ${t.status}: ${t.title}${t.latest ? ` — ${t.latest.text}` : ''}`);
      L.push(...sharedLines(t, '    '));
      for (const as of t.assumptions) L.push(`    assumed: ${as.text} (wrong -> ${as.breaks})`);
      for (const h of t.hazards.filter((x) => !x.cleared)) L.push(`    HAZARD: ${h.what} (verify: ${h.verify})`);
    }
  }
  L.push(...liveSection(cp));
  L.push('', 'Take a ticket with `genlock start ID` and claim what you will touch before editing.');
  console.log(L.join('\n'));
}

/**
 * Continuity: picking work back up, whether the next reader is another agent or this one
 * after a cleared context. There is no separate document to go stale. Goals say what is
 * next, tickets say what just happened, and everything live is read when it is asked for.
 *
 *   orient      what a session should know as it starts
 *   checkpoint  refuses until the records are current, so context can be cleared safely
 *   continue    everything needed to carry on with a goal or ticket
 */

import fs from 'node:fs';
import path from 'node:path';
import { die, dirtyFiles, emit, identity, liveForbids, readEvents, repoRoot, resolveId, sharedLines, shortName } from './store.mjs';
import { dueLabel, rankedGoals, rankedTasks } from './rank.mjs';
import { allTickets, loadTicket, render, OPEN_STATES, summariseReqs } from './tickets.mjs';
import { allGoals, daysUntil, goalLine, goalsSkipped, loadGoal, nextLine, openNext, progress } from './goals.mjs';
import { covers, holderLabel, liveClaims, releaseTicket, workMark } from './claims.mjs';
import { inboxFor, userQuestions } from './ask.mjs';
import { openReviews } from './reviews.mjs';
import { yesFor } from './relay.mjs';
import { RETRO_EVERY, bugsSinceRetro } from './retro.mjs';
import { openClaudeWindow } from './spinoff.mjs';
import { appDidIt, appFailure, requestOfApp } from './appask.mjs';
import { openSessions, SESSION_CAP, overCap, capMessage } from './cap.mjs';

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
  const active = rankedGoals(goals).filter((g) => g.status === 'active');
  const proposed = goals.filter((g) => g.status === 'proposed');
  const open = rankedTasks(tickets);
  const claims = liveClaims();
  const me = identity();
  const L = ['genlock orient'];

  if (active.length) {
    L.push('', 'Goals:');
    for (const g of active) {
      L.push(`  ${goalLine(g, tickets)}`);
      for (const n of openNext(g)) L.push(`    next ${nextLine(n)}`);
      for (const f of liveForbids(g)) L.push(`    DO NOT: ${f.text}`);
      const bugs = bugsSinceRetro(g.id).length;
      if (bugs >= RETRO_EVERY) L.push(`    ${bugs} bugs closed since the last retro: offer the user one (genlock retro ${g.id})`);
    }
  } else if (!goalsSkipped()) {
    L.push('', 'No goals recorded yet. Do not stop to ask for one: get on with what the user wants. Once the work '
      + 'makes a goal clear, record it in their words and mention it in one line: genlock goal add "..." --user-said "...".');
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
    .map(({ g, n }) => ({ due: n.due, line: `${g.id}  ${nextLine(n)}` }));
  const ownDates = [...active, ...parked, ...open].filter((r) => r.due).map((r) => ({ due: r.due, line: `${r.id}  ${r.title}  [${dueLabel(r.due)}]` }));
  const deadlines = [...dated, ...ownDates].sort((x, y) => x.due.localeCompare(y.due)).filter((d) => daysUntil(d.due) <= DEADLINE_WINDOW);
  if (deadlines.length) {
    L.push('', 'Deadlines:', ...deadlines.map((d) => `  ${d.line}`));
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
      const mark = workMark(t, me, claims);
      if (mark) L.push(`    ${mark}`);
      if (t.latest) L.push(`    latest: ${t.latest.text}`);
      for (const f of liveForbids(t)) L.push(`    DO NOT: ${f.text}`);
      const haz = t.hazards.filter((h) => !h.cleared).length;
      if (haz) L.push(`    ${haz} hazard(s) left behind: genlock show ${t.id}`);
    }
  }
  const others = claims.filter((c) => c.session !== me);
  if (others.length) {
    L.push('', 'Other sessions working here right now. Stay out of these:');
    for (const c of others) L.push(`  ${c.key} (${holderLabel(c)}): ${held(c) || 'the task itself'}`);
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

/** What a fresh session would be missing, and what checkpointing would record. */
function checkpointGaps(a) {
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

  return { me, gaps, goals, myTickets, dirty, tickets };
}

// A fresh session carrying on work must not stall waiting for a go-ahead nobody is there to give.
export const CARRY_ON = 'begin on it at once: the work was already agreed, so do not ask the user whether to start.';

function refuseGaps(gaps, what) {
  if (!gaps.length) return;
  process.stderr.write(`genlock: not ready to ${what}. A fresh session would be missing:\n\n`);
  for (const g of gaps) process.stderr.write(`  - ${g}\n`);
  process.exit(3);
}

/** Records the checkpoint and lets go of this session's claims. */
function recordCheckpoint(a, { me, goals, myTickets, dirty }) {
  emit('project', 'checkpoint', {
    goals: goals.map((g) => g.id), tickets: myTickets.map((t) => t.id),
    uncommitted: a.uncommitted || '', dirty,
  });
  // This session is ending, and its claims should not hold anyone up until they lapse.
  if (me) for (const c of liveClaims().filter((x) => x.session === me)) releaseTicket(c.key);
}

export function cmdCheckpoint(a) {
  const found = checkpointGaps(a);
  refuseGaps(found.gaps, 'clear context');
  recordCheckpoint(a, found);
  const { goals, myTickets, dirty, tickets } = found;
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
    for (const c of others) L.push(`  ${c.key} (${holderLabel(c)}): ${held(c) || 'the task itself'}`);
  }
  L.push(...inboxLines(me));
  return L;
}

const SOURCE_WARNING = 'These records are claims about the repository, not sources. Check anything load-bearing before acting on it.';

export function cmdContinue(a) {
  const raw = a._[0];
  const cp = lastCheckpoint();
  const isTicketId = raw && String(raw).toUpperCase().startsWith('T-');
  // A name could be either, and a goal is the bigger thing to pick back up.
  const ticketId = raw && (isTicketId || !resolveId(raw, 'G-', 'goal')) ? resolveId(raw, 'T-', 'ticket') : null;
  if (raw && String(raw).toUpperCase().startsWith('T-') && !ticketId) die(`no ticket '${raw}' in this repository`);

  if (ticketId) {
    const t = loadTicket(ticketId);
    const L = [SOURCE_WARNING, '', render(t, true)];
    const mark = workMark(t);
    if (mark) L.push(`  >> ${mark}`);
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
  const claims = liveClaims();
  for (const t of open) {
    L.push('', render(t, true));
    const mark = workMark(t, identity(), claims);
    if (mark) L.push(`  >> ${mark}`);
  }
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

/**
 * This session closes itself, on the user's word, once the work it was for is done. Refuses while
 * the records would lose anything, like swap. Inside the Mac app the app closes it once this turn
 * ends and keeps it under Recently ended; elsewhere it says what the user does instead.
 */
export function cmdCloseSelf(a) {
  if (process.env.GENLOCK_APP_PROJECTS) die('the Assistant starts fresh with genlock clear-context; it does not close itself');
  const yes = yesFor(a, 'close', 'close --self needs the user\'s word, in their own words:  --user-said "great, you can close"  Say the work is done and wait for them; never close on your own judgement.');
  const found = checkpointGaps(a);
  refuseGaps(found.gaps, 'close');
  recordCheckpoint(a, found);
  emit('project', 'close', { user_said: yes.said, ...(yes.relayed_by ? { relayed_by: yes.relayed_by } : {}), in_app: !!process.env.GENLOCK_APP_CHANNEL });
  yes.use();
  const dir = process.env.GENLOCK_APP_CHANNEL;
  if (!dir) {
    console.log('[TASK-COMPLETE] checkpoint recorded. This is not the Genlock app, so the user closes this session by hand with /exit.');
    console.log('Tell them that, in one line.');
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'close.tmp'), JSON.stringify({ at: Date.now(), user_said: yes.said, by: 'self' }));
  fs.renameSync(path.join(dir, 'close.tmp'), path.join(dir, 'close.json'));
  console.log('[TASK-COMPLETE] checkpoint recorded. When this turn ends the app closes this session; it stays under Recently ended.');
  console.log('Finish your reply in one line.');
}

/**
 * Swaps this session for a fresh one on a goal, on the user's yes. Refuses while a fresh
 * session would be missing anything, because the records are all it will have. Inside the
 * Mac app it asks the app, which replaces the session once this turn ends; elsewhere it says
 * what the user runs instead.
 */
export function cmdSwap(a) {
  const raw = a._.join(' ').trim();
  if (!raw) die('swap needs the goal the fresh session opens on:  genlock swap GOAL --user-said "THEIR YES"');
  if (process.env.GENLOCK_APP_PROJECTS) die('the Assistant starts fresh with genlock clear-context, not swap');
  // Swapping keeps the session count flat and exists to save tokens, so it needs no yes. One the
  // user gave is still recorded.
  const yes = a.relayed || String(a.user_said || '').trim() ? yesFor(a, 'swap', '') : { said: null, relayed_by: null, use: () => {} };
  const userSaid = yes.said;
  const id = resolveId(raw, 'G-', 'goal');
  const goal = id && loadGoal(id);
  if (!goal) die(`no goal '${raw}' in this repository. genlock goal list shows them.`);
  if (!['active', 'parked'].includes(goal.status)) die(`${goal.id} is ${goal.status}, so there is nothing to carry on with. Pick an active goal.`);

  // A swap always goes through: a gap is reported for this session to fill before its turn ends.
  const found = checkpointGaps(a);
  recordCheckpoint(a, found);
  const name = shortName(goal.id);
  // The fresh session carries on this session's work, so its open tasks go with it.
  const me = identity();
  const handed = me ? allTickets().filter((t) => OPEN_STATES.has(t.status) && t.status !== 'draft' && t.owner === me) : [];
  for (const t of handed) {
    emit(t.id, 'handoff', { goal: goal.id });
    releaseTicket(t.id);
  }
  emit('project', 'swap', { goal: goal.id, ...(userSaid ? { user_said: userSaid } : { by: 'agent', why: 'save tokens' }), ...(yes.relayed_by ? { relayed_by: yes.relayed_by } : {}), in_app: !!process.env.GENLOCK_APP_CHANNEL });
  yes.use();

  const dir = process.env.GENLOCK_APP_CHANNEL;
  if (!dir) {
    console.log('[STATUS-UPDATE] checkpoint recorded.');
    warnGaps(found.gaps);
    console.log(`This is not the Genlock app, so the user swaps by hand: run /clear, then say "continue ${name}".`);
    console.log('Tell them that, in one line.');
    return;
  }
  const take = handed.length
    ? ' The session you replace handed you its tasks: '
      + handed.map((t) => `${t.id} ("${t.title}")${t.status === 'blocked' ? ', blocked' : ''}`).join(', ')
      + `. Before anything else, take each one that is not blocked with genlock start ID, so they are recorded as yours.`
    : '';
  const prompt = `Carry on with the goal "${goal.title}". Start with: genlock continue ${goal.id}.${take} `
    + `Then say in one or two lines what you are picking up, and ${CARRY_ON}`;
  const res = requestOfApp(dir, 'swap.json', { goal: goal.id, title: goal.title, prompt, tickets: handed.map((t) => t.id), user_said: userSaid, relayed_by: yes.relayed_by }, { consumed: false });
  if (handed.length) console.log(`Handed to the fresh session: ${handed.map((t) => shortName(t.id)).join(', ')}.`);
  if (appDidIt(res)) {
    console.log(`[STATUS-UPDATE] When this turn ends the app opens a fresh session on ${name} in this tab;`);
    console.log('this conversation stays under Recently ended.');
    warnGaps(found.gaps);
    console.log('Finish your reply in one line.');
    return;
  }
  // The fail-safe: the fresh session is created another way, at once, without asking anyone.
  emit('project', 'swap-fallback', { goal: goal.id, why: appFailure(res) });
  console.log(`[TECH-REPORT] The swap did not go through the app: ${appFailure(res)}.`);
  fallbackOpen(dir, prompt, name, repoRoot(), 'this conversation');
  warnGaps(found.gaps);
}

/**
 * The fail-safe when the app did not open a session: open it in a Terminal window, then let the
 * app close this one if it is still listening (the fresh one exists now, so nothing is lost).
 * If no window opens either, the old session stays and the agent gets the command to hand on.
 */
function fallbackOpen(channel, prompt, name, project, what) {
  const opened = openClaudeWindow(prompt, name, project);
  if (!opened.ok) {
    emit('project', 'open-failed', { project, command: opened.command });
    console.log(`No window could be opened either, so ${what} stays open. Run this yourself if you can, or give it to the user in one line:`);
    console.log(`  ${opened.command}`);
    return false;
  }
  emit('project', 'open-fallback', { project, how: 'terminal window' });
  console.log(`[STATUS-UPDATE] Opened the fresh session in a Terminal window on ${path.basename(project)} instead, with the same opening.`);
  if (channel) {
    fs.writeFileSync(path.join(channel, 'close.tmp'), JSON.stringify({ at: Date.now(), by: 'self', why: 'replaced' }));
    fs.renameSync(path.join(channel, 'close.tmp'), path.join(channel, 'close.json'));
    console.log(`Tell the user in one line that the fresh session is in a Terminal window and ${what} can be closed (the app closes it if it is still listening).`);
  }
  return true;
}

/* ------------------------------------------------------------ open, from a project session */

/** The project the app opened this session in, and how many sessions it has open (Subassistants aside). */
function appProject(channel) {
  let own = null;
  try { own = JSON.parse(fs.readFileSync(path.join(channel, 'session.json'), 'utf8')); } catch {}
  return own?.project || repoRoot();
}

/** The app's project list: where GENLOCK_APP_PROJECTS says, else beside the app's channel folders. */
function appProjects(channel) {
  const candidates = [process.env.GENLOCK_APP_PROJECTS, channel && path.join(path.dirname(path.dirname(channel)), 'projects.json')].filter(Boolean);
  for (const file of candidates) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).filter((p) => p?.path); } catch {}
  }
  return [];
}

/** The folder of the app's project called NAME (or at that path), or null. */
function projectNamed(name, channel) {
  const lower = String(name).toLowerCase();
  const hit = appProjects(channel).find((p) => path.basename(p.path).toLowerCase() === lower || path.resolve(p.path) === path.resolve(String(name)));
  return hit && fs.existsSync(hit.path) ? hit.path : null;
}

/** Tells the agent, without stopping it, what a fresh session would be missing. */
function warnGaps(gaps) {
  if (!gaps.length) return;
  console.log('Opened anyway, but fill these before your turn ends, so the fresh session finds them in the records:');
  for (const g of gaps) console.log(`  - ${g}`);
}

/**
 * A project session opens a fresh one, in its own project or any other. No yes is needed: --handoff
 * gives this session's work to the fresh one and closes this one, to save tokens on a long
 * conversation; without it the fresh session runs beside this one. Nothing stops an open except
 * the per-project cap, which the user lifts with --over-cap (TJ, 12 Nov 2026).
 */
export function cmdOpenOwn(a) {
  const name = a._[0];
  const channel = process.env.GENLOCK_APP_CHANNEL;
  const ownProject = channel ? appProject(channel) : repoRoot();
  const handoff = !!a.handoff;
  let project = ownProject;
  if (name && String(name).toLowerCase() !== path.basename(ownProject).toLowerCase()) {
    if (handoff) die(`a handoff gives this session's work to a fresh session in its own project (${path.basename(ownProject)}). To start work in '${name}', use genlock open ${name} --prompt "WHAT TO DO".`);
    project = projectNamed(name, channel);
    if (!project) {
      const known = appProjects(channel).map((p) => path.basename(p.path));
      die(`no project called '${name}'.${known.length ? ` These exist: ${known.join(', ')}` : ''}`);
    }
  }
  const here = path.basename(project);
  const given = a.prompt === undefined || a.prompt === true ? '' : String(a.prompt).trim();
  if (!handoff && !given) die('open needs what the fresh session starts on:  genlock open --prompt "WHAT TO DO"   (or --handoff, to give it this session\'s work and close this one)');
  const approved = overCap(a);
  const open = channel ? Math.max(openSessions(project, channel), project === ownProject ? 1 : 0) : 0;
  if (!handoff && channel && !approved && open >= SESSION_CAP) die(capMessage(here, open, 'a fresh session'));
  if (approved) emit('project', 'over-cap', { project, open, user_said: approved });
  const where = { project, open };

  let prompt = given;
  let found = { gaps: [] };
  if (handoff) {
    // A handoff always opens: a gap is reported for this session to fill before its turn ends.
    found = checkpointGaps(a);
    recordCheckpoint(a, found);
    const me = identity();
    const handed = me ? allTickets().filter((t) => OPEN_STATES.has(t.status) && t.status !== 'draft' && t.owner === me) : [];
    for (const t of handed) { emit(t.id, 'handoff', {}); releaseTicket(t.id); }
    emit('project', 'handoff', { by: 'agent', why: 'save tokens', tickets: handed.map((t) => t.id), in_app: !!channel });
    const take = handed.length
      ? ` A session whose conversation had grown long handed you its tasks: ${handed.map((t) => `${t.id} ("${t.title}")${t.status === 'blocked' ? ', blocked' : ''}`).join(', ')}. `
        + 'Take each one that is not blocked with genlock start ID, read it with genlock show ID, and carry on from its latest.'
      : ' A session whose conversation had grown long handed its work to you. Start with genlock continue.';
    prompt = `${given ? `${given}\n\n` : ''}${take.trim()} Say in one or two lines what you are picking up, and ${CARRY_ON}`;
  }

  if (!channel) {
    const opened = openClaudeWindow(prompt, here, project);
    console.log(opened.ok ? `[STATUS-UPDATE] a fresh session opened in a new terminal window on ${here}.` : `No window could be opened from here. Run this in a terminal:\n  ${opened.command}`);
    if (handoff) { warnGaps(found.gaps); console.log('This is not the Genlock app, so this session does not close itself: tell the user in one line they can /exit it.'); }
    return;
  }
  const file = `open-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`;
  const res = requestOfApp(channel, file, { project: where.project, prompt, at: Date.now(), handoff, ...(approved ? { over_cap: approved } : {}) });
  if (res.state === 'refused' && res.code === 'cap') {
    // The cap is the user's rule, not a failure: only their words (--over-cap) lift it.
    console.log(`[TECH-REPORT] ${res.why}`);
    console.log('Ask the user in one line whether to go past the cap, then rerun with --over-cap "THEIR WORDS".');
    return;
  }
  if (!appDidIt(res)) {
    // The fail-safe: the session is created another way, at once, without asking anyone.
    emit('project', 'open-fallback-needed', { project, handoff, why: appFailure(res) });
    console.log(`[TECH-REPORT] The open did not go through the app: ${appFailure(res)}.`);
    fallbackOpen(handoff ? channel : null, prompt, here, project, 'this session');
    if (handoff) warnGaps(found.gaps);
    return;
  }
  if (handoff) {
    // Only now that the fresh session exists does this one close.
    fs.writeFileSync(path.join(channel, 'close.tmp'), JSON.stringify({ at: Date.now(), by: 'self', why: 'handoff' }));
    fs.renameSync(path.join(channel, 'close.tmp'), path.join(channel, 'close.json'));
    console.log(`[STATUS-UPDATE] A fresh session opened on ${here} with this session's work; this one closes when its turn ends and stays under Recently ended.`);
    warnGaps(found.gaps);
    console.log('Finish your reply in one line.');
    return;
  }
  console.log(`[STATUS-UPDATE] a fresh session is opening on ${here}${project === ownProject ? ' beside this one' : ''} (${where.open + 1} of ${approved ? `${SESSION_CAP}, past the cap on the user's word` : `at most ${SESSION_CAP}`}). Carry on with your own work.`);
}

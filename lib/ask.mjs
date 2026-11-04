/**
 * Questions between sessions. A running session cannot be interrupted, so a question is
 * a record, and a hook delivers it at that session's next tool call. Nobody blocks on an
 * answer: the asker carries on and sees the reply the same way.
 *
 * Status questions do not need this. Any session can read the shared records.
 */

import fs from 'node:fs';
import path from 'node:path';
import { die, emit, identity, listIds, newId, readEvents, resolveId } from './store.mjs';
import { liveClaims, liveDir } from './claims.mjs';
import { loadTicket } from './tickets.mjs';

function loadQuestion(id) {
  const q = { id, to: null, about: null, text: '', from: null, answer: null, answered_by: null, at: null };
  for (const e of readEvents(id)) {
    if (e.op === 'ask') Object.assign(q, { to: e.to, about: e.about || null, text: e.text, from: e.by, at: e.at });
    if (e.op === 'answer') Object.assign(q, { answer: e.text, answered_by: e.by });
  }
  return q;
}

/** What is waiting on the user, or (once answered) what they said. */
export const userQuestions = () => listIds('Q-').map(loadQuestion).filter((q) => q.to === 'user');

/** Questions this session should answer, and answers to questions it asked. */
export function inboxFor(me) {
  const all = listIds('Q-').map(loadQuestion);
  const claims = liveClaims();
  const isMine = (to) => {
    if (to === 'user') return false;
    if (to === 'any') return true;
    if (claims.some((c) => c.key === to && c.session === me)) return true;
    return loadTicket(to)?.owner === me;
  };
  return {
    questions: all.filter((q) => !q.answer && q.from !== me && isMine(q.to)),
    answers: all.filter((q) => q.answer && q.from === me),
  };
}

export function cmdAsk(a) {
  const raw = a._[0];
  const text = a._.slice(1).join(' ').trim();
  if (!raw || !text) die('ask needs a ticket, "any" or "user", and the question:  genlock ask T-XXXXX "..."');
  let to = raw.toLowerCase();
  if (to === 'user') {
    const about = a.about ? (resolveId(a.about, 'G-', 'goal') || resolveId(a.about, 'T-', 'ticket')) : null;
    if (a.about && !about) die(`no goal or ticket '${a.about}' in this repository`);
    const id = newId('Q-');
    emit(id, 'ask', { to, about, text });
    console.log(`${id} is on the list of what waits on the user. Agents see it at orient until it is answered.`);
    return;
  }
  if (to !== 'any') {
    to = resolveId(raw, 'T-', 'ticket');
    if (!to) die(`no ticket '${raw}' in this repository`);
  }
  const id = newId('Q-');
  emit(id, 'ask', { to, text });
  console.log(`${id} asked of ${to}. It reaches them at their next tool call. Do not wait for it: carry on, and the answer reaches you the same way.`);
}

export function cmdAnswer(a) {
  const raw = a._[0];
  const text = a._.slice(1).join(' ').trim();
  if (!raw || !text) die('answer needs a question id and the answer:  genlock answer Q-XXXXX "..."');
  const id = resolveId(raw, 'Q-', 'question');
  if (!id) die(`no question '${raw}' in this repository`);
  if (loadQuestion(id).to === 'user' && !a.user_said)
    die('this question is for the user, so answering it requires --user-said: their own words');
  emit(id, 'answer', { text, user_said: a.user_said || '' });
  console.log(`${id} answered.`);
}

export function cmdInbox() {
  const { questions, answers } = inboxFor(identity());
  if (!questions.length && !answers.length) { console.log('nothing for you.'); return; }
  for (const q of questions) console.log(`question ${q.id}: ${q.text}\n  -> genlock answer ${q.id} "..."`);
  for (const q of answers) console.log(`answer ${q.id}: ${q.text} -> ${q.answer}`);
}

/**
 * Claude Code PostToolUse hook. Adds anything new to the agent's context, once each.
 * Like the guard, an internal failure stays silent rather than disturbing the session.
 */
export function cmdDeliver() {
  try {
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* no input */ }
    const me = input.session_id || identity();
    if (!me) return;
    const { questions, answers } = inboxFor(me);
    if (!questions.length && !answers.length) return;

    const dir = path.join(liveDir(), 'seen');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(me).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    let seen = [];
    try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first delivery */ }

    const L = [];
    for (const q of questions) {
      if (!seen.includes(`q:${q.id}`)) { L.push(`Another session asks (${q.id}): ${q.text}\nAnswer briefly when you reach a stopping point: genlock answer ${q.id} "..."`); seen.push(`q:${q.id}`); }
    }
    for (const q of answers) {
      if (!seen.includes(`a:${q.id}`)) { L.push(`Answer to your question ${q.id} ("${q.text}"): ${q.answer}`); seen.push(`a:${q.id}`); }
    }
    if (!L.length) return;
    fs.writeFileSync(file, JSON.stringify(seen));
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: L.join('\n\n') },
    }));
  } catch { /* fail silent */ }
}

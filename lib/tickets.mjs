/**
 * Tickets. The one mechanical refusal: `done` will not accept a ticket whose requirements
 * lack recorded evidence, so "done" is PROVED rather than asserted.
 *
 * A ticket's state is never stored. It is computed by replaying its events, which is what
 * lets two sessions on two branches both write to one ticket and merge cleanly.
 */

import { randomBytes } from 'node:crypto';
import {
  applyShared, bold, checkShortName, die, emit, emptyShared, identity, listIds, nameItNudge, newId, parseDue, readEvents, refuse, resolveId, sharedLines, shortName,
} from './store.mjs';
import { lintRequirement, lintTitle } from './lint.mjs';
import { claimFor, holderLabel, releaseTicket, withLock, writeClaim } from './claims.mjs';
import { dueLabel, rankedTasks } from './rank.mjs';
import { loadGoal, openNext } from './goals.mjs';

export const OPEN_STATES = new Set(['draft', 'open', 'in_progress', 'blocked']);

export const LATEST_MAX = 600;

const GRILL = {
  observed: 'Observed, or derived? Cite the coordinate and the raw value.',
  cause: 'Is any cause stated here a measurement, or a hypothesis?',
  absence: 'Anything reported missing that my instrument only failed to match?',
  assumption: 'Which assumption here is mine, that nobody chose?',
  falsify: 'What one check, document or number would falsify this?',
};
const GRILL_KEYS = Object.keys(GRILL);

/* ------------------------------------------------------------------- replay */

export function loadTicket(id) {
  const events = readEvents(id);
  if (!events.length) return null;
  const t = {
    id, title: '', ask: '', status: 'open', loose: false, created: events[0].at,
    updated: events[events.length - 1].at, requirements: [], assumptions: [], grill: {},
    ...emptyShared(), log: [], latest: null, hazards: [], blocked_reason: null, goal: null, owner: null,
    parent: null, spinoff: null, closed: null,
  };
  const addReq = (r) => t.requirements.push({
    rid: r.rid, n: t.requirements.length + 1, text: r.text, check: r.check || '',
    state: 'open', evidence: '', at: '',
  });
  const log = (e, kind, text) => t.log.push({ at: e.at, by: e.by, kind, text });

  for (const e of events) {
    if (applyShared(t, e)) { log(e, e.op, e.text || e.path || ''); continue; }
    switch (e.op) {
      case 'hazard':
        t.hazards.push({ hid: e.e, what: e.what, verify: e.verify, cleared: null });
        log(e, 'hazard', e.what);
        break;
      case 'hazard_clear': {
        const h = t.hazards.find((x) => x.hid === e.hid);
        if (h) h.cleared = e.evidence;
        log(e, 'hazard', `cleared: ${e.evidence}`);
        break;
      }
      case 'open':
        Object.assign(t, {
          title: e.title, ask: e.ask || '', loose: !!e.loose, goal: e.goal || null, due: e.due || null,
          owner: e.owner || null, parent: e.parent || null,
          status: e.draft ? 'draft' : 'open',
        });
        (e.requirements || []).forEach(addReq);
        log(e, 'open', e.title);
        break;
      case 'req':
        addReq(e);
        // New unproved work reopens a ticket, including one that merged in after a close.
        if (t.status === 'draft' || t.status === 'done') t.status = t.status === 'done' ? 'in_progress' : 'open';
        log(e, 'req', `${t.requirements.length}. ${e.text}`);
        break;
      case 'mark': {
        const r = t.requirements.find((x) => x.rid === e.rid);
        if (!r) break;
        r.state = e.state; r.evidence = e.evidence; r.at = e.at;
        if (t.status === 'open') t.status = 'in_progress';
        log(e, e.state, `${r.n}. ${e.state === 'failed' ? 'FAILED' : e.state} -- ${e.evidence}`);
        break;
      }
      case 'start':
        t.status = 'in_progress'; t.blocked_reason = null;
        if (e.by !== 'unknown') t.owner = e.by;
        log(e, 'status', 'in_progress');
        break;
      case 'update': t.latest = { text: e.text, at: e.at, by: e.by }; log(e, 'update', e.text); break;
      case 'block': t.status = 'blocked'; t.blocked_reason = e.why; log(e, 'blocked', e.why); break;
      case 'abandon': t.status = 'abandoned'; t.closed = e.at; log(e, 'abandoned', e.why); break;
      case 'note': log(e, 'note', e.text); break;
      case 'assume':
        t.assumptions.push({ text: e.text, breaks: e.breaks, at: e.at });
        log(e, 'assume', `${e.text} -- breaks: ${e.breaks}`);
        break;
      case 'grill':
        Object.assign(t.grill, e.answers);
        log(e, 'grill', Object.keys(e.answers).join(', '));
        break;
      case 'done': t.status = 'done'; t.closed = e.at; log(e, 'done', e.summary || ''); break;
      case 'link': t.goal = e.goal; log(e, 'link', e.goal); break;
      case 'assign': t.owner = e.owner; log(e, 'assign', e.owner); break;
      // A swap: the old session is ending, so the task is nobody's until the fresh one starts it.
      case 'handoff': t.owner = null; t.handed_off = { from: e.by, goal: e.goal, at: e.at }; log(e, 'handoff', `to the fresh session on ${e.goal}`); break;
      case 'spinoff':
        t.spinoff = { ...(t.spinoff || {}), ...e.fields };
        log(e, 'spinoff', e.fields.state || 'amended');
        break;
      default: break; // An op from a newer version is kept on disk and ignored here.
    }
  }
  return t;
}

export const allTickets = () => listIds('T-').map(loadTicket).filter(Boolean);

export function requireTicket(a, cmd) {
  const raw = a._[0];
  if (!raw) die(`${cmd} needs a ticket id`);
  const id = resolveId(raw, 'T-', 'ticket');
  if (!id) die(`no ticket '${raw}' in this repository`);
  return loadTicket(id);
}

/* ------------------------------------------------------------------- output */

export function summariseReqs(t) {
  const rs = t.requirements || [];
  if (!rs.length) return 'none';
  const c = {};
  for (const r of rs) c[r.state] = (c[r.state] || 0) + 1;
  // A waiver is NOT a proof, and the summary must never let the two read alike.
  const parts = [`${c.met || 0} of ${rs.length} proved`];
  if (c.waived) parts.push(`${c.waived} waived`);
  if (c.failed) parts.push(`${c.failed} FAILED`);
  return parts.join(', ');
}

function reqLine(r) {
  const mark = { open: '[ ]', met: '[x]', failed: '[!]', waived: '[~]' }[r.state];
  let s = `  ${mark} ${r.n}. ${r.text}`;
  if (r.check) s += `\n         check: ${r.check}`;
  if (r.evidence) s += `\n         ${r.state === 'waived' ? 'waived' : 'evidence'}: ${r.evidence}`;
  return s;
}

export function render(t, withLog = false) {
  const L = [];
  L.push(`${bold(shortName(t.id))} (${t.id})  ${t.title}`);
  L.push(`  status ${t.status}   created ${t.created.slice(0, 10)}`
    + `${t.goal ? `   goal ${t.goal}` : ''}${t.parent ? `   spun off from ${t.parent}` : ''}`);
  if (t.due) L.push(`  ${dueLabel(t.due)}`);
  if (t.owner) L.push(`  owner: ${t.owner}`);
  if (t.ask) L.push(`  ask: ${t.ask}`);
  if (t.blocked_reason && t.status === 'blocked') L.push(`  BLOCKED: ${t.blocked_reason}`);
  if (t.latest) L.push(`  latest (${t.latest.at.slice(0, 16).replace('T', ' ')}): ${t.latest.text}`);
  const shared = sharedLines(t);
  if (shared.length) L.push('', ...shared);
  const hazards = t.hazards.filter((h) => !h.cleared);
  if (hazards.length) {
    L.push('', '  HAZARDS, left behind and not yet dealt with:');
    hazards.forEach((h, i) => L.push(`    ${i + 1}. ${h.what}`, `       verify: ${h.verify}`));
  }
  L.push('', `  requirements (${summariseReqs(t)})`);
  if (t.status === 'draft') L.push('  none yet: the agent working this ticket writes them before starting.');
  for (const r of t.requirements) L.push(reqLine(r));
  if (t.assumptions.length) {
    L.push('', '  assumptions crossed');
    for (const a of t.assumptions) L.push(`  - ${a.text}`, `      breaks: ${a.breaks}`);
  }
  if (GRILL_KEYS.some((k) => t.grill[k])) {
    L.push('', '  grill');
    for (const k of GRILL_KEYS) if (t.grill[k]) L.push(`  - ${(`${k}:`).padEnd(12)}${t.grill[k]}`);
  }
  if (withLog && t.log.length) {
    L.push('', '  log');
    for (const e of t.log) L.push(`  ${e.at.slice(0, 16).replace('T', ' ')}  ${e.kind.padEnd(8)} ${e.text}`);
  }
  return L.join('\n');
}

/* ----------------------------------------------------------------- commands */

function pairs(a) {
  const reqs = a.r || [];
  const checks = (a.c || []).slice();
  if (checks.length > reqs.length) die(`more checks (${checks.length}) than requirements (${reqs.length})`);
  while (checks.length < reqs.length) checks.push('');
  return reqs.map((text, i) => [text, checks[i]]);
}

const rid = () => randomBytes(3).toString('hex');

/** Used by `new` and by spinoff. Requirements may be left for the agent who takes the ticket. */
export function openTicket({ title, ask, loose, draft, goal, parent, owner, due, reqs = [] }) {
  const id = newId('T-');
  emit(id, 'open', {
    title: title.trim(), ask: ask || '', loose: !!loose, draft: !!draft,
    goal: goal || null, parent: parent || null, owner: owner || identity() || null, due: due || null,
    requirements: reqs.map(([text, check]) => ({ rid: rid(), text: text.trim(), check: check.trim() })),
  });
  return loadTicket(id);
}

export function cmdNew(a) {
  const title = a._[0];
  if (!title) die('new needs a title:  genlock new "the thing that will be true" -r ... -c ...');
  const rp = pairs(a);
  const problems = [];
  if (!a.loose) {
    for (const p of lintTitle(title)) problems.push(['title', p]);
    if (!rp.length && !a.draft) problems.push(['requirements',
      'a ticket with no requirements cannot be finished. Write what must be TRUE for '
      + 'this to be done, BEFORE starting -- one -r per requirement, each with a -c check']);
    rp.forEach(([text, check], i) => {
      for (const p of lintRequirement(text, check)) problems.push([`requirement ${i + 1}`, p]);
    });
  }
  if (problems.length) {
    refuse('refusing to open this ticket.', problems,
      '  A requirement is a statement that is either TRUE or FALSE once the work is\n'
      + '  finished, and a check is how you will find out which.\n'
      + '  Rewrite and try again, or --loose to bypass (which forfeits `genlock done`).');
  }
  let goal = null;
  if (a.goal) {
    goal = resolveId(a.goal, 'G-', 'goal');
    if (!goal) die(`no goal '${a.goal}' in this repository. \`genlock goal list\` shows them`);
  }
  // Before anything is created, so a taken name refuses the whole thing.
  const short = a.short ? checkShortName(a.short, 'T-') : null;
  const t = openTicket({
    title, ask: a.ask, loose: a.loose, draft: a.draft && !rp.length, goal, owner: a.owner, due: parseDue(a.due), reqs: rp,
  });
  if (short) emit(t.id, 'short', { short });
  console.log(a.quiet ? t.id : render(loadTicket(t.id)));
  if (!short && !a.quiet) console.log(`\n${nameItNudge(t.id)}`);
}

export function cmdReq(a) {
  const t = requireTicket(a, 'req');
  const rp = pairs(a);
  if (!rp.length) die('req needs -r "what must be true" -c "how it is checked"');
  const problems = [];
  if (!t.loose) rp.forEach(([text, check], i) => {
    for (const p of lintRequirement(text, check)) problems.push([`new requirement ${i + 1}`, p]);
  });
  if (problems.length) refuse('refusing to add that requirement.', problems);
  for (const [text, check] of rp) emit(t.id, 'req', { rid: rid(), text: text.trim(), check: check.trim() });
  console.log(render(loadTicket(t.id)));
}

export function mark(a, state, field) {
  const t = requireTicket(a, state);
  const num = a._[1];
  if (!/^\d+$/.test(String(num || '')))
    die(`${state} needs a requirement number:  genlock ${state} ${t.id} 2 --${field} "..."`);
  const r = t.requirements.find((x) => x.n === parseInt(num, 10));
  if (!r) die(`${t.id} has no requirement ${num} (it has ${t.requirements.length})`);
  const ev = a[field];
  if (!ev || !String(ev).trim())
    die(`${state} requires --${field}: what did you OBSERVE that settles requirement ${r.n}?\n`
      + `     the check on it is: ${r.check || '(none recorded)'}`);
  emit(t.id, 'mark', { rid: r.rid, state, evidence: String(ev).trim() });
  const after = loadTicket(t.id);
  console.log(reqLine(after.requirements.find((x) => x.rid === r.rid)));
  console.log(`\n  ${t.id}: ${summariseReqs(after)}`);
}

export function cmdStart(a) {
  const t = requireTicket(a, 'start');
  if (t.status === 'blocked' && !a.because)
    die(`${t.id} is blocked: ${t.blocked_reason}\n     Starting it needs --because: what changed, and who said so.`);
  if (t.status === 'draft')
    die(`${t.id} has no requirements yet. Write what must be true before starting:\n`
      + `     genlock req ${t.id} -r "..." -c "..."`);
  const me = identity();
  let took = null;
  // Check and claim together: two sessions reading "top of the list" at once must not both win.
  if (me) withLock(() => {
    const held = claimFor(t.id);
    if (held && held.session !== me) {
      if (!a.take_over || !a.user_said) {
        process.stderr.write(`genlock: start refused. ${t.id} is held by ${holderLabel(held)}.\n`
          + '  Another agent is working on it. Pick the next thing instead.\n'
          + '  Taking it over is the user\'s call, on their words:\n'
          + `  genlock start ${t.id} --take-over --user-said "THEIR WORDS"\n`);
        process.exit(4);
      }
      took = held;
    }
    writeClaim({ key: t.id, session: me, paths: took ? [] : (held?.paths || []), resources: took ? [] : (held?.resources || []) });
  });
  if (took) emit(t.id, 'note', { text: `taken over from ${holderLabel(took)}; user said: ${a.user_said}` });
  if (a.because) emit(t.id, 'note', { text: `unblocked: ${a.because}` });
  emit(t.id, 'start');
  console.log(`${t.id} in_progress -- ${summariseReqs(t)}${me ? ', claimed by this session' : ''}`);
  if (took) console.log(`  taken over from ${holderLabel(took)}. That agent may still be running; tell it.`);
}

export function withReason(a, cmd, op, label) {
  const t = requireTicket(a, cmd);
  const why = a._.slice(1).join(' ').trim();
  if (!why) die(`${cmd} needs a reason:  genlock ${cmd} ${t.id} "..."`);
  emit(t.id, op, op === 'note' ? { text: why } : { why });
  if (op === 'abandon') releaseTicket(t.id);
  console.log(`${t.id} ${label} -- ${why}`);
}

export function cmdAssume(a) {
  const t = requireTicket(a, 'assume');
  const text = a._.slice(1).join(' ').trim();
  if (!text) die(`assume needs the assumption:  genlock assume ${t.id} "..." --breaks "..."`);
  if (!a.breaks) die('assume requires --breaks: what goes wrong if the assumption is false?\n'
    + '     an assumption with no stated consequence cannot be weighed');
  emit(t.id, 'assume', { text, breaks: String(a.breaks).trim() });
  console.log(`[ASSUMING] ${t.id} · ${text}`);
  console.log(`           wrong -> ${a.breaks}`);
}

export function cmdGrill(a) {
  const t = requireTicket(a, 'grill');
  const answers = {};
  for (const k of GRILL_KEYS) if (a[k]) answers[k] = String(a[k]).trim();
  if (!Object.keys(answers).length) {
    console.log('  The five questions. Answer each with --<field> "..."\n');
    for (const k of GRILL_KEYS)
      console.log(`  --${k.padEnd(12)} ${(t.grill[k] ? 'answered' : 'OPEN').padEnd(9)}${GRILL[k]}`);
    return;
  }
  emit(t.id, 'grill', { answers });
  const g = loadTicket(t.id).grill;
  const missing = GRILL_KEYS.filter((k) => !g[k]);
  console.log(`${t.id} grilled: ${5 - missing.length} of 5 answered.`);
  if (missing.length) console.log(`  still open: ${missing.join(', ')}`);
}

/** The one refusal this whole tool exists for. */
export function cmdDone(a) {
  const t = requireTicket(a, 'done');
  const blockers = [];
  if (t.loose) blockers.push('this ticket was opened with --loose, so its requirements '
    + 'were never linted. It cannot be closed as done; reopen it properly');
  if (!t.requirements.length) blockers.push("no requirements. There is nothing here that 'done' could mean");
  for (const r of t.requirements.filter((x) => x.state === 'open'))
    blockers.push(`requirement ${r.n} is unproved: ${r.text}\n      its check: ${r.check || '(none)'}`
      + `\n      -> genlock met ${t.id} ${r.n} --evidence "what you observed"`);
  for (const r of t.requirements.filter((x) => x.state === 'failed'))
    blockers.push(`requirement ${r.n} FAILED and was never resolved: ${r.text}\n      ${r.evidence}`);
  const openG = GRILL_KEYS.filter((k) => !t.grill[k]);
  if (openG.length)
    blockers.push(`the grill is unanswered: ${openG.join(', ')}\n      -> genlock grill ${t.id}  (to see the questions)`);

  if (blockers.length) {
    process.stderr.write(`genlock: ${t.id} is NOT done.\n\n`);
    for (const b of blockers) process.stderr.write(`  - ${b}\n`);
    process.stderr.write('\n  Nothing may be reported complete while any of the above is true.\n');
    process.exit(3);
  }

  emit(t.id, 'done', { summary: summariseReqs(t) });
  releaseTicket(t.id);

  // Status reporting comes FROM the ticket, so the ticket writes the line.
  console.log(`[TASK-COMPLETE] ${t.id} · ${t.title}`);
  for (const r of t.requirements) {
    const tag = r.state === 'waived' ? 'waived' : 'proved';
    const how = r.state === 'waived' ? 'why' : 'by';
    console.log(`  ✓ ${r.text} — ${tag} (${how}: ${r.evidence})`);
  }
  const g = t.grill;
  const tried = (g.observed || g.cause || '').trim();
  if (tried) console.log(`[GRILLED] ${tried}`);
  console.log(`          still unbroken: ${g.falsify}`);
  for (const as of t.assumptions) console.log(`[ASSUMING] ${as.text} — wrong -> ${as.breaks}`);
  if (t.goal) {
    const sib = allTickets().filter((x) => x.goal === t.goal && x.status !== 'abandoned');
    console.log(`[STATUS-UPDATE] goal ${t.goal}: ${sib.filter((x) => x.status === 'done').length} of ${sib.length} tickets done`);
    const next = openNext(loadGoal(t.goal));
    console.log(`Goal ${t.goal} next things${next.length ? ':' : ': none.'}`);
    for (const n of next) console.log(`  ${n.n}. ${n.text}`);
    console.log(`Are these still right? genlock goal next ${t.goal} "..."  |  --done N  |  --still-right`);
  }
}

/** What just happened on this ticket, so whoever picks it up next knows. */
export function cmdUpdate(a) {
  const t = requireTicket(a, 'update');
  const text = a._.slice(1).join(' ').trim();
  if (!text) die(`update needs the latest:  genlock update ${t.id} "what just happened, and where it stands"`);
  if (text.length > LATEST_MAX)
    die(`latest is ${text.length} characters; the limit is ${LATEST_MAX}. A long latest is a handoff document in disguise.\n`
      + '     Say where it stands. Put findings in a file and point at them with `genlock ref`, decisions in\n'
      + '     `genlock decide`, and what comes next in `genlock goal next`.');
  emit(t.id, 'update', { text });
  console.log(`[STATUS-UPDATE] ${t.id} · ${t.title} — ${t.status}, ${summariseReqs(t)}. ${text}`);
}

function ticketOrGoal(raw) {
  const id = resolveId(raw, 'T-', 'ticket') || resolveId(raw, 'G-', 'goal');
  if (!id) die(`no ticket or goal '${raw}' in this repository`);
  return id.startsWith('T-') ? loadTicket(id) : loadGoal(id);
}

/** A decision belongs on the ticket or goal it governs, in the words of whoever made it. */
export function cmdDecide(a) {
  const raw = a._[0];
  const text = a._.slice(1).join(' ').trim();
  if (!raw || !text) die('decide needs a ticket or goal and the decision:  genlock decide T-XXXXX "..." [--user-said ".."] [--supersedes N]');
  const rec = ticketOrGoal(raw);
  let supersedes;
  if (a.supersedes !== undefined) {
    const old = rec.decisions[parseInt(a.supersedes, 10) - 1];
    if (!old) die(`${rec.id} has no decision ${a.supersedes} (it has ${rec.decisions.length})`);
    supersedes = old.did;
  }
  emit(rec.id, 'decide', { did: randomBytes(3).toString('hex'), text, user_said: a.user_said || '', supersedes });
  console.log(`${rec.id} decision recorded: ${text}`);
}

/** Durable findings stay in files. A record points at them, and says why they matter here. */
export function cmdRef(a) {
  const [raw, file] = a._;
  if (!raw || !file) die('ref needs a ticket or goal and a path:  genlock ref T-XXXXX notes/findings/X.md --why "..."');
  if (!a.why) die('ref requires --why: what will the next reader find there, and when do they need it?');
  const rec = ticketOrGoal(raw);
  emit(rec.id, 'ref', { path: file, why: String(a.why).trim() });
  console.log(`${rec.id} points at ${file}`);
}

/** A hard stop: something a later agent must not do, however reasonable it looks by then. */
export function cmdForbid(a) {
  const raw = a._[0];
  const text = a._.slice(1).join(' ').trim();
  if (!raw || !text) die('forbid needs a ticket or goal and what must not be done:  genlock forbid G-XXXXX "..." --lifted-by "..."');
  if (!a.lifted_by) die('forbid requires --lifted-by: who or what can lift this? A stop nobody can lift outlives its reason.');
  const rec = ticketOrGoal(raw);
  emit(rec.id, 'forbid', { fid: randomBytes(3).toString('hex'), text, lifted_by: String(a.lifted_by).trim() });
  console.log(`${rec.id} DO NOT: ${text}`);
}

export function cmdUnforbid(a) {
  const [raw, num] = a._;
  if (!raw || !num) die('unforbid needs a ticket or goal and a number:  genlock unforbid G-XXXXX 1 --user-said "..."');
  if (!a.user_said) die('unforbid requires --user-said: the words of whoever lifted it');
  const rec = ticketOrGoal(raw);
  const live = rec.forbids.filter((f) => !f.lifted);
  const f = live[parseInt(num, 10) - 1];
  if (!f) die(`${rec.id} has no standing stop ${num} (it has ${live.length})`);
  emit(rec.id, 'unforbid', { fid: f.fid, user_said: String(a.user_said).trim() });
  console.log(`${rec.id} lifted: ${f.text}`);
}

/** Something left behind that needs checking before anyone trusts or commits it. */
export function cmdHazard(a) {
  const t = requireTicket(a, 'hazard');
  if (a.clear !== undefined) {
    const live = t.hazards.filter((h) => !h.cleared);
    const h = live[parseInt(a.clear, 10) - 1];
    if (!h) die(`${t.id} has no open hazard ${a.clear} (it has ${live.length})`);
    if (!a.evidence) die('clearing a hazard requires --evidence: what did you observe?');
    emit(t.id, 'hazard_clear', { hid: h.hid, evidence: String(a.evidence).trim() });
    console.log(`${t.id} hazard cleared: ${h.what}`);
    return;
  }
  const what = a._.slice(1).join(' ').trim();
  if (!what) die(`hazard needs what was left behind:  genlock hazard ${t.id} "..." --verify "..."`);
  if (!a.verify) die('hazard requires --verify: how does the next agent check it? It must not be trusted on your word.');
  emit(t.id, 'hazard', { what, verify: String(a.verify).trim() });
  console.log(`${t.id} HAZARD: ${what}`);
}

export function cmdShow(a) {
  const t = requireTicket(a, 'show');
  console.log(a.json ? JSON.stringify(t, null, 2) : render(t, true));
}

/** One line, for a [STATUS-UPDATE]. Status updates come FROM tickets. */
export function cmdStatus(a) {
  const t = requireTicket(a, 'status');
  console.log(`[STATUS-UPDATE] ${t.id} · ${t.title} — ${t.status}, ${summariseReqs(t)}`);
}

export function cmdList(a) {
  let want = null;
  if (a.open) want = OPEN_STATES;
  else if (a.status) want = new Set([String(a.status)]);
  let rows = allTickets().filter((t) => !want || want.has(t.status));
  if (a.goal) {
    const g = resolveId(a.goal, 'G-', 'goal');
    rows = rows.filter((t) => t.goal === g);
  }
  if (!rows.length) { console.log('no tickets.'); return; }
  // Open work by rank, most important first, then anything closed, oldest first.
  const place = new Map(rankedTasks().map((t) => [t.id, t.rank]));
  rows.sort((x, y) => (place.get(x.id) ?? Infinity) - (place.get(y.id) ?? Infinity) || x.created.localeCompare(y.created));
  for (const t of rows) {
    const flag = { draft: '~', open: ' ', in_progress: '>', blocked: '!', done: '✓', abandoned: 'x' }[t.status] || '?';
    console.log(`${flag} ${String(place.has(t.id) ? `#${place.get(t.id)}` : '').padEnd(4)}${shortName(t.id)} (${t.id})  ${t.status.padEnd(13)}${summariseReqs(t).padEnd(26)}`
      + `${t.goal ? `${t.goal}  ` : ''}${t.title}${t.due ? `  [${dueLabel(t.due)}]` : ''}`);
  }
}

/** Lint candidate requirements without opening anything. */
export function cmdLint(a) {
  const rp = pairs(a);
  if (!rp.length) {
    if (!a._.length) die('lint needs -r "..." -c "..." or a ticket id');
    const t = requireTicket(a, 'lint');
    let bad = 0;
    for (const r of t.requirements) {
      const ps = lintRequirement(r.text, r.check);
      if (!ps.length) continue;
      bad++;
      console.log(`  requirement ${r.n}: ${r.text}`);
      for (const p of ps) console.log(`      ${p}`);
    }
    console.log(`${t.id}: ${bad} of ${t.requirements.length} requirements are unclear.`);
    process.exit(bad ? 1 : 0);
  }
  let bad = 0;
  rp.forEach(([text, check], i) => {
    const ps = lintRequirement(text, check);
    if (!ps.length) { console.log(`  ${i + 1}. ok`); return; }
    bad++;
    console.log(`  ${i + 1}. ${text}`);
    for (const p of ps) console.log(`      ${p}`);
  });
  process.exit(bad ? 1 : 0);
}

export function cmdAssign(a) {
  const t = requireTicket(a, 'assign');
  const owner = a._[1];
  if (!owner) die(`assign needs an owner:  genlock assign ${t.id} SESSION`);
  emit(t.id, 'assign', { owner });
  console.log(`${t.id} assigned to ${owner}`);
}

export function cmdLink(a) {
  const t = requireTicket(a, 'link');
  if (!a._[1]) die(`link needs a goal:  genlock link ${t.id} G-XXXXX`);
  const g = resolveId(a._[1], 'G-', 'goal');
  if (!g) die(`no goal '${a._[1]}' in this repository`);
  emit(t.id, 'link', { goal: g });
  console.log(`${t.id} linked to ${g}`);
}

/**
 * Goals: what the work is for. Tickets stay invisible; goals are the one layer the user
 * sees, because only the user can say what they are. So an agent may PROPOSE a goal, but
 * nothing becomes active or closes without the user's own words on record.
 *
 * Progress is never typed. It is counted from the tickets linked to the goal.
 */

import { randomBytes } from 'node:crypto';
import {
  applyShared, die, emit, emptyShared, listIds, newId, parseDue, readEvents, resolveId, sharedLines,
} from './store.mjs';
import { allTickets, OPEN_STATES } from './tickets.mjs';
import { dueLabel, rankedGoals } from './rank.mjs';

const STALE_DAYS = 14;

/** Goals that hold a place in the ranking. */
export const goalIsOpen = (g) => ['active', 'proposed', 'parked'].includes(g.status);

export function loadGoal(id) {
  const events = readEvents(id);
  if (!events.length) return null;
  const g = {
    id, title: '', why: '', done_when: '', status: 'active', created: events[0].at,
    updated: events[events.length - 1].at, user_said: '', updates: [], evidence: '',
    ...emptyShared(), waiting_on: '', next: [], next_touched: events[0].at, touched_by: [...new Set(events.map((e) => e.by))],
  };
  for (const e of events) {
    if (applyShared(g, e)) continue;
    switch (e.op) {
      case 'next_add':
        g.next.push({ nid: e.nid, text: e.text, done: false, at: e.at, due: e.due || null });
        g.next_touched = e.at;
        break;
      case 'next_move': {
        const i = g.next.findIndex((x) => x.nid === e.nid);
        if (i >= 0) {
          const [item] = g.next.splice(i, 1);
          const j = e.before ? g.next.findIndex((x) => x.nid === e.before) : -1;
          g.next.splice(j >= 0 ? j : g.next.length, 0, item);
        }
        g.next_touched = e.at;
        break;
      }
      case 'park': g.status = 'parked'; g.waiting_on = e.waiting_on; break;
      case 'unpark': g.status = 'active'; g.waiting_on = ''; g.next_touched = e.at; break;
      case 'next_done': {
        const item = g.next.find((x) => x.nid === e.nid);
        if (item) item.done = true;
        g.next_touched = e.at;
        break;
      }
      case 'next_keep': g.next_touched = e.at; break;
      case 'add': Object.assign(g, { title: e.title, why: e.why || '', done_when: e.done_when || '', status: 'active', user_said: e.user_said, due: e.due || null }); break;
      case 'propose': Object.assign(g, { title: e.title, why: e.why, done_when: e.done_when || '', status: 'proposed' }); break;
      case 'accept': g.status = 'active'; g.user_said = e.user_said; break;
      case 'reject': g.status = 'rejected'; g.user_said = e.user_said; break;
      case 'update': g.updates.push({ at: e.at, text: e.text }); break;
      case 'done': g.status = 'done'; g.evidence = e.evidence; g.user_said = e.user_said; break;
      case 'drop': g.status = 'dropped'; g.user_said = e.user_said; break;
      default: break;
    }
  }
  return g;
}

/** Days until a date, by calendar day, so a deadline today reads as today. */
export function daysUntil(day) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return Math.round((Date.parse(day) - today.getTime()) / 86400000);
}

export function nextLine(n) {
  if (!n.due) return `${n.n}. ${n.text}`;
  const d = daysUntil(n.due);
  const when = d < 0 ? `OVERDUE by ${-d} day(s), was ${n.due}` : d === 0 ? `DUE TODAY, ${n.due}` : `due ${n.due}, in ${d} day(s)`;
  return `${n.n}. ${n.text}  [${when}]`;
}

/** Open next things, numbered as the user and agents will refer to them. */
export const openNext = (g) => g.next.filter((x) => !x.done).map((x, i) => ({ ...x, n: i + 1 }));

export const allGoals = () => listIds('G-').map(loadGoal).filter(Boolean);
export const goalsSkipped = () => readEvents('project').some((e) => e.op === 'no_goals');

function requireGoal(raw, cmd) {
  if (!raw) die(`goal ${cmd} needs a goal id`);
  const id = resolveId(raw, 'G-', 'goal');
  if (!id) die(`no goal '${raw}' in this repository`);
  return loadGoal(id);
}

function needsUser(a, cmd) {
  if (!a.user_said || !String(a.user_said).trim())
    die(`goal ${cmd} requires --user-said: the user's own words. Goals belong to the user,\n`
      + '     so an agent cannot set or close one on its own judgement. Ask them first.');
  return String(a.user_said).trim();
}

export function progress(g, tickets = allTickets()) {
  const mine = tickets.filter((t) => t.goal === g.id && t.status !== 'abandoned');
  const done = mine.filter((t) => t.status === 'done').length;
  const blocked = mine.filter((t) => t.status === 'blocked').length;
  const parts = [`${done} of ${mine.length} tickets done`];
  if (blocked) parts.push(`${blocked} blocked`);
  return { line: parts.join(', '), total: mine.length, done, open: mine.filter((t) => OPEN_STATES.has(t.status)) };
}

/** No activity on the goal or its tickets for a while: it may no longer be what is wanted. */
export function isStale(g, tickets) {
  const latest = [g.updated, ...tickets.filter((t) => t.goal === g.id).map((t) => t.updated)].sort().pop();
  return Date.now() - Date.parse(latest) > STALE_DAYS * 86400000;
}

export function goalLine(g, tickets) {
  return `${g.rank ? `#${g.rank} ` : ''}${g.id}  ${g.title} — ${progress(g, tickets).line}`
    + `${g.due ? `  [${dueLabel(g.due)}]` : ''}`
    + `${g.status === 'active' && isStale(g, tickets) ? `  (no activity in ${STALE_DAYS}+ days)` : ''}`;
}

const subs = {
  list(a) {
    const tickets = allTickets();
    const all = allGoals();
    // Most important first, then anything closed.
    const rows = [...rankedGoals(all), ...(a.all ? all.filter((g) => !goalIsOpen(g)) : [])];
    if (!rows.length) {
      console.log(a.all ? 'no goals.' : 'no active goals.');
      return;
    }
    for (const g of rows) console.log(`${g.status.padEnd(9)} ${goalLine(g, tickets)}`);
  },
  add(a) {
    const title = a._[1];
    if (!title) die('goal add needs a title:  genlock goal add "..." --user-said "..."');
    const user_said = needsUser(a, 'add');
    const id = newId('G-');
    emit(id, 'add', { title: title.trim(), why: a.why || '', done_when: a.done_when || '', user_said, due: parseDue(a.due) });
    console.log(`[STATUS-UPDATE] goal ${id} set: ${title.trim()}`);
  },
  propose(a) {
    const title = a._[1];
    if (!title) die('goal propose needs a title:  genlock goal propose "..." --why "..."');
    if (!a.why) die('goal propose requires --why: what did you see in the work that suggests this?');
    const id = newId('G-');
    emit(id, 'propose', { title: title.trim(), why: String(a.why).trim(), done_when: a.done_when || '' });
    console.log(`${id} proposed, not active. Ask the user, in one line:`);
    console.log(`  "This looks like a goal of its own: ${title.trim()}. Want me to track it?"`);
    console.log(`Then: genlock goal accept ${id} --user-said "..."   or   genlock goal reject ${id} --user-said "..."`);
  },
  accept(a) {
    const g = requireGoal(a._[1], 'accept');
    if (g.status !== 'proposed') die(`${g.id} is ${g.status}, not proposed`);
    emit(g.id, 'accept', { user_said: needsUser(a, 'accept') });
    console.log(`[STATUS-UPDATE] goal ${g.id} set: ${g.title}`);
  },
  reject(a) {
    const g = requireGoal(a._[1], 'reject');
    if (g.status !== 'proposed') die(`${g.id} is ${g.status}, not proposed`);
    emit(g.id, 'reject', { user_said: needsUser(a, 'reject') });
    console.log(`${g.id} rejected`);
  },
  update(a) {
    const g = requireGoal(a._[1], 'update');
    const text = a._.slice(2).join(' ').trim();
    if (!text) die(`goal update needs what moved:  genlock goal update ${g.id} "..."`);
    emit(g.id, 'update', { text });
    console.log(`[STATUS-UPDATE] goal ${g.id} · ${g.title} — ${progress(g).line}. ${text}`);
  },
  next(a) {
    const g = requireGoal(a._[1], 'next');
    const text = a._.slice(2).join(' ').trim();
    if (a.done !== undefined) {
      const item = openNext(g).find((x) => x.n === parseInt(a.done, 10));
      if (!item) die(`${g.id} has no open next thing ${a.done}`);
      emit(g.id, 'next_done', { nid: item.nid });
    } else if (a.still_right) {
      emit(g.id, 'next_keep');
    } else if (a.move !== undefined) {
      const open = openNext(g);
      const item = open.find((x) => x.n === parseInt(a.move, 10));
      const dest = parseInt(a.to, 10);
      if (!item || !(dest >= 1)) die(`goal next --move needs an open number and --to:  genlock goal next ${g.id} --move 3 --to 1`);
      const rest = open.filter((x) => x.nid !== item.nid);
      emit(g.id, 'next_move', { nid: item.nid, before: rest[dest - 1]?.nid || null });
    } else if (text) {
      emit(g.id, 'next_add', { nid: randomBytes(3).toString('hex'), text, due: parseDue(a.due) });
    }
    const items = openNext(loadGoal(g.id));
    console.log(`${g.id} next things${items.length ? ':' : ': none.'}`);
    for (const n of items) console.log(`  ${nextLine(n)}`);
  },
  park(a) {
    const g = requireGoal(a._[1], 'park');
    if (!a.waiting_on) die('goal park requires --waiting-on: who or what brings this back?');
    emit(g.id, 'park', { waiting_on: String(a.waiting_on).trim() });
    console.log(`${g.id} parked, waiting on: ${a.waiting_on}`);
  },
  unpark(a) {
    const g = requireGoal(a._[1], 'unpark');
    emit(g.id, 'unpark');
    console.log(`${g.id} active again`);
  },
  status(a) {
    const g = requireGoal(a._[1], 'status');
    console.log(`[STATUS-UPDATE] goal ${g.id} · ${g.title} — ${g.status}, ${progress(g).line}`);
  },
  show(a) {
    const g = requireGoal(a._[1], 'show');
    const tickets = allTickets().filter((t) => t.goal === g.id);
    if (a.json) { console.log(JSON.stringify({ ...g, tickets: tickets.map((t) => t.id) }, null, 2)); return; }
    const place = rankedGoals().find((x) => x.id === g.id)?.rank;
    console.log(`${place ? `#${place} ` : ''}${g.id}  ${g.title}\n  ${g.status}, ${progress(g).line}`);
    if (g.due) console.log(`  ${dueLabel(g.due)}`);
    if (g.why) console.log(`  why: ${g.why}`);
    if (g.done_when) console.log(`  done when: ${g.done_when}`);
    if (g.user_said) console.log(`  user said: ${g.user_said}`);
    if (g.waiting_on) console.log(`  waiting on: ${g.waiting_on}`);
    for (const n of openNext(g)) console.log(`  next ${nextLine(n)}`);
    for (const line of sharedLines(g)) console.log(line);
    for (const t of tickets) console.log(`  ${t.status === 'done' ? '✓' : '-'} ${t.id} ${t.status.padEnd(12)} ${t.title}${t.latest ? `\n      latest: ${t.latest.text}` : ''}`);
    for (const u of g.updates) console.log(`  ${u.at.slice(0, 10)}  ${u.text}`);
  },
  done(a) {
    const g = requireGoal(a._[1], 'done');
    const p = progress(g);
    if (p.open.length) {
      process.stderr.write(`genlock: ${g.id} still has open tickets. Close, abandon or unlink them first:\n`);
      for (const t of p.open) process.stderr.write(`  - ${t.id} ${t.status}: ${t.title}\n`);
      process.exit(3);
    }
    if (!a.evidence) die('goal done requires --evidence: what shows this goal was reached?');
    emit(g.id, 'done', { evidence: String(a.evidence).trim(), user_said: needsUser(a, 'done') });
    console.log(`[TASK-COMPLETE] goal ${g.id} · ${g.title} — ${p.line}`);
  },
  drop(a) {
    const g = requireGoal(a._[1], 'drop');
    emit(g.id, 'drop', { user_said: needsUser(a, 'drop') });
    console.log(`${g.id} dropped`);
  },
  none(a) {
    emit('project', 'no_goals', { user_said: needsUser(a, 'none') });
    console.log('recorded. Agents will stop asking until a goal is set.');
  },
};

export function cmdGoal(a) {
  const sub = a._[0] || 'list';
  if (!subs[sub]) die(`unknown goal command '${sub}'. Try: list add propose accept reject next park unpark update status show done drop none`);
  subs[sub](a);
}

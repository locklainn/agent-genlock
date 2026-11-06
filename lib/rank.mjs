/**
 * The ranking: one strict order for goals and one for tasks. No two things can share a place,
 * because a place is a position in a list rather than a number anyone stores.
 *
 * The list is replayed from events like everything else here. A thing joins at the bottom when
 * it is created, and each move puts it before another thing or at the end. Two agents moving
 * things at once, even on two branches, replay into one order, and a merge cannot produce a tie.
 *
 * Agents and the app both move things with `genlock rank`. Reads come from `genlock snapshot`.
 */

import { die, emit, parseDue, readEvents, resolveId, shortName, shortNames, slugify } from './store.mjs';
import { allGoals, daysUntil, goalIsOpen } from './goals.mjs';
import { allTickets, OPEN_STATES } from './tickets.mjs';

const RECORD = 'ranking';

function replay(kind, items) {
  const moves = readEvents(RECORD).filter((e) => e.op === 'rank' && e.kind === kind);
  // Sort is stable, so at the same instant a thing exists before it is moved.
  const stream = [...items.map((i) => ({ at: i.created, joins: i.id })), ...moves]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const list = [];
  for (const step of stream) {
    if (step.joins) { list.push(step.joins); continue; }
    const from = list.indexOf(step.id);
    if (from < 0) continue;
    list.splice(from, 1);
    const to = step.before ? list.indexOf(step.before) : -1;
    list.splice(to >= 0 ? to : list.length, 0, step.id);
  }
  return list;
}

/** Open things in their order, each with its `rank`, counting from 1 with no gaps. */
function ranked(kind, items, isOpen) {
  const byId = new Map(items.map((i) => [i.id, i]));
  return replay(kind, items).map((id) => byId.get(id)).filter(isOpen).map((item, i) => ({ ...item, rank: i + 1 }));
}

export const rankedGoals = (goals = allGoals()) => ranked('goals', goals, goalIsOpen);
export const rankedTasks = (tickets = allTickets()) => ranked('tasks', tickets, (t) => OPEN_STATES.has(t.status));

/** "due 2026-12-01, in 3 day(s)", or empty. */
export function dueLabel(due) {
  if (!due) return '';
  const d = daysUntil(due);
  return d < 0 ? `OVERDUE by ${-d} day(s), was ${due}` : d === 0 ? `DUE TODAY, ${due}` : `due ${due}, in ${d} day(s)`;
}

function find(raw) {
  const goal = resolveId(raw, 'G-', 'goal');
  if (goal) return { id: goal, kind: 'goals' };
  const task = resolveId(raw, 'T-', 'ticket');
  if (task) return { id: task, kind: 'tasks' };
  die(`no goal or ticket '${raw}' in this repository`);
  return null;
}

function print(kind) {
  const rows = kind === 'goals' ? rankedGoals() : rankedTasks();
  console.log(`${kind === 'goals' ? 'Goals' : 'Tasks'}, most important first:`);
  if (!rows.length) console.log('  none open.');
  for (const r of rows) console.log(`  ${String(r.rank).padStart(2)}. ${shortName(r.id)} (${r.id})  ${r.title}${r.due ? `  [${dueLabel(r.due)}]` : ''}`);
}

export function cmdRank(a) {
  const target = a._[0];
  if (!target) { print('goals'); print('tasks'); return; }
  if (target === 'goals' || target === 'tasks') { print(target); return; }

  const { id, kind } = find(target);
  const rows = kind === 'goals' ? rankedGoals() : rankedTasks();
  if (!rows.some((r) => r.id === id)) die(`${id} is closed, so it has no place in the ranking`);
  const rest = rows.filter((r) => r.id !== id);

  let before;
  if (a.before !== undefined) {
    const other = find(a.before);
    if (other.kind !== kind) die('goals are ranked with goals and tasks with tasks');
    if (other.id === id) die(`${id} cannot go before itself`);
    if (!rest.some((r) => r.id === other.id)) die(`${other.id} is closed, so it has no place in the ranking`);
    before = other.id;
  } else {
    const to = Number(a.to);
    if (!Number.isInteger(to) || to < 1) die(`rank needs a place:  genlock rank ${id} --to 1  |  genlock rank ${id} --before OTHER`);
    before = rest[to - 1]?.id || null;
  }
  emit(RECORD, 'rank', { kind, id, before });
  print(kind);
}

/** Gives a goal or task a short name of the user's choosing. */
export function cmdShort(a) {
  const target = a._[0];
  const name = slugify(a._.slice(1).join(' '));
  if (!target || !name) die('short needs a goal or ticket and a name:  genlock short ID "billing page"');
  const { id, kind } = find(target);
  if (/^[gtqr]-/.test(name)) die(`'${name}' looks like an id, which is what short names are for avoiding`);
  const names = shortNames(kind === 'goals' ? 'G-' : 'T-');
  for (const [other, n] of names) {
    if (other !== id && n.name === name) die(`'${name}' is already ${other}, ${n.title}`);
  }
  emit(id, 'short', { short: name });
  console.log(`${id} is now ${name}`);
}

export function cmdDue(a) {
  const target = a._[0];
  if (!target) die('due needs a goal or ticket:  genlock due ID YYYY-MM-DD  |  genlock due ID --clear');
  const { id } = find(target);
  if (a.clear) {
    emit(id, 'due', { due: null });
    console.log(`${id} has no due date`);
    return;
  }
  const due = parseDue(a._[1]);
  if (!due) die(`due needs a date:  genlock due ${id} YYYY-MM-DD  |  genlock due ${id} --clear`);
  emit(id, 'due', { due });
  console.log(`${id} ${dueLabel(due)}`);
}

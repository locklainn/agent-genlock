/**
 * Tags and key-value metadata on goals and tasks, kept in the records so they outlive the
 * session that set them. The first use: knowing which finished work has been filed to an
 * outside log (NextLevel) and which has not, after the filing session has closed.
 *
 *   genlock tag ID [TAG ..] [--remove TAG[,TAG]]     add or remove; with neither, list
 *   genlock meta ID [KEY [VALUE]] [--clear]          set, read, or clear one key; with none, list
 *   genlock tagged TAG [--json]                      every goal and task carrying TAG
 *   genlock filed ID [ID ..] --event EVENT [--to DEST]   mark finished work as filed (DEST: nextlevel)
 *   genlock unfiled [--to DEST] [--since YYYY-MM-DD] [--json]   finished work not filed yet
 *
 * Filing sets the tag `filed:DEST` and the metadata `DEST.event` and `DEST.filed_at`.
 */

import { die, emit, parseDue, resolveId, shortName } from './store.mjs';
import { allTickets, loadTicket } from './tickets.mjs';
import { allGoals, loadGoal } from './goals.mjs';

const TAG = /^[a-z0-9][a-z0-9._:\-]{0,47}$/;
const KEY = /^[a-z0-9][a-z0-9._\-]{0,47}$/;
const DEFAULT_DEST = 'nextlevel';

export const filedTag = (dest = DEFAULT_DEST) => `filed:${dest}`;

function cleanTag(raw) {
  const t = String(raw).trim().replace(/^#/, '').toLowerCase();
  if (!TAG.test(t)) die(`'${raw}' is not a tag: letters, digits and . _ : - only, up to 48 characters`);
  return t;
}

function cleanKey(raw) {
  const k = String(raw).trim().toLowerCase();
  if (!KEY.test(k)) die(`'${raw}' is not a metadata key: letters, digits and . _ - only, up to 48 characters`);
  return k;
}

/** A goal or a ticket, by id, short name or title words: { id, rec, kind }. */
function find(raw) {
  const g = resolveId(raw, 'G-', 'goal');
  if (g) return { id: g, rec: loadGoal(g), kind: 'goal' };
  const t = resolveId(raw, 'T-', 'ticket');
  if (t) return { id: t, rec: loadTicket(t), kind: 'task' };
  die(`no goal or ticket '${raw}' in this repository`);
  return null;
}

const label = (r) => `${shortName(r.id) || r.id} (${r.id})`;
const isDone = (kind, rec) => rec.status === 'done';
const doneAt = (kind, rec) => (kind === 'goal' ? rec.completed_at : rec.closed) || rec.updated;

export function cmdTag(a) {
  const target = a._[0];
  if (!target) die('usage: genlock tag ID [TAG ..] [--remove TAG[,TAG]]');
  const { id, rec } = find(target);
  const add = a._.slice(1).map(cleanTag).filter((t) => !rec.tags.includes(t));
  const remove = (a.remove ? String(a.remove).split(',') : []).map(cleanTag).filter((t) => rec.tags.includes(t));
  if (add.length || remove.length) {
    const text = [...add.map((t) => `+#${t}`), ...remove.map((t) => `-#${t}`)].join(' ');
    emit(id, 'tag', { add, remove, text: `tags ${text}` });
  }
  const now = [...rec.tags.filter((t) => !remove.includes(t)), ...add];
  console.log(`${label(rec)}  ${now.length ? now.map((t) => `#${t}`).join(' ') : 'no tags'}`);
}

export function cmdMeta(a) {
  const [target, rawKey, ...rest] = a._;
  if (!target) die('usage: genlock meta ID [KEY [VALUE]] [--clear]');
  const { id, rec } = find(target);
  if (!rawKey) {
    const all = Object.entries(rec.meta);
    if (a.json) { console.log(JSON.stringify(rec.meta)); return; }
    console.log(all.length ? all.map(([k, v]) => `${k}=${v}`).join('\n') : `${label(rec)} has no metadata`);
    return;
  }
  const key = cleanKey(rawKey);
  if (a.clear) {
    if (key in rec.meta) emit(id, 'meta', { key, value: null, text: `meta ${key} cleared` });
    console.log(`${label(rec)}  ${key} cleared`);
    return;
  }
  if (!rest.length) {
    if (!(key in rec.meta)) die(`${label(rec)} has no ${key}`);
    console.log(rec.meta[key]);
    return;
  }
  const value = rest.join(' ');
  if (value.length > 500) die('a metadata value is at most 500 characters; findings go in files');
  if (rec.meta[key] !== value) emit(id, 'meta', { key, value, text: `meta ${key}=${value}` });
  console.log(`${label(rec)}  ${key}=${value}`);
}

/** Every goal and task, with what kind it is. */
const everything = () => [
  ...allGoals().map((rec) => ({ kind: 'goal', rec })),
  ...allTickets().map((rec) => ({ kind: 'task', rec })),
];

const row = ({ kind, rec }) => ({
  kind, id: rec.id, short: shortName(rec.id), title: rec.title, status: rec.status,
  done_at: isDone(kind, rec) ? doneAt(kind, rec) : null, tags: rec.tags, meta: rec.meta,
});

export function cmdTagged(a) {
  if (!a._[0]) die('usage: genlock tagged TAG [--json]');
  const tag = cleanTag(a._[0]);
  const rows = everything().filter(({ rec }) => rec.tags.includes(tag)).map(row);
  if (a.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log(`nothing is tagged #${tag}.`); return; }
  for (const r of rows) console.log(`  ${r.kind.padEnd(4)}  ${(r.short || r.id).padEnd(24)} ${r.status.padEnd(11)} ${r.title}`);
}

export function cmdFiled(a) {
  const dest = a.to ? cleanKey(a.to) : DEFAULT_DEST;
  const event = a.event ? String(a.event).trim() : '';
  if (!a._.length || !event) die(`usage: genlock filed ID [ID ..] --event EVENT_ID [--to ${DEFAULT_DEST}]\n`
    + 'EVENT_ID is the sourceEventId the filing used, so the record says which event carries this work.');
  const found = a._.map(find);
  const notDone = found.filter(({ kind, rec }) => !isDone(kind, rec));
  if (notDone.length && !a.force) {
    die(`only finished work is filed, and ${notDone.map(({ rec }) => `${label(rec)} is ${rec.status}`).join(', ')}. `
      + 'Nothing was marked. --force marks it anyway.');
  }
  const at = new Date().toISOString();
  const tag = filedTag(dest);
  for (const { id, rec } of found) {
    if (!rec.tags.includes(tag)) emit(id, 'tag', { add: [tag], remove: [], text: `filed to ${dest} as ${event}` });
    if (rec.meta[`${dest}.event`] !== event) {
      emit(id, 'meta', { key: `${dest}.event`, value: event, text: `meta ${dest}.event=${event}` });
      emit(id, 'meta', { key: `${dest}.filed_at`, value: at, text: `meta ${dest}.filed_at=${at}` });
    }
    console.log(`${label(rec)}  #${tag}  ${dest}.event=${event}`);
  }
}

export function cmdUnfiled(a) {
  const dest = a.to ? cleanKey(a.to) : DEFAULT_DEST;
  const since = a.since ? parseDue(a.since) : null;
  const tag = filedTag(dest);
  const rows = everything()
    .filter(({ kind, rec }) => isDone(kind, rec) && !rec.tags.includes(tag))
    .filter(({ kind, rec }) => !since || doneAt(kind, rec).slice(0, 10) >= since)
    .map(row)
    .sort((x, y) => String(y.done_at).localeCompare(String(x.done_at)));
  if (a.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log(`all finished work${since ? ` since ${since}` : ''} is filed to ${dest}.`); return; }
  console.log(`Finished, not filed to ${dest}${since ? ` (since ${since})` : ''}: ${rows.length}`);
  for (const r of rows) console.log(`  ${String(r.done_at).slice(0, 10)}  ${r.kind.padEnd(4)}  ${(r.short || r.id).padEnd(24)} ${r.title}`);
  console.log(`Mark one filed with: genlock filed ID --event EVENT_ID${dest === DEFAULT_DEST ? '' : ` --to ${dest}`}`);
}

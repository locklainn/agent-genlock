/**
 * Keeps genlock's own bookkeeping out of the user's transcript.
 *
 * In auto mode Claude Code shows a diff of every file a Bash command changed (its
 * "bash edit diff"), so each genlock command printed its record files as raw JSON:
 * "Created .genlock/records/R-36CB7.jsonl (+1 -0)" and the event underneath. The
 * PostToolUse hook receives that diff in tool_response.bashEditDiff and may hand back
 * the output without the .genlock files; what changed is then said in one plain line
 * per record, shown to the user only (the agent already has the command's own output).
 */

import fs from 'node:fs';
import path from 'node:path';

const OURS = /[\\/]\.genlock[\\/]/;
const isOurs = (f) => OURS.test(typeof f === 'string' ? f : f?.filePath || '');

const KIND = { T: 'task', G: 'goal', R: 'review', Q: 'question' };
const CREATE = new Set(['open', 'add', 'propose', 'request', 'ask']);
const STATUS = {
  start: 'started', done: 'done', abandon: 'abandoned', block: 'blocked', unblock: 'unblocked',
  park: 'parked', unpark: 'unparked', accept: 'accepted', reject: 'rejected', reopen: 'reopened',
  reviewed: 'reviewed', answer: 'answered', close: 'closed',
};
const WHAT = {
  update: 'latest', mark: 'proof', req: 'requirement', decide: 'decision', assume: 'assumption',
  grill: 'grill', short: 'short name', due: 'due date', link: 'goal link', assign: 'owner',
  next_add: 'next things', next_done: 'next things', next_move: 'next things', next_keep: 'next things',
  note: 'note', ref: 'reference', hazard: 'hazard', hazard_clear: 'hazard', forbid: 'forbid',
  unforbid: 'forbid', tag: 'tags', drop: 'next things', meta: 'details', voice: 'voice', no_goals: 'goals',
  rank: 'order', checkpoint: 'checkpoint', handoff: 'handoff', swap: 'swap', spinoff: 'spin-off',
};

const clip = (s, n = 70) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

/** The events a diff added to one record file. */
const addedEvents = (file) => (file.hunks || [])
  .flatMap((h) => h.lines || [])
  .filter((l) => l.startsWith('+'))
  .map((l) => parse(l.slice(1)))
  .filter((e) => e && e.op);

/** What a person calls this record: its short name, else its title, else its id. */
function nameOf(filePath, id, added = []) {
  let title = '';
  let short = '';
  let what = '';
  let events = added;
  try { events = fs.readFileSync(filePath, 'utf8').split('\n').map(parse).filter(Boolean); } catch { /* gone: what the diff added */ }
  for (const e of events) {
    if (e.op === 'short' && e.short) short = e.short;
    if (!title && e.title) title = e.title;
    if (!what && (e.path || e.text)) what = e.path || e.text;
  }
  return short || clip(title) || clip(what) || id;
}

/** One plain line for one changed record file, or null when there is nothing worth saying. */
export function summarize(file) {
  const id = path.basename(file.filePath || '', '.jsonl');
  if (!/^[A-Z]-/.test(id)) return id === 'project' ? 'Updated project settings' : null;
  const kind = KIND[id[0]] || 'record';
  const events = addedEvents(file);
  const ops = events.map((e) => e.op);
  const name = nameOf(file.filePath, id, events);
  const created = events.find((e) => CREATE.has(e.op));
  if (created || file.created) {
    if (kind === 'review') return `Asked for review of ${clip(created?.path || name)}`;
    if (kind === 'question') return `Asked ${created?.to === 'user' ? 'you' : clip(created?.to || 'a session', 30)}: ${clip(created?.text || name)}`;
    return `Added ${kind} "${name}"`;
  }
  if (kind === 'question' && ops.includes('answer')) return `Answered: ${name}`;
  if (kind === 'review' && ops.includes('reviewed')) return `Reviewed ${name}`;
  const status = [...ops].reverse().find((o) => STATUS[o]);
  if (status) return `Changed status of ${name} to ${STATUS[status]}`;
  const parts = [...new Set(ops.map((o) => WHAT[o] || o))];
  return parts.length ? `Updated ${parts.join(', ')} on ${name}` : `Updated ${kind} ${name}`;
}

/**
 * Given a PostToolUse hook input, the hook output fields that hide .genlock files from the
 * Bash edit diff and say what changed instead. Null when the diff touched none of them, so
 * the hook returns no rewrite at all: hooks run in parallel and a needless identity rewrite
 * could overwrite another hook's real one.
 */
export function quietRecords(input) {
  const out = input?.tool_response;
  const diff = out && typeof out === 'object' ? out.bashEditDiff : null;
  if (!diff || typeof diff !== 'object') return null;
  const files = Array.isArray(diff.files) ? diff.files : [];
  const changed = Array.isArray(diff.changedFiles) ? diff.changedFiles : [];
  const ours = files.filter(isOurs);
  if (!ours.length && !changed.some(isOurs)) return null;

  const lines = ours.map(summarize).filter(Boolean);
  // Paths listed without hunks (a diff too big to show) still deserve a line each.
  const shown = new Set(ours.map((f) => f.filePath));
  for (const p of changed.filter(isOurs)) {
    if (!shown.has(p)) lines.push(summarize({ filePath: p, hunks: [] }));
  }

  const keptFiles = files.filter((f) => !isOurs(f));
  const keptChanged = changed.filter((f) => !isOurs(f));
  const rest = { ...out };
  if (keptFiles.length || keptChanged.length || diff.moreFiles) {
    rest.bashEditDiff = { ...diff, files: keptFiles, ...(Array.isArray(diff.changedFiles) ? { changedFiles: keptChanged } : {}) };
  } else {
    delete rest.bashEditDiff;
  }
  return { updatedToolOutput: rest, lines: [...new Set(lines.filter(Boolean))] };
}

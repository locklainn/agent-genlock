/**
 * Files the agent wants the user to look at. A path mentioned in a reply scrolls away,
 * so a request to review is a record, and stays visible until the user has dealt with it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { die, emit, listIds, newId, readEvents, repoRoot, resolveId } from './store.mjs';

const isUrl = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

export function loadReview(id) {
  const r = { id, path: '', why: '', about: null, status: 'open', note: '', at: null, by: null, updated: null };
  for (const e of readEvents(id)) {
    r.updated = e.at;
    if (e.op === 'request') Object.assign(r, { path: e.path, why: e.why, about: e.about || null, status: 'open', note: '', at: e.at, by: e.by });
    if (e.op === 'reviewed') Object.assign(r, { status: 'reviewed', note: e.note || '' });
  }
  return r;
}

export const allReviews = () => listIds('R-').map(loadReview);
export const openReviews = () => allReviews().filter((r) => r.status === 'open');

/** Repository-relative where possible, so a record means the same thing on another machine. */
function normalizePath(raw) {
  if (isUrl(raw)) return raw;
  const abs = path.resolve(process.cwd(), raw);
  if (!fs.existsSync(abs)) die(`no file at '${raw}'. A review request has to point at something that can be opened.`);
  const rel = path.relative(fs.realpathSync(repoRoot()), fs.realpathSync(abs)).replace(/\\/g, '/');
  return rel.startsWith('..') ? abs : rel;
}

export function cmdReview(a) {
  const sub = a._[0];
  if (!sub) die('review needs a path:  genlock review PATH --why "what to look at" [--about GOAL|TICKET]');

  if (sub === 'list') {
    const rows = a.all ? allReviews() : openReviews();
    if (!rows.length) { console.log(a.all ? 'no review requests.' : 'nothing waiting for review.'); return; }
    for (const r of rows) console.log(`${r.status === 'open' ? '-' : '✓'} ${r.id}  ${r.path} — ${r.why}`);
    return;
  }

  if (sub === 'done') {
    const id = a._[1] && resolveId(a._[1], 'R-', 'review');
    if (!id) die(`no review '${a._[1] || ''}' in this repository`);
    emit(id, 'reviewed', { note: a.note || '' });
    console.log(`${id} reviewed.`);
    return;
  }

  if (!a.why) die('review requires --why: what should they look at, and what do you need from them?');
  const file = normalizePath(sub);
  let about = null;
  if (a.about) {
    about = resolveId(a.about, 'G-', 'goal') || resolveId(a.about, 'T-', 'ticket');
    if (!about) die(`no goal or ticket '${a.about}' in this repository`);
  }
  // Asking again about the same file refreshes the request rather than listing it twice.
  const existing = openReviews().find((r) => r.path === file);
  const id = existing ? existing.id : newId('R-');
  emit(id, 'request', { path: file, why: String(a.why).trim(), about });
  console.log(`${id} waiting for the user's review: ${file}`);
}

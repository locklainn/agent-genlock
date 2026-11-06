/**
 * For the Assistant: one session that looks across every project, so you can get status and pass
 * things on without moving between them. Only that session is given where the projects are, so a
 * project's own agent cannot read the others or tell them what to do.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { die } from './store.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const TIERS = ['today', 'soon', 'later'];

function where() {
  const store = process.env.GENLOCK_APP_PROJECTS;
  const channels = process.env.GENLOCK_APP_CHANNELS;
  if (!store || !channels) die('this only works in the Assistant, in the Genlock app');
  return { store, channels };
}

const readJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

function load() {
  const { store, channels } = where();
  const projects = readJSON(store, []).map((p) => ({ ...p, name: path.basename(p.path) }))
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  const open = readJSON(path.join(path.dirname(store), 'sessions.json'), {}).open || [];
  return { projects, open, channels };
}

function snapshot(folder) {
  try {
    const env = { ...process.env };
    delete env.GENLOCK_SESSION;
    return JSON.parse(execFileSync(process.execPath, [CLI, 'snapshot'], {
      cwd: folder, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, maxBuffer: 64 * 1024 * 1024,
    }));
  } catch { return null; }
}

const SESSION_WORDS = { working: 'working now', waiting: 'NEEDS THE USER', done: 'finished its last turn' };

function sessionLines(project, open, channels) {
  const mine = open.filter((o) => o.project === project.path && !o.spawn);
  if (!mine.length) return ['  session: none open'];
  return mine.flatMap((o) => {
    const state = o.token ? readJSON(path.join(channels, o.token, 'state.json'), null) : null;
    if (!state) return ['  session: open, nothing reported yet'];
    const ago = Math.round((Date.now() - state.at) / 60000);
    const lines = [`  session: ${SESSION_WORDS[state.state] || state.state}, ${ago < 1 ? 'just now' : `${ago}m ago`}`];
    if (state.message) lines.push(`  it last said: ${state.message}`);
    return lines;
  });
}

function workLines(snap) {
  if (!snap) return ['  could not read its goals and tasks'];
  if (!snap.initialized) return ['  goals and tasks: not set up in Genlock'];
  const when = (r) => (r.due ? `  [due ${r.due}${r.days_until < 0 ? ', OVERDUE' : ''}]` : '');
  const L = [];
  const goals = snap.goals.filter((g) => g.rank).sort((a, b) => a.rank - b.rank);
  for (const g of goals.slice(0, 3)) {
    L.push(`  goal #${g.rank}: ${g.title} (${g.status}, ${g.progress.done} of ${g.progress.total} tasks)${when(g)}`);
  }
  if (goals.length > 3) L.push(`  ...and ${goals.length - 3} more goals`);
  const tasks = snap.tickets.filter((t) => t.rank).sort((a, b) => a.rank - b.rank);
  for (const t of tasks.slice(0, 3)) {
    L.push(`  task #${t.rank}: ${t.title} (${t.status})${when(t)}${t.latest ? `\n    latest: ${t.latest.text}` : ''}`);
  }
  if (tasks.length > 3) L.push(`  ...and ${tasks.length - 3} more tasks`);
  for (const t of tasks) if (t.blocked_reason) L.push(`  BLOCKED ${t.title}: ${t.blocked_reason}`);
  for (const q of snap.questions_for_user) L.push(`  WAITING ON THE USER: ${q.text}`);
  const reviews = snap.reviews.filter((r) => r.status === 'open' || r.status === 'to_review').length;
  if (reviews) L.push(`  ${reviews} to review`);
  return L;
}

export function cmdOverview() {
  const { projects, open, channels } = load();
  if (!projects.length) { console.log('No projects in Genlock yet.'); return; }
  for (const p of projects) {
    if (!fs.existsSync(p.path)) continue;
    console.log(`${p.name} (${p.tier})`);
    for (const line of [...sessionLines(p, open, channels), ...workLines(snapshot(p.path))]) console.log(line);
    console.log('');
  }
}

/** Passes a message to a project's open session. The app types it in. */
export function cmdTell(a) {
  const { projects, open, channels } = load();
  const name = a._[0];
  const text = a._.slice(1).join(' ').trim();
  if (!name || !text) die('tell needs a project and a message:  genlock tell PROJECT "..."');
  const hits = projects.filter((p) => p.name.toLowerCase() === String(name).toLowerCase());
  if (!hits.length) die(`no project called '${name}'. These exist: ${projects.map((p) => p.name).join(', ')}`);
  if (hits.length > 1) die(`several projects are called '${name}': ${hits.map((p) => p.path).join(', ')}`);
  const session = open.find((o) => o.project === hits[0].path && !o.spawn && o.token);
  if (!session) die(`${hits[0].name} has no session open, so nothing was sent. Ask the user to open it.`);
  const folder = path.join(channels, session.token);
  fs.mkdirSync(folder, { recursive: true });
  const file = `tell-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
  fs.writeFileSync(path.join(folder, `${file}.tmp`), JSON.stringify({ text }));
  fs.renameSync(path.join(folder, `${file}.tmp`), path.join(folder, file));
  console.log(`Passed to ${hits[0].name}. Its answer shows in \`genlock overview\` once it has replied.`);
}

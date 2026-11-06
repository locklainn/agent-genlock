/**
 * For the Assistant: one session that looks across every project, so you can get status and pass
 * things on without moving between them. Only that session is given where the projects are, so a
 * project's own agent cannot read the others or tell them what to do.
 *
 * Everything printed here stays in the Assistant's context for the rest of its conversation, so
 * this prints as little as it can: a short block per project, and only for projects that changed
 * since it last looked. Detail on one project is there to ask for.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { die, identity } from './store.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const TIERS = ['today', 'soon', 'later'];
const SOON_DAYS = 7;
// A transcript this big suggests a long conversation. It is a rough signal, since the file also
// holds what compaction has already dropped, so it only ever prompts a judgement.
const LONG_TRANSCRIPT_BYTES = 800 * 1024;
const clip = (text, max) => { const t = String(text).replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

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
    const lines = [`  session: ${SESSION_WORDS[state.state] || state.state}`];
    if (state.message) lines.push(`  it last said: ${clip(state.message, 160)}`);
    return lines;
  });
}

/** The least that still says what needs the user and what is on top. */
function briefLines(snap) {
  if (!snap) return ['  could not read its goals and tasks'];
  if (!snap.initialized) return [];
  const L = [];
  const goals = snap.goals.filter((g) => g.rank).sort((a, b) => a.rank - b.rank);
  const tasks = snap.tickets.filter((t) => t.rank).sort((a, b) => a.rank - b.rank);
  const top = goals.find((g) => g.status === 'active');
  if (top) L.push(`  top goal: ${clip(top.title, 80)} (${goals.length} open)`);
  if (tasks[0]) L.push(`  top task: ${clip(tasks[0].title, 80)} (${tasks.length} open)`);
  const blocked = tasks.filter((t) => t.blocked_reason);
  if (blocked.length) L.push(`  BLOCKED: ${blocked.length}, first: ${clip(blocked[0].title, 80)}`);
  const dated = [...goals, ...tasks].filter((r) => r.due && r.days_until <= SOON_DAYS).sort((a, b) => a.days_until - b.days_until);
  if (dated.length) {
    const d = dated[0];
    L.push(`  DUE: ${clip(d.title, 60)}, ${d.days_until < 0 ? `overdue by ${-d.days_until}d` : `in ${d.days_until}d`}${dated.length > 1 ? ` (+${dated.length - 1} more)` : ''}`);
  }
  const asks = snap.questions_for_user;
  if (asks.length) L.push(`  WAITING ON THE USER: ${asks.length}, newest: ${clip(asks[asks.length - 1].text, 110)}`);
  return L;
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

const seenFile = () => path.join(path.dirname(where().store), 'assistant-seen.json');

export function cmdOverview(a = { _: [] }) {
  const { projects, open, channels } = load();
  if (!projects.length) { console.log('No projects in Genlock yet.'); return; }
  const present = projects.filter((p) => fs.existsSync(p.path));

  // One project, in full.
  if (a._[0]) {
    const p = present.find((x) => x.name.toLowerCase() === String(a._[0]).toLowerCase());
    if (!p) die(`no project called '${a._[0]}'. These exist: ${present.map((x) => x.name).join(', ')}`);
    console.log(`${p.name} (${p.tier})`);
    for (const line of [...sessionLines(p, open, channels), ...workLines(snapshot(p.path))]) console.log(line);
    return;
  }

  // "Unchanged" only means something to the conversation that saw it. A new one gets everything.
  const last = readJSON(seenFile(), {});
  const seen = a.all || last.conversation !== identity() ? {} : (last.blocks || {});
  const now = {};
  const changed = [];
  const same = [];
  const idle = [];
  for (const p of present) {
    const lines = [...sessionLines(p, open, channels), ...briefLines(snapshot(p.path))];
    const block = lines.join('\n');
    now[p.name] = block;
    if (seen[p.name] === block) same.push(p.name);
    else if (block === '  session: none open') idle.push(p.name);
    else changed.push(`${p.name} (${p.tier})\n${block}`);
  }
  fs.writeFileSync(seenFile(), JSON.stringify({ conversation: identity(), blocks: now }));
  if (changed.length) console.log(changed.join('\n\n'));
  else console.log('Nothing has changed since you last looked.');
  if (idle.length) console.log(`\nNo session and nothing tracked: ${idle.join(', ')}`);
  if (same.length) console.log(`\nUnchanged: ${same.join(', ')}`);
  if (conversationIsLong()) console.log('\nThis conversation has grown long. At the next natural break, save what matters and clear.');
}

const ownTranscript = () => {
  const dir = process.env.GENLOCK_APP_CHANNEL;
  return dir ? readJSON(path.join(dir, 'state.json'), {}).transcript : null;
};

function conversationIsLong() {
  try { return fs.statSync(ownTranscript()).size >= LONG_TRANSCRIPT_BYTES; } catch { return false; }
}

const assistantHome = () => path.join(path.dirname(where().store), 'Assistant');
const notesDir = () => path.join(assistantHome(), 'notes');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function saveNote(title, body) {
  fs.mkdirSync(notesDir(), { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const file = path.join(notesDir(), `${stamp()}-${slug || 'note'}.md`);
  fs.writeFileSync(file, `# ${title}\n\n${body}\n`);
  return file;
}

/** Keeps something outside the conversation, to read back whenever it is needed. */
export function cmdRemember(a) {
  const [title, ...rest] = a._;
  const body = rest.join(' ').trim();
  if (!title || !body) die('remember needs a title and what to keep:  genlock remember "TITLE" "WHAT TO KEEP"');
  where();
  console.log(`Saved: ${path.basename(saveNote(String(title).trim(), body))}`);
}

export function cmdRemembered(a) {
  where();
  const files = fs.existsSync(notesDir()) ? fs.readdirSync(notesDir()).filter((f) => f.endsWith('.md')).sort() : [];
  const word = a._.join(' ').trim().toLowerCase();
  if (!word) {
    if (!files.length) { console.log('Nothing saved yet.'); return; }
    for (const f of files) console.log(`${f.slice(0, 10)}  ${fs.readFileSync(path.join(notesDir(), f), 'utf8').split('\n')[0].replace(/^# /, '')}`);
    return;
  }
  const hits = files.map((f) => fs.readFileSync(path.join(notesDir(), f), 'utf8')).filter((t) => t.toLowerCase().includes(word));
  console.log(hits.length ? hits.join('\n---\n') : `Nothing saved mentions '${word}'.`);
}

/** Asks the app to start this session fresh when its turn ends, carrying only the handoff. */
export function cmdClearContext(a) {
  where();
  const handoff = a._.join(' ').trim();
  if (!handoff) die('clear-context needs a handoff to yourself:  genlock clear-context "WHERE THINGS STAND"');
  const dir = process.env.GENLOCK_APP_CHANNEL;
  if (!dir) die('this only works in the Assistant, in the Genlock app');
  let copy = '';
  const transcript = ownTranscript();
  if (transcript && fs.existsSync(transcript)) {
    const kept = path.join(assistantHome(), 'conversations');
    fs.mkdirSync(kept, { recursive: true });
    const target = path.join(kept, `${stamp()}.jsonl`);
    fs.copyFileSync(transcript, target);
    copy = `\n\nThe full earlier conversation is saved at ${target}. Search it if you need something the handoff leaves out.`;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'clear-context.tmp'), JSON.stringify({ handoff: handoff + copy }));
  fs.renameSync(path.join(dir, 'clear-context.tmp'), path.join(dir, 'clear-context.json'));
  console.log('You will start fresh when this turn ends and the user has heard your reply. Finish your reply as normal.');
}

// What the Assistant may do to a project's records. Finishing work is left to whoever did it,
// because `done` has to be proved by them.
const AT_VERBS = new Set(['rank', 'due', 'new', 'update', 'note', 'link', 'decide', 'goal', 'ask', 'answer', 'list', 'show', 'orient', 'inbox']);

/** Runs a genlock command in one project's folder, so its records stay current from anywhere. */
export function runAt(argv) {
  const { projects } = load();
  const [name, verb, ...rest] = argv;
  if (!name || !verb) die('at needs a project and a command:  genlock at PROJECT rank T-ABC --to 1');
  const hits = projects.filter((p) => p.name.toLowerCase() === name.toLowerCase());
  if (hits.length !== 1) die(`no single project called '${name}'. These exist: ${projects.map((p) => p.name).join(', ')}`);
  if (!AT_VERBS.has(verb)) die(`at does not run '${verb}'. It runs: ${[...AT_VERBS].join(' ')}`);
  if (!fs.existsSync(path.join(hits[0].path, '.genlock', 'records'))) {
    die(`${hits[0].name} is not set up in Genlock, so it has no goals or tasks to change`);
  }
  const r = spawnSync(process.execPath, [CLI, verb, ...rest], { cwd: hits[0].path, stdio: 'inherit' });
  process.exit(r.status ?? 1);
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

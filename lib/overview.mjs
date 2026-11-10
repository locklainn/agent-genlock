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
import { cmdCloseSelf, cmdOpenOwn } from './continuity.mjs';
import { RELAY_ACTIONS, writeGrant } from './relay.mjs';
import { markAwaiting, owe } from './relayback.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const TIERS = ['today', 'soon', 'later'];
// A transcript this big suggests a long conversation. It is a rough signal, since the file also
// holds what compaction has already dropped, so it only ever prompts a judgement.
const LONG_TRANSCRIPT_BYTES = 800 * 1024;
// The Assistant should stay near-stateless, so its own bar is far lower.
const ASSISTANT_LONG_BYTES = 250 * 1024;
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

/** The session slot a project's Subassistant runs in. It coordinates; it is never told work itself. */
export const SUB_SLOT = 'assistant';
const isSub = (o) => o.slot === SUB_SLOT;
/** In a Subassistant: the one project it works in. Unset in Tally. */
const scope = () => process.env.GENLOCK_APP_SCOPE || null;

/**
 * Projects and the sessions working in them. A Subassistant sees only its own project, and nobody
 * sees Subassistants as sessions to tell, sweep or close: `subs` lists them for delegation.
 */
function load() {
  const { store, channels } = where();
  let projects = readJSON(store, []).map((p) => ({ ...p, name: path.basename(p.path) }))
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  const all = projects;
  if (scope()) projects = projects.filter((p) => path.resolve(p.path) === path.resolve(scope()));
  const every = readJSON(path.join(path.dirname(store), 'sessions.json'), {}).open || [];
  const open = every.filter((o) => !isSub(o));
  const subs = every.filter((o) => isSub(o) && o.token);
  return { projects, all, open, subs, channels };
}

/** A Subassistant naming some other project is refused, so it never reaches outside its own. */
function guardScope(all, name) {
  if (!scope() || !name) return;
  const mineName = path.basename(scope()).toLowerCase();
  const other = all.find((p) => p.name.toLowerCase() === String(name).toLowerCase() && p.name.toLowerCase() !== mineName);
  if (other) die(`you work only in ${path.basename(scope())}, so nothing was done in ${other.name}. Other projects are Tally's: tell the user to ask there.`);
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

const COUNT_WORDS = { working: 'working', waiting: 'waiting on the user', done: 'finished', unknown: 'not reported yet' };

/** The tasks a session owns: by its conversation, or by the task it was opened on. */
function sessionTasks(o, state, snap, conversations = {}) {
  const convo = state?.session || o.spawn?.session || conversations[sessionKey(o)] || null;
  const owned = (snap?.tickets || []).filter((t) => (convo && t.owner === convo) || (o.spawn && t.id === o.spawn.ticket));
  return { convo, owned, open: owned.filter((t) => !FINISHED.has(t.status)) };
}

/** What a session is on, in a few words: its open task, or the one it finished. */
function taskName({ owned, open }) {
  const current = open.filter((t) => t.status === 'in_progress');
  const named = current.length ? current : open;
  if (named.length) return named.map((t) => `${t.short} (${clip(t.title, 60)})`).join(', ');
  if (owned.length) return `${owned.map((t) => t.short).join(', ')}, finished`;
  return 'no task recorded';
}

// Every open session is a session: the one the app opened first, an extra one, or one started from a
// task are listed the same way, each by what it is working on.
function sessionLines(project, open, channels, snap, conversations) {
  const mine = open.filter((o) => o.project === project.path);
  if (!mine.length) return ['  session: none open'];
  const counts = {};
  const lines = mine.flatMap((o) => {
    const state = o.token ? readJSON(path.join(channels, o.token, 'state.json'), null) : null;
    const key = state && COUNT_WORDS[state.state] ? state.state : 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    const doing = state ? SESSION_WORDS[state.state] || state.state : 'nothing reported yet';
    const L = [`  session on ${taskName(sessionTasks(o, state, snap, conversations))}: ${doing}`];
    if (state?.message) L.push(`    it last said: ${clip(state.message, 160)}`);
    return L;
  });
  const by = Object.keys(COUNT_WORDS).filter((k) => counts[k]).map((k) => `${counts[k]} ${COUNT_WORDS[k]}`).join(', ');
  return [`  ${mine.length} session${mine.length === 1 ? '' : 's'}: ${by}`, ...lines];
}

// Oldest first. The snapshot lists questions by id, and ids are random, so its last one is not the newest.
const byAsked = (snap) => [...snap.questions_for_user].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

const openReviews = (snap) => (snap.reviews || []).filter((r) => r.status === 'open');

function workLines(snap) {
  if (!snap) return ['  could not read its goals and tasks'];
  if (!snap.initialized) return ['  goals and tasks: not set up in Genlock'];
  const when = (r) => (r.due ? `  [due ${r.due}${r.days_until < 0 ? ', OVERDUE' : ''}]` : '');
  const L = [];
  const goals = snap.goals.filter((g) => g.rank).sort((a, b) => a.rank - b.rank);
  for (const g of goals.slice(0, 3)) {
    L.push(`  goal #${g.rank}: ${g.short}: ${g.title} (${g.status}, ${g.progress.done} of ${g.progress.total} tasks)${when(g)}`);
  }
  if (goals.length > 3) L.push(`  ...and ${goals.length - 3} more goals`);
  const tasks = snap.tickets.filter((t) => t.rank).sort((a, b) => a.rank - b.rank);
  for (const t of tasks.slice(0, 3)) {
    L.push(`  task #${t.rank}: ${t.short}: ${t.title} (${t.status})${when(t)}${t.latest ? `\n    latest: ${t.latest.text}` : ''}`);
  }
  if (tasks.length > 3) L.push(`  ...and ${tasks.length - 3} more tasks`);
  for (const t of tasks) if (t.blocked_reason) L.push(`  BLOCKED ${t.title}: ${t.blocked_reason}`);
  for (const q of byAsked(snap)) L.push(`  WAITING ON THE USER: ${q.text}`);
  const reviews = openReviews(snap).length;
  if (reviews) L.push(`  ${reviews} to review`);
  return L;
}

// Tally and each Subassistant keep their own: a Subassistant sees one project, and writing that
// over Tally's would file the project as already reported at Tally's next status.
const seenFile = () => path.join(path.dirname(where().store),
  scope() ? `assistant-seen-${path.basename(scope()).replace(/[^\w.-]+/g, '_')}.json` : 'assistant-seen.json');

export function cmdOverview(a = { _: [] }) {
  const { projects, open, channels } = load();
  if (!projects.length) { console.log('No projects in Genlock yet.'); return; }
  const conversations = readJSON(path.join(path.dirname(where().store), 'sessions.json'), {}).conversations || {};
  const present = projects.filter((p) => fs.existsSync(p.path));

  // One project, in full.
  if (a._[0]) {
    const p = present.find((x) => x.name.toLowerCase() === String(a._[0]).toLowerCase());
    if (!p) die(`no project called '${a._[0]}'. These exist: ${present.map((x) => x.name).join(', ')}`);
    console.log(`${p.name} (${p.tier})`);
    const snap = snapshot(p.path);
    for (const line of [...sessionLines(p, open, channels, snap, conversations), ...workLines(snap)]) console.log(line);
    return;
  }

  // The Assistant is meant to be near-stateless: a fresh conversation still needs everything, but
  // "what changed since the last status" survives the clear, because the user asks for exactly that.
  const last = readJSON(seenFile(), {});
  const fresh = a.all || last.conversation !== identity();
  const seen = last.blocks || {};
  const now = {};
  const changed = [];
  const same = [];
  const every = [];
  const idle = [];
  for (const p of present) {
    const snap = snapshot(p.path);
    // A status is what the open sessions are doing, and nothing else: no backlog, open tasks, due
    // dates, questions or in-progress work no session holds. overview PROJECT still has those.
    const lines = sessionLines(p, open, channels, snap, conversations);
    const block = lines.join('\n');
    now[p.name] = block;
    if (block === '  session: none open') { idle.push(p.name); continue; }
    const unchanged = seen[p.name] === block;
    if (unchanged) same.push(p.name);
    else changed.push(`${p.name} (${p.tier})\n${block}`);
    every.push(`${p.name} (${p.tier}), ${unchanged ? 'NO CHANGE since the last status' : 'CHANGED since the last status'}\n${block}`);
  }
  // Merged, so a project missing from this run (unreadable, or outside a Subassistant's scope)
  // keeps what was last reported for it rather than reading as new next time.
  fs.writeFileSync(seenFile(), JSON.stringify({ conversation: identity(), blocks: { ...seen, ...now } }));
  if (fresh) {
    // A status covers every project every time. Unchanged ones are said in a line, never skipped.
    console.log(every.length
      ? `Every project with a session open, and what each session is doing. Report each one in your status, changed or not; for one with no change, say so in a line. Report only these sessions: not backlog, open tasks or work no session holds.\n\n${every.join('\n\n')}`
      : 'No project has a session open.');
  } else {
    console.log(changed.length ? changed.join('\n\n') : 'Nothing has changed since you last looked.');
    if (same.length) console.log(`\nUnchanged: ${same.join(', ')}`);
  }
  if (idle.length) console.log(`\nNo session open: ${idle.join(', ')}`);
  if (conversationIsLong()) console.log('\nThis conversation has grown long. Record what matters and run genlock clear-context at the end of this turn.');
}

const ownTranscript = () => {
  const dir = process.env.GENLOCK_APP_CHANNEL;
  return dir ? readJSON(path.join(dir, 'state.json'), {}).transcript : null;
};

function conversationIsLong() {
  try { return fs.statSync(ownTranscript()).size >= ASSISTANT_LONG_BYTES; } catch { return false; }
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

/** What the Assistant is called, chosen by the user or by itself. */
export function cmdName(a) {
  where();
  const name = a._.join(' ').replace(/\s+/g, ' ').trim();
  if (!name) die('name needs one:  genlock name "NAME"');
  if (name.length > 24) die('a name is a word or two, 24 characters at most');
  fs.mkdirSync(assistantHome(), { recursive: true });
  fs.writeFileSync(path.join(assistantHome(), 'name.txt'), `${name}\n`);
  console.log(`Your name is ${name}. The app shows it from now on.`);
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
  const { projects, all } = load();
  const [name, verb, ...rest] = argv;
  guardScope(all, name);
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
  const { projects, all, open, subs, channels } = load();
  const name = a._[0];
  const text = a._.slice(1).join(' ').trim();
  if (!name || !text) die('tell needs a project or a task, and a message:  genlock tell PROJECT|TASK "..." [--session main|TASK|+slot]');
  guardScope(all, name);
  const { project, session } = resolveSession(projects, open, channels, name, a.session);
  // Tally delegates: a project with a Subassistant open gets the message through it.
  const sub = !scope() && subs.find((o) => o.project === project.path);
  if (sub) return delegate(sub, project, session, text, a, channels);
  const folder = path.join(channels, session.token);
  fs.mkdirSync(folder, { recursive: true });
  let message = text;
  if (a.relay_yes !== undefined) {
    const said = String(a.relay_yes === true ? '' : a.relay_yes).trim();
    if (!said) die('--relay-yes needs the user\'s own words, exactly as they said them:  --relay-yes "yes, swap it"');
    const action = a.for || null;
    if (action && !RELAY_ACTIONS.includes(action)) die(`--for is one of: ${RELAY_ACTIONS.join(', ')}`);
    writeGrant(folder, said, action);
    message += ` (TJ said yes through the Assistant: "${said}". Run ${action ? `genlock ${action === 'launch' ? 'spinoff launch' : 'swap'}` : 'the command'} with --relayed in place of --user-said.)`;
  } else if (a.for) die('--for goes with --relay-yes');
  const file = `tell-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
  fs.writeFileSync(path.join(folder, `${file}.tmp`), JSON.stringify({ text: message }));
  fs.renameSync(path.join(folder, `${file}.tmp`), path.join(folder, file));
  // From a Subassistant, the reply comes back to it rather than to Tally.
  const from = scope() ? process.env.GENLOCK_APP_CHANNEL || null : null;
  markAwaiting(folder, from);
  if (from) owe(from, session.token);
  console.log(`Passed to ${project.name} [${sessionName(session)}${sessionLabel(session, channels)}]. Its whole reply comes back to you once its turn ends.`);
}

/** Drops a message in a channel folder for the app to type in, written whole then renamed. */
function drop(folder, message) {
  fs.mkdirSync(folder, { recursive: true });
  const file = `tell-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
  fs.writeFileSync(path.join(folder, `${file}.tmp`), JSON.stringify({ text: message }));
  fs.renameSync(path.join(folder, `${file}.tmp`), path.join(folder, file));
}

/**
 * Tally's message for a session, handed to that project's Subassistant to pass on. The user's yes
 * travels as their words, for the Subassistant to relay in turn; Tally hears one combined reply.
 */
function delegate(sub, project, session, text, a, channels) {
  const target = `[${sessionName(session)}]${sessionLabel(session, channels)}`;
  let message = `[from Tally] For ${project.name} ${target}: ${text.replace(/[.\s]*$/, '.')}`;
  if (a.relay_yes !== undefined) {
    const said = String(a.relay_yes === true ? '' : a.relay_yes).trim();
    if (!said) die('--relay-yes needs the user\'s own words, exactly as they said them:  --relay-yes "yes, swap it"');
    if (a.for && !RELAY_ACTIONS.includes(a.for)) die(`--for is one of: ${RELAY_ACTIONS.join(', ')}`);
    message += ` TJ said yes through Tally: "${said}". Pass it on with --relay-yes "${said}"${a.for ? ` --for ${a.for}` : ''}.`;
  } else if (a.for) die('--for goes with --relay-yes');
  message += ' Pass it to that session with genlock tell, then reply once it has answered.';
  const folder = path.join(channels, sub.token);
  drop(folder, message);
  markAwaiting(folder);
  console.log(`Passed to ${project.name}'s Subassistant, for ${target}. Its combined reply comes back to you once that session has answered.`);
}

/* ---- the sweep: every session, and what would tidy it ---------------------------- */

// A session sitting this long with nothing open is probably finished with.
const IDLE_HOURS = 12;
const FINISHED = new Set(['done', 'abandoned']);

const conversationsOf = () => readJSON(path.join(path.dirname(where().store), 'sessions.json'), {}).conversations || {};
const snapOf = (p) => (fs.existsSync(path.join(p.path, '.genlock', 'records')) ? snapshot(p.path) : null);
const sameTask = (t, want) => t.id.toLowerCase() === want || String(t.short || '').toLowerCase() === want;

/** The open session that owns a task, preferring one whose copy of it is still open. */
function ownerOf(open, project, channels, snap, task) {
  const conversations = conversationsOf();
  const mine = open.filter((o) => o.project === project.path && o.token);
  const owns = (o) => sessionTasks(o, readJSON(path.join(channels, o.token, 'state.json'), null), snap, conversations).owned.some((t) => t.id === task.id);
  return mine.find(owns) || null;
}

/** " on TASK" for a session, from what it owns, or "" when it owns nothing. */
function sessionLabel(o, channels, snap) {
  const project = { path: o.project };
  const s = snap === undefined ? snapOf(project) : snap;
  const state = o.token ? readJSON(path.join(channels, o.token, 'state.json'), null) : null;
  const named = taskName(sessionTasks(o, state, s, conversationsOf()));
  return named === 'no task recorded' ? ', no task recorded' : ` on ${named}`;
}

/**
 * Which session a message is for. A project with one session open gets it; with several, the caller
 * must say which (main, +slot, or the task it is on), because guessing sends it to the wrong one.
 * A task id or short name in place of the project finds the project and the session that owns it.
 */
function resolveSession(projects, open, channels, name, which) {
  const want = String(name).toLowerCase();
  const hits = projects.filter((p) => p.name.toLowerCase() === want);
  if (hits.length > 1) die(`several projects are called '${name}': ${hits.map((p) => p.path).join(', ')}`);
  if (hits.length === 1) {
    const project = hits[0];
    const mine = open.filter((o) => o.project === project.path && o.token);
    if (!mine.length) die(`${project.name} has no session open, so nothing was sent. Start one with genlock open ${project.name}, or ask the user to.`);
    if (which) {
      const pick = String(which).toLowerCase();
      let session = mine.find((o) => sessionName(o).toLowerCase() === pick);
      if (!session) {
        const snap = snapOf(project);
        const task = (snap?.tickets || []).filter((t) => sameTask(t, pick));
        if (task.length === 1) session = ownerOf(open, project, channels, snap, task[0]);
      }
      if (!session) die(`${project.name} has no session called or working on '${which}', so nothing was sent. Open: ${listSessions(mine, channels, snapOf(project))}`);
      return { project, session };
    }
    if (mine.length === 1) return { project, session: mine[0] };
    die(`${project.name} has ${mine.length} sessions open, so nothing was sent: say which with --session, or name the task instead of the project. Open: ${listSessions(mine, channels, snapOf(project))}`);
  }
  // Not a project: a task, in whichever project has it.
  const found = [];
  for (const p of projects.filter((x) => fs.existsSync(x.path))) {
    const snap = snapOf(p);
    for (const t of (snap?.tickets || []).filter((x) => sameTask(x, want))) found.push({ project: p, snap, task: t });
  }
  if (!found.length) die(`no project or task called '${name}'. Projects: ${projects.map((p) => p.name).join(', ')}`);
  if (found.length > 1) die(`several tasks are called '${name}': ${found.map((f) => `${f.task.id} in ${f.project.name}`).join(', ')}. Use the id.`);
  const { project, snap, task } = found[0];
  const session = ownerOf(open, project, channels, snap, task);
  if (!session) die(`${task.short} (${task.id}) in ${project.name} has no open session working on it, so nothing was sent. Start one with genlock open ${project.name} --prompt "continue ${task.short}", or tell another of its sessions.`);
  return { project, session };
}

const listSessions = (mine, channels, snap) => mine.map((o) => `[${sessionName(o)}]${sessionLabel(o, channels, snap)}`).join('; ');

/** How a session is named to `close` and `tell --session`: main, its task, or +slot. */
const sessionName = (o) => (o.spawn?.ticket ? o.spawn.ticket : o.slot ? `+${o.slot}` : 'main');

function findSession(open, project, name) {
  const mine = open.filter((o) => o.project === project.path && o.token);
  const want = String(name || 'main').toLowerCase();
  return mine.find((o) => sessionName(o).toLowerCase() === want);
}

const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

const allProved = (t) => t.requirements.length > 0 && t.requirements.every((r) => r.state === 'met' || r.state === 'waived');

function sweepSession(o, snap, conversations, channels) {
  const dir = path.join(channels, o.token || '-');
  const state = o.token ? readJSON(path.join(dir, 'state.json'), null) : null;
  const { convo, owned, open } = sessionTasks(o, state, snap, conversations);
  const idle = state?.at ? Date.now() - state.at : null;
  const L = [];
  L.push(`  [${sessionName(o)}] session: ${state ? SESSION_WORDS[state.state] || state.state : 'nothing reported yet'}${idle != null ? `, last active ${ago(idle)} ago` : ''}`);
  if (state?.message) L.push(`    it last said: ${clip(state.message, 140)}`);
  for (const t of open) L.push(`    task ${t.short}: ${clip(t.title, 70)} (${t.status}, ${t.summary})`);
  if (!owned.length) L.push('    task: none recorded');
  const done = owned.filter((t) => FINISHED.has(t.status));
  if (done.length && !open.length) L.push(`    finished: ${done.map((t) => t.short).join(', ')}`);

  const S = [];
  const busy = state?.state === 'working';
  if (state?.state === 'waiting') S.push('it is waiting on the user: answer it');
  for (const t of open.filter(allProved)) S.push(`every requirement of ${t.short} is proved but it is still open: tell it to run genlock done ${t.id}`);
  if (!busy && owned.length && !open.length) S.push('its task is finished: it can close, once TJ says so');
  if (!busy && !owned.length && idle != null && idle >= IDLE_HOURS * 3600000) S.push(`idle ${ago(idle)} with no task: close it`);
  if (fs.existsSync(path.join(dir, 'swap.json'))) S.push('it has asked to swap for a fresh session, waiting for its turn to end');
  else if (!busy && state?.transcript) {
    try { if (fs.statSync(state.transcript).size >= LONG_TRANSCRIPT_BYTES) S.push('its conversation is long: if its work is not finished, it can swap to carry the same work on in a fresh session'); } catch { /* gone */ }
  }
  for (const s of S) L.push(`    SUGGEST: ${s}`);
  return { lines: L, convo, suggestions: S.length };
}

const sessionKey = (o) => (o.spawn ? `${o.project}#${o.spawn.ticket}` : o.slot ? `${o.project}#+${o.slot}` : o.project);

/** Every open session in every project, with what it is doing and what would tidy it up. */
export function cmdSweep(a = {}) {
  const { projects, open, channels } = load();
  const { store } = where();
  const conversations = readJSON(path.join(path.dirname(store), 'sessions.json'), {}).conversations || {};
  const present = projects.filter((p) => fs.existsSync(p.path));
  if (!present.length) { console.log('No projects in Genlock yet.'); return; }
  const quiet = [];
  let suggestions = 0;
  let sessions = 0;
  const blocks = [];
  for (const p of present) {
    const mine = open.filter((o) => o.project === p.path);
    const snap = fs.existsSync(path.join(p.path, '.genlock', 'records')) ? snapshot(p.path) : null;
    const L = [];
    const convos = new Set();
    for (const o of mine) {
      const s = sweepSession(o, snap, conversations, channels);
      L.push(...s.lines);
      if (s.convo) convos.add(s.convo);
      suggestions += s.suggestions;
      sessions += 1;
    }
    // Work left in progress by a session that is no longer open. Not part of a status, which covers
    // open sessions only; --orphans asks for it.
    const orphans = !a.orphans ? [] : (snap?.tickets || []).filter((t) => t.status === 'in_progress' && !convos.has(t.owner)
      && !mine.some((o) => o.spawn?.ticket === t.id));
    for (const t of orphans) {
      L.push(`  SUGGEST: ${t.short} (${clip(t.title, 60)}, ${t.summary}) is in progress but no open session owns it: `
        + (allProved(t) ? 'every requirement is proved, so reopen its session to run done' : 'reopen its session from Recently ended, or park it'));
      suggestions += 1;
    }
    if (!L.length) { quiet.push(p.name); continue; }
    blocks.push(`${p.name} (${p.tier})${mine.length ? '' : ', no session open'}\n${L.join('\n')}`);
  }
  console.log(blocks.length ? blocks.join('\n\n') : 'No sessions open.');
  if (quiet.length) console.log(`\nNo session open: ${quiet.join(', ')}`);
  console.log(`\n${sessions} session${sessions === 1 ? '' : 's'} open, ${suggestions} suggestion${suggestions === 1 ? '' : 's'}.`
    + (suggestions ? ' Nothing has been changed. Act on a suggestion only on the user\'s yes.' : ''));
}

/** Asks the app to open a fresh session on a project, beside any already open, starting on a prompt if given. */
export function cmdOpen(a) {
  // A project session opens sessions in its own project only; see cmdOpenOwn.
  if (!process.env.GENLOCK_APP_PROJECTS) return cmdOpenOwn(a);
  const { projects, all } = load();
  const own = process.env.GENLOCK_APP_CHANNEL;
  if (!own) die('open only works in the Assistant, in the Genlock app');
  const name = a._[0];
  guardScope(all, name);
  if (!name) die('open needs a project:  genlock open PROJECT [--prompt "WHAT TO START ON"]');
  const hits = projects.filter((p) => p.name.toLowerCase() === String(name).toLowerCase());
  if (!hits.length) die(`no project called '${name}'. These exist: ${projects.map((p) => p.name).join(', ')}`);
  if (hits.length > 1) die(`several projects are called '${name}': ${hits.map((p) => p.path).join(', ')}`);
  if (!fs.existsSync(hits[0].path)) die(`${hits[0].name} is not on disk at ${hits[0].path}, so no session was opened`);
  const prompt = a.prompt === undefined ? '' : String(a.prompt === true ? '' : a.prompt).trim();
  if (a.prompt !== undefined && !prompt) die('--prompt needs the text the session should start on');
  fs.mkdirSync(own, { recursive: true });
  const file = `open-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
  fs.writeFileSync(path.join(own, `${file}.tmp`), JSON.stringify({ project: hits[0].path, prompt: prompt || null, at: Date.now() }));
  fs.renameSync(path.join(own, `${file}.tmp`), path.join(own, file));
  console.log(`Opening a fresh session on ${hits[0].name}${prompt ? ', starting on your prompt' : ''}. It shows in genlock overview once it has started.`);
}

/** Asks the app to end one session. It goes to Recently ended, so it can be reopened. */
export function cmdClose(a) {
  if (a.self) return cmdCloseSelf(a);
  const { projects, all, open, channels } = load();
  const [name, which] = a._;
  guardScope(all, name);
  if (!name) die('close needs a project and a session:  genlock close PROJECT [main|T-ABC|+slot] --user-said ".."   (or, for this session itself: genlock close --self --user-said "..")');
  const said = String(a.user_said || '').trim();
  if (!said) die('close needs the user\'s yes for this session, in their words:  --user-said ".."  Ask first; nothing closes without them.');
  const hits = projects.filter((p) => p.name.toLowerCase() === String(name).toLowerCase());
  if (hits.length !== 1) die(`no single project called '${name}'. These exist: ${projects.map((p) => p.name).join(', ')}`);
  // A session by name (main, +slot, its task id) or by the short name of the task it is on.
  const o = which ? resolveSession(projects, open, channels, name, which).session : findSession(open, hits[0], which);
  if (!o) {
    const names = open.filter((x) => x.project === hits[0].path && x.token).map(sessionName);
    die(`${hits[0].name} has no session called '${which || 'main'}'.${names.length ? ` Open: ${names.join(', ')}` : ' It has none open.'}`);
  }
  const folder = path.join(channels, o.token);
  const state = readJSON(path.join(folder, 'state.json'), null);
  if (state?.state === 'working') die(`${hits[0].name} [${sessionName(o)}] is working right now, so it was not closed. Try again once its turn ends.`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'close.tmp'), JSON.stringify({ at: Date.now(), user_said: said, by: 'assistant' }));
  fs.renameSync(path.join(folder, 'close.tmp'), path.join(folder, 'close.json'));
  console.log(`Closing ${hits[0].name} [${sessionName(o)}]. Its conversation goes under Recently ended, so it can be reopened.`);
}

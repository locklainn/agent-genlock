/**
 * Spoken replies. When someone has dictated a message, the agent hands over a short spoken
 * version here, and whatever launched the session speaks it. The channel is a folder named
 * by GENLOCK_APP_CHANNEL, outside the repository, so voice writes nothing to the project.
 */

import { allowDecision } from './allow.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { die, identity, recordsDir } from './store.mjs';
import { allTickets, OPEN_STATES } from './tickets.mjs';
import { trackWaits } from './waits.mjs';
import { ackOf, awaitingFrom, awaitingKind, clearAwaiting, isAwaiting, paid, reportsUp, stillOwed, writeRelay } from './relayback.mjs';

// A relay names the Subassistant it is for; one with no `to` goes to Tally, as before.
const toWhom = (dir) => { const to = awaitingFrom(dir); return to ? { to } : {}; };

const channel = () => process.env.GENLOCK_APP_CHANNEL || null;
const pendingFile = (dir) => path.join(dir, 'pending');

export function cmdSay(a) {
  const text = a._.join(' ').trim();
  if (!text) die('say needs what to speak:  genlock say "the important part, in a sentence or two"');
  const dir = channel();
  if (!dir) { console.log('Nobody is listening: this session has no voice channel. Nothing was spoken.'); return; }
  fs.mkdirSync(dir, { recursive: true });
  const name = `say-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
  // Written whole and then renamed, so a reader can never pick up half a message.
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ text }));
  fs.renameSync(tmp, path.join(dir, name));
  fs.rmSync(pendingFile(dir), { force: true });
  console.log('Spoken.');
}

/**
 * A session names itself, so its tab and the phone say what it is for rather than "Session 2".
 * Written to its app channel beside state.json; the app and the phone bridge read it.
 */
export function cmdTitle(a) {
  const dir = channel();
  const clear = Boolean(a.clear);
  const title = a._.join(' ').replace(/\s+/g, ' ').trim();
  if (!clear && !title) die('title needs a name for this session:  genlock title "billing page"   (or genlock title --clear)');
  if (title.length > 40) die('a session title is two to four words, 40 characters at most');
  if (!dir) { console.log('This session is not running in the Genlock app, so nothing shows a title. Nothing was saved.'); return; }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'title.json');
  if (clear) { fs.rmSync(file, { force: true }); console.log('Title cleared: the tab shows its task again.'); return; }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ title, at: Date.now() }));
  fs.renameSync(tmp, file);
  console.log(`This session's tab now reads "${title}".`);
}

/**
 * Claude Code Stop hook, in a voice session. If the user dictated and the agent is about to
 * finish without answering aloud, send it back once. Everything else lets it stop, so this
 * can never trap a session.
 */
export function cmdVoiceCheck() {
  const dir = channel();
  if (!dir || !fs.existsSync(pendingFile(dir))) return;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* no input */ }
  fs.rmSync(pendingFile(dir), { force: true });
  if (input.stop_hook_active) return;
  process.stderr.write('The user dictated their last message and is listening. Before finishing, run: '
    + 'genlock say "the important part, in one to three spoken sentences". If there is more worth hearing, '
    + 'end by asking whether to go into more depth.\n');
  process.exit(2);
}

/**
 * Claude Code hook, in a session the Mac app started. Tells the app what the session is doing,
 * so it can say when an agent is finished or needs you. Whether it is waiting comes from
 * Claude Code itself rather than from guessing at what is on screen.
 */
export function cmdSessionState() {
  const dir = channel();
  if (!dir) return;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* no input */ }
  const event = input.hook_event_name;
  let state = null;
  let message = '';
  fs.mkdirSync(dir, { recursive: true });
  const background = trackWaits(dir, event, input);
  if (event === 'PreToolUse') {
    // The app's own hook: session commands never reach the auto-mode classifier, in any project.
    const allow = allowDecision(input);
    if (allow) process.stdout.write(JSON.stringify(allow));
    return;
  }
  if (event === 'UserPromptSubmit' || event === 'PostToolUse') state = 'working';
  if (event === 'Notification') {
    message = String(input.message || '');
    state = 'waiting';
    // Claude Code nudging that it has been sitting idle is not a question. A turn that already ended
    // stays as it was, with what it last said, and one that never reported ending (interrupted) has now.
    if (input.notification_type === 'idle_prompt' || /waiting for your input/i.test(message)) {
      let current = null;
      try { current = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).state; } catch { /* none yet */ }
      if (current === 'done' || current === 'waiting') return;
      state = 'done';
      message = '';
    } else if (reportsUp() && isAwaiting(dir)) {
      // Stuck on a permission prompt or a question mid-turn: whoever asked should hear, or nobody will.
      writeRelay(dir, 'waiting', message, toWhom(dir));
    }
  }
  if (event === 'Stop') {
    // A dictated turn with no spoken reply is sent back, so it is not finished yet.
    if (fs.existsSync(pendingFile(dir))) {
      fs.rmSync(pendingFile(dir), { force: true });
      if (!input.stop_hook_active) {
        process.stderr.write('The user dictated their last message and is listening. Before finishing, run: '
          + 'genlock say "the important part, in one to three spoken sentences". If there is more worth hearing, '
          + 'end by asking whether to go into more depth.\n');
        process.exit(2);
      }
    }
    state = 'done';
    const said = String(input.last_assistant_message || '');
    message = said.replace(/\s+/g, ' ').trim().slice(0, 160);
    // The Assistant passed this session something: its whole answer goes back, once.
    // A Subassistant Tally delegated to waits for the sessions it passed the message on to, so
    // Tally hears one combined reply rather than "passed it on".
    if (reportsUp() && isAwaiting(dir) && !(process.env.GENLOCK_APP_SCOPE && stillOwed(dir))) {
      const to = awaitingFrom(dir);
      const kind = awaitingKind(dir);
      writeRelay(dir, 'reply', said.trim() || '(it finished its turn without saying anything)', { ...toWhom(dir), ...(kind === 'do' ? { ack: ackOf(said) } : {}) });
      clearAwaiting(dir);
      if (to) paid(to, path.basename(dir));
    }
    // Its turn is over but a job it started is still running: not done, and not needing you either.
    if (background.length) state = 'holding';
  }
  if (!state) return;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ state, message, at: Date.now(), session: input.session_id, transcript: input.transcript_path }));
  fs.renameSync(tmp, path.join(dir, 'state.json'));
  if (event === 'UserPromptSubmit') fs.rmSync(nudgedFile(dir), { force: true });
  if (event === 'PostToolUse') nudgeUntracked(dir, input);
}

const nudgedFile = (dir) => path.join(dir, 'nudged');
const REAL_WORK = /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/;
const FILE_EDIT = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

/** Left in a session's channel while it edits files with no started task; genlock sweep marks it. */
export const UNTRACKED_FILE = 'untracked.json';

/**
 * Agents almost always work under a started task, because the sprint report is built from
 * completed tasks: work done outside one never shows up. A goal is optional, a task is not.
 * The first real change of a turn with no started task tells the agent, out of sight of the
 * user, to open or start one; each file edit also leaves a mark that genlock sweep shows,
 * cleared once the session starts a task. Never for the Assistant, which works across projects.
 */
function nudgeUntracked(dir, input) {
  try {
    if (process.env.GENLOCK_APP_PROJECTS) return;
    const tool = input.tool_name || '';
    if (!REAL_WORK.test(tool)) return;
    if (!fs.existsSync(recordsDir())) return;
    const me = new Set([input.session_id, identity()].filter(Boolean));
    if (!me.size) return;
    // Checked before the genlock skip, so `genlock start` itself clears the mark.
    const mark = path.join(dir, UNTRACKED_FILE);
    if (allTickets().some((t) => t.status === 'in_progress' && me.has(t.owner))) { fs.rmSync(mark, { force: true }); return; }
    if (tool === 'Bash' && /(^|[;&|]\s*)(\S*\/)?genlock(\.mjs)?\b/.test(String(input.tool_input?.command || ''))) return;
    if (FILE_EDIT.test(tool)) {
      let prior = null;
      try { prior = JSON.parse(fs.readFileSync(mark, 'utf8')); } catch { /* first one */ }
      const file = input.tool_input?.file_path || input.tool_input?.notebook_path || null;
      fs.writeFileSync(`${mark}.tmp`, JSON.stringify({ since: prior?.since || Date.now(), at: Date.now(), edits: (prior?.edits || 0) + 1, file, session: input.session_id || null }));
      fs.renameSync(`${mark}.tmp`, mark);
    }
    if (fs.existsSync(nudgedFile(dir))) return;
    fs.writeFileSync(nudgedFile(dir), '');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'You are changing files with no started task. Almost all work belongs under a task, because the '
          + 'sprint report is built from completed tasks; a goal is optional for odd work, a task is not. Before going further, '
          + 'open one (genlock new "TITLE" --short "NAME" -r .. -c .., then genlock start ID) or start one you already have '
          + '(genlock continue, then genlock start ID). Until then genlock sweep marks this session as working with no task. '
          + 'Do not mention this reminder to the user.',
      },
    }));
  } catch { /* fail silent: a reminder must never disturb the session */ }
}

/**
 * Claude Code status line, in a session the Mac app started. Prints nothing, so the app's
 * terminals keep that row for work: the app shows the usage itself, from usage.json beside
 * the session channels. The user's own status line command still runs on the same input,
 * with its output dropped, so whatever it records keeps being recorded.
 */
export function cmdStatusLine() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no input */ }
  let input = {};
  try { input = JSON.parse(raw); } catch { /* not JSON */ }
  const limits = input.rate_limits || {};
  const dir = channel();
  if (dir && (limits.five_hour || limits.seven_day)) {
    const pick = (l) => (l ? { used: l.used_percentage ?? null, resetsAt: l.resets_at ?? null } : null);
    const base = path.dirname(dir);
    fs.mkdirSync(base, { recursive: true });
    const tmp = path.join(base, `usage.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), session: pick(limits.five_hour), weekly: pick(limits.seven_day) }));
    fs.renameSync(tmp, path.join(base, 'usage.json'));
  }
  const own = ownStatusLine();
  if (own) spawnSync('/bin/sh', ['-c', own], { input: raw, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
}

/** The status line command in the user's own settings, unless it is this one. */
function ownStatusLine() {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    const cmd = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).statusLine?.command;
    return typeof cmd === 'string' && cmd.trim() && !/\bstatus-line\b/.test(cmd) ? cmd : null;
  } catch { return null; }
}

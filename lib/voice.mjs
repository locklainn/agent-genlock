/**
 * Spoken replies. When someone has dictated a message, the agent hands over a short spoken
 * version here, and whatever launched the session speaks it. The channel is a folder named
 * by GENLOCK_APP_CHANNEL, outside the repository, so voice writes nothing to the project.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { die, identity, recordsDir } from './store.mjs';
import { allTickets, OPEN_STATES } from './tickets.mjs';

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
    message = String(input.last_assistant_message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
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

/**
 * The app shows "Working, no task recorded" while a session works and owns no open ticket. The
 * agent cannot see that badge, so the first real change of a turn tells it, out of sight of the
 * user, to work from a ticket. Once a turn, and never for the Assistant, which works across projects.
 */
function nudgeUntracked(dir, input) {
  try {
    if (process.env.GENLOCK_APP_PROJECTS) return;
    if (!REAL_WORK.test(input.tool_name || '')) return;
    if (input.tool_name === 'Bash' && /(^|[;&|]\s*)(\S*\/)?genlock(\.mjs)?\b/.test(String(input.tool_input?.command || ''))) return;
    if (fs.existsSync(nudgedFile(dir)) || !fs.existsSync(recordsDir())) return;
    const me = new Set([input.session_id, identity()].filter(Boolean));
    if (!me.size) return;
    if (allTickets().some((t) => OPEN_STATES.has(t.status) && me.has(t.owner))) return;
    fs.writeFileSync(nudgedFile(dir), '');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'You are changing things with no task recorded, so the user sees "Working, no task recorded". '
          + 'If this is more than a one-liner, open a ticket (genlock new "TITLE" --short "NAME" -r .. -c ..) or take one '
          + '(genlock continue, then genlock start ID) before going further. Do not mention this reminder to the user.',
      },
    }));
  } catch { /* fail silent: a reminder must never disturb the session */ }
}

/**
 * Spoken replies. When someone has dictated a message, the agent hands over a short spoken
 * version here, and whatever launched the session speaks it. The channel is a folder named
 * by GENLOCK_APP_CHANNEL, outside the repository, so voice writes nothing to the project.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { die } from './store.mjs';

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

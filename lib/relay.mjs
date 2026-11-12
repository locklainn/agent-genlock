/**
 * A yes the user gave the Assistant, passed on to one project session. On the phone the user
 * talks only to the Assistant, so swap and spinoff launch in a project session cannot wait for
 * a yes typed in that pane. `genlock tell PROJECT ".." --do --relay-yes "THEIR WORDS"`, which runs
 * only in the Assistant, leaves a grant in that session's own channel; the session's
 * `--relayed` reads it, and uses it up once the action has gone through.
 */
import fs from 'node:fs';
import path from 'node:path';
import { die } from './store.mjs';

const FILE = 'relay-yes.json';
export const RELAY_ACTIONS = ['swap', 'launch'];
// A yes is about the moment it was given. One left lying around for hours is not a yes to now.
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Leaves the user's yes for one session. Called by tell, in the Assistant. */
export function writeGrant(folder, userSaid, action) {
  fs.mkdirSync(folder, { recursive: true });
  const tmp = path.join(folder, `${FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ user_said: userSaid, for: action || 'any', at: Date.now() }));
  fs.renameSync(tmp, path.join(folder, FILE));
}

/**
 * The yes relayed to this session for ACTION, or a refusal. It is not used up here, so an
 * action that refuses for another reason (say, checkpoint gaps) can be run again.
 */
export function relayedYes(a, action) {
  if (String(a.user_said || '').trim()) die('pass either --user-said or --relayed, not both');
  const dir = process.env.GENLOCK_APP_CHANNEL;
  if (!dir) die('--relayed works only in a session in the Genlock app, for a yes the Assistant passed on. Ask the user here instead.');
  const file = path.join(dir, FILE);
  let g = null;
  try { g = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
  if (!g?.user_said) die('no yes has been relayed to this session by the Assistant, so nothing was done. Ask the user directly.');
  if (Date.now() - (g.at || 0) > MAX_AGE_MS) {
    fs.rmSync(file, { force: true });
    die('the yes the Assistant relayed is over two hours old, so it no longer counts. Ask the user again.');
  }
  if (g.for !== 'any' && g.for !== action) die(`the yes the Assistant relayed was for ${g.for}, not ${action}. Ask the user again.`);
  return { said: String(g.user_said), relayed_by: 'assistant', use: () => fs.rmSync(file, { force: true }) };
}

/** The user's yes for ACTION: typed with --user-said, or relayed with --relayed. */
export function yesFor(a, action, missing) {
  if (a.relayed) return relayedYes(a, action);
  const said = String(a.user_said || '').trim();
  if (!said) die(missing);
  return { said, relayed_by: null, use: () => {} };
}

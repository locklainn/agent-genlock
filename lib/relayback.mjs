/**
 * What a project session says back to the Assistant. On the phone the user talks only to the
 * Assistant, so a reply that stays in a project's pane never reaches them. When the Assistant
 * passes a session something with `tell`, that session is marked as owing a reply; at the end
 * of its turn its full final message is left in its own channel as relay-*.json, and so is any
 * question it asks the user. The app hands these to the Assistant together once it is idle.
 *
 * Only sessions the Assistant told something report replies, so work the user does directly in
 * a pane at the desk is not echoed to the Assistant turn by turn.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const AWAITING = 'awaiting-reply.json';
// The Assistant's context holds every relay for the rest of its conversation. A reply longer than
// this is cut, with a note, and the full text stays in the session.
export const MAX_RELAY_CHARS = 6000;

/**
 * Marks a session as owing a reply. Called by tell, in Tally or a project's Subassistant. `from` is
 * the sender's own channel folder, so the reply goes back to whoever asked; none means Tally.
 */
export function markAwaiting(folder, from = null) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, AWAITING), JSON.stringify(from ? { at: Date.now(), from } : { at: Date.now() }));
}

// A Subassistant holds its own reply to Tally until the sessions it told have answered. A marker
// older than this is from a session that went away, and stops holding.
const OWED_MS = 30 * 60 * 1000;

/** In the Subassistant's folder: session `token` owes it a reply. */
export function owe(from, token) {
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, `owed-${token}`), String(Date.now()));
}

/** That session answered: called by its own hook, with the folder its reply went to. */
export const paid = (to, token) => fs.rmSync(path.join(to, `owed-${token}`), { force: true });

/** Whether sessions this Subassistant told still owe it replies, so its own is not ready yet. */
export function stillOwed(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.startsWith('owed-')); } catch { return false; }
  return names.some((f) => {
    try { return Date.now() - Number(fs.readFileSync(path.join(dir, f), 'utf8')) < OWED_MS; } catch { return false; }
  });
}

/** Whose reply this session owes: the asking Subassistant's channel folder, or null for Tally. */
export function awaitingFrom(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, AWAITING), 'utf8')).from || null; } catch { return null; }
}

/**
 * Whether this session reports replies upward. Project sessions do, and so does a Subassistant
 * (GENLOCK_APP_SCOPE set), because Tally delegates to it. Only Tally, at the top, does not.
 */
export const reportsUp = () => !process.env.GENLOCK_APP_PROJECTS || !!process.env.GENLOCK_APP_SCOPE;

export const isAwaiting = (dir) => fs.existsSync(path.join(dir, AWAITING));
export const clearAwaiting = (dir) => fs.rmSync(path.join(dir, AWAITING), { force: true });

/** Leaves one report for the Assistant in this session's channel, written whole then renamed. */
export function writeRelay(dir, kind, text, extra = {}) {
  let body = String(text || '').trim();
  if (!body) return;
  if (body.length > MAX_RELAY_CHARS) body = `${body.slice(0, MAX_RELAY_CHARS)}… (cut at ${MAX_RELAY_CHARS} characters; the rest is in that session)`;
  fs.mkdirSync(dir, { recursive: true });
  const name = `relay-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
  fs.writeFileSync(path.join(dir, `${name}.tmp`), JSON.stringify({ kind, text: body, at: Date.now(), ...extra }));
  fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, name));
}

/** In a project session or Subassistant the app started, not Tally: where its reports go, else null. */
export function projectChannel() {
  if (!reportsUp()) return null;
  return process.env.GENLOCK_APP_CHANNEL || null;
}

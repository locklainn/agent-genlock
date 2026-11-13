/**
 * How many sessions a project may have open at once, and how many it has. Every way an agent opens
 * a session checks this: open --prompt, the Assistant's open, and spinoff launch. The app checks it
 * again when it opens one, so a request that slipped past (an older genlock, a race) is still held.
 * A handoff or swap replaces the session that asks, so it never counts against the cap. The cap is
 * the only thing that stops an agent opening a session (TJ, 12 Nov 2026: blocked spawns cost more
 * time than they saved), and the user lifts it for one open with --over-cap "THEIR WORDS".
 */
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_CAP = Number(process.env.GENLOCK_SESSION_CAP) || 12;

const readJSON = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Sessions open on `project`, its own Assistant aside, counted from the app's channel folders. */
export function openSessions(project, channel = process.env.GENLOCK_APP_CHANNEL) {
  if (!channel) return 0;
  const base = path.dirname(channel);
  let open = 0;
  for (const name of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const o = readJSON(path.join(base, name, 'session.json'));
    if (o?.project && o.slot !== 'assistant' && real(o.project) === real(project)) open += 1;
  }
  return open;
}

/** The user's words lifting the cap for one open, from --over-cap, or null. */
export function overCap(a) {
  const v = a?.over_cap;
  return v === undefined || v === true ? null : String(v).trim() || null;
}

/** What to say at the cap: how many are open, and how the user lifts it. */
export function capMessage(name, open, what) {
  return `${name} already has ${open} sessions open, and the cap is ${SESSION_CAP}, so ${what} was not opened. `
    + 'Ask the user whether to go past it, and on their yes run the same command again with --over-cap "THEIR WORDS". '
    + 'Or hand a session\'s work over (genlock open --handoff), which never counts against the cap.';
}

/** The refusal to print when `project` is at the cap, or null when there is room or the user lifted it. */
export function capRefusal(project, what, channel = process.env.GENLOCK_APP_CHANNEL, approved = null) {
  if (approved) return null;
  const open = openSessions(project, channel);
  if (open < SESSION_CAP) return null;
  return capMessage(path.basename(project), open, what);
}

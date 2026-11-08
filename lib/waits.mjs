/**
 * What a session is blocked on that is not the agent thinking: a long command, a background task
 * still running after the turn ended, or a wait a script declares (a test queue, a lock). The app
 * shows it so a quiet session is not mistaken for a stuck one.
 *
 * Three kinds of file in the session's channel, each with one writer, so nothing races:
 *   wait-tool.json         the tool call in flight (PreToolUse writes it, every later event clears it)
 *   wait-bg.json           background tasks started this session and not yet reported finished
 *   wait-decl-<pid>.json   `genlock wait "LABEL"` from a script, keyed by the script's pid
 */
import fs from 'node:fs';
import path from 'node:path';

const toolFile = (dir) => path.join(dir, 'wait-tool.json');
const bgFile = (dir) => path.join(dir, 'wait-bg.json');
const declPrefix = 'wait-decl-';

function writeJSON(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** What a tool call is, in a few words: the Bash description the agent wrote, else the command. */
export function toolLabel(input) {
  const ti = input.tool_input || {};
  if (input.tool_name === 'Bash') {
    const text = String(ti.description || ti.command || 'a command').replace(/\s+/g, ' ').trim();
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  }
  return String(ti.description || input.tool_name || 'a tool');
}

/** The background task id a tool result started, if it started one. */
export function backgroundTaskId(response) {
  if (!response) return null;
  if (typeof response === 'object' && response.backgroundTaskId) return String(response.backgroundTaskId);
  const m = /\(ID: ([A-Za-z0-9_-]+)\)/.exec(typeof response === 'string' ? response : '');
  return m ? m[1] : null;
}

/** Task ids the transcript reports as finished (completed, failed, killed). Reads only its tail. */
export function finishedTasks(transcript) {
  const done = new Set();
  if (!transcript) return done;
  try {
    const size = fs.statSync(transcript).size;
    const fd = fs.openSync(transcript, 'r');
    const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    for (const m of buf.toString('utf8').matchAll(/<task-id>([A-Za-z0-9_-]+)<\/task-id>[\s\S]{0,600}?<status>(\w+)<\/status>/g)) {
      if (m[2] !== 'running') done.add(m[1]);
    }
  } catch { /* no transcript: nothing known finished */ }
  return done;
}

/**
 * Called from the session-state hook on every event. Returns the background tasks still running,
 * so Stop can report the session as holding rather than done.
 */
export function trackWaits(dir, event, input) {
  try {
    if (event === 'PreToolUse') {
      writeJSON(toolFile(dir), { label: toolLabel(input), since: Date.now() });
    } else {
      fs.rmSync(toolFile(dir), { force: true });
    }
    // A wait the agent declared itself lasts until its next move; a script's lasts while the script runs.
    if (event === 'PreToolUse' || event === 'UserPromptSubmit') clearDeadDeclared(dir);
    let bg = readJSON(bgFile(dir), []);
    const before = bg.length;
    if (event === 'PostToolUse') {
      const id = backgroundTaskId(input.tool_response);
      if (id && !bg.some((t) => t.id === id)) bg.push({ id, label: toolLabel(input), since: Date.now() });
    }
    if (bg.length && event !== 'PreToolUse') {
      const done = finishedTasks(input.transcript_path);
      bg = bg.filter((t) => !done.has(t.id));
    }
    if (bg.length !== before || event === 'PostToolUse') {
      if (bg.length) writeJSON(bgFile(dir), bg); else fs.rmSync(bgFile(dir), { force: true });
    }
    return bg;
  } catch { return []; }
}

function clearDeadDeclared(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(declPrefix) || !name.endsWith('.json')) continue;
    const pid = Number(name.slice(declPrefix.length, -5));
    if (!alive(pid)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 *   genlock wait "WHAT"            say what this session is waiting on (a queue, a lock, a job)
 *   genlock wait "WHAT" --queued   it is in line behind something else
 *   genlock wait --clear           the wait is over
 * Keyed by the calling process, so a script's waits are its own and end with it. Outside an app
 * session it does nothing and exits 0, so scripts can call it unconditionally.
 */
export function cmdWait(a) {
  const dir = process.env.GENLOCK_APP_CHANNEL;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${declPrefix}${process.ppid}.json`);
  if (a.clear) { fs.rmSync(file, { force: true }); return; }
  const label = a._.join(' ').trim();
  if (!label) {
    process.stderr.write('wait needs what it is waiting on:  genlock wait "build queue" [--queued]  |  genlock wait --clear\n');
    process.exit(1);
  }
  const kind = a.queued ? 'queued' : 'running';
  writeJSON(file, { label, kind, since: Date.now(), pid: process.ppid });
}

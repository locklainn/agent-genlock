// What the bridge knows about Genlock on this laptop: where the Assistant is, how to put a
// message into it, how to read its replies, and a status snapshot across projects.
// It only reads the Mac app's files and drops tell-*.json into a channel, which the app
// already types into the session's prompt (VoiceChannel.takeTells).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const genlockHome = () =>
  process.env.GENLOCK_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'Genlock');

const CLI = process.env.GENLOCK_CLI || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/genlock.mjs');

const readJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

export const PHONE_PREFIX = '[phone]';

/* ---- pairing ---------------------------------------------------------------------- */

export const pairingFile = () => path.join(genlockHome(), 'phone', 'pairing.json');

/** The key both sides show the relay. Derived, so the secret itself never leaves the laptop. */
export const relayKey = (secret) => createHmac('sha256', secret).update('genlock-relay-auth').digest('hex');

export function newPairing(relay) {
  const p = { relay: relay.replace(/\/$/, ''), room: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex'), created: Date.now() };
  fs.mkdirSync(path.dirname(pairingFile()), { recursive: true });
  fs.writeFileSync(pairingFile(), JSON.stringify(p, null, 2), { mode: 0o600 });
  return p;
}

export const loadPairing = () => readJSON(pairingFile(), null);

/** What the phone scans. */
export const pairingLink = (p) =>
  `genlock://pair?relay=${encodeURIComponent(p.relay)}&room=${p.room}&key=${relayKey(p.secret)}`;

export const roomURL = (p, role) => {
  const base = p.relay.replace(/^http/, 'ws');
  return `${base}/room/${p.room}?role=${role}&key=${relayKey(p.secret)}`;
};

/* ---- the Assistant ---------------------------------------------------------------- */

/** The Assistant's open session: its channel folder and transcript, or null when it is closed. */
export function findAssistant(home = genlockHome()) {
  const folder = path.join(home, 'Assistant');
  const open = readJSON(path.join(home, 'sessions.json'), {}).open || [];
  const entry = open.find((o) => o.project === folder && o.token);
  if (!entry) return null;
  const channel = path.join(home, 'voice', entry.token);
  const state = readJSON(path.join(channel, 'state.json'), {});
  let name = null;
  try { name = fs.readFileSync(path.join(folder, 'name.txt'), 'utf8').trim() || null; } catch {}
  return { channel, transcript: state.transcript || null, state: state.state || null, name };
}

/**
 * A status update starts the Assistant on a fresh conversation, so it never piles up context.
 * Matched on the words too, because the installed phone app sends the button as plain text.
 */
export const isStatusRequest = (text) => /^\s*status update\b/i.test(String(text || ''));

/** Where a message waits while the Assistant is closed. The Mac app starts it with what is here. */
export const assistantInbox = (home = genlockHome()) => path.join(home, 'phone', 'inbox');

/** Bring the Mac app up, in the background, so it can start the Assistant. A no-op when it is running. */
export function wakeApp() {
  if (process.env.GENLOCK_NO_WAKE) return;
  execFile('/usr/bin/pgrep', ['-x', 'Genlock'], (err) => {
    // pgrep exits 1 when nothing matched: the app is not running.
    if (err && err.code === 1) execFile('/usr/bin/open', ['-g', '-b', 'com.locklainn.genlock'], () => {});
  });
}

/**
 * Drop a message where the app types it into the Assistant's prompt. With the Assistant closed,
 * it waits in the inbox and the app is woken to start the Assistant on it: nothing is lost.
 * Returns the file's name and whether it was queued.
 */
export function deliverToAssistant(text, home = genlockHome(), { fresh = isStatusRequest(text), wake = wakeApp } = {}) {
  const a = findAssistant(home);
  const folder = a ? a.channel : assistantInbox(home);
  fs.mkdirSync(folder, { recursive: true });
  const name = `tell-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
  const body = JSON.stringify({ text: `${PHONE_PREFIX} ${text.replace(/\s+/g, ' ').trim()}`, ...(fresh ? { fresh: true } : {}) });
  fs.writeFileSync(path.join(folder, `${name}.tmp`), body);
  fs.renameSync(path.join(folder, `${name}.tmp`), path.join(folder, name));
  if (!a) wake();
  return { name, queued: !a, folder };
}

/** The same, returning only the file's name. */
export const sendToAssistant = (text, home, opts) => deliverToAssistant(text, home, opts).name;

/**
 * Where a prompt in the Assistant's conversation came from: 'phone' ([phone]), 'relay' (an automatic
 * report from the project sessions), 'notice' (a notice the Mac app typed in, such as a load alert),
 * 'laptop' (TJ typing or speaking at the laptop, or through Remote Control: anything else a person
 * wrote), or null for system text (task notifications, command output, a compaction summary). A long
 * message arrives wrapped in <pasted_content>; it is judged by what is inside.
 */
export function promptSource(raw) {
  let t = String(raw || '').trim();
  const wrapped = t.match(/^<pasted_content\b[^>]*>([\s\S]*?)(?:<\/pasted_content>)?$/);
  if (wrapped) t = wrapped[1].trim();
  if (!t) return null;
  if (t.startsWith(PHONE_PREFIX)) return 'phone';
  if (t.startsWith('[relay]')) return 'relay';
  if (MAC_NOTICE.test(t)) return 'notice';
  if (t.startsWith('<') || t.startsWith('This session is being continued from a previous conversation')) return null;
  return 'laptop';
}

const PHONE_PREFIX_RE = /^\[phone\]\s*/;
/** A notice the Mac app typed into the conversation (a load alert): not TJ's words, so not TJ at the laptop. */
const MAC_NOTICE = /^\[Load alert\b/;

/**
 * How long a conversation the Assistant has moved off is still read. A fresh start can end a
 * conversation whose last turn is still being written, and that reply must still reach the phone.
 */
const DRAIN_MS = 10 * 60 * 1000;
/** What the follower keeps per conversation. */
const READER_FIELDS = ['file', 'offset', 'partial', 'texts', 'lastSource', 'lastPrompt'];

/** A prompt as the phone shows it: unwrapped, without the [voice] tag. */
const shownPrompt = (raw) => String(raw || '').trim()
  .replace(/^<pasted_content\b[^>]*>([\s\S]*?)(?:<\/pasted_content>)?$/, '$1').trim()
  .replace(/^\[voice\]\s*/, '');

/**
 * Follows a Claude Code transcript and reports each finished Assistant turn, plus prompts typed
 * at the laptop. It starts at the end of the file: history is not replayed, only read for the
 * moved-on mark.
 * Call poll() on a timer; it re-resolves the transcript, since a swap or restart changes it.
 *
 * The moved-on mark (`mark`, ms) is when TJ last prompted the Assistant from the laptop or Remote
 * Control. Anything the phone holds from before it, the conversation has moved past.
 */
export class TranscriptFollower {
  constructor(resolve, { onReply, onPrompt, onPhone, onFiles, onMoved } = {}) {
    this.resolve = resolve;
    this.onReply = onReply || (() => {});
    this.onPrompt = onPrompt || (() => {});
    // A message from the phone reached the conversation: the Assistant is starting on it.
    this.onPhone = onPhone || (() => {});
    // The Assistant sent files with SendUserFile: they go to the phone too, not only to Remote Control.
    this.onFiles = onFiles || (() => {});
    // TJ prompted the Assistant somewhere other than the phone: { at } is the new mark.
    this.onMoved = onMoved || (() => {});
    this.file = null;
    this.offset = 0;
    this.partial = '';
    this.texts = new Map();
    /** Set when the Assistant is being started for a phone message: read its new conversation whole. */
    this.readNextFromStart = false;
    /** When TJ last prompted from the laptop or Remote Control, in ms; 0 when never seen. */
    this.mark = 0;
    /** Where the latest prompt came from: the reply that follows answers it. */
    this.lastSource = null;
    /**
     * What began the turn now running, for the phone's YOU SAID: { source, turn, text } for TJ's own
     * words (the phone or the laptop), null for a turn that began on an event (a relay report, an
     * alert, a task notification), which answers nothing he said.
     */
    this.lastPrompt = null;
    this.quiet = false;
    /** Conversations the Assistant moved off, still read until `until` for a turn they were finishing. */
    this.draining = [];
  }

  reader() { return Object.fromEntries(READER_FIELDS.map((k) => [k, this[k]])); }

  /** Reads a conversation the Assistant has moved off, with its own offset and turn state. */
  drain(now = Date.now()) {
    this.draining = this.draining.filter((r) => r.until > now && fs.existsSync(r.file));
    for (const r of this.draining) {
      const saved = this.reader();
      Object.assign(this, r);
      try { this.read(r.file); } finally { Object.assign(r, this.reader()); Object.assign(this, saved); }
    }
  }

  poll() {
    const file = this.resolve();
    this.drain();
    // No conversation to name (a fresh start removed the channel before the next one began):
    // the one being followed may still be finishing its turn, so it is read as before.
    if (!file) { if (this.file) this.read(this.file); return; }
    if (file !== this.file) {
      if (this.file) {
        // The tail written so far is read now; anything after it, while it drains.
        this.read(this.file);
        this.draining.push({ ...this.reader(), until: Date.now() + DRAIN_MS });
      }
      // Back on a conversation still draining: carry on from where it was, so nothing repeats.
      const back = this.draining.find((r) => r.file === file);
      if (back) {
        this.draining = this.draining.filter((r) => r !== back);
        const { until, ...state } = back;
        Object.assign(this, state);
        this.read(file);
        return;
      }
      // A new conversation is read from its start, an existing one from where it is now.
      const fresh = this.file !== null;
      this.file = file;
      this.partial = '';
      this.texts = new Map();
      // So is the first one after the bridge queued a message for a closed Assistant: the
      // Assistant it starts may have written its first turn before this poll saw the file.
      const fromStart = fresh || this.readNextFromStart;
      this.readNextFromStart = false;
      this.offset = 0;
      if (!fromStart) {
        // History is read without reporting anything, for the mark and the latest prompt's source.
        this.quiet = true;
        try { this.read(file); } finally { this.quiet = false; }
        return;
      }
    }
    this.read(file);
  }

  read(file) {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;
    const lines = (this.partial + buf.toString('utf8')).split('\n');
    this.partial = lines.pop();
    for (const line of lines) if (line.trim()) this.line(line);
  }

  prompt(raw, e, { queued = false } = {}) {
    const source = promptSource(raw);
    // A new turn begun by an event clears YOU SAID; an event folded into a turn already running leaves it.
    if (!queued) this.lastPrompt = null;
    if (!source) return;
    this.lastSource = source;
    const words = shownPrompt(raw).replace(PHONE_PREFIX_RE, '').replace(/^\[voice\]\s*/, '').trim();
    this.lastPrompt = source === 'phone' || source === 'laptop'
      ? { source, turn: e.uuid, text: words }
      : (queued ? this.lastPrompt : null);
    if (source === 'laptop') {
      const at = Date.parse(e.timestamp) || Date.now();
      const moved = at > this.mark;
      if (moved) this.mark = at;
      if (this.quiet) return;
      this.onPrompt({ text: shownPrompt(raw), turn: e.uuid, at });
      if (moved) this.onMoved({ at });
    } else if (source === 'phone' && !this.quiet) this.onPhone({ turn: e.uuid });
  }

  line(raw) {
    let e;
    try { e = JSON.parse(raw); } catch { return; }
    if (e.isSidechain) return;
    const m = e.message;
    if (e.type === 'user' && m && typeof m.content === 'string' && !e.isMeta) return this.prompt(m.content, e);
    // A message sent while the Assistant was mid-turn is folded into that turn as a queued command,
    // not a user prompt. It has still reached the Assistant, so the phone hears it was picked up.
    if (e.type === 'attachment' && e.attachment?.type === 'queued_command') return this.prompt(e.attachment.prompt, e, { queued: true });
    if (e.type !== 'assistant' || !m || !Array.isArray(m.content)) return;
    const id = m.id || e.uuid;
    const got = this.texts.get(id) || [];
    for (const c of m.content) {
      if (c.type === 'text' && c.text?.trim()) got.push(c.text.trim());
      if (!this.quiet && c.type === 'tool_use' && c.name === 'SendUserFile' && Array.isArray(c.input?.files) && c.input.files.length) {
        this.onFiles({ files: c.input.files.map(String), caption: c.input.caption ? String(c.input.caption) : undefined, turn: c.id });
      }
    }
    this.texts.set(id, got);
    if (m.stop_reason === 'end_turn') {
      this.texts.delete(id);
      // answers: where the prompt this turn answers came from; prompt: that prompt, or null for an event.
      if (got.length && !this.quiet) this.onReply({ text: got.join('\n\n'), turn: id, answers: this.lastSource, prompt: this.lastPrompt });
    }
  }
}

/* ---- grid ------------------------------------------------------------------------- */

export const gridFile = (home = genlockHome()) => path.join(home, 'phone', 'grid.json');

/**
 * The Mac grid view as the app last wrote it (app/Sources/GenlockApp/PhoneGrid.swift): the phone
 * shows this rather than working the state out again. `mac: 'closed'` when the app that wrote it
 * is no longer running, so the phone never shows a dead app's sessions as live.
 */
export function readGrid(home = genlockHome(), alive = pidAlive) {
  let raw, mtime;
  try { raw = fs.readFileSync(gridFile(home), 'utf8'); mtime = fs.statSync(gridFile(home)).mtimeMs; } catch { return { mac: 'closed', projects: [], sig: 'none' }; }
  let g;
  try { g = JSON.parse(raw); } catch { return { mac: 'closed', projects: [], sig: 'bad' }; }
  if (!g.pid || !alive(g.pid)) return { mac: 'closed', projects: [], sig: `dead-${g.pid}` };
  return { mac: 'open', projects: g.projects || [], at: mtime, sig: raw };
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* ---- status ----------------------------------------------------------------------- */

const TIERS = ['today', 'week', 'someday'];
const sessionName = (o) => (o.spawn?.ticket ? o.spawn.ticket : o.slot ? `+${o.slot}` : 'main');
const SUB_SLOT = 'assistant';
/** A goal or task's name as the Mac shows it: its short name in words, else its title. */
const heading = (x) => {
  if (!x.short || x.named === false) return x.title;
  const w = String(x.short).replace(/-/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
};
// Status is only what the open sessions are doing (TJ's rule): a task counts while an open session holds
// it, or for RECENT_MS after one finished it (at most RECENT_MAX per project). No backlog, open tasks,
// due dates or in-progress work no session holds.
const RECENT_MS = 24 * 3600 * 1000;
const RECENT_MAX = 5;
const ENDED = new Set(['done', 'abandoned', 'dropped']);
const taskOrder = (t) => (t.status === 'in_progress' ? 0 : t.status === 'done' ? 2 : 1);
const goalOrder = ({ g, ts }) => (ts.some((t) => t.status === 'in_progress') ? 0 : g.status === 'done' ? 2 : 1);
const clip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

function snapshot(folder) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.GENLOCK_SESSION;
    execFile(process.execPath, [CLI, 'snapshot'], { cwd: folder, env, timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

/**
 * The sprint report across every project, exactly as `genlock sprint --all --json` gives it to
 * the Mac app, so the phone and the Mac can never disagree. OPTS picks the range: { sprint }
 * (current, previous, -N or a date inside it) or { from, to } (YYYY-MM-DD).
 */
export function sprintReport(home = genlockHome(), opts = {}) {
  const args = [CLI, 'sprint', '--all', '--json'];
  if (opts.from) args.push('--from', String(opts.from), '--to', String(opts.to || opts.from));
  else if (opts.sprint !== undefined && opts.sprint !== null) args.push('--sprint', String(opts.sprint));
  const env = { ...process.env, GENLOCK_HOME: home };
  delete env.GENLOCK_SESSION;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { env, timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) return reject(new Error(String(errOut || err.message).trim()));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

/** Every project, its open sessions and what they are on, what waits on the user, what is due. */
export async function status(home = genlockHome(), snap = snapshot, now = Date.now()) {
  const projects = readJSON(path.join(home, 'projects.json'), [])
    .filter((p) => p.path && fs.existsSync(p.path))
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  const open = readJSON(path.join(home, 'sessions.json'), {}).open || [];
  const out = await Promise.all(projects.map(async (p) => {
    const s = await snap(p.path);
    const tickets = s?.tickets || [];
    const mine = open.filter((o) => o.project === p.path && o.token).map((o) => ({ o, st: readJSON(path.join(home, 'voice', o.token, 'state.json'), {}) }));
    const goals = (s?.goals || []).filter((g) => g.rank).sort((a, b) => a.rank - b.rank);
    const order = { in_progress: 0, blocked: 1, open: 2 };
    // A session's task, the way the Mac finds it: the ticket it was spawned on, else the open task
    // its agent owns, in progress first. Its title follows the Mac's tab: that task, else the project.
    const plain = mine.filter(({ o }) => !o.spawn && o.slot !== SUB_SLOT);
    const workOf = ({ o, st }) => {
      const agents = new Set([st.session, o.spawn?.session].filter(Boolean));
      const first = (t) => (t.id === o.spawn?.ticket ? 0 : 1);
      return tickets.filter((t) => t.id === o.spawn?.ticket || (t.rank && t.owner && agents.has(t.owner)))
        .sort((a, b) => first(a) - first(b) || (order[a.status] ?? 3) - (order[b.status] ?? 3) || (a.rank || 1e9) - (b.rank || 1e9))[0] || null;
    };
    const titleOf = (m, work) => {
      if (m.o.slot === SUB_SLOT) return 'Assistant';
      // The name the agent gave this session with genlock title, ahead of its task, as on the Mac.
      const named = String(readJSON(path.join(home, 'voice', m.o.token, 'title.json'), {}).title || '').trim();
      if (named) return named;
      if (work) return heading(work);
      if (!m.o.spawn && !m.o.slot && plain.length === 1) return path.basename(p.path);
      return `Session ${plain.indexOf(m) + 1}`;
    };
    const holder = (t) => {
      const hit = mine.find((m) => workOf(m)?.id === t.id);
      // Named without its task, which would only repeat the line it sits under.
      return hit ? titleOf(hit, null) : null;
    };
    const taskView = (t) => ({
      name: clip(heading(t), 80), title: clip(t.short && t.named !== false ? `${t.short}: ${t.title}` : t.title, 140), status: t.status, proof: t.summary,
      latest: t.latest ? clip(t.latest.text, 300) : null, at: t.latest?.at || t.updated, who: holder(t),
    });
    const sessions = mine.map((m) => {
      const work = workOf(m);
      const g = work?.goal ? goals.find((x) => x.id === work.goal) || (s?.goals || []).find((x) => x.id === work.goal) : null;
      return {
        name: m.o.spawn?.ticket || sessionName(m.o),
        title: clip(titleOf(m, work), 80),
        state: m.st.state || 'starting',
        said: clip(String(m.st.message || '').replace(/\*\*|__|`/g, ''), 300),
        task: work ? clip(work.title, 120) : null,
        goal: g ? { title: clip(heading(g), 100), done: g.progress?.done || 0, total: g.progress?.total || 0 } : null,
        work: work ? taskView(work) : null,
      };
    });
    // Tasks view: what live sessions drive, grouped by goal.
    // A session holds the task it was spawned on and every open task its agent owns.
    const agents = new Set(mine.flatMap(({ o, st }) => [st.session, o.spawn?.session]).filter(Boolean));
    const spawned = new Set(mine.map(({ o }) => o.spawn?.ticket).filter(Boolean));
    const held = new Set(tickets.filter((t) => !ENDED.has(t.status)
      && (spawned.has(t.id) || (t.owner && agents.has(t.owner)) || mine.some((m) => workOf(m)?.id === t.id))).map((t) => t.id));
    const recent = (iso) => iso && now - Date.parse(iso) <= RECENT_MS;
    const moved = (t) => t.latest?.at || t.updated;
    const finished = (t) => t.closed || t.updated;
    const live = tickets.filter((t) => held.has(t.id));
    const theirs = (t) => spawned.has(t.id) || (t.owner && agents.has(t.owner));
    const doneLately = tickets.filter((t) => t.status === 'done' && theirs(t) && recent(finished(t)))
      .sort((a, b) => String(finished(b)).localeCompare(String(finished(a)))).slice(0, RECENT_MAX);
    const current = [...live, ...doneLately]
      .sort((a, b) => taskOrder(a) - taskOrder(b) || String(moved(b) || '').localeCompare(String(moved(a) || '')));
    const allGoals = s?.goals || [];
    const goalView = (g, ts) => ({ title: clip(heading(g), 100), status: g.status === 'done' ? 'done' : 'active',
      done: g.progress?.done || 0, total: g.progress?.total || 0, tasks: ts.map(taskView) });
    const goalTasks = allGoals
      .map((g) => ({ g, ts: current.filter((t) => t.goal === g.id) }))
      .filter(({ ts }) => ts.length)
      .sort((a, b) => goalOrder(a) - goalOrder(b) || (a.g.rank || 1e9) - (b.g.rank || 1e9))
      .map(({ g, ts }) => goalView(g, ts));
    const loose = current.filter((t) => !allGoals.some((g) => g.id === t.goal)).map(taskView);
    if (loose.length) goalTasks.push({ title: 'No goal', status: 'active', done: 0, total: 0, tasks: loose });
    return {
      name: path.basename(p.path),
      goals: goalTasks,
      tier: p.tier || null,
      sessions,
    };
  }));
  // Every project with a session open, every time, and no other.
  return out.filter((p) => p.sessions.length);
}

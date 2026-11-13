/**
 * The Genlock speaker: one process on the Mac that keeps the Kokoro model loaded and speaks any
 * project's text in that project's voice, a sentence at a time. Loading the model takes ~5s, so
 * the Mac app and the phone bridge both ask this one process rather than each loading their own,
 * and one engine is what guarantees one voice.
 *
 *   POST /speak  {text, root?|project?|voice?, format?: 'wav'|'m4a', speed?}
 *     -> NDJSON, one line per sentence as soon as it is made:
 *        {"i":0,"text":"..","voice":"bf_emma","format":"m4a","seconds":2.1,"audio":"<base64>"}
 *        and a last line {"done":true,"n":4}
 *   GET  /health -> {ok, pid, voices}
 *
 * It listens on 127.0.0.1 only, on a port it writes to ~/.genlock/voice/serve.json. A client that
 * finds none starts one detached. It exits after IDLE_MS without a request, to give back the memory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { home, makeEngine, engineKey, parseVoice, sentences, voiceLabel, wavBytes, defaultFor, ROSTER } from './voices.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
// Long: a cold start costs the first reply 10s or more, which is the pause a listener hears.
const IDLE_MS = Number(process.env.GENLOCK_SPEAKER_IDLE_MS) || 12 * 3600_000;
export const serveFile = () => path.join(home(), 'serve.json');
const hubFile = () => path.join(home(), 'hub.json');
/** Which code a speaker runs, by content. A speaker whose files change under it retires after
 *  the request it is on, so the next client starts the new code. Clients never kill a speaker:
 *  two copies of genlock (the app's and the repository's) would otherwise keep replacing each
 *  other's, and every replacement is a cold start a listener hears as a long pause. */
const buildOf = () => crypto.createHash('sha256').update(['speaker.mjs', 'voices.mjs']
  .map((f) => { try { return fs.readFileSync(path.join(path.dirname(CLI), '..', 'lib', f)); } catch { return ''; } }).join('\0')).digest('hex').slice(0, 12);
const BUILD = buildOf();
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ---- which voice ---------------------------------------------------------------------------

/** The voice for text that belongs to no project: set with `genlock voice set --hub`. */
export function hubVoice() {
  const h = readJSON(hubFile(), null);
  if (h?.parts) return { parts: h.parts, speed: h.speed || 1, how: 'hub' };
  return { parts: [[ROSTER[0], 1]], speed: 1, how: 'hub default' };
}
export function setHubVoice(parts, speed = 1) {
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(hubFile(), JSON.stringify({ parts, ...(speed !== 1 ? { speed } : {}), at: new Date().toISOString() }, null, 2));
}

function recordedVoice(root) {
  const f = path.join(root, '.genlock', 'records', 'project.jsonl');
  if (!fs.existsSync(f)) return null;
  let last = null;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"op":"voice"')) continue;
    try { const e = JSON.parse(line); if (e.op === 'voice' && Array.isArray(e.parts)) last = e; } catch { /* a damaged line is skipped */ }
  }
  return last && { parts: last.parts, speed: last.speed || 1, how: last.how };
}

/**
 * The voice recorded in ROOT's .genlock. A project with records but no voice yet is assigned one
 * the way `genlock voice` there would, and it is recorded, so it never moves after.
 */
export function voiceAt(root) {
  const seen = recordedVoice(root);
  if (seen) return seen;
  if (!fs.existsSync(path.join(root, '.genlock')) && !fs.existsSync(path.join(root, '.git'))) return null;
  spawnSync(process.execPath, [CLI, 'voice'], { cwd: root, stdio: 'ignore', env: { ...process.env, GENLOCK_TERMINAL: 'print' } });
  return recordedVoice(root);
}

/** A project's root from the name an item carries ("genlock", "ghostlight"): the Mac app's list. */
export function rootForProject(name) {
  if (!name) return null;
  const appHome = process.env.GENLOCK_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'Genlock');
  const roots = readJSON(path.join(appHome, 'projects.json'), []).map((p) => p.path).filter(Boolean);
  const want = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = (r) => path.basename(r).toLowerCase().replace(/[^a-z0-9]/g, '');
  return roots.find((r) => key(r) === want) || roots.find((r) => key(r).includes(want) || want.includes(key(r))) || null;
}

/** {parts, speed, how} for a request: an explicit voice, else the root's, else the project's, else the hub's. */
export function voiceFor({ voice, root, project } = {}) {
  if (voice) return { parts: parseVoice(voice), speed: 1, how: 'asked' };
  const r = root || rootForProject(project);
  return (r && voiceAt(r)) || hubVoice();
}

// ---- the server ----------------------------------------------------------------------------

/** Loaded engines by voice, the two most recent kept: a blend needs a table of its own. */
class Engines {
  constructor(keep = 3) { this.keep = keep; this.map = new Map(); }
  get(parts) {
    const k = engineKey(parts);
    let e = this.map.get(k);
    if (e) { this.map.delete(k); this.map.set(k, e); return e; }
    e = makeEngine(parts);
    this.map.set(k, e);
    while (this.map.size > this.keep) this.map.delete(this.map.keys().next().value);
    return e;
  }
}

function toM4a(wav) {
  const id = crypto.randomBytes(6).toString('hex');
  const src = path.join(os.tmpdir(), `genlock-say-${id}.wav`);
  const out = path.join(os.tmpdir(), `genlock-say-${id}.m4a`);
  try {
    fs.writeFileSync(src, wav);
    const r = spawnSync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '48000', src, out], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('afconvert failed');
    return fs.readFileSync(out);
  } finally { fs.rmSync(src, { force: true }); fs.rmSync(out, { force: true }); }
}

/** One line per clip made, so a late clip can be proved: how long it waited, how long it took,
 *  how much audio it holds, and the memory the Mac had at the time. ~/.genlock/voice/speaker.log */
export const clipLogFile = () => path.join(home(), 'speaker.log');
function swapUsedMB() {
  const r = spawnSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
  const m = /used = ([\d.]+)M/.exec(r.stdout || '');
  return m ? Math.round(+m[1]) : undefined;
}
function clipLog(rec) {
  try {
    const f = clipLogFile();
    if (fs.existsSync(f) && fs.statSync(f).size > 2e6) fs.renameSync(f, `${f}.1`);
    const line = { at: new Date().toISOString(), pid: process.pid, ...rec, rssMB: Math.round(process.memoryUsage().rss / 1e6), swapMB: swapUsedMB() };
    fs.appendFileSync(f, `${JSON.stringify(line)}\n`);
  } catch { /* the log never stops speech */ }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function serve({ port = 0, quiet = false } = {}) {
  // One speaker per machine: each holds about a gigabyte, and a second one only fights the first.
  const other = readJSON(serveFile(), null);
  if (other?.pid && other.pid !== process.pid && alive(other.pid)) { if (!quiet) console.log(`A speaker is already running (pid ${other.pid}).`); process.exit(0); }
  const engines = new Engines();
  let idle;
  // Round robin: each job's step makes one sentence and says whether it has more.
  const jobs = [];
  let busy = false;
  let leaving = null;
  const enqueue = (step) => { jobs.push(step); pump(); };
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (jobs.length) {
      const step = jobs.shift();
      let more = false;
      try { more = await step(); } catch (e) { log('step failed', e.message); }
      if (more) jobs.push(step);
    }
    busy = false;
    whenIdle();
  };
  // Leave only with nothing in hand, so a retiring speaker never drops a request it accepted.
  const whenIdle = () => {
    if (busy || jobs.length) return;
    if (!leaving && buildOf() !== BUILD) leaving = 'code changed';
    if (!leaving) return;
    log(leaving, 'exiting');
    server.close();
    const ours = readJSON(serveFile(), {}).pid === process.pid;
    cleanup();
    // A newer copy of the code starts now, so the next reply does not wait on a cold start.
    if (ours && leaving === 'code changed') spawn(process.execPath, [CLI, 'voice', 'serve', '--quiet'], { detached: true, stdio: 'ignore', env: process.env }).unref();
    setTimeout(() => process.exit(0), 100);
  };
  const log = (...a) => { if (!quiet) console.log(new Date().toISOString().slice(11, 19), ...a); };
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => { log('idle, exiting'); cleanup(); process.exit(0); }, IDLE_MS); };
  const cleanup = () => { if (readJSON(serveFile(), {}).pid === process.pid) fs.rmSync(serveFile(), { force: true }); };

  const server = http.createServer((req, res) => {
    touch();
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, voices: [...engines.map.keys()] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/speak') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let ask;
      try { ask = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end('not JSON'); return; }
      let voice;
      try { voice = voiceFor(ask); } catch (e) { res.writeHead(400); res.end(String(e.message)); return; }
      const format = ask.format === 'm4a' ? 'm4a' : 'wav';
      const speed = Number(ask.speed) > 0 ? Number(ask.speed) * (voice.speed || 1) : (voice.speed || 1);
      const said = sentences(ask.text || '');
      let gone = false;
      res.on('close', () => { gone = !res.writableFinished; });
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const asked = Date.now();
      const tag = String(ask.tag || ask.project || '').slice(0, 60);
      // Requests take turns a sentence at a time: the CPU is the limit, and a long reading on the
      // Mac must not hold the phone's next update past its wait (or the other way round).
      const label = voiceLabel(voice.parts);
      let i = 0; let load = 0; let engine;
      const finish = (line) => { try { res.end(`${JSON.stringify(line)}\n`); } catch { /* gone */ } };
      enqueue(async () => {
        try {
          if (gone) return false;
          if (!engine) { const t0 = Date.now(); engine = engines.get(voice.parts); load = Date.now() - t0; }
          if (i >= said.length) { finish({ done: true, n: said.length, voice: label }); log('spoke', said.length, 'sentences in', label); return false; }
          const t = Date.now();
          const a = await engine.generate(said[i], speed, voice.parts);
          const wav = wavBytes(a.samples, a.sampleRate);
          const audio = format === 'm4a' ? toM4a(wav) : wav;
          const seconds = +(a.samples.length / a.sampleRate).toFixed(2);
          res.write(`${JSON.stringify({ i, text: said[i], voice: label, format, seconds, audio: audio.toString('base64') })}\n`);
          clipLog({ tag, voice: label, i, n: said.length, chars: said[i].length, queuedMs: i ? undefined : t - asked - load, loadMs: i ? undefined : load, sinceAskMs: Date.now() - asked, makeMs: Date.now() - t, audioS: seconds });
          i++;
          return true;
        } catch (e) { log('speak failed', e.message); finish({ error: e.message }); return false; }
      });
    });
  });
  server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(serveFile(), JSON.stringify({ port: p, pid: process.pid, build: BUILD, at: new Date().toISOString() }, null, 2));
    log(`Genlock speaker on 127.0.0.1:${p}`);
    // Load both accents' engines now, between requests, so no reply waits on a load later.
    const warm = [[['af_heart', 1]], [['bf_emma', 1]]];
    for (const parts of warm) enqueue(async () => { try { engines.get(parts); } catch (e) { log('warm', e.message); } return false; });
    // Another speaker took serve.json (two clients started one at once): nobody can find this one,
    // so it would hold a gigabyte of model for nothing. Leave once the queue is empty.
    setInterval(() => {
      if (readJSON(serveFile(), {}).pid !== process.pid) { leaving = 'replaced,'; whenIdle(); }
    }, 60_000).unref();
    touch();
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });
  return server;
}

// ---- the client ----------------------------------------------------------------------------

// Generous: a speaker loading a new voice holds its thread for ~5s, and is still the one to use.
async function healthy(port, ms = 8000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

/** The speaker's port, starting it detached if none answers. Throws if it will not come up. */
export async function ensureSpeaker({ waitMs = 45_000 } = {}) {
  const until = Date.now() + waitMs;
  const lock = path.join(home(), 'starting.lock');
  for (;;) {
    const s = readJSON(serveFile(), null);
    if (s?.port && await healthy(s.port, 2000)) return s.port;
    // A live speaker that is slow to answer (loading, or the Mac is swapping) is waited for, never
    // replaced: starting a second one under memory pressure is what makes it slower still.
    const running = s?.pid && alive(s.pid);
    if (!running) {
      let mine = false;
      try { fs.mkdirSync(home(), { recursive: true }); fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); mine = true; } catch {
        // Someone else is starting one; a lock left by a crash is cleared after a minute.
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { force: true }); } catch { /* gone */ }
      }
      if (mine) {
        const child = spawn(process.execPath, [CLI, 'voice', 'serve', '--quiet'], { detached: true, stdio: 'ignore', env: process.env });
        child.unref();
        setTimeout(() => fs.rmSync(lock, { force: true }), 30_000).unref();
      }
    }
    if (Date.now() > until) throw new Error('The Genlock speaker did not answer in time. Is the voice installed? genlock voice install');
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Speak through the speaker; yields one clip per sentence {i, text, voice, format, seconds, audio: Buffer}. */
export async function* speak(ask, { signal } = {}) {
  const port = await ensureSpeaker();
  const r = await fetch(`http://127.0.0.1:${port}/speak`, { method: 'POST', body: JSON.stringify(ask), signal, headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`speaker said ${r.status}: ${await r.text()}`);
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.error) throw new Error(m.error);
      if (m.done) return;
      yield { ...m, audio: Buffer.from(m.audio, 'base64') };
    }
  }
}

export { defaultFor };

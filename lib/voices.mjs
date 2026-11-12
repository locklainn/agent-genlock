/**
 * The Genlock voice: Kokoro, an open-source neural voice, run by sherpa-onnx. Every project has
 * a voice of its own, like a person who runs it. A voice never changes underneath anyone:
 *
 *  - The engine's files are pinned by sha256. A file that does not match is refused, never
 *    spoken through, because a different file is a different voice.
 *  - A project's voice is a record in its .genlock, so it travels with the repository. Set it
 *    with `genlock voice set`; until then the first use assigns one from the project's identity
 *    and records that, so a later change to the roster cannot move it.
 *
 * The engine lives in ~/.genlock/voice, outside every repository and outside the npm package,
 * which stays dependency-free: `genlock voice install` fetches it once.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { die, emit, git, readEvents, repoRoot } from './store.mjs';

export const ENGINE = {
  // 2.x dropped espeak-ng, and with it every word not in the lexicon is skipped in silence
  // ("Wildcard", "README"). 1.13.8 still falls back to espeak-ng for them.
  sherpa: 'sherpa-onnx-node@1.13.8',
  model: 'kokoro-multi-lang-v1_0',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2',
  tarball: '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4',
  files: {
    'model.onnx': 'b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11',
    'voices.bin': '1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29',
    'tokens.txt': '6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425',
    'lexicon-us-en.txt': '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14',
    'lexicon-gb-en.txt': 'c4cbb37316f62210dff52718a7afcaae24f50c032cc75ab47ae67b831d1049e7',
    // A folder: how words missing from the lexicon are pronounced. Hashed as path + bytes of each file.
    'espeak-ng-data/': '943056ae19b95f4577774d23af002151a2ed396964f39693edc9f10941ba2c1d',
  },
};

/** The order of speakers in voices.bin, fixed by the pinned file. */
export const SPEAKERS = ('af_alloy,af_aoede,af_bella,af_heart,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky,'
  + 'am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa,'
  + 'bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis,'
  + 'ef_dora,em_alex,ff_siwis,hf_alpha,hf_beta,hm_omega,hm_psi,if_sara,im_nicola,'
  + 'jf_alpha,jf_gongitsune,jf_nezumi,jf_tebukuro,jm_kumo,pf_dora,pm_alex,pm_santa,'
  + 'zf_xiaobei,zf_xiaoni,zf_xiaoxiao,zf_xiaoyi,zm_yunjian,zm_yunxi,zm_yunxia,zm_yunyang,em_santa').split(',');
export const ENGLISH = SPEAKERS.filter((s) => /^[ab][fm]_/.test(s));
const STYLE = 510 * 256; // floats per voice
const SPARE = SPEAKERS.indexOf('em_santa'); // a blend is spoken from this slot of a private copy

/**
 * The voices a project can be assigned when nobody has chosen one. A project's assignment is
 * recorded on first use, so editing this list later moves no project that already has a voice.
 */
// TJ, 2026-11-12: not bm_fable; af_nicole "is a bit dramatic ... telling a story", so she is only
// for a project that sets her on purpose.
export const ROSTER = ['af_heart', 'af_bella', 'af_sarah', 'am_michael', 'am_fenrir', 'am_puck',
  'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis'];

export const home = () => process.env.GENLOCK_VOICE_HOME || path.join(os.homedir(), '.genlock', 'voice');
const modelDir = () => path.join(home(), ENGINE.model);

// ---- what a voice is -----------------------------------------------------------------------

/** "bf_emma" or "bf_emma:0.6,af_heart:0.4" -> [[name, weight], ...], weights summing to 1. */
export function parseVoice(spec) {
  const parts = String(spec).split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [name, w] = p.split(':');
    if (!SPEAKERS.includes(name)) die(`no voice called '${name}'. \`genlock voice list\` shows them.`);
    const weight = w === undefined ? 1 : Number(w);
    if (!(weight > 0)) die(`'${p}': a weight is a number above 0, like bf_emma:0.6`);
    return [name, weight];
  });
  if (!parts.length) die('a voice is a name like bf_emma, or a blend like bf_emma:0.6,af_heart:0.4');
  if (new Set(parts.map((p) => p[0])).size !== parts.length) die('a blend names each voice once');
  const total = parts.reduce((s, p) => s + p[1], 0);
  return parts.map(([n, w]) => [n, Math.round((w / total) * 1000) / 1000]);
}
export const voiceLabel = (parts) => parts.length === 1 ? parts[0][0] : parts.map(([n, w]) => `${n}:${w}`).join(',');

/** British spelling-to-sound for a voice that is mostly British, American otherwise. */
const accent = (parts) => [...parts].sort((a, b) => b[1] - a[1])[0][0].startsWith('b') ? 'gb' : 'us';

// ---- which voice a project has -------------------------------------------------------------

/** Stable across clones, renames and machines: the repository's first commit, else its folder. */
export function projectKey(root = repoRoot()) {
  const line = String(git(['rev-list', '--max-parents=0', 'HEAD'], root) || '').trim().split('\n').pop();
  return /^[0-9a-f]{40}$/.test(line) ? `commit:${line}` : `folder:${path.basename(root)}`;
}
export const defaultFor = (key) => ROSTER[crypto.createHash('sha256').update(key).digest().readUInt32BE(0) % ROSTER.length];

/** The project's voice, assigning and recording one on first use unless told only to look. */
export function projectVoice({ record = true } = {}) {
  const last = readEvents('project').filter((e) => e.op === 'voice').pop();
  if (last) return { parts: last.parts, speed: last.speed || 1, how: last.how, at: last.at };
  const key = projectKey();
  const parts = [[defaultFor(key), 1]];
  if (record) emit('project', 'voice', { parts, how: 'assigned', key });
  return { parts, speed: 1, how: record ? 'assigned' : 'would be assigned', key };
}

// ---- the engine ----------------------------------------------------------------------------

const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
function sha256(file) {
  const h = crypto.createHash('sha256');
  if (!fs.statSync(file).isDirectory()) return h.update(fs.readFileSync(file)).digest('hex');
  for (const f of walk(file).sort()) { h.update(`${path.relative(file, f)}\0`); h.update(fs.readFileSync(f)); }
  return h.digest('hex');
}

/**
 * Refuses unless every pinned file is present and unchanged. The model is 300 MB, so it is
 * hashed in full once and then trusted while its size and mtime match that check.
 */
export function verify() {
  const dir = modelDir();
  if (!fs.existsSync(dir)) die('The Genlock voice is not installed on this machine. Run: genlock voice install');
  const stampFile = path.join(home(), 'verified.json');
  let stamp = {};
  try { stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { /* none yet */ }
  const bad = [];
  let changed = false;
  for (const [name, want] of Object.entries(ENGINE.files)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { bad.push(`${name} is missing`); continue; }
    const st = fs.statSync(file);
    const seen = stamp[name];
    if (name === 'model.onnx' && seen && seen.size === st.size && seen.mtimeMs === st.mtimeMs && seen.sha === want) continue;
    const got = sha256(file);
    if (got !== want) { bad.push(`${name} has sha256 ${got.slice(0, 12)}.., pinned ${want.slice(0, 12)}..`); continue; }
    stamp[name] = { size: st.size, mtimeMs: st.mtimeMs, sha: got }; changed = true;
  }
  if (bad.length) {
    die(`The Genlock voice files do not match the pinned ones, so nothing was spoken (a different file is a different voice):\n  ${bad.join('\n  ')}\nReinstall them: genlock voice install --force`);
  }
  if (changed) fs.writeFileSync(stampFile, JSON.stringify(stamp, null, 2));
  return dir;
}

function engineVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(home(), 'engine', 'node_modules', 'sherpa-onnx-node', 'package.json'), 'utf8')).version; } catch { return null; }
}

function loadSherpa() {
  const want = ENGINE.sherpa.split('@').pop();
  if (engineVersion() !== want) die(`The voice engine here is ${engineVersion() || 'missing'}, pinned ${want}. Run: genlock voice install`);
  const req = createRequire(path.join(home(), 'engine', 'package.json'));
  try { return req('sherpa-onnx-node'); } catch (e) { die(`The voice engine did not load (${e.message.split('\n')[0]}). Run: genlock voice install --force`); }
}

/** A voices table with the blend in the spare slot, cached by the blend it holds. */
function blendTable(dir, parts) {
  const id = crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
  const out = path.join(home(), 'blends', `${id}.bin`);
  if (fs.existsSync(out)) return out;
  const buf = fs.readFileSync(path.join(dir, 'voices.bin'));
  const table = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const mix = new Float32Array(STYLE);
  for (const [name, w] of parts) {
    const v = table.subarray(SPEAKERS.indexOf(name) * STYLE, (SPEAKERS.indexOf(name) + 1) * STYLE);
    for (let i = 0; i < STYLE; i++) mix[i] += w * v[i];
  }
  table.set(mix, SPARE * STYLE);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.tmp`, Buffer.from(table.buffer));
  fs.renameSync(`${out}.tmp`, out);
  return out;
}

/** Text the model can read: numbers become words, markup and paths are dropped. */
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export function numberWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  for (const [size, word] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= size) return `${numberWords(Math.floor(n / size))} ${word}${n % size ? ` ${numberWords(n % size)}` : ''}`;
  }
  return String(n);
}
export function speakable(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s*(->|→)\s*/g, ' to ')
    .replace(/[`*_#>|]/g, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/%/g, ' percent')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/\d+(?:\.\d+){2,}/g, (v) => v.split('.').map((d) => numberWords(Number(d))).join(' point '))
    .replace(/(\d+)\.(\d+)/g, (_, a, b) => `${numberWords(Number(a))} point ${[...b].map((d) => ONES[d]).join(' ')}`)
    .replace(/\d+/g, (d) => (d.length > 12 ? [...d].map((x) => ONES[x]).join(' ') : numberWords(Number(d))))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Speak TEXT in a voice; returns { samples: Float32Array, sampleRate }. */
export function synthesize(text, voice) {
  const dir = verify();
  const sherpa = loadSherpa();
  const parts = voice.parts;
  const single = parts.length === 1;
  const lex = accent(parts) === 'gb' ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt';
  const tts = new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: path.join(dir, 'model.onnx'),
        voices: single ? path.join(dir, 'voices.bin') : blendTable(dir, parts),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: path.join(dir, 'espeak-ng-data'),
        lexicon: path.join(dir, lex),
        lang: accent(parts) === 'gb' ? 'en-gb' : 'en-us',
      },
      numThreads: Math.max(1, Math.min(6, os.cpus().length - 1)),
      provider: 'cpu',
    },
    maxNumSentences: 1,
  });
  const sid = single ? SPEAKERS.indexOf(parts[0][0]) : SPARE;
  const a = tts.generate({ text: speakable(text), sid, speed: voice.speed || 1 });
  return { samples: a.samples, sampleRate: a.sampleRate, write: (file) => sherpa.writeWave(file, { samples: a.samples, sampleRate: a.sampleRate }) };
}

// ---- install -------------------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} failed:\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-5).join('\n')}`);
  return r.stdout;
}

function install(force) {
  const h = home();
  fs.mkdirSync(h, { recursive: true });
  const engine = path.join(h, 'engine');
  if (force || engineVersion() !== ENGINE.sherpa.split('@').pop()) {
    fs.mkdirSync(engine, { recursive: true });
    fs.writeFileSync(path.join(engine, 'package.json'), JSON.stringify({ name: 'genlock-voice-engine', private: true }, null, 2));
    console.log(`Installing ${ENGINE.sherpa} ...`);
    sh('npm', ['install', '--no-audit', '--no-fund', '--save-exact', ENGINE.sherpa], { cwd: engine });
  }
  if (force) { fs.rmSync(modelDir(), { recursive: true, force: true }); fs.rmSync(path.join(h, 'verified.json'), { force: true }); }
  if (!fs.existsSync(modelDir())) {
    const tar = path.join(h, `${ENGINE.model}.tar.bz2`);
    if (!fs.existsSync(tar) || sha256(tar) !== ENGINE.tarball) {
      console.log(`Downloading ${ENGINE.model} (about 300 MB) ...`);
      sh('curl', ['-sSfL', '-o', `${tar}.part`, ENGINE.url]);
      fs.renameSync(`${tar}.part`, tar);
    }
    const got = sha256(tar);
    if (got !== ENGINE.tarball) { fs.rmSync(tar); die(`The download's sha256 is ${got}, not the pinned ${ENGINE.tarball}. Nothing was installed.`); }
    sh('tar', ['xjf', tar, '-C', h]);
    fs.rmSync(tar);
  }
  verify();
  console.log(`The Genlock voice is installed in ${h} and matches the pinned files.`);
}

// ---- the command ---------------------------------------------------------------------------

const USAGE = `genlock voice                      this project's voice (assigned and recorded on first use)
genlock voice set NAME             give this project a voice: bf_emma, or a blend bf_emma:0.6,af_heart:0.4
       [--speed 1.1]
genlock voice list                 the voices there are, and the roster new projects are given from
genlock voice sample ["TEXT"]      write a wav of this project's voice  [--voice SPEC] [--out FILE]
genlock voice install [--force]    fetch the pinned engine into ~/.genlock/voice`;

export function cmdVoice(a) {
  const [sub, ...rest] = a._;
  if (!sub) {
    const v = projectVoice();
    const how = v.how === 'set' ? 'set' : 'assigned';
    console.log(`This project's voice: ${voiceLabel(v.parts)}${v.speed !== 1 ? ` at speed ${v.speed}` : ''} (${how}${v.at ? ` ${v.at.slice(0, 10)}` : ' just now'}).`);
    return;
  }
  if (sub === 'set') {
    const spec = rest.join(',');
    if (!spec) die('voice set needs a voice:  genlock voice set bf_emma   or   genlock voice set bf_emma:0.6,af_heart:0.4');
    const parts = parseVoice(spec);
    const speed = a.speed === undefined ? 1 : Number(a.speed);
    if (!(speed >= 0.5 && speed <= 2)) die('--speed is between 0.5 and 2');
    emit('project', 'voice', { parts, how: 'set', ...(speed !== 1 ? { speed } : {}) });
    console.log(`This project's voice is now ${voiceLabel(parts)}${speed !== 1 ? ` at speed ${speed}` : ''}. It is recorded in .genlock, so it stays until set again.`);
    return;
  }
  if (sub === 'list') {
    const groups = { 'American female': /^af_/, 'American male': /^am_/, 'British female': /^bf_/, 'British male': /^bm_/ };
    for (const [label, re] of Object.entries(groups)) console.log(`${label.padEnd(16)} ${ENGLISH.filter((s) => re.test(s)).join(' ')}`);
    console.log(`\nNew projects are given one of: ${ROSTER.join(' ')}`);
    return;
  }
  if (sub === 'sample') {
    const voice = a.voice ? { parts: parseVoice(a.voice), speed: Number(a.speed || 1) } : projectVoice();
    const text = rest.join(' ') || `Genlock here, in ${voiceLabel(voice.parts)}. Two tasks moved this morning, and 1 question is waiting for you.`;
    const out = path.resolve(a.out || path.join(os.tmpdir(), `genlock-voice-${Date.now()}.wav`));
    const t0 = Date.now();
    const audio = synthesize(text, voice);
    audio.write(out);
    console.log(`Wrote ${out}: ${(audio.samples.length / audio.sampleRate).toFixed(1)}s of ${voiceLabel(voice.parts)}, made in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    return;
  }
  if (sub === 'install') { install(Boolean(a.force)); return; }
  console.log(USAGE);
  if (sub !== 'help') process.exitCode = 1;
}

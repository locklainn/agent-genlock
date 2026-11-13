#!/usr/bin/env node
/* The Genlock voice: a project's voice must never move, and the engine must refuse files it did
   not pin rather than speak in another voice. Run: node tests/voices.mjs
   The engine itself is not needed: every refusal here happens before it would load. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROSTER, defaultFor, parseVoice, speakable, sentences, wavBytes, ENGINE } from '../lib/voices.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-voice-test-')));
const env = { ...process.env, HOME: ROOT, GENLOCK_TERMINAL: 'print', GENLOCK_AGENT_PID: '0', GENLOCK_SESSION: 'voice-test' };
delete env.GENLOCK_APP_CHANNEL; delete env.CLAUDE_CODE_SESSION_ID; delete env.GENLOCK_VOICE_HOME;
process.env.GENLOCK_VOICE_HOME = path.join(ROOT, 'voicehome'); process.env.GENLOCK_HOME = path.join(ROOT, 'apphome');
const { voiceAt, voiceFor, rootForProject, setHubVoice, hubVoice } = await import('../lib/speaker.mjs');

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(`${name}${detail ? `\n    ${detail}` : ''}`); };
const run = (cwd, args, extra = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...env, ...extra } });
  return { code: r.status, all: (r.stdout || '') + (r.stderr || '') };
};
function repo(name, commit = true) {
  const d = path.join(ROOT, name); fs.mkdirSync(d);
  const git = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  if (commit) { fs.writeFileSync(path.join(d, 'a'), name); git('add', 'a'); git('commit', '-qm', 'first'); }
  run(d, ['init']);
  return d;
}
const voiceOf = (out) => (out.match(/voice: (\S+)/) || [])[1];

// A project's voice is assigned on first use, recorded, and the same every time after.
const a = repo('alpha');
const first = run(a, ['voice']);
ok('voice: first use assigns a roster voice', first.code === 0 && ROSTER.includes(voiceOf(first.all)), first.all);
ok('voice: the first use says it was assigned just now', /assigned just now/.test(first.all), first.all);
const second = run(a, ['voice']);
ok('voice: a second call gives the same voice', voiceOf(second.all) === voiceOf(first.all), `${first.all} / ${second.all}`);
ok('voice: the second call reads the record rather than assigning again', /assigned \d{4}-\d\d-\d\d/.test(second.all), second.all);
const recs = fs.readFileSync(path.join(a, '.genlock', 'records', 'project.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"op":"voice"'));
ok('voice: exactly one assignment is recorded', recs.length === 1, recs.join('\n'));

// The record wins over the roster: rewrite the recorded voice and it is what is spoken.
fs.appendFileSync(path.join(a, '.genlock', 'records', 'project.jsonl'),
  `${JSON.stringify({ e: 'aaaaaaaaaaaa', at: '2099-01-01T00:00:00.000Z', by: 'x', op: 'voice', parts: [['am_onyx', 1]], how: 'assigned' })}\n`);
ok('voice: a recorded voice is used even when it is not on the roster', voiceOf(run(a, ['voice']).all) === 'am_onyx');

// Set, blend, refusals.
const b = repo('beta');
ok('voice set: records a chosen voice', run(b, ['voice', 'set', 'af_nicole']).code === 0 && voiceOf(run(b, ['voice']).all) === 'af_nicole');
run(b, ['voice', 'set', 'bf_emma:3,af_heart:2']);
ok('voice set: a blend is stored with weights that sum to 1', voiceOf(run(b, ['voice']).all) === 'bf_emma:0.6,af_heart:0.4', run(b, ['voice']).all);
const bad = run(b, ['voice', 'set', 'hal_9000']);
ok('voice set: an unknown voice is refused', bad.code !== 0 && /no voice called 'hal_9000'/.test(bad.all), bad.all);
ok('voice set: a refused set leaves the voice as it was', voiceOf(run(b, ['voice']).all) === 'bf_emma:0.6,af_heart:0.4');
const twice = run(b, ['voice', 'set', 'bf_emma,bf_emma']);
ok('voice set: a blend naming a voice twice is refused', twice.code !== 0, twice.all);

// Same identity, same voice: a clone in another folder gets the voice its first commit gives.
const keyed = defaultFor('commit:0123456789abcdef0123456789abcdef01234567');
ok('default: the same key always gives the same voice', [1, 2, 3].every(() => defaultFor('commit:0123456789abcdef0123456789abcdef01234567') === keyed));
ok('default: never fable, never nicole (TJ, 2026-11-12)', !ROSTER.includes('bm_fable') && !ROSTER.includes('af_nicole'));
const spread = new Set(Array.from({ length: 200 }, (_, i) => defaultFor(`commit:${i}`)));
ok('default: projects spread across the roster', spread.size === ROSTER.length, [...spread].join(' '));

// The engine refuses files it did not pin, before anything is spoken.
const fake = path.join(ROOT, 'fake-voice');
const dir = path.join(fake, ENGINE.model);
fs.mkdirSync(path.join(dir, 'espeak-ng-data'), { recursive: true });
for (const f of Object.keys(ENGINE.files)) if (!f.endsWith('/')) fs.writeFileSync(path.join(dir, f), 'not the pinned file');
const tampered = run(b, ['voice', 'sample', 'hello'], { GENLOCK_VOICE_HOME: fake });
ok('engine: tampered files are refused and nothing is spoken', tampered.code !== 0 && /do not match the pinned ones, so nothing was spoken/.test(tampered.all) && /voices\.bin has sha256/.test(tampered.all), tampered.all);
const missing = run(b, ['voice', 'sample', 'hello'], { GENLOCK_VOICE_HOME: path.join(ROOT, 'nowhere') });
ok('engine: a missing install says how to install', missing.code !== 0 && /genlock voice install/.test(missing.all), missing.all);

// Numbers are spoken, not skipped.
ok('speakable: numbers become words', speakable('Voice 10 of 12') === 'Voice ten of twelve', speakable('Voice 10 of 12'));
ok('speakable: arrows, percents and decimals', speakable('422 -> 474, 12.5%') === 'four hundred twenty-two to four hundred seventy-four, twelve point five percent', speakable('422 -> 474, 12.5%'));
ok('speakable: thousands separators', speakable('1,250 pages') === 'one thousand two hundred fifty pages', speakable('1,250 pages'));
ok('parseVoice: single voice', JSON.stringify(parseVoice('af_heart')) === '[["af_heart",1]]');

// The speaker reads a project's voice from its records, assigning one the way `genlock voice` would.
ok('voiceAt: a repo with a set voice gives it', JSON.stringify(voiceAt(b).parts) === '[["bf_emma",0.6],["af_heart",0.4]]', JSON.stringify(voiceAt(b)));
const c = repo('gamma');
const assigned = voiceAt(c);
ok('voiceAt: a repo with no voice yet is assigned one and it is recorded', assigned && ROSTER.includes(assigned.parts[0][0])
  && fs.readFileSync(path.join(c, '.genlock', 'records', 'project.jsonl'), 'utf8').includes('"op":"voice"'), JSON.stringify(assigned));
ok('voiceAt: a folder without genlock records has no voice', voiceAt(ROOT) === null);
fs.mkdirSync(process.env.GENLOCK_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.GENLOCK_HOME, 'projects.json'), JSON.stringify([{ path: a }, { path: b }, { path: path.join(ROOT, 'agent-genlock') }]));
ok('rootForProject: an item\'s project name finds its root', rootForProject('Beta') === b && rootForProject('genlock') === path.join(ROOT, 'agent-genlock'));
ok('voiceFor: by project name', voiceFor({ project: 'beta' }).parts[0][0] === 'bf_emma');
ok('voiceFor: no project falls to the hub voice', voiceFor({ project: 'nope' }).how.startsWith('hub'));
setHubVoice([['bm_george', 1]]);
ok('hub: set --hub is what untagged text is spoken in', hubVoice().parts[0][0] === 'bm_george' && voiceFor({}).parts[0][0] === 'bm_george');
const hubCli = run(b, ['voice', 'set', '--hub', 'bm_lewis'], { GENLOCK_VOICE_HOME: process.env.GENLOCK_VOICE_HOME });
ok('hub: genlock voice set --hub records it outside any project', hubCli.code === 0 && hubVoice().parts[0][0] === 'bm_lewis' && voiceOf(run(b, ['voice']).all) === 'bf_emma:0.6,af_heart:0.4', hubCli.all);

// Sentences: cut where a listener hears a stop, never at a decimal point.
const ss = sentences('Moved 12.5% today. Next: ship it!\n\n- a list item\n```js\ncode()\n```');
ok('sentences: decimals stay whole, paragraphs and bullets split, code dropped', JSON.stringify(ss) === JSON.stringify(['Moved twelve point five percent today.', 'Next: ship it!', 'a list item']), JSON.stringify(ss));
ok('sentences: a very long sentence is cut at commas', sentences(Array(30).fill('another clause here').join(', ') + '.').length > 1);
const w = wavBytes(new Float32Array([0, 0.5, -1]), 24000);
ok('wav: header and samples', w.length === 50 && w.toString('ascii', 0, 4) === 'RIFF' && w.readUInt32LE(24) === 24000 && w.readInt16LE(46) === 16384);

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);

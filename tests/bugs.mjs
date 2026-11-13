#!/usr/bin/env node
/* Bug tickets and retros: a bug cannot close without its cause on record, causes shared by
   several bugs cluster in a retro, and the same records give the same report.
   Run: node tests/bugs.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-bugs-test-')));
const env = { ...process.env, HOME: ROOT, GENLOCK_HOME: path.join(ROOT, 'app'), GENLOCK_SESSION: 'fixer', GENLOCK_AGENT_PID: '0', GENLOCK_TERMINAL: 'print' };
delete env.CLAUDE_CODE_SESSION_ID; delete env.GENLOCK_APP_CHANNEL;
spawnSync('git', ['init', '-q'], { cwd: ROOT });

const g = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const ok = (...args) => { const r = g(...args); assert.equal(r.code, 0, `${args.join(' ')}\n${r.all}`); return r.out; };
const idOf = (out) => /\b(T-[0-9A-Z]{5})\b/.exec(out)[1];

ok('goal', 'add', 'Ship the multiplayer town', '--short', 'town', '--user-said', 'ship the town');

function bug(short, title, extra = []) {
  return idOf(ok('new', title, '--bug', '--short', short, '--goal', 'town', '--found-by', 'playtest 2026-11-13',
    '-r', `the ${short} repro no longer reproduces`, '-c', 'manual: replay the playtest step', ...extra));
}
function prove(id) {
  ok('start', id);
  ok('met', id, '1', '--evidence', 'replayed the step, no repro');
  ok('grill', id, '--observed', 'replayed', '--cause', 'measured', '--absence', 'none', '--assumption', 'one machine', '--falsify', 'a second machine');
}
const cause = (id, f) => ok('cause', id, ...Object.entries(f).flatMap(([k, v]) => [].concat(v).flatMap((x) => [`--${k}`, x])));

let A; let B; let C; let D;

test('a bug ticket refuses done until every required cause field is set, naming each', () => {
  A = bug('timer-drift', 'Round timer runs fast on the host');
  prove(A);
  let r = g('done', A);
  assert.equal(r.code, 3, r.all);
  for (const f of ['symptom', 'root-cause', 'scope', 'system', 'class', 'corrective', 'preventive']) assert.match(r.err, new RegExp(`--${f} is not set`), f);
  cause(A, { symptom: 'host timer 10% fast at 01:30 in the round', 'root-cause': 'compares wall-clock ms to frame ticks',
    why: ['timer drifts', 'two clocks mixed'], scope: 'one-off', system: 'Round Timer', class: 'clock-domain-mismatch',
    corrective: 'timer reads frame ticks only' });
  r = g('done', A);
  assert.equal(r.code, 3);
  assert.match(r.err, /--preventive is not set/);
  assert.doesNotMatch(r.err, /--symptom is not set/);
  // "none" needs a reason.
  cause(A, { preventive: 'none' });
  assert.match(g('done', A).err, /none without a reason/);
  cause(A, { preventive: 'none: one call site' });
  ok('done', A);
  const shown = ok('show', A);
  assert.match(shown, /BUG, found by playtest 2026-11-13/);
  assert.match(shown, /system:\s+round-timer/, 'system names are normalised so they converge');
  assert.match(shown, /1\. timer drifts/);
});

test('an unknown class is refused, and classes add extends the vocabulary', () => {
  B = bug('desync', 'Clients disagree on the round end');
  const r = g('cause', B, '--class', 'made-up-thing');
  assert.equal(r.code, 1);
  assert.match(r.err, /genlock classes add made-up-thing/);
  ok('classes', 'add', 'tick-rate-assumption', 'code assumes a fixed tick rate');
  assert.match(ok('classes'), /tick-rate-assumption/);
});

test('setting a shared class or system names the other bugs that share it', () => {
  const out = cause(B, { symptom: 'two clients end the round 300ms apart', 'root-cause': 'client clock compared with server clock',
    scope: 'one-off', system: 'round timer', class: 'clock-domain-mismatch', corrective: 'server sends end tick',
    preventive: 'test compares end ticks across two clients', gate: 'CI net suite' });
  assert.match(out, new RegExp(`1 other bug on this goal shares class clock-domain-mismatch: ${A}`));
  assert.match(out, /scope is one-off, but this cause is shared/);
  prove(B); ok('done', B);

  C = bug('lobby-empty', 'Lobby list is empty on first open');
  const out2 = cause(C, { symptom: 'lobby empty first time', 'root-cause': 'list loaded lazily after render', scope: 'systemic',
    system: 'lobbby', class: 'load-on-first-use', corrective: 'load before render' });
  assert.match(out2, /lobbby is a new system name on this goal\. Already in use: round-timer/);
  cause(C, { system: 'lobby' });
  // C stays open with no preventive.
  D = bug('leaderboard', 'BUG: leaderboard shows stale scores');
  cause(D, { symptom: 'stale scores', 'root-cause': 'cache never invalidated', scope: 'systemic', system: 'lobby',
    class: 'stale-proxy-check', corrective: 'invalidate on write', preventive: 'test writes then reads', gate: 'pre-commit unit suite' });
  prove(D); ok('done', D);
  // Two systemic bugs that both got a real preventive: a cluster, but a settled one.
  const F = bug('stale-avatar', 'Avatar stays old after change');
  cause(F, { symptom: 'old avatar', 'root-cause': 'cache key ignores version', scope: 'systemic', system: 'profiles',
    class: 'stale-proxy-check', corrective: 'version in key', preventive: 'cache keys built by one helper with a test', gate: 'pre-commit unit suite' });
  prove(F); ok('done', F);
  // An old ticket titled as a bug but never marked: listed, never guessed.
  ok('new', 'BUG: chat drops emoji', '--goal', 'town', '-r', 'emoji arrive intact in chat', '-c', 'manual: send one');
});

test('list --bug filters by class and system; classes --counts counts them', () => {
  const all = ok('list', '--bug');
  for (const id of [A, B, C, D]) assert.match(all, new RegExp(id));
  assert.doesNotMatch(all, /chat drops emoji/);
  const byClass = ok('list', '--bug', '--class', 'clock-domain-mismatch');
  assert.match(byClass, new RegExp(A)); assert.match(byClass, new RegExp(B)); assert.doesNotMatch(byClass, new RegExp(C));
  const bySystem = ok('list', '--system', 'Lobby');
  assert.match(bySystem, new RegExp(C)); assert.match(bySystem, new RegExp(D)); assert.doesNotMatch(bySystem, new RegExp(A));
  const counts = ok('classes', '--counts', '--goal', 'town');
  assert.match(counts, /^\s+2\s+clock-domain-mismatch/m);
  assert.match(counts, /^\s+1\s+load-on-first-use/m);
  assert.doesNotMatch(counts, /race-condition/);
});

let report1;
test('a retro clusters causes, flags one-offs that look systemic, preventive gaps and unclassified bugs', () => {
  const out = ok('retro', 'town', '--out', 'retro.md');
  assert.match(out, /5 bugs, 4 clusters \(3 flagged\), 2 one-offs that look systemic, 1 preventive gaps, 2 unclassified/);
  report1 = fs.readFileSync(path.join(ROOT, 'retro.md'), 'utf8');
  assert.match(report1, new RegExp(`\\| class clock-domain-mismatch \\| 2 \\| 0 \\| yes \\| ${A}, ${B} \\|`));
  assert.match(report1, new RegExp(`\\| system round-timer \\| 2 \\| 0 \\| yes \\| ${A}, ${B} \\|`));
  // C is systemic but open with no preventive yet, so lobby is flagged; stale-proxy-check is settled.
  assert.match(report1, /\| class stale-proxy-check \| 2 \| 0 \| no \| /);
  assert.match(report1, new RegExp(`\\| system lobby \\| 2 \\| 1 \\| yes \\| ${C}, ${D} \\|`));
  assert.match(report1, new RegExp(`## One-offs that look systemic[\\s\\S]*${A}[\\s\\S]*${B}[\\s\\S]*## Preventive gaps`));
  assert.match(report1, new RegExp(`## Preventive gaps[\\s\\S]*${A}.*none: one call site[\\s\\S]*## Unclassified`));
  assert.match(report1, new RegExp(`## Unclassified[\\s\\S]*${C}.*missing: preventive[\\s\\S]*chat drops emoji — missing: not marked`));
  assert.match(report1, /This is the first retro on this goal/);
  const drafts = ok('tagged', `retro:${JSON.parse(ok('snapshot')).goals[0].id.toLowerCase()}`);
  assert.equal(drafts.trim().split('\n').length, 2, drafts);
  assert.doesNotMatch(drafts, /round-timer system/, 'a system cluster with the same bugs as a class cluster is not drafted twice');
  assert.match(drafts, /draft/);
  // Recorded on the goal, pointed at, and put in front of the user.
  const shown = ok('goal', 'show', 'town');
  assert.match(shown, /retro \d{4}-\d{2}-\d{2}\s+retro\.md\s+\(5 bugs, 4 clusters, 3 flagged\)/);
  assert.match(ok('review', 'list'), /retro\.md/);
});

test('the same records give the same report, and a re-run drafts nothing new', () => {
  fs.appendFileSync(path.join(ROOT, 'retro.md'), 'The clock cluster is the real one.\n');
  ok('retro', 'town', '--out', 'retro.md');
  const report2 = fs.readFileSync(path.join(ROOT, 'retro.md'), 'utf8');
  const tables = (s) => s.split('<!-- END OF GENERATED REPORT')[0];
  assert.equal(tables(report2), tables(report1));
  assert.match(report2, /The clock cluster is the real one\./, 'a written reading survives regeneration');
  const gid = JSON.parse(ok('snapshot')).goals[0].id.toLowerCase();
  assert.equal(ok('tagged', `retro:${gid}`).trim().split('\n').length, 2);
});

test('the next retro says what changed since the last one', () => {
  const E = bug('round-end', 'Round end banner shows twice');
  cause(E, { symptom: 'banner twice', 'root-cause': 'end event from both clocks', scope: 'systemic', system: 'round timer',
    class: 'clock-domain-mismatch', corrective: 'one source of end', preventive: 'lint: one clock per module' });
  assert.match(g('done', E).err, /--gate is not set: where the preventive runs/, 'a preventive with nowhere it runs does not close');
  cause(E, { gate: 'CI lint step' });
  prove(E); ok('done', E);
  ok('retro', 'town', '--out', 'retro2.md');
  const r = fs.readFileSync(path.join(ROOT, 'retro2.md'), 'utf8');
  assert.match(r, new RegExp(`- new bugs: ${E}`));
  assert.match(r, /clusters that grew: class:clock-domain-mismatch \(2 -> 3\), system:round-timer \(2 -> 3\)/);
  assert.match(r, /stopped recurring \(no new bug since\): class:stale-proxy-check, system:lobby/);
  const gid = JSON.parse(ok('snapshot')).goals[0].id.toLowerCase();
  assert.equal(ok('tagged', `retro:${gid}`).trim().split('\n').length, 2, 'existing drafts are reused, not duplicated');
});

test('--draft with requirements is refused rather than silently dropped', () => {
  const r = g('new', 'Lobby search finds rooms', '--draft', '-r', 'searching "red" lists the red room', '-c', 'manual: search');
  assert.equal(r.code, 2, r.all);
  assert.match(r.err, /a draft has no requirements yet/);
});

test('genlock bug converts an existing ticket, and a waiver needs a reason', () => {
  const id = idOf(ok('new', 'Chat history loads', '-r', 'chat history shows the last 50 messages', '-c', 'manual: open chat'));
  assert.equal(g('cause', id, '--symptom', 'x').code, 1);
  ok('bug', id, '--found-by', A);
  assert.match(ok('show', id), new RegExp(`found by ${A}`));
  assert.equal(g('cause', id, '--waive', 'root-cause').code, 1);
  ok('cause', id, '--waive', 'root-cause', '--reason', 'logs gone, cannot reproduce');
  assert.match(ok('show', id), /root cause:\s+\[waived\] logs gone/);
});

test('the snapshot carries each bug ticket\'s cause and each goal\'s bug counts', () => {
  const snap = JSON.parse(ok('snapshot'));
  const a = snap.tickets.find((t) => t.id === A);
  assert.equal(a.bug.class, 'clock-domain-mismatch');
  assert.equal(a.bug.system, 'round-timer');
  assert.deepEqual(a.bug.missing, []);
  assert.deepEqual(snap.tickets.find((t) => t.id === C).bug.missing, ['preventive']);
  assert.equal(snap.tickets.find((t) => /chat drops emoji/.test(t.title)).bug, null);
  const town = snap.goals.find((x) => x.short === 'town');
  assert.equal(town.bugs.total, 6);
  assert.equal(town.bugs.since_retro, 0);
  assert.match(town.bugs.last_retro.path, /retro2\.md/);
});

test('orient offers a retro once ten bugs have closed since the last one', () => {
  ok('goal', 'add', 'Polish the menus', '--short', 'menus', '--user-said', 'polish menus');
  const close = (n) => {
    const id = idOf(ok('new', `Menu glitch number ${n}`, '--bug', '--goal', 'menus', '-r', `menu glitch ${n} no longer shows`, '-c', 'manual: open menu'));
    ok('cause', id, '--symptom', 's', '--root-cause', 'r', '--scope', 'systemic', '--system', 'menus', '--class', 'unhandled-edge-case',
      '--corrective', 'c', '--preventive', 'none: cosmetic');
    prove(id); return g('done', id);
  };
  for (let n = 1; n <= 9; n++) close(n);
  assert.doesNotMatch(ok('orient'), /bugs closed since the last retro/);
  const tenth = close(10);
  assert.match(tenth.out, /10 bug tickets have closed on menus .* since its last retro/);
  assert.match(ok('orient'), /10 bugs closed since the last retro: offer the user one \(genlock retro G-/);
  assert.equal(JSON.parse(ok('snapshot')).goals.find((x) => x.short === 'menus').bugs.retro_due, true);
});

test('the MCP server offers the bug tools and they run', () => {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bug_classes', arguments: { counts: true, goal: 'town' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tickets_list', arguments: { bug: true, class: 'stale-proxy-check' } } },
  ].map((m) => JSON.stringify(m)).join('\n');
  const r = spawnSync(process.execPath, [CLI, 'mcp'], { cwd: ROOT, env, encoding: 'utf8', input: `${lines}\n` });
  const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const names = out.find((m) => m.id === 1).result.tools.map((t) => t.name);
  for (const n of ['ticket_bug', 'bug_cause', 'bug_classes', 'bug_class_add', 'retro']) assert.ok(names.includes(n), n);
  const newTool = out.find((m) => m.id === 1).result.tools.find((t) => t.name === 'ticket_new');
  assert.ok(newTool.inputSchema.properties.bug && newTool.inputSchema.properties.found_by);
  assert.match(out.find((m) => m.id === 2).result.content[0].text, /3\s+clock-domain-mismatch/);
  const listed = out.find((m) => m.id === 3).result.content[0].text;
  assert.match(listed, new RegExp(D)); assert.doesNotMatch(listed, new RegExp(A));
});

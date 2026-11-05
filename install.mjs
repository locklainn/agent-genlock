#!/usr/bin/env node
/**
 * genlock install -- wire any or all of the modules into a repository's agent setup.
 *
 *   genlock install                       # every module's rules, into detected agent files
 *   genlock install --only goals,tickets  # just these (plus anything they depend on)
 *   genlock install --hooks               # Claude Code hooks: orient, guard, deliver
 *   genlock install --mcp                 # register the MCP server in .mcp.json
 *   genlock install --skill               # also install the Claude Code skills
 *   genlock install --global              # into ~/.claude rather than this repository
 *   genlock install --full                # the long form of the tickets protocol
 *   genlock install --private             # keep records out of git, on this machine only
 *   genlock install --check               # report, write nothing
 *
 * Idempotent: the block is fenced by markers and replaced in place, hooks and servers are
 * replaced rather than added twice, and everything else in each file is left as it was.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'bin', 'genlock.mjs');
const BEGIN = '<!-- BEGIN genlock (managed by `genlock install`; edits inside are overwritten) -->';
const END = '<!-- END genlock -->';

const MODULES = {
  labels: { file: 'labels.md', skill: 'status-labels', needs: [] },
  tickets: { file: 'tickets.md', skill: 'ticketed-work', needs: [] },
  goals: { file: 'goals.md', skill: 'goals', needs: [] },
  continuity: { file: 'continuity.md', skill: 'continuity', needs: ['tickets', 'goals'] },
  coordination: { file: 'coordination.md', skill: 'coordination', needs: [] },
  reviews: { file: 'reviews.md', skill: 'reviews', needs: [] },
  spinoffs: { file: 'spinoffs.md', skill: 'spinoffs', needs: ['tickets', 'coordination'] },
};

const CANDIDATES = [
  'CLAUDE.md', 'AGENTS.md', '.cursorrules', '.cursor/rules/genlock.mdc', '.windsurfrules',
  '.github/copilot-instructions.md', 'GEMINI.md', '.clinerules',
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const many = (f) => argv.reduce((a, t, i) => (t === f && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const check = has('--check');
const global = has('--global');

function selected() {
  const only = many('--only').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const want = new Set(only.length ? only : Object.keys(MODULES));
  for (const m of want) {
    if (!MODULES[m]) {
      console.error(`genlock: no module '${m}'. There are: ${Object.keys(MODULES).join(', ')}`);
      process.exit(1);
    }
  }
  for (const m of [...want]) for (const d of MODULES[m].needs) {
    if (!want.has(d)) console.log(`  including ${d}, which ${m} depends on`);
    want.add(d);
  }
  return Object.keys(MODULES).filter((m) => want.has(m));
}

const mods = selected();
const blockFor = (m) => fs.readFileSync(path.join(HERE, 'agent',
  m === 'tickets' && has('--full') ? 'tickets.full.md' : MODULES[m].file), 'utf8').trim();
const block = mods.map(blockFor).join('\n\n');

function targets() {
  const explicit = many('--target');
  if (explicit.length) return explicit.map((t) => path.resolve(t));
  if (global) return [path.join(os.homedir(), '.claude', 'CLAUDE.md')];
  const found = CANDIDATES.filter((c) => fs.existsSync(path.resolve(c))).map((c) => path.resolve(c));
  if (found.length) return found;
  return [path.resolve(fs.existsSync('.claude') ? 'CLAUDE.md' : 'AGENTS.md')];
}

function weave(existing, body) {
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  const managed = `${BEGIN}\n\n${body}\n\n${END}\n`;
  if (b >= 0 && e > b) {
    const rest = existing.slice(e + END.length).replace(/^\n+/, '');
    return existing.slice(0, b) + managed + (rest ? `\n${rest}` : '');
  }
  const sep = existing.length === 0 ? '' : (existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n');
  return existing + sep + managed;
}

function writeIfChanged(file, before, after, label) {
  if (after === before) { console.log(`  unchanged  ${file}`); return; }
  if (check) { console.log(`  would write ${label}: ${file}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  console.log(`  wrote ${label}: ${file}`);
}

for (const t of targets()) {
  const before = fs.existsSync(t) ? fs.readFileSync(t, 'utf8') : '';
  writeIfChanged(t, before, weave(before, block), 'rules');
}

/** On PATH, the bare name survives upgrades. Otherwise this checkout's absolute path. */
const WINDOWS = process.platform === 'win32';
const onPath = (WINDOWS
  ? spawnSync('where', ['genlock'], { stdio: 'ignore' })
  : spawnSync('sh', ['-c', 'command -v genlock'], { stdio: 'ignore' })).status === 0;
if (!onPath) {
  console.log('  genlock is not on PATH, so these settings name this copy by its full path and will not work on another\n'
    + '  machine. To fix: npm install -g github:locklainn/agent-genlock, then run this again.');
}
const fwd = (p) => p.replace(/\\/g, '/');
const command = onPath ? ['genlock'] : [fwd(process.execPath), fwd(CLI)];
const shellCmd = (sub) => `${command.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(' ')} ${sub}`;

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { console.error(`genlock: ${file} is not valid JSON, so it was left alone.`); process.exit(1); }
}

if (has('--hooks')) {
  const file = global ? path.join(os.homedir(), '.claude', 'settings.json') : path.resolve('.claude/settings.json');
  const settings = readJson(file);
  const before = JSON.stringify(settings, null, 2);
  settings.hooks ||= {};
  const put = (event, matcher, sub) => {
    const kept = (settings.hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !/genlock(\.mjs)?["']? (orient|guard|deliver)\b/.test(h.command || '')) }))
      .filter((g) => g.hooks.length);
    const group = { hooks: [{ type: 'command', command: shellCmd(sub) }] };
    if (matcher) group.matcher = matcher;
    settings.hooks[event] = [...kept, group];
  };
  if (mods.includes('goals') || mods.includes('continuity')) put('SessionStart', null, 'orient');
  if (mods.includes('coordination')) {
    put('PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit|Bash', 'guard');
    put('PostToolUse', null, 'deliver');
  }
  writeIfChanged(file, before === '{}' ? '' : `${before}\n`, `${JSON.stringify(settings, null, 2)}\n`, 'hooks');
}

if (has('--mcp')) {
  if (global) {
    console.log(`  to register for every repository, run: claude mcp add --scope user genlock -- ${shellCmd('mcp')}`);
  } else {
    const file = path.resolve('.mcp.json');
    const cfg = readJson(file);
    const before = JSON.stringify(cfg, null, 2);
    cfg.mcpServers ||= {};
    // Windows cannot start npm's genlock.cmd shim directly, so it goes through cmd.
    cfg.mcpServers.genlock = WINDOWS && onPath
      ? { command: 'cmd', args: ['/c', 'genlock', 'mcp'] }
      : { command: command[0], args: [...command.slice(1), 'mcp'] };
    writeIfChanged(file, before === '{}' ? '' : `${before}\n`, `${JSON.stringify(cfg, null, 2)}\n`, 'MCP server');
  }
}

if (has('--skill')) {
  const base = global ? path.join(os.homedir(), '.claude', 'skills') : path.resolve('.claude/skills');
  for (const m of mods) {
    const { skill } = MODULES[m];
    const src = path.join(HERE, 'skills', skill);
    const dest = path.join(base, skill);
    if (!check) {
      fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dest, f));
    }
    console.log(`  ${check ? 'would install' : 'installed'} skill: ${dest}`);
  }
}

if (has('--private')) {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('genlock: --private needs a git repository.');
    process.exit(1);
  }
  const file = path.resolve(r.stdout.trim());
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const after = /^\.genlock\/$/m.test(before) ? before : `${before}${before && !before.endsWith('\n') ? '\n' : ''}.genlock/\n`;
  writeIfChanged(file, before, after, 'private records');
}

console.log(`\n${check ? 'Dry run. ' : ''}Modules: ${mods.join(', ')} (${block.split(/\s+/).length} words of rules).`);

if (has('--next-steps') && !check) {
  console.log(`
Next:
  genlock doctor      confirm it took
  genlock orient      see where things stand, and whether goals are known
  genlock guide       if there are already status notes or handoff documents here

Restart your agent session so it loads the new rules, hooks and tools.`);
}

#!/usr/bin/env node
/**
 * tkt install -- wire the protocol into whatever agent this repo uses.
 *
 *   npx @locklainn/tkt install            # compact block, auto-detected targets
 *   npx @locklainn/tkt install --full     # the whole protocol instead
 *   npx @locklainn/tkt install --global   # into ~/.claude/CLAUDE.md, for every repo
 *   npx @locklainn/tkt install --target AGENTS.md --target .cursorrules
 *   npx @locklainn/tkt install --skill    # also drop the Claude Code skill
 *   npx @locklainn/tkt install --check    # report, write nothing
 *
 * Idempotent: the block is fenced by markers and replaced in place, never appended
 * twice. Everything outside the markers is left exactly as it was.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEGIN = '<!-- BEGIN tkt-protocol (managed by `tkt install`; edits inside are overwritten) -->';
const END = '<!-- END tkt-protocol -->';

const CANDIDATES = [
  'CLAUDE.md',        // Claude Code
  'AGENTS.md',        // Codex, Amp, Jules, and the emerging shared convention
  '.cursorrules',     // Cursor (legacy single file)
  '.cursor/rules/tkt.mdc',
  '.windsurfrules',   // Windsurf
  '.github/copilot-instructions.md',
  'GEMINI.md',        // Gemini CLI
  '.clinerules',      // Cline
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const many = (f) => argv.reduce((a, t, i) => (t === f && argv[i + 1] ? [...a, argv[i + 1]] : a), []);

const full = has('--full');
const check = has('--check');
const block = fs.readFileSync(
  path.join(HERE, 'agent', full ? 'PROTOCOL.md' : 'PROTOCOL.compact.md'), 'utf8').trim();

function targets() {
  const explicit = many('--target');
  if (explicit.length) return explicit.map((t) => path.resolve(t));
  if (has('--global')) return [path.join(os.homedir(), '.claude', 'CLAUDE.md')];
  const found = CANDIDATES.filter((c) => fs.existsSync(path.resolve(c))).map((c) => path.resolve(c));
  if (found.length) return found;
  // Nothing to detect: create the one convention the most agents read.
  return [path.resolve(fs.existsSync('.claude') ? 'CLAUDE.md' : 'AGENTS.md')];
}

function weave(existing, body) {
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  const managed = `${BEGIN}\n\n${body}\n\n${END}\n`;
  if (b >= 0 && e > b) {
    return existing.slice(0, b) + managed + existing.slice(e + END.length).replace(/^\n+/, '\n');
  }
  const sep = existing.length === 0 ? '' : (existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n');
  return existing + sep + managed;
}

let changed = 0;
for (const t of targets()) {
  const before = fs.existsSync(t) ? fs.readFileSync(t, 'utf8') : '';
  const after = weave(before, block);
  const verb = before.includes(BEGIN) ? 'updated' : before ? 'appended to' : 'created';
  if (after === before) { console.log(`  unchanged  ${t}`); continue; }
  if (check) { console.log(`  would ${verb.padEnd(12)}${t}`); changed++; continue; }
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, after);
  console.log(`  ${verb.padEnd(12)}${t}`);
  changed++;
}

if (has('--skill')) {
  const dest = path.join(os.homedir(), '.claude', 'skills', 'ticketed-work');
  const src = path.join(HERE, 'skills', 'ticketed-work');
  if (!check) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
  console.log(`  ${check ? 'WOULD INSTALL' : 'skill'}      ${dest}`);
}

console.log(`\n${check ? 'Dry run.' : `${changed} file${changed === 1 ? '' : 's'} written.`} `
  + `Protocol: ${full ? 'full' : 'compact'} (${block.split(/\s+/).length} words).`);
if (!check && changed) console.log('The agent now opens a ticket before work and cannot claim done without proving it.');

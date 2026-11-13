/**
 * Pre-approves genlock's own commands in Claude Code, so auto mode's classifier never judges them.
 *
 * Why: sessions are told to swap, open and close themselves without asking, but that instruction
 * lives in a system prompt the classifier does not see. To it, an agent closing its own session
 * looks unwanted, and it denied swaps (nightmaremode, 2026-11-13). A PreToolUse hook that answers
 * permissionDecision "allow" settles the call before the classifier runs.
 *
 * Only commands made of genlock calls plus harmless plumbing qualify: cd, head, tail, echo, true,
 * joined by ; && || | or newlines, with output redirected only to 2>&1 or /dev/null. Anything
 * else (another program, $( ), backticks, a variable assignment, a redirect into a file) gets no
 * answer from here and goes through the normal checks.
 */

const PLUMBING = new Set(['cd', 'head', 'tail', 'echo', 'true', 'printf']);
const SAFE_REDIRECT = /^(\d?>&\d|&?\d?>{1,2}\/dev\/null|\d?<\/dev\/null)$/;

/** Split a shell command into simple commands, each a list of words. Null if it is anything fancier. */
export function simpleCommands(command) {
  const cmds = [];
  let words = [];
  let word = '';
  let inWord = false;
  let redir = false;   // an unquoted < or > is in this word
  let quote = null;
  const endWord = () => { if (inWord) words.push({ w: word, redir }); word = ''; inWord = false; redir = false; };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === '`' || (ch === '$' && command[i + 1] === '(')) return null;
      if (ch === '\\' && i + 1 < command.length) { word += command[++i]; continue; }
      word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === '\\') {
      if (command[i + 1] === '\n') { i++; continue; }
      if (i + 1 < command.length) { word += command[++i]; inWord = true; }
      continue;
    }
    if (ch === '`' || ch === '(' || ch === ')' || ch === '{' || ch === '}') return null;
    if (ch === '$' && command[i + 1] === '(') return null;
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === '\n' || ch === ';') { endCmd(); continue; }
    if (ch === '|' || ch === '&') {
      // 2>&1 and &>/dev/null are redirects, not separators.
      if (ch === '&' && (word.endsWith('>') || command[i + 1] === '>')) { word += ch; inWord = true; redir = true; continue; }
      if (command[i + 1] === ch) i++;
      else if (ch === '&') return null;       // a lone & backgrounds a job
      endCmd();
      continue;
    }
    if (ch === '<' || ch === '>') redir = true;
    word += ch;
    inWord = true;
  }
  if (quote) return null;
  endCmd();
  return cmds;
}

function isGenlock(word) {
  return word === 'genlock' || /\/genlock(\.mjs)?$/.test(word);
}

/** True when every part of the command is genlock or plumbing, and at least one part is genlock. */
export function genlockOnly(command) {
  if (typeof command !== 'string' || !command.trim() || /<<|<\(|>\(/.test(command)) return false;
  const cmds = simpleCommands(command);
  if (!cmds || !cmds.length) return false;
  let sawGenlock = false;
  for (const words of cmds) {
    const args = [];
    for (let k = 0; k < words.length; k++) {
      const { w, redir } = words[k];
      if (redir) {
        // A redirect is one word (2>&1, >/dev/null) or an operator followed by its target.
        const joined = /^(\d?>{1,2}|&>|\d?<)$/.test(w) && k + 1 < words.length ? w + words[++k].w : w;
        if (!SAFE_REDIRECT.test(joined)) return false;
        continue;
      }
      args.push(w);
    }
    if (!args.length) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) return false;
    if (isGenlock(args[0])) { sawGenlock = true; continue; }
    if (!PLUMBING.has(args[0])) return false;
  }
  return sawGenlock;
}

/** The PreToolUse answer that settles a genlock-only Bash call, or null to stay out of it. */
export function allowDecision(input) {
  if (!input || input.tool_name !== 'Bash') return null;
  if (!genlockOnly(input.tool_input?.command)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'genlock records and session management (swap, open, close) are pre-approved by the user',
    },
  };
}

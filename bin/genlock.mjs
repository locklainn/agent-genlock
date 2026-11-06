#!/usr/bin/env node
/**
 * genlock - keeps work intact as it passes between coding-agent sessions.
 *
 * Goals say what the work is for and what is next, tickets prove what is done and say what
 * just happened, claims stop concurrent agents colliding, questions pass between sessions,
 * and spin-offs move a tangent into its own session. Each can be used without the others.
 *
 * Zero dependencies. Node 16+. Records live in the repository, under .genlock/.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { die, damaged, dirtyFiles, git, repoRoot, genlockDir, readEvents, listIds, identity } from '../lib/store.mjs';
import {
  cmdAssign, cmdAssume, cmdDecide, cmdDone, cmdForbid, cmdGrill, cmdHazard, cmdLink, cmdLint, cmdList, cmdNew, cmdRef,
  cmdReq, cmdShow, cmdStart, cmdStatus, cmdUnforbid, cmdUpdate, mark, withReason,
} from '../lib/tickets.mjs';
import { cmdGoal } from '../lib/goals.mjs';
import { cmdCheck, cmdClaim, cmdClaims, cmdGuard, cmdRelease, liveBase, liveClaims } from '../lib/claims.mjs';
import { cmdCheckpoint, cmdContinue, cmdOrient } from '../lib/continuity.mjs';
import { cmdAnswer, cmdAsk, cmdDeliver, cmdInbox } from '../lib/ask.mjs';
import { cmdSpinoff } from '../lib/spinoff.mjs';
import { cmdReview } from '../lib/reviews.mjs';
import { cmdSnapshot } from '../lib/snapshot.mjs';
import { cmdDue, cmdRank } from '../lib/rank.mjs';
import { cmdOverview, cmdTell } from '../lib/overview.mjs';
import { cmdSay, cmdSessionState, cmdVoiceCheck } from '../lib/voice.mjs';
import { runMcp } from '../lib/mcp.mjs';

const VERSION = '2.2.0';

const USAGE = `genlock ${VERSION} -- keeps coding agents aligned through shared goals and tickets.

START HERE
  genlock init --private | --shared             set up this repository; records stay local, or are committed
  genlock doctor                                confirm it took
  genlock guide                                 adopting it where work is already under way
  genlock orient                                what is going on here

TICKETS   requirements first; done is proved, not asserted
  genlock new "TITLE" -r "REQ" -c "CHECK" [-r .. -c ..] [--goal G] [--due YYYY-MM-DD] [--ask ..] [--draft]
  genlock list [--open] [--status S] [--goal G]  |  genlock show ID [--json]  |  genlock status ID
  genlock start ID  |  genlock req ID -r ".." -c ".."  |  genlock assign ID SESSION  |  genlock link ID GOAL
  genlock update ID "THE LATEST"   (600 characters at most; findings go in files)
  genlock hazard ID "WHAT WAS LEFT BEHIND" --verify "HOW TO CHECK"  |  genlock hazard ID --clear N --evidence ".."
  genlock start ID --because ".."               required to restart a blocked ticket

ON A TICKET OR A GOAL
  genlock rank [goals|tasks]                    the strict order, most important first. No two share a place
  genlock rank ID --to N  |  genlock rank ID --before OTHER
  genlock due ID YYYY-MM-DD  |  genlock due ID --clear
  genlock decide ID "WHAT" [--user-said ..] [--supersedes N]
  genlock forbid ID "WHAT MUST NOT BE DONE" --lifted-by ".."  |  genlock unforbid ID N --user-said ".."
  genlock ref ID PATH --why "WHAT THE READER FINDS THERE, AND WHEN THEY NEED IT"
  genlock met ID N --evidence "WHAT YOU OBSERVED"  |  genlock fail ID N --evidence ".."  |  genlock waive ID N --reason ".."
  genlock assume ID "WHAT" --breaks "WHAT IF WRONG"
  genlock grill ID [--observed .. --cause .. --absence .. --assumption .. --falsify ..]
  genlock done ID                                 REFUSES unless every requirement is proved
  genlock block ID "WHY"  |  genlock abandon ID "WHY"  |  genlock note ID "WHAT"
  genlock lint -r ".." -c ".."  |  genlock lint ID

GOALS     what the work is for; only the user sets or closes one
  genlock goal list [--all]  |  genlock goal show G  |  genlock goal status G
  genlock goal add "TITLE" --user-said ".." [--why ..] [--done-when ..]
  genlock goal propose "TITLE" --why ".."  |  genlock goal accept G --user-said ".."  |  genlock goal reject G --user-said ".."
  genlock goal next G ["NEXT THING" [--due YYYY-MM-DD]] [--done N] [--move N --to M] [--still-right]
  genlock goal park G --waiting-on ".."  |  genlock goal unpark G
  genlock goal update G "WHAT MOVED"  |  genlock goal done G --evidence ".." --user-said ".."
  genlock goal drop G --user-said ".."  |  genlock goal none --user-said ".."

CONTINUITY  stop and pick back up, with nothing lost
  genlock orient                                  what a session should know as it starts
  genlock checkpoint [--uncommitted ".."]         REFUSES until goals and tickets are current
  genlock continue [GOAL|TICKET]                  everything needed to carry on

REVIEWS   files the user should look at, kept findable
  genlock review PATH --why ".." [--about GOAL|TICKET]  |  genlock review list [--all]  |  genlock review done R [--note ..]

QUESTIONS between sessions; nobody waits for an answer
  genlock ask TICKET|any "QUESTION"  |  genlock answer Q "ANSWER"  |  genlock inbox
  genlock ask user "QUESTION" [--about GOAL|TICKET]  |  genlock answer Q "ANSWER" --user-said ".."
  genlock deliver                                 the Claude Code PostToolUse hook

CLAIMS    who is working on what, right now
  genlock claim ID --path P [--resource R] [--ttl MIN] [--replace]
  genlock release ID [--reason ..]  |  genlock claims [--json]  |  genlock check --path P [--resource R]
  genlock guard                                   the Claude Code PreToolUse hook

SPIN-OFFS move a tangent into its own session, once the user says yes
  genlock spinoff propose "TITLE" --parent ID --why ".." --context ".." --path P --needs none --blocks none
  genlock spinoff check ID  |  genlock spinoff amend ID ..  |  genlock spinoff park ID "WHY"
  genlock spinoff launch ID --user-said ".." [--worktree]

  genlock mcp                                     run as an MCP server, over stdio
  genlock snapshot                                everything above as JSON, for tools that display it
  genlock say "TEXT"                              speak a reply, in a session started with a voice channel
  genlock sync [-m MSG]                           commit only .genlock/ (never pushes)
  genlock where
  genlock install [--only a,b] [--hooks] [--mcp] [--skill] [--private] [--global] [--full] [--check]

Exit codes: 0 fine, 1 usage or not found, 2 lint refused, 3 not done, 4 conflict or unsafe.`;

/* ---------------------------------------------------------------- whole-repo */

function cmdSync(a) {
  if (!fs.existsSync(genlockDir())) die('no .genlock/ here yet; nothing to commit');
  const root = repoRoot();
  if (!git(['rev-parse', '--git-dir'], root)) die('not a git repository');
  if (git(['check-ignore', '-q', '.genlock/records/x.jsonl'], root) !== null)
    die('records here are private: .genlock/ is excluded from git, so there is nothing to commit');
  if (git(['add', '--', '.genlock'], root) === null) die('git add failed');
  if (git(['diff', '--cached', '--quiet', '--', '.genlock'], root) !== null) {
    console.log('nothing new in .genlock/.');
    return;
  }
  // --only, so anything else another agent has staged stays out of this commit.
  const r = spawnSync('git', ['commit', '--only', '-m', a.m || 'genlock: update records', '--', '.genlock'],
    { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) die(`git commit failed: ${r.stderr || r.stdout}`);
  console.log(`committed .genlock/ as ${git(['rev-parse', '--short', 'HEAD'], root)}. Nothing was pushed.`);
}

function cmdDoctor() {
  const root = repoRoot();
  const problems = [];
  const report = (ok, text) => { console.log(`${ok ? 'ok ' : 'BAD'}  ${text}`); if (!ok) problems.push(text); };
  report(parseInt(process.versions.node, 10) >= 16, `node ${process.versions.node}`);
  const inGit = !!git(['rev-parse', '--git-dir'], root);
  report(inGit, inGit ? 'git repository' : 'not a git repository, so records have no merge protection');
  if (inGit) {
    const attr = git(['check-attr', 'merge', '--', '.genlock/records/T-X.jsonl'], root) || '';
    const ignored = git(['check-ignore', '-q', '.genlock/records/x.jsonl'], root) !== null;
    if (ignored) console.log('ok   records are private: excluded from git, on this machine only');
    else if (!listIds('T-').length && !listIds('G-').length) console.log('ok   no records yet: the merge rule arrives with the first one');
    else report(/merge: union$/.test(attr), `merge rule for records: ${attr || 'unreadable'}`);
  }
  const hookFiles = [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json'),
    path.join(os.homedir(), '.claude', 'settings.json')];
  const hook = hookFiles.find((f) => { try { return /guard/.test(fs.readFileSync(f, 'utf8')) && /genlock/.test(fs.readFileSync(f, 'utf8')); } catch { return false; } });
  report(!!hook, hook ? `guard hook in ${hook}` : 'guard hook not installed, so claims are honour-system: genlock init');
  const idv = identity();
  report(!!idv, idv ? `session identity ${idv.slice(0, 8)}` : 'no session identity: set GENLOCK_SESSION, or run under Claude Code');
  for (const id of [...listIds('T-'), ...listIds('G-'), ...listIds('Q-'), ...listIds('R-'), 'project']) readEvents(id);
  report(!damaged.length, damaged.length ? `${damaged.length} unreadable record line(s): ${damaged.slice(0, 3).join(', ')}` : 'every record line parses');
  console.log(`     ${listIds('T-').length} tickets, ${listIds('G-').length} goals, ${liveClaims().length} live claims, ${dirtyFiles().length} uncommitted files`);
  process.exit(problems.length ? 1 : 0);
}

function cmdWhere() {
  console.log(`records: ${genlockDir()}`);
  console.log(`live:    ${liveBase()}`);
}

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function runInstaller(extra = []) {
  const r = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'install.mjs'), ...extra, ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const cmdInstall = () => runInstaller();
function cmdInit() {
  const args = process.argv.slice(3);
  if (!args.includes('--private') && !args.includes('--shared') && !args.includes('--check')) {
    die('init needs a choice, because it decides where your records go:\n\n'
      + '  genlock init --private   records stay on this machine, excluded from git. Use for public or sensitive repositories\n'
      + '  genlock init --shared    records are committed with your work, so they have history and reach other machines\n\n'
      + 'Records are permanent logs that can quote people. Add --check to see what would change. Nothing was written.');
  }
  runInstaller(['--hooks', '--mcp', '--skill', '--next-steps']);
}
const cmdGuide = () => process.stdout.write(fs.readFileSync(path.join(PACKAGE_ROOT, 'docs', 'ADOPTING.md'), 'utf8'));

/* -------------------------------------------------------------------- shell */

const COMMANDS = {
  new: cmdNew, add: cmdNew,
  list: cmdList, ls: cmdList,
  show: cmdShow, cat: cmdShow,
  status: cmdStatus,
  start: cmdStart,
  req: cmdReq,
  met: (a) => mark(a, 'met', 'evidence'),
  fail: (a) => mark(a, 'failed', 'evidence'),
  waive: (a) => mark(a, 'waived', 'reason'),
  assume: cmdAssume,
  grill: cmdGrill,
  done: cmdDone, close: cmdDone,
  block: (a) => withReason(a, 'block', 'block', 'BLOCKED'),
  abandon: (a) => withReason(a, 'abandon', 'abandon', 'abandoned'),
  note: (a) => withReason(a, 'note', 'note', 'noted'),
  lint: cmdLint,
  assign: cmdAssign,
  link: cmdLink,
  goal: cmdGoal,
  update: cmdUpdate,
  ref: cmdRef,
  forbid: cmdForbid,
  unforbid: cmdUnforbid,
  hazard: cmdHazard,
  decide: cmdDecide,
  orient: cmdOrient,
  checkpoint: cmdCheckpoint,
  continue: cmdContinue,
  ask: cmdAsk,
  answer: cmdAnswer,
  inbox: cmdInbox,
  deliver: cmdDeliver,
  mcp: runMcp,
  review: cmdReview,
  snapshot: cmdSnapshot,
  overview: cmdOverview,
  tell: cmdTell,
  rank: cmdRank,
  due: cmdDue,
  say: cmdSay,
  'voice-check': cmdVoiceCheck,
  'session-state': cmdSessionState,
  claim: cmdClaim,
  release: cmdRelease,
  claims: cmdClaims,
  check: cmdCheck,
  guard: cmdGuard,
  spinoff: cmdSpinoff,
  sync: cmdSync,
  doctor: cmdDoctor,
  where: cmdWhere,
  install: cmdInstall,
  init: cmdInit,
  guide: cmdGuide,
};

const SHORT = new Set(['r', 'c', 'm']);
const MULTI = new Set(['r', 'c', 'path', 'resource', 'read', 'decisions']);
const FLAGS = new Set(['open', 'all', 'json', 'quiet', 'loose', 'draft', 'replace', 'worktree', 'parent-idle', 'still-right']);

function parse(argv) {
  const a = { _: [], r: [], c: [] };
  const put = (name, val) => {
    const key = name.replace(/-/g, '_');
    if (MULTI.has(name)) (a[key] ||= []).push(val); else a[key] = val;
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      let name = tok.slice(2); let val = null;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (FLAGS.has(name) && val === null) { a[name.replace(/-/g, '_')] = true; continue; }
      // `due ID --clear` stands alone, while `hazard ID --clear N` takes a number.
      if (val === null && name === 'clear' && argv[i + 1] === undefined) { a.clear = true; continue; }
      if (val === null) { val = argv[++i]; if (val === undefined) die(`--${name} needs a value`); }
      put(name, val);
    } else if (/^-[A-Za-z]/.test(tok)) {
      const name = tok.slice(1);
      if (!SHORT.has(name)) die(`unknown flag -${name}`);
      const val = argv[++i];
      if (val === undefined) die(`-${name} needs a value`);
      put(name, val);
    } else a._.push(tok);
  }
  return a;
}

const argv = process.argv.slice(2);
// Anywhere on the line: asking for help must never run the command it is asking about.
if (!argv.length || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
if (['-V', '--version', 'version'].includes(argv[0])) { console.log(VERSION); process.exit(0); }
const fn = COMMANDS[argv[0]];
if (!fn) die(`unknown command '${argv[0]}'. \`genlock help\` lists them.`);
if (fn === cmdInstall || fn === cmdInit || fn === cmdGuide) fn();
else fn(parse(argv.slice(1)));

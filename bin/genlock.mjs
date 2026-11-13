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
import { cmdCheck, cmdClaim, cmdClaims, cmdGuard, cmdRelease, cmdSessionEnd, liveBase, liveClaims } from '../lib/claims.mjs';
import { cmdCheckpoint, cmdContinue, cmdOrient, cmdSwap } from '../lib/continuity.mjs';
import { cmdFollowups } from '../lib/followups.mjs';
import { cmdAnswer, cmdAsk, cmdDeliver, cmdInbox } from '../lib/ask.mjs';
import { cmdSpinoff } from '../lib/spinoff.mjs';
import { cmdReview } from '../lib/reviews.mjs';
import { cmdSnapshot } from '../lib/snapshot.mjs';
import { cmdDue, cmdRank, cmdShort } from '../lib/rank.mjs';
import { cmdClearContext, cmdClose, cmdName, cmdOpen, cmdOverview, cmdRemember, cmdRemembered, cmdSweep, cmdTell, runAt } from '../lib/overview.mjs';
import { cmdSay, cmdSessionState, cmdStatusLine, cmdTitle, cmdVoiceCheck } from '../lib/voice.mjs';
import { cmdLoad } from '../lib/load.mjs';
import { cmdWait } from '../lib/waits.mjs';
import { cmdVoice } from '../lib/voices.mjs';
import { runMcp } from '../lib/mcp.mjs';
import { cmdSprint } from '../lib/sprint.mjs';
import { cmdBackup, cmdRestore } from '../lib/backup.mjs';
import { cmdAttach, cmdFiles, cmdPurge } from '../lib/attach.mjs';
import { cmdFiled, cmdMeta, cmdTag, cmdTagged, cmdUnfiled } from '../lib/tags.mjs';
import { cmdBug, cmdCause, cmdClasses, cmdRetro } from '../lib/retro.mjs';

const VERSION = '2.2.0';

const USAGE = `genlock ${VERSION} -- keeps coding agents aligned through shared goals and tickets.

START HERE
  genlock init --private | --shared             set up this repository; records stay local, or are committed
  genlock doctor                                confirm it took
  genlock guide                                 adopting it where work is already under way
  genlock orient                                what is going on here

TICKETS   requirements first; done is proved, not asserted
  genlock new "TITLE" [--short "NAME"] -r "REQ" -c "CHECK" [-r .. -c ..] [--goal G] [--due YYYY-MM-DD] [--ask ..] [--draft]
  genlock list [--open] [--status S] [--goal G] [--bug [--class C] [--system S]]  |  genlock show ID [--json]  |  genlock status ID
  genlock start ID  |  genlock req ID -r ".." -c ".."  |  genlock assign ID SESSION  |  genlock link ID GOAL
  genlock update ID "THE LATEST"   (600 characters at most; findings go in files)
  genlock hazard ID "WHAT WAS LEFT BEHIND" --verify "HOW TO CHECK"  |  genlock hazard ID --clear N --evidence ".."
  genlock start ID --because ".."               required to restart a blocked ticket
  genlock start ID --take-over --user-said ".." take a ticket another live session holds (start claims it)

ON A TICKET OR A GOAL
  Every goal and ticket has a short name. Use it, or words from its title, anywhere an ID goes:
    genlock continue billing-page  |  genlock start "refund button"
  genlock short ID "NAME"                       choose its short name
  genlock rank [goals|tasks]                    the strict order, most important first. No two share a place
  genlock rank ID --to N  |  genlock rank ID --before OTHER
  genlock due ID YYYY-MM-DD  |  genlock due ID --clear
  genlock decide ID "WHAT" [--user-said ..] [--supersedes N]
  genlock tag ID [TAG ..] [--remove TAG,..]  |  genlock tagged TAG    labels that outlive the session
  genlock meta ID [KEY [VALUE]] [--clear]       key-value facts about a goal or task
  genlock filed ID [ID ..] --event EVENT_ID [--to nextlevel]   finished work was logged elsewhere: tag it
  genlock unfiled [--to nextlevel] [--since YYYY-MM-DD]        finished work not logged yet
  genlock forbid ID "WHAT MUST NOT BE DONE" --lifted-by ".."  |  genlock unforbid ID N --user-said ".."
  genlock ref ID PATH --why "WHAT THE READER FINDS THERE, AND WHEN THEY NEED IT"
  genlock attach ID FILE [FILE ..] --why ".."   keep a copy of a screenshot or file the user sent, on ID
  genlock files [ID]  |  genlock purge ID [N ..] | --done | --before YYYY-MM-DD --user-said ".."
  genlock met ID N --evidence "WHAT YOU OBSERVED"  |  genlock fail ID N --evidence ".."  |  genlock waive ID N --reason ".."
  genlock assume ID "WHAT" --breaks "WHAT IF WRONG"
  genlock grill ID [--observed .. --cause .. --absence .. --assumption .. --falsify ..]
  genlock done ID                                 REFUSES unless every requirement is proved
  genlock block ID "WHY"  |  genlock abandon ID "WHY"  |  genlock note ID "WHAT"
  genlock lint -r ".." -c ".."  |  genlock lint ID

BUGS      a defect closes only once its cause is on record; retros group causes so systemic ones surface
  genlock new "TITLE" --bug [--found-by "playtest 2026-11-13"|TICKET] -r .. -c ..  |  genlock bug ID [--found-by ..]
  genlock cause ID --symptom .. --root-cause .. [--why .. ×N] [--contributing ..] --scope one-off|systemic
                   --system .. --class .. --corrective .. --preventive ".."|"none: WHY" --gate "WHERE IT RUNS" [--related T-..]
  genlock cause ID                              which cause fields are set  |  genlock cause ID --waive FIELD --reason ".."
  genlock classes [--counts] [--goal G]  |  genlock classes add NAME "MEANING"   the cause-class vocabulary
  genlock retro GOAL [--since YYYY-MM-DD] [--out PATH]   report: clusters, one-offs that look systemic, preventive gaps,
                                                         unclassified bugs, and draft systemic tickets for the user to accept

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
  genlock followups [--json]                      what this session identified and has not finished
  genlock swap GOAL                               conversation grown long: checkpoint, then this same work carried on
                                                  in a fresh session in this tab (no yes needed: it saves tokens)
  genlock open --handoff [--prompt ".."]          the same from anywhere: a fresh session takes this one's tasks, this one closes
  genlock open [PROJECT] --prompt ".."            a fresh session, here or in another project (12 per project; --over-cap ".." past that)
  genlock close --self --user-said ".."           when the user says you can close: checkpoint, then this session closes

REVIEWS   files the user should look at, kept findable
  genlock review PATH --why ".." [--about GOAL|TICKET]  |  genlock review list [--all]  |  genlock review done R [--note ..]

QUESTIONS between sessions; nobody waits for an answer
  genlock ask TICKET|any "QUESTION"  |  genlock answer Q "ANSWER"  |  genlock inbox
  genlock ask user "QUESTION" [--about GOAL|TICKET]  |  genlock answer Q "ANSWER" --user-said ".."
  genlock ask assistant "MESSAGE"                  in the app: message this project's Assistant, mid-turn
  genlock deliver                                 the Claude Code PostToolUse hook

CLAIMS    who is working on what, right now
  genlock claim ID --path P [--resource R] [--ttl MIN] [--replace]
  genlock release ID [--reason ..]  |  genlock claims [--json]  |  genlock check --path P [--resource R]
  genlock guard                                   the Claude Code PreToolUse hook
  genlock session-end                             the Claude Code SessionEnd hook: releases the session's claims

SPIN-OFFS move a tangent into its own session, once the user says yes
  genlock spinoff propose "TITLE" --parent ID --why ".." --context ".." --path P --needs none --blocks none
  genlock spinoff check ID  |  genlock spinoff amend ID ..  |  genlock spinoff park ID "WHY"
  genlock spinoff launch ID --user-said ".." [--worktree]   (or --relayed, on a yes the Assistant passed on)

  genlock mcp                                     run as an MCP server, over stdio
  genlock snapshot                                everything above as JSON, for tools that display it
  genlock sprint [current|previous|-N|YYYY-MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD] [--all] [--json]
                                  what got done in a sprint (one week, from one Claude weekly reset to the next)
                                  or a date range; --all covers every project in the app
  genlock sprint --set-reset "thu 17:00 America/Los_Angeles"   when the weekly usage resets: sprints follow it
  genlock say "TEXT"                              speak a reply, in a session started with a voice channel
  genlock voice [set|list|sample|install]         this project's Genlock voice: one per project, recorded so it never changes
  genlock title "NAME"  |  genlock title --clear   name this session in the app and on the phone, two to four words
  genlock wait "TEXT" --state testing|running|queued|waiting  |  genlock wait --clear
  genlock load [--json]  |  genlock load snooze|test cpu|memory|battery|session|weekly   how pressured the Mac is; quiet or test its load alerts
                                  show the app what this session is on, in your words: testing and running
                                  are work happening; queued and waiting are nothing happening until something moves
  genlock backup [--all] [--out DIR]              one archive of goals and tasks (--all: every project in the app),
                                  in ~/genlock-backups unless --out says
  genlock restore ARCHIVE [--project NAME] [--into DIR] [--force]  |  genlock restore ARCHIVE --list
                                  put records back; refuses over existing records unless --force, which saves them first
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
  attach: cmdAttach,
  files: cmdFiles,
  purge: cmdPurge,
  forbid: cmdForbid,
  unforbid: cmdUnforbid,
  hazard: cmdHazard,
  decide: cmdDecide,
  orient: cmdOrient,
  checkpoint: cmdCheckpoint,
  continue: cmdContinue,
  swap: cmdSwap,
  followups: cmdFollowups,
  ask: cmdAsk,
  answer: cmdAnswer,
  inbox: cmdInbox,
  deliver: cmdDeliver,
  mcp: runMcp,
  review: cmdReview,
  snapshot: cmdSnapshot,
  sprint: cmdSprint,
  backup: cmdBackup,
  tag: cmdTag,
  tagged: cmdTagged,
  meta: cmdMeta,
  filed: cmdFiled,
  unfiled: cmdUnfiled,
  restore: cmdRestore,
  bug: cmdBug,
  cause: cmdCause,
  classes: cmdClasses,
  retro: cmdRetro,
  overview: cmdOverview,
  tell: cmdTell,
  sweep: cmdSweep,
  close: cmdClose,
  open: cmdOpen,
  name: cmdName,
  remember: cmdRemember,
  remembered: cmdRemembered,
  'clear-context': cmdClearContext,
  rank: cmdRank,
  due: cmdDue,
  short: cmdShort,
  say: cmdSay,
  title: cmdTitle,
  'voice-check': cmdVoiceCheck,
  voice: cmdVoice,
  'session-state': cmdSessionState,
  wait: cmdWait,
  'status-line': cmdStatusLine,
  load: cmdLoad,
  claim: cmdClaim,
  release: cmdRelease,
  claims: cmdClaims,
  check: cmdCheck,
  guard: cmdGuard,
  'session-end': cmdSessionEnd,
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
// Repeatable on `cause` only: elsewhere --why is a single reason.
const CAUSE_MULTI = new Set(['why', 'contributing', 'related']);
const FLAGS = new Set(['take-over', 'queued', 'open', 'all', 'json', 'quiet', 'loose', 'draft', 'replace', 'worktree', 'parent-idle', 'still-right', 'records', 'relayed', 'self', 'handoff', 'orphans', 'force', 'hub', 'list', 'bug', 'counts']);

function parse(argv, cmd) {
  const a = { _: [], r: [], c: [] };
  const put = (name, val) => {
    const key = name.replace(/-/g, '_');
    if (MULTI.has(name) || (cmd === 'cause' && CAUSE_MULTI.has(name))) (a[key] ||= []).push(val); else a[key] = val;
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      let name = tok.slice(2); let val = null;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (FLAGS.has(name) && val === null) { a[name.replace(/-/g, '_')] = true; continue; }
      // `tell --do` / `tell --ask` stand alone, while `new --ask ..` takes a question.
      if (val === null && cmd === 'tell' && (name === 'do' || name === 'ask')) { a[name] = true; continue; }
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
// Its flags belong to the command it runs, so this one is not parsed here.
if (argv[0] === 'at') runAt(argv.slice(1));
const fn = COMMANDS[argv[0]];
if (!fn) die(`unknown command '${argv[0]}'. \`genlock help\` lists them.`);
if (fn === cmdInstall || fn === cmdInit || fn === cmdGuide) fn();
else fn(parse(argv.slice(1), argv[0]));

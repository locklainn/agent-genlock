/**
 * The MCP server: the same operations as the CLI, as named tools any MCP client can
 * discover. Every tool runs the CLI itself, so a refusal is the same refusal and there is
 * no second implementation to drift. A refusal comes back as a tool error, with the reason.
 *
 * Speaks JSON-RPC over stdio, one message per line. No dependencies.
 */

import readline from 'node:readline';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'genlock.mjs');
const str = (description) => ({ type: 'string', description });
const list = (description) => ({ type: 'array', items: { type: 'string' }, description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

const flag = (name, v) => (v === undefined || v === null || v === '' ? [] : [`--${name}`, String(v)]);
const each = (name, vs) => (vs || []).flatMap((v) => [name, v]);
const on = (name, v) => (v ? [`--${name}`] : []);

/* [name, description, properties, required, argv builder] */
const TOOLS = [
  ['orient', 'What this repository is working toward right now: goals, next things, open tickets, who is working where. Use when asked "what are the goals" or "what is going on", and when starting work.',
    {}, [], () => ['orient']],
  ['continue_work', 'Everything needed to carry on with a goal or ticket. Use when the user says "continue" or "pick this back up". With no id, finds the goal from the last checkpoint and may ask which goal is meant.',
    { id: str('Goal or ticket id (optional)') }, [], (a) => ['continue', ...(a.id ? [a.id] : [])]],
  ['checkpoint', 'Use when the user says "start a handoff" or wants to clear context. Refuses until every ticket\'s latest and goal\'s next things are current, naming what is missing.',
    { uncommitted: str('What any uncommitted files are') }, [], (a) => ['checkpoint', ...flag('uncommitted', a.uncommitted)]],

  ['goals_list', 'List goals with progress counted from their tickets.',
    { all: bool('Include finished, dropped and rejected goals') }, [], (a) => ['goal', 'list', ...on('all', a.all)]],
  ['goal_show', 'One goal: next things, decisions, tickets and each ticket\'s latest.',
    { id: str('Goal id') }, ['id'], (a) => ['goal', 'show', a.id]],
  ['goal_add', 'Set a goal the user has stated. Requires the user\'s own words.',
    { title: str('The goal'), user_said: str('The user\'s words'), why: str('Why it matters'), done_when: str('What would show it is reached'), short: str('A two or three word name for it') },
    ['title', 'user_said'], (a) => ['goal', 'add', a.title, ...flag('short', a.short), ...flag('user-said', a.user_said), ...flag('why', a.why), ...flag('done-when', a.done_when)]],
  ['goal_propose', 'Record a possible new goal noticed during the work. It is not active until the user accepts it, so ask them.',
    { title: str('The goal'), why: str('What in the work suggests it'), short: str('A two or three word name for it') }, ['title', 'why'],
    (a) => ['goal', 'propose', a.title, ...flag('short', a.short), ...flag('why', a.why)]],
  ['goal_accept', 'The user said yes to a proposed goal.',
    { id: str('Goal id'), user_said: str('The user\'s words') }, ['id', 'user_said'], (a) => ['goal', 'accept', a.id, ...flag('user-said', a.user_said)]],
  ['goal_reject', 'The user said no to a proposed goal.',
    { id: str('Goal id'), user_said: str('The user\'s words') }, ['id', 'user_said'], (a) => ['goal', 'reject', a.id, ...flag('user-said', a.user_said)]],
  ['goal_next', 'Keep a goal\'s next things current: add one, mark one done, or confirm they are still right. With only an id, lists them.',
    { id: str('Goal id'), add: str('A next thing to add'), due: str('Its deadline, YYYY-MM-DD'), done: num('Number of the next thing that is finished'), move: num('Number to reorder'), to: num('Its new position'), still_right: bool('Confirm the list is still right') },
    ['id'], (a) => ['goal', 'next', a.id, ...(a.add ? [a.add] : []), ...flag('due', a.due), ...flag('done', a.done), ...flag('move', a.move), ...flag('to', a.to), ...on('still-right', a.still_right)]],
  ['rank', 'See or change the strict order of goals or tasks, most important first. No two share a place. With no id, shows the order. With an id, moves it to place `to`, or before `before`.',
    { id: str('Goal or ticket id to move'), to: num('Place to move it to, counting from 1'), before: str('Another id of the same kind to move it before') }, [],
    (a) => ['rank', ...(a.id ? [a.id] : []), ...flag('to', a.to), ...flag('before', a.before)]],
  ['short', 'Give a goal or ticket a short name to use instead of its id.',
    { id: str('Goal or ticket'), name: str('The short name') }, ['id', 'name'], (a) => ['short', a.id, a.name]],
  ['due', 'Set or clear the due date of a goal or ticket.',
    { id: str('Goal or ticket id'), date: str('The date, YYYY-MM-DD'), clear: bool('Remove the due date') }, ['id'],
    (a) => ['due', a.id, ...(a.date ? [a.date] : []), ...on('clear', a.clear)]],
  ['goal_update', 'Record what moved on a goal. Progress counts are added automatically.',
    { id: str('Goal id'), text: str('What moved') }, ['id', 'text'], (a) => ['goal', 'update', a.id, a.text]],
  ['goal_done', 'Close a goal. Refused while it has open tickets. Requires the user\'s own words.',
    { id: str('Goal id'), evidence: str('What shows it was reached'), user_said: str('The user\'s words') },
    ['id', 'evidence', 'user_said'], (a) => ['goal', 'done', a.id, ...flag('evidence', a.evidence), ...flag('user-said', a.user_said)]],
  ['goals_completed', 'Finished goals, newest first, with when and what showed it.',
    {}, [], () => ['goal', 'completed']],
  ['goal_reopen', 'Make a completed goal active again. Requires the user\'s own words.',
    { id: str('Goal id'), user_said: str('The user\'s words') }, ['id', 'user_said'], (a) => ['goal', 'reopen', a.id, ...flag('user-said', a.user_said)]],

  ['tickets_list', 'List tickets.',
    { open: bool('Only open tickets'), goal: str('Only tickets for this goal'), bug: bool('Only bug tickets'), class: str('Only bugs of this cause class'), system: str('Only bugs in this system') }, [],
    (a) => ['list', ...on('open', a.open), ...flag('goal', a.goal), ...on('bug', a.bug), ...flag('class', a.class), ...flag('system', a.system)]],
  ['ticket_bug', 'Mark an existing ticket as a bug, so it closes only once its cause is recorded.',
    { id: str('Ticket id'), found_by: str('What found it, or a ticket id') }, ['id'], (a) => ['bug', a.id, ...flag('found-by', a.found_by)]],
  ['bug_cause', 'Record a bug ticket\'s cause. ticket_done refuses a bug until symptom, root_cause, scope, system, class, corrective and preventive are set, and gate whenever there is a preventive. With only an id, shows which are set. Prints other bugs sharing the class or system, so names converge.',
    {
      id: str('Ticket id'), symptom: str('What was observed, and where'), root_cause: str('The cause, reached by asking why until it is changeable'),
      whys: list('One "why" step each (five whys)'), contributing: list('Conditions that let it happen'), scope: str('one-off or systemic'),
      system: str('Which system it lives in; reuse a name already on the goal'), class: str('Cause class; bug_classes lists them'),
      corrective: str('What this fix changed'), preventive: str('The check or rule that stops the kind recurring, or "none: <reason>"'),
      gate: str('Where the preventive runs before a change lands: pre-commit, CI, the suite every build runs'), related: list('Other tickets with the same cause'),
      waive: str('A required field that cannot be known'), reason: str('Why it cannot be known, with waive'),
    }, ['id'],
    (a) => ['cause', a.id, ...flag('symptom', a.symptom), ...flag('root-cause', a.root_cause), ...each('--why', a.whys), ...each('--contributing', a.contributing),
      ...flag('scope', a.scope), ...flag('system', a.system), ...flag('class', a.class), ...flag('corrective', a.corrective), ...flag('preventive', a.preventive),
      ...flag('gate', a.gate), ...each('--related', a.related), ...flag('waive', a.waive), ...flag('reason', a.reason)]],
  ['bug_classes', 'The cause-class vocabulary for bugs, or with counts, how many bugs fall in each.',
    { counts: bool('Count bugs per class'), goal: str('Only bugs on this goal') }, [], (a) => ['classes', ...on('counts', a.counts), ...flag('goal', a.goal)]],
  ['bug_class_add', 'Add a cause class when none in bug_classes fits.',
    { name: str('The class name'), meaning: str('What this kind of cause is') }, ['name', 'meaning'], (a) => ['classes', 'add', a.name, a.meaning]],
  ['retro', 'A bug retro over a goal: groups bug causes by class and system so systemic ones surface, writes a markdown report, and drafts systemic tickets for the user to accept. Offer one when ten bugs have closed since the last.',
    { goal: str('Goal id'), since: str('Only bugs closed or opened since YYYY-MM-DD'), out: str('Report path') }, ['goal'],
    (a) => ['retro', a.goal, ...flag('since', a.since), ...flag('out', a.out)]],
  ['ticket_show', 'One ticket: latest, decisions, requirements, evidence, log.',
    { id: str('Ticket id') }, ['id'], (a) => ['show', a.id]],
  ['ticket_new', 'Open a ticket before starting work. Vague requirements are refused. Each requirement is true or false when finished, with a check.',
    { title: str('The outcome'), short: str('A two or three word name for it'), requirements: list('What must be true'), checks: list('How each is checked, in the same order'), goal: str('Goal id'), ask: str('The user\'s words'), draft: bool('Requirements come later'),
      bug: bool('The work is a defect: something built that does not behave as intended. It closes only once its cause is recorded with bug_cause'), found_by: str('For a bug: what found it, e.g. "playtest 2026-11-13", or a ticket id') },
    ['title'], (a) => ['new', a.title, ...flag('short', a.short), ...(a.requirements || []).flatMap((r, i) => ['-r', r, '-c', (a.checks || [])[i] || '']), ...flag('goal', a.goal), ...flag('ask', a.ask), ...on('draft', a.draft), ...on('bug', a.bug), ...flag('found-by', a.found_by)]],
  ['ticket_start', 'Take a ticket: it becomes in progress and owned by this session.',
    { id: str('Ticket id'), because: str('Required if blocked: what changed, and who said so'),
      take_over: str('Set to "yes" to take a ticket another live session holds; needs user_said'), user_said: str('The user\'s words allowing a take-over') },
    ['id'], (a) => ['start', a.id, ...flag('because', a.because), ...(a.take_over ? ['--take-over'] : []), ...flag('user-said', a.user_said)]],
  ['ticket_requirement', 'Add a requirement to a ticket.',
    { id: str('Ticket id'), requirement: str('What must be true'), check: str('How it is checked') }, ['id', 'requirement', 'check'],
    (a) => ['req', a.id, '-r', a.requirement, '-c', a.check]],
  ['ticket_update', 'Set a ticket\'s latest: what just happened and where it stands. Call this as work moves, since it is what the next session reads.',
    { id: str('Ticket id'), text: str('The latest') }, ['id', 'text'], (a) => ['update', a.id, a.text]],
  ['ticket_met', 'Prove a requirement with what you observed, such as a command and its output.',
    { id: str('Ticket id'), n: num('Requirement number'), evidence: str('What you observed') }, ['id', 'n', 'evidence'],
    (a) => ['met', a.id, String(a.n), ...flag('evidence', a.evidence)]],
  ['ticket_grill', 'Answer the five fixed questions before closing a ticket. With only an id, shows which are open.',
    { id: str('Ticket id'), observed: str('Observed or derived?'), cause: str('Measurement or hypothesis?'), absence: str('Missing, or merely unmatched?'), assumption: str('Whose assumption?'), falsify: str('What would falsify it?') },
    ['id'], (a) => ['grill', a.id, ...['observed', 'cause', 'absence', 'assumption', 'falsify'].flatMap((k) => flag(k, a[k]))]],
  ['ticket_done', 'Close a ticket. Refused unless every requirement is proved and the grill is answered.',
    { id: str('Ticket id') }, ['id'], (a) => ['done', a.id]],
  ['ticket_assign', 'Assign a ticket to a session.',
    { id: str('Ticket id'), owner: str('Session') }, ['id', 'owner'], (a) => ['assign', a.id, a.owner]],
  ['ticket_link', 'Associate a ticket with a goal.',
    { id: str('Ticket id'), goal: str('Goal id') }, ['id', 'goal'], (a) => ['link', a.id, a.goal]],
  ['decide', 'Record a decision on the ticket or goal it governs, in the words of whoever made it.',
    { id: str('Ticket or goal id'), text: str('The decision'), user_said: str('The user\'s words, if theirs'), supersedes: num('Number of a decision this withdraws') }, ['id', 'text'],
    (a) => ['decide', a.id, a.text, ...flag('user-said', a.user_said), ...flag('supersedes', a.supersedes)]],

  ['ref', 'Point a ticket or goal at a file holding durable findings. Findings stay in files; records point at them.',
    { id: str('Ticket or goal id'), path: str('Path'), why: str('What the reader finds there, and when they need it') }, ['id', 'path', 'why'],
    (a) => ['ref', a.id, a.path, ...flag('why', a.why)]],
  ['forbid', 'Record a hard stop: something later agents must not do, and who can lift it.',
    { id: str('Ticket or goal id'), text: str('What must not be done'), lifted_by: str('Who or what can lift it') }, ['id', 'text', 'lifted_by'],
    (a) => ['forbid', a.id, a.text, ...flag('lifted-by', a.lifted_by)]],
  ['unforbid', 'Lift a hard stop, in the words of whoever lifted it.',
    { id: str('Ticket or goal id'), n: num('Stop number'), user_said: str('Their words') }, ['id', 'n', 'user_said'],
    (a) => ['unforbid', a.id, String(a.n), ...flag('user-said', a.user_said)]],
  ['hazard', 'Record something left behind that the next agent must verify, such as a stray process or suspect uncommitted file.',
    { id: str('Ticket id'), what: str('What was left behind'), verify: str('How to check it') }, ['id', 'what', 'verify'],
    (a) => ['hazard', a.id, a.what, ...flag('verify', a.verify)]],
  ['hazard_clear', 'Mark a hazard dealt with.',
    { id: str('Ticket id'), n: num('Hazard number'), evidence: str('What you observed') }, ['id', 'n', 'evidence'],
    (a) => ['hazard', a.id, ...flag('clear', a.n), ...flag('evidence', a.evidence)]],
  ['goal_park', 'Set a goal aside until someone or something brings it back.',
    { id: str('Goal id'), waiting_on: str('Who or what') }, ['id', 'waiting_on'], (a) => ['goal', 'park', a.id, ...flag('waiting-on', a.waiting_on)]],
  ['goal_unpark', 'Bring a parked goal back.', { id: str('Goal id') }, ['id'], (a) => ['goal', 'unpark', a.id]],
  ['ask_user', 'Add a question to the list of what waits on the user. Use for decisions that are theirs. Surfaces at every session start until answered.',
    { text: str('The question'), about: str('Goal or ticket id') }, ['text'], (a) => ['ask', 'user', a.text, ...flag('about', a.about)]],
  ['answer_user_question', 'Record the user\'s answer to a question waiting on them.',
    { id: str('Question id'), text: str('The answer'), user_said: str('Their words') }, ['id', 'text', 'user_said'],
    (a) => ['answer', a.id, a.text, ...flag('user-said', a.user_said)]],

  ['review_request', 'Whenever you ask the user to read, check or approve a file, register it here so it stays findable. Takes a path or URL.',
    { path: str('File path or URL'), why: str('What to look at, and what you need from them'), about: str('Goal or ticket id') }, ['path', 'why'],
    (a) => ['review', a.path, ...flag('why', a.why), ...flag('about', a.about)]],
  ['reviews_list', 'Files waiting for the user to review.', { all: bool('Include finished ones') }, [], (a) => ['review', 'list', ...on('all', a.all)]],
  ['review_done', 'The user has dealt with a review request.',
    { id: str('Review id'), note: str('What they said') }, ['id'], (a) => ['review', 'done', a.id, ...flag('note', a.note)]],

  ['claim', 'Declare what this session is about to touch. Refused if another session holds it.',
    { id: str('Ticket id or a name'), paths: list('Paths or globs'), resources: list('Shared things, such as a build slot') }, ['id'],
    (a) => ['claim', a.id, ...each('--path', a.paths), ...each('--resource', a.resources)]],
  ['release', 'Let go of what a ticket holds.',
    { id: str('Ticket id or a name'), reason: str('Required for another session\'s claim') }, ['id'], (a) => ['release', a.id, ...flag('reason', a.reason)]],
  ['claims', 'Who holds what right now.', {}, [], () => ['claims']],

  ['ask_session', 'Ask whoever is working a ticket, or "any" session, a question. Do not wait: it reaches them at their next tool call and the answer reaches you the same way.',
    { to: str('Ticket id, or "any"'), text: str('The question') }, ['to', 'text'], (a) => ['ask', a.to, a.text]],
  ['answer_session', 'Answer another session\'s question.',
    { id: str('Question id'), text: str('The answer') }, ['id', 'text'], (a) => ['answer', a.id, a.text]],
  ['inbox', 'Questions for this session, and answers to its own.', {}, [], () => ['inbox']],

  ['spinoff_propose', 'Move a tangent into its own session. Records the ticket and runs the safety check. Never launches: if safe, offer it to the user and wait.',
    {
      title: str('The outcome'), why: str('Why it deserves its own session'), context: str('What the new agent needs to know'), parent: str('Ticket it came from'),
      parent_idle: bool('This session is writing nothing else'), paths: list('What it will touch'), resources: list('Shared things it needs'),
      needs: str('What it needs from the parent\'s unfinished work, or "none"'), blocks: str('What the parent needs from it, or "none"'), decisions: list('Decisions it inherits'),
    }, ['title', 'why', 'context', 'paths', 'needs', 'blocks'],
    (a) => ['spinoff', 'propose', a.title, ...flag('why', a.why), ...flag('context', a.context), ...flag('parent', a.parent), ...on('parent-idle', a.parent_idle),
      ...each('--path', a.paths), ...each('--resource', a.resources), ...flag('needs', a.needs), ...flag('blocks', a.blocks), ...each('--decisions', a.decisions)]],
  ['spinoff_check', 'Re-run the safety check on a spin-off.',
    { id: str('Ticket id') }, ['id'], (a) => ['spinoff', 'check', a.id]],
  ['spinoff_launch', 'Open the spin-off in a new terminal window. Only after the user says yes. Re-checks safety first.',
    { id: str('Ticket id'), user_said: str('The user\'s yes, in their words') }, ['id', 'user_said'], (a) => ['spinoff', 'launch', a.id, ...flag('user-said', a.user_said)]],
  ['spinoff_park', 'Not now. The ticket stays.',
    { id: str('Ticket id'), why: str('Why') }, ['id', 'why'], (a) => ['spinoff', 'park', a.id, a.why]],
].map(([name, description, properties, required, build]) => ({ name, description, properties, required, build }));

function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `no tool '${name}'` }] };
  const r = spawnSync(process.execPath, [CLI, ...tool.build(args)], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim() || '(no output)';
  return { isError: r.status !== 0, content: [{ type: 'text', text }] };
}

const INSTRUCTIONS = 'genlock keeps agents aligned through shared goals and tickets. Call `orient` when starting work or when '
  + 'asked about goals or status. Keep tickets\' latest and goals\' next things current as work moves. "Start a handoff" means '
  + 'call `checkpoint`; "continue" means call `continue_work`. Claim before editing. Offer a spin-off only after `spinoff_propose` says safe.';

export function runMcp() {
  const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'parse error' } }); return; }
    const { id, method, params } = m;
    if (id === undefined) return; // A notification takes no reply.
    if (method === 'initialize') {
      send({ id, result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'genlock', version: '2.2.0' }, instructions: INSTRUCTIONS,
      } });
    } else if (method === 'ping') {
      send({ id, result: {} });
    } else if (method === 'tools/list') {
      send({ id, result: { tools: TOOLS.map((t) => ({
        name: t.name, description: t.description,
        inputSchema: { type: 'object', properties: t.properties, required: t.required },
      })) } });
    } else if (method === 'tools/call') {
      send({ id, result: callTool(params?.name, params?.arguments) });
    } else {
      send({ id, error: { code: -32601, message: `no method '${method}'` } });
    }
  });
}

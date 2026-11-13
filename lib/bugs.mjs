/**
 * Bug tickets. A bug is something built that does not behave as intended, and fixing one is
 * not finished until its CAUSE is on record: what was seen, why it happened, whether the cause
 * is one-off or systemic, which system it lives in, what class of cause it is, what the fix
 * changed, and what stops the kind recurring. Agents fix bugs one at a time and each session
 * sees only its own ticket, so a systemic cause shared by several bugs stays invisible unless
 * the causes are written down in a shape a retro can group. `genlock retro` does the grouping.
 *
 * This module holds the fields and the replay; it imports nothing from tickets.mjs, so
 * tickets.mjs can use it. The commands are in retro.mjs.
 */

import { die, readEvents, slugify } from './store.mjs';

/** Every cause field, its flag, and what it asks. `list` fields append; the rest replace. */
export const CAUSE_FIELDS = [
  { key: 'symptom', flag: 'symptom', required: true, ask: 'what was observed, and where (screen, log, coordinate)' },
  { key: 'root_cause', flag: 'root-cause', required: true, ask: 'the cause, reached by asking why until the answer is something changeable' },
  { key: 'whys', flag: 'why', list: true, ask: 'one "why" step per flag (five whys); optional, encouraged' },
  { key: 'contributing', flag: 'contributing', list: true, ask: 'conditions that let it happen or hid it' },
  { key: 'scope', flag: 'scope', required: true, ask: 'one-off | systemic' },
  { key: 'system', flag: 'system', required: true, ask: 'which system it lives in (reuse a name already on the goal)' },
  { key: 'class', flag: 'class', required: true, ask: 'the cause class (`genlock classes` lists them)' },
  { key: 'corrective', flag: 'corrective', required: true, ask: 'what this fix changed' },
  { key: 'preventive', flag: 'preventive', required: true, ask: 'the check or rule added so the kind cannot recur, or "none: <reason>"' },
  { key: 'gate', flag: 'gate', ask: 'where the preventive runs before a change lands (pre-commit hook, CI job, the suite every build runs); required with a preventive' },
  { key: 'related', flag: 'related', list: true, ask: 'other tickets with the same cause' },
];
export const REQUIRED_CAUSE = CAUSE_FIELDS.filter((f) => f.required).map((f) => f.key);
export const SCOPES = ['one-off', 'systemic'];

/** The starting vocabulary. Extend it per project with `genlock classes add NAME "meaning"`. */
export const BASE_CLASSES = {
  'stale-proxy-check': 'a check passed by looking at a stand-in (a flag, a cached value, a file) instead of the real thing',
  'clock-domain-mismatch': 'two clocks or time bases compared as if they were one (wall vs. monotonic, server vs. client, frames vs. ms)',
  'nondeterministic-test': 'a test whose result depends on timing, order, randomness or the environment',
  'load-on-first-use': 'something loaded or initialised lazily, so the first use is slow, empty or wrong',
  'data-model-mismatch': 'two parts disagree about the shape or meaning of the same data',
  'artifact-offered-as-design': 'a by-product of how something was built was shown or kept as if it were the intended design',
  'missing-multiplayer-path': 'the single-player or single-user path was built; the shared or networked one was not',
  'missing-error-path': 'the failure case was never handled, so it fails silently or wrongly',
  'unhandled-edge-case': 'a boundary input (empty, zero, maximum, unicode) the code did not consider',
  'race-condition': 'two things happen in an order the code did not expect',
  'config-drift': 'one configuration differs between places that were meant to match',
  'spec-misread': 'it was built as specified, but the specification was understood differently from what was meant',
  'split-ownership': 'two places each own part of one thing, so neither keeps it whole',
  'placeholder-shipped': 'a stand-in (placeholder geometry, stub data, temporary art) stayed in as if final',
  'missing-generator-rule': 'a generator or procedural rule had no case for this, so its output is wrong or missing',
  'missing-inverse': 'one direction of a behaviour was built (open, add, enter) and its inverse was not',
  'unchecked-on-target': 'checked in isolation, never on the real target it runs on (the body, the device, the build)',
  'opt-in-guard': 'a guard exists but runs only when someone chooses to run it, so changes slip past it',
  'environment-difference': 'works in one environment and not another (machine, OS, build mode, network)',
};

/** A gate that says "none" is no gate: the check still runs only when someone remembers it. */
export const gated = (b) => !!b.gate && !/^none\b/i.test(b.gate);

export const emptyBug = () => ({
  found_by: '', symptom: '', root_cause: '', whys: [], contributing: [], scope: '', system: '', class: '',
  corrective: '', preventive: '', related: [], waived: {},
});

/** Replay a bug op onto a ticket. True if this event was one. */
export function applyBug(t, e, log) {
  switch (e.op) {
    case 'bug':
      t.bug ||= emptyBug();
      if (e.found_by) t.bug.found_by = e.found_by;
      log(e, 'bug', `marked a bug${e.found_by ? `, found by ${e.found_by}` : ''}`);
      return true;
    case 'cause': {
      t.bug ||= emptyBug();
      const set = [];
      for (const f of CAUSE_FIELDS) {
        const v = e.fields?.[f.key];
        if (v === undefined) continue;
        // null clears a field, so a wrong value can be taken back.
        if (v === null) { t.bug[f.key] = f.list ? [] : ''; set.push(`${f.flag} cleared`); continue; }
        if (f.list) for (const x of [].concat(v)) { if (!t.bug[f.key].includes(x)) t.bug[f.key].push(x); }
        else t.bug[f.key] = v;
        delete t.bug.waived[f.key];
        set.push(f.flag);
      }
      log(e, 'cause', set.join(', '));
      return true;
    }
    case 'cause_waive':
      t.bug ||= emptyBug();
      t.bug.waived[e.field] = e.reason;
      log(e, 'cause', `${e.field} waived: ${e.reason}`);
      return true;
    default: return false;
  }
}

/** What stops a bug ticket closing: each required field neither set nor waived. */
export function bugGaps(t) {
  if (!t.bug) return [];
  const gaps = [];
  for (const k of REQUIRED_CAUSE) {
    const f = CAUSE_FIELDS.find((x) => x.key === k);
    if (t.bug.waived[k]) continue;
    if (!t.bug[k]) gaps.push(`--${f.flag} is not set: ${f.ask}`);
  }
  const p = t.bug.preventive;
  if (p && /^none\b/i.test(p) && !/^none\s*:\s*\S/i.test(p))
    gaps.push('--preventive says none without a reason. Write "none: <why no check can stop this kind>"');
  // A guard nobody runs prevents nothing: the check has to sit where every change passes it.
  if (p && !/^none\b/i.test(p) && !gated(t.bug) && !t.bug.waived.gate)
    gaps.push('--gate is not set: where the preventive runs before a change lands (pre-commit hook, CI job, the suite every'
      + ' build runs). A check that runs only when someone opts in does not prevent anything');
  return gaps;
}

const show = (v) => (Array.isArray(v) ? v.join(' | ') : v);

/** The cause block `genlock show` prints. */
export function bugLines(t) {
  if (!t.bug) return [];
  const b = t.bug;
  const L = ['', `  BUG${b.found_by ? `, found by ${b.found_by}` : ''}  (cause: ${REQUIRED_CAUSE.filter((k) => b[k] || b.waived[k]).length} of ${REQUIRED_CAUSE.length} required fields set)`];
  for (const f of CAUSE_FIELDS) {
    const v = b[f.key];
    if (f.key === 'whys') { v.forEach((w, i) => L.push(`    ${(i === 0 ? 'why:' : '').padEnd(14)}${i + 1}. ${w}`)); continue; }
    if (Array.isArray(v) ? v.length : v) L.push(`    ${(`${f.key.replace('_', ' ')}:`).padEnd(14)}${show(v)}`);
    else if (b.waived[f.key]) L.push(`    ${(`${f.key.replace('_', ' ')}:`).padEnd(14)}[waived] ${b.waived[f.key]}`);
    else if (f.required) L.push(`    ${(`${f.key.replace('_', ' ')}:`).padEnd(14)}[ ] not set`);
  }
  return L;
}

/** The project's class vocabulary: the base set plus any added with `genlock classes add`. */
export function classVocabulary() {
  const v = { ...BASE_CLASSES };
  for (const e of readEvents('project')) if (e.op === 'class_add') v[e.name] = e.meaning;
  return v;
}

/** A class or system name, normalised so "Clock Domain" and "clock-domain" converge. */
export function cleanName(raw, what) {
  const n = slugify(String(raw));
  if (!n) die(`${what} needs a name`);
  return n;
}

/** Titles that say "bug" but were never marked: listed by retros, never guessed into a class. */
export const titledAsBug = (t) => /^\s*(bug|defect)\b\s*[:\-]/i.test(t.title);

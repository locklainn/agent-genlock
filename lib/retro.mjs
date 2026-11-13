/**
 * Bug commands and goal retros.
 *
 *   genlock bug ID [--found-by ..]          mark an existing ticket as a bug
 *   genlock cause ID --symptom .. --root-cause .. --why .. --contributing .. --scope one-off|systemic
 *                    --system .. --class .. --corrective .. --preventive .. --gate .. --related T-..
 *   genlock cause ID --waive FIELD --reason ".."
 *   genlock classes [--counts] [--goal G]  |  genlock classes add NAME "MEANING"
 *   genlock retro GOAL [--since YYYY-MM-DD] [--out PATH]
 *
 * A retro is generated from the records and nothing else: the same records give the same
 * report, byte for byte. It never guesses a cause; a bug missing its fields is listed as
 * unclassified. The proposed systemic tickets are drafts, never started: the user accepts them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { die, emit, newId, parseDue, readEvents, repoRoot, resolveId, shortName } from './store.mjs';
import { allTickets, loadTicket, openTicket, requireTicket } from './tickets.mjs';
import { loadGoal } from './goals.mjs';
import { CAUSE_FIELDS, REQUIRED_CAUSE, SCOPES, bugGaps, classVocabulary, cleanName, titledAsBug } from './bugs.mjs';

/** Closed bugs on a goal since its last retro at which a retro is offered. */
export const RETRO_EVERY = 10;
const READING_MARK = '<!-- END OF GENERATED REPORT. Everything above comes from the records; a written reading goes below. -->';

const label = (id) => `${shortName(id)} (${id})`;
const goalBugs = (goal) => allTickets().filter((t) => t.bug && t.goal === goal && t.status !== 'abandoned');

/** Past retros on a goal, oldest first. */
export const retrosOf = (goal) => readEvents(goal).filter((e) => e.op === 'retro');

/** Bugs on a goal closed since its last retro. */
export function bugsSinceRetro(goal) {
  const last = retrosOf(goal).pop();
  return goalBugs(goal).filter((t) => t.status === 'done' && (!last || t.closed > last.at));
}

/** Printed when a bug closes: the offer of a retro, once the count passes the threshold. */
export function retroNudge(goal) {
  if (!goal) return;
  const n = bugsSinceRetro(goal).length;
  if (n >= RETRO_EVERY) {
    console.log(`${n} bug tickets have closed on ${label(goal)} since its last retro. Offer the user one, in a line:`
      + `\n  "Want a retro over these bugs, to find causes they share?"  then: genlock retro ${goal}`);
  }
}

/** What `goal show` prints about retros. */
export function retroLines(goal) {
  const L = [];
  for (const r of retrosOf(goal)) {
    L.push(`  retro ${r.at.slice(0, 10)}  ${r.path}  (${r.counts.bugs} bugs, ${r.counts.clusters} clusters, ${r.counts.flagged} flagged)`);
  }
  const bugs = goalBugs(goal);
  if (bugs.length) {
    const since = bugsSinceRetro(goal).length;
    L.push(`  bugs: ${bugs.length} on this goal, ${since} closed since the last retro${since >= RETRO_EVERY ? ' -- offer a retro' : ''}`);
  }
  return L;
}

/* ------------------------------------------------------------------- bug, cause */

export function cmdBug(a) {
  const t = requireTicket(a, 'bug');
  const found = a.found_by ? foundByOf(a.found_by) : '';
  if (t.bug && !found) { console.log(`${label(t.id)} is already a bug ticket.`); return; }
  emit(t.id, 'bug', { found_by: found });
  console.log(`${label(t.id)} is a bug ticket. It closes only once its cause is on record:`);
  console.log(`  genlock cause ${t.id} --symptom .. --root-cause .. --scope one-off|systemic --system .. --class .. --corrective .. --preventive ..`);
}

function foundByOf(raw) {
  const s = String(raw).trim();
  const id = /^t-[0-9a-z]{5}$/i.test(s) ? resolveId(s, 'T-', 'ticket') : null;
  return id || s;
}

/** Other bugs, on the same goal when there is one, whose `field` has `value`. */
function sharing(t, field, value) {
  return allTickets().filter((x) => x.id !== t.id && x.bug && x.status !== 'abandoned'
    && (t.goal ? x.goal === t.goal : true) && x.bug[field] === value);
}

export function cmdCause(a) {
  const t = requireTicket(a, 'cause');
  if (!t.bug) die(`${t.id} is not a bug ticket. Mark it first, if it is one:  genlock bug ${t.id}`);
  const where = t.goal ? 'on this goal' : 'in this repository';

  if (a.waive) {
    const f = CAUSE_FIELDS.find((x) => x.flag === a.waive || x.key === a.waive);
    if (!f || !(f.required || f.key === 'gate')) die(`--waive takes one of: ${CAUSE_FIELDS.filter((x) => x.required || x.key === 'gate').map((x) => x.flag).join(', ')}`);
    if (!a.reason || !String(a.reason).trim()) die('a waived cause field needs --reason: why it cannot be known. A waiver is not a finding.');
    emit(t.id, 'cause_waive', { field: f.key, reason: String(a.reason).trim() });
    console.log(`${t.id} ${f.flag} waived: ${a.reason}`);
    return;
  }

  const fields = {};
  const vocab = classVocabulary();
  for (const f of CAUSE_FIELDS) {
    const raw = a[f.flag.replace(/-/g, '_')];
    if (raw === undefined) continue;
    const vals = [].concat(raw).map((v) => String(v).trim()).filter(Boolean);
    if (!vals.length) die(`--${f.flag} needs a value: ${f.ask}`);
    if (f.key === 'scope' && !SCOPES.includes(vals[0])) die(`--scope is one-off or systemic, not '${vals[0]}'`);
    if (f.key === 'class') {
      vals[0] = cleanName(vals[0], 'class');
      if (!vocab[vals[0]]) {
        die(`'${vals[0]}' is not a cause class here. \`genlock classes\` lists them; if none fits, add one:\n`
          + `     genlock classes add ${vals[0]} "what this kind of cause is"`);
      }
    }
    if (f.key === 'system') vals[0] = cleanName(vals[0], 'system');
    if (f.key === 'related') {
      vals.forEach((v, i) => { const id = resolveId(v, 'T-', 'ticket'); if (!id) die(`--related: no ticket '${v}'`); vals[i] = id; });
    }
    fields[f.key] = f.list ? vals : vals[vals.length - 1];
  }
  if (!Object.keys(fields).length) {
    console.log(`  ${label(t.id)}: the cause fields. Set each with --<flag> "..."\n`);
    for (const f of CAUSE_FIELDS) {
      const v = t.bug[f.key];
      const state = (Array.isArray(v) ? v.length : v) ? 'set' : t.bug.waived[f.key] ? 'waived' : f.required ? 'OPEN' : 'optional';
      console.log(`  --${f.flag.padEnd(14)}${state.padEnd(10)}${f.ask}`);
    }
    return;
  }
  // Before writing, so the agent sees which names are already in use and can converge on them.
  const priorSystems = [...new Set(allTickets().filter((x) => x.bug && x.id !== t.id && (!t.goal || x.goal === t.goal)).map((x) => x.bug.system).filter(Boolean))].sort();
  emit(t.id, 'cause', { fields });
  const after = loadTicket(t.id);
  console.log(`${t.id} cause: ${Object.keys(fields).map((k) => CAUSE_FIELDS.find((f) => f.key === k).flag).join(', ')} recorded.`);

  for (const field of ['class', 'system']) {
    if (!fields[field]) continue;
    const others = sharing(after, field, fields[field]);
    if (others.length) {
      console.log(`  ${others.length} other bug${others.length === 1 ? '' : 's'} ${where} share${others.length === 1 ? 's' : ''} ${field} ${fields[field]}: ${others.map((x) => x.id).join(', ')}`);
    } else if (field === 'system' && priorSystems.length) {
      console.log(`  ${fields[field]} is a new system name ${where}. Already in use: ${priorSystems.join(', ')}. Reuse one if it is the same system.`);
    }
  }
  const sharedWith = new Set([...(after.bug.class ? sharing(after, 'class', after.bug.class) : []), ...(after.bug.system ? sharing(after, 'system', after.bug.system) : [])].map((x) => x.id));
  if (after.bug.scope === 'one-off' && sharedWith.size) {
    console.log(`  scope is one-off, but this cause is shared with ${[...sharedWith].join(', ')}. If the fix is one-off by choice,`
      + `\n  say why in --preventive or with genlock decide ${t.id} "..."; otherwise the cause is systemic.`);
  }
  const gaps = bugGaps(after);
  console.log(gaps.length ? `  still needed before done: ${REQUIRED_CAUSE.filter((k) => !after.bug[k] && !after.bug.waived[k]).map((k) => CAUSE_FIELDS.find((f) => f.key === k).flag).join(', ') || gaps.join('; ')}`
    : '  every required cause field is set.');
}

/* ------------------------------------------------------------------------ classes */

export function cmdClasses(a) {
  if (a._[0] === 'add') {
    const name = cleanName(a._[1] || '', 'class');
    const meaning = a._.slice(2).join(' ').trim();
    if (!meaning) die(`classes add needs what the class means:  genlock classes add ${name} "what this kind of cause is"`);
    if (classVocabulary()[name]) die(`'${name}' is already a class: ${classVocabulary()[name]}`);
    emit('project', 'class_add', { name, meaning });
    console.log(`class ${name} added: ${meaning}`);
    return;
  }
  if (a._[0]) die(`unknown classes command '${a._[0]}'. Try: genlock classes [--counts] [--goal G]  |  genlock classes add NAME "MEANING"`);
  const vocab = classVocabulary();
  let bugs = allTickets().filter((t) => t.bug && t.status !== 'abandoned');
  if (a.goal) {
    const g = resolveId(a.goal, 'G-', 'goal');
    if (!g) die(`no goal '${a.goal}' in this repository`);
    bugs = bugs.filter((t) => t.goal === g);
  }
  const count = {};
  for (const t of bugs) if (t.bug.class) count[t.bug.class] = (count[t.bug.class] || 0) + 1;
  const names = Object.keys(vocab).sort((x, y) => (a.counts ? (count[y] || 0) - (count[x] || 0) : 0) || x.localeCompare(y));
  for (const n of names) {
    if (a.counts && !count[n]) continue;
    console.log(`  ${a.counts ? String(count[n]).padStart(3) + '  ' : ''}${n.padEnd(28)}${vocab[n]}`);
  }
  if (a.counts) {
    const unclassified = bugs.filter((t) => !t.bug.class).length;
    if (!names.some((n) => count[n])) console.log('  no classified bugs yet.');
    if (unclassified) console.log(`  ${String(unclassified).padStart(3)}  (no class yet)`);
  } else console.log('\nAdd one with: genlock classes add NAME "what this kind of cause is"');
}

/* -------------------------------------------------------------------------- retro */

const cell = (v) => String(Array.isArray(v) ? v.join('; ') : v || '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ') || '—';
const noPreventive = (b) => !b.preventive || /^none\b/i.test(b.preventive);
/** A preventive with nowhere it runs is a gap too: it relies on someone remembering it. */
const ungated = (b) => !noPreventive(b) && !b.gate;

/** Everything the report says, computed from records. Pure: same tickets in, same object out. */
export function analyse(bugs, unmarked, prior) {
  const clusters = [];
  for (const field of ['class', 'system']) {
    const by = new Map();
    for (const t of bugs) if (t.bug[field]) by.set(t.bug[field], [...(by.get(t.bug[field]) || []), t]);
    for (const [name, ts] of by) {
      if (ts.length < 2) continue;
      // Settled only when every bug in it was treated as systemic AND got a real preventive.
      const flagged = !ts.every((t) => t.bug.scope === 'systemic' && !noPreventive(t.bug) && !ungated(t.bug));
      clusters.push({ key: `${field}:${name}`, field, name, bugs: ts.map((t) => t.id), open: ts.filter((t) => t.status !== 'done').length, flagged });
    }
  }
  clusters.sort((x, y) => y.bugs.length - x.bugs.length || x.key.localeCompare(y.key));
  const inCluster = new Set(clusters.flatMap((c) => c.bugs));
  const looksSystemic = bugs.filter((t) => t.bug.scope === 'one-off' && inCluster.has(t.id))
    .map((t) => ({ t, with: clusters.filter((c) => c.bugs.includes(t.id)).map((c) => c.key) }));
  const preventiveGaps = bugs.filter((t) => t.status === 'done' && ((noPreventive(t.bug) && !t.bug.waived.preventive) || ungated(t.bug)));
  const unclassified = [
    ...bugs.filter((t) => bugGaps(t).length).map((t) => ({ t, missing: REQUIRED_CAUSE.filter((k) => !t.bug[k] && !t.bug.waived[k]).map((k) => CAUSE_FIELDS.find((f) => f.key === k).flag) })),
    ...unmarked.map((t) => ({ t, missing: ['not marked as a bug (genlock bug)'] })),
  ];
  let changes = null;
  if (prior) {
    const before = new Set(prior.bugs);
    const fresh = bugs.filter((t) => !before.has(t.id)).map((t) => t.id);
    const freshSet = new Set(fresh);
    const priorKeys = Object.keys(prior.clusters || {});
    changes = {
      since: prior.at.slice(0, 10), path: prior.path, new_bugs: fresh,
      new_clusters: clusters.filter((c) => !prior.clusters?.[c.key]).map((c) => c.key),
      grew: clusters.filter((c) => prior.clusters?.[c.key] && c.bugs.length > prior.clusters[c.key].length)
        .map((c) => `${c.key} (${prior.clusters[c.key].length} -> ${c.bugs.length})`),
      stopped: priorKeys.filter((k) => !clusters.some((c) => c.key === k && c.bugs.some((id) => freshSet.has(id)))).sort(),
    };
  }
  return { clusters, looksSystemic, preventiveGaps, unclassified, changes };
}

function fingerprint(bugs, unmarked, since) {
  const data = bugs.map((t) => [t.id, t.status, t.title, t.bug]).concat(unmarked.map((t) => [t.id, t.title]));
  return createHash('sha256').update(JSON.stringify([since || '', data])).digest('hex').slice(0, 16);
}

function report(goal, bugs, an, drafts, since) {
  const L = [];
  const g = loadGoal(goal);
  const asOf = [...bugs, ...an.unclassified.map((u) => u.t)].map((t) => t.updated).sort().pop() || '';
  L.push(`# Bug retro: ${g.title}`, '');
  L.push(`Goal ${label(goal)}. ${bugs.length} bug ticket${bugs.length === 1 ? '' : 's'}${since ? ` closed or opened since ${since}` : ''}; records as of ${asOf.slice(0, 16).replace('T', ' ') || 'never'} UTC.`);
  L.push(`${an.clusters.length} cluster${an.clusters.length === 1 ? '' : 's'}, ${an.clusters.filter((c) => c.flagged).length} flagged for a systemic fix. Generated by \`genlock retro\`; the same records give the same report.`, '');

  L.push('## Since the last retro', '');
  if (!an.changes) L.push('This is the first retro on this goal.');
  else {
    const c = an.changes;
    L.push(`Last retro ${c.since} (${c.path}).`, '');
    L.push(`- new bugs: ${c.new_bugs.length ? c.new_bugs.join(', ') : 'none'}`);
    L.push(`- new clusters: ${c.new_clusters.length ? c.new_clusters.join(', ') : 'none'}`);
    L.push(`- clusters that grew: ${c.grew.length ? c.grew.join(', ') : 'none'}`);
    L.push(`- clusters that stopped recurring (no new bug since): ${c.stopped.length ? c.stopped.join(', ') : 'none'}`);
  }
  L.push('');

  L.push('## Bugs', '');
  if (!bugs.length) L.push('No bug tickets on this goal.');
  else {
    L.push('| ticket | status | symptom | root cause | class | system | scope | corrective | preventive |', '|---|---|---|---|---|---|---|---|---|');
    for (const t of bugs) {
      const b = t.bug;
      L.push(`| ${t.id} ${cell(shortName(t.id))} | ${t.status} | ${cell(b.symptom)} | ${cell(b.root_cause)} | ${cell(b.class)} | ${cell(b.system)} | ${cell(b.scope)} | ${cell(b.corrective)} | ${cell(b.preventive || (b.waived.preventive && `[waived] ${b.waived.preventive}`))}${b.gate ? ` (gate: ${cell(b.gate)})` : ''} |`);
    }
  }
  L.push('');

  L.push('## Clusters', '', 'Two or more bugs sharing a cause class or a system. A cluster is flagged unless every bug in it was treated as systemic and got a real preventive with a gate it runs in.', '');
  if (!an.clusters.length) L.push('None: no class or system is shared by two bugs.');
  else {
    L.push('| cluster | bugs | open | flagged | tickets |', '|---|---|---|---|---|');
    for (const c of an.clusters) L.push(`| ${c.field} ${c.name} | ${c.bugs.length} | ${c.open} | ${c.flagged ? 'yes' : 'no'} | ${c.bugs.join(', ')} |`);
  }
  L.push('');

  L.push('## One-offs that look systemic', '', 'Fixed as one-off, but the cause is shared with other bugs.', '');
  if (!an.looksSystemic.length) L.push('None.');
  for (const { t, with: w } of an.looksSystemic) L.push(`- ${t.id} ${t.title} — shares ${w.join(', ')}`);
  L.push('');

  L.push('## Preventive gaps', '', 'Closed with no check or rule that stops the kind recurring, or with one that runs nowhere a change must pass.', '');
  if (!an.preventiveGaps.length) L.push('None.');
  for (const t of an.preventiveGaps) L.push(`- ${t.id} ${t.title} — preventive: ${t.bug.preventive || '(not set)'}${ungated(t.bug) ? `; gate: ${t.bug.waived.gate ? `[waived] ${t.bug.waived.gate}` : '(none)'}` : ''}`);
  L.push('');

  L.push('## Unclassified', '', 'Missing cause fields, listed rather than guessed.', '');
  if (!an.unclassified.length) L.push('None.');
  for (const { t, missing } of an.unclassified) L.push(`- ${t.id} ${t.status} ${t.title} — missing: ${missing.join(', ')}`);
  L.push('');

  L.push('## Proposed systemic tickets', '', 'One draft per flagged cluster (one for a class and a system holding the same bugs), linked to the goal and never started. They become work when the user accepts them.', '');
  if (!drafts.length) L.push('None: no cluster is flagged.');
  for (const d of drafts) L.push(`- ${d.id} ${d.title} (${d.status}) — covers ${d.bugs.join(', ')}`);
  L.push('');
  return L.join('\n');
}

/** One draft systemic ticket per flagged cluster, reused across retros so re-running never duplicates. */
function draftsFor(goal, clusters, create) {
  const tag = `retro:${goal.toLowerCase()}`;
  const existing = allTickets().filter((t) => t.goal === goal && t.meta['retro.cluster']);
  const out = [];
  const seen = new Set();
  for (const c of clusters.filter((x) => x.flagged)) {
    // A class and a system holding the very same bugs are one cause seen twice: one draft, not two.
    const same = [...c.bugs].sort().join(',');
    if (seen.has(same)) continue;
    seen.add(same);
    let t = existing.find((x) => x.meta['retro.cluster'] === c.key);
    if (!t && create) {
      const made = openTicket({
        title: `Systemic fix for the ${c.name} ${c.field === 'class' ? 'cause class' : 'system'}, shared by several bugs`,
        ask: `A retro found ${c.bugs.length} bugs sharing ${c.key}: ${c.bugs.join(', ')}. Fix the cause at the level they share, and add the check that stops the kind recurring.`,
        draft: true, goal,
      });
      emit(made.id, 'tag', { add: [tag], remove: [], text: `tags +#${tag}` });
      emit(made.id, 'meta', { key: 'retro.cluster', value: c.key, text: `meta retro.cluster=${c.key}` });
      t = loadTicket(made.id);
    }
    if (t) out.push({ id: t.id, title: t.title, status: t.status, bugs: c.bugs });
  }
  return out;
}

export function cmdRetro(a) {
  const raw = a._[0];
  if (!raw) die('retro needs a goal:  genlock retro GOAL [--since YYYY-MM-DD] [--out PATH]');
  const goal = resolveId(raw, 'G-', 'goal');
  if (!goal) die(`no goal '${raw}' in this repository`);
  const since = a.since ? parseDue(a.since) : null;
  const inRange = (t) => !since || (t.closed || t.created).slice(0, 10) >= since;
  const bugs = goalBugs(goal).filter(inRange).sort((x, y) => x.created.localeCompare(y.created) || x.id.localeCompare(y.id));
  const unmarked = allTickets().filter((t) => !t.bug && t.goal === goal && t.status !== 'abandoned' && titledAsBug(t) && inRange(t))
    .sort((x, y) => x.created.localeCompare(y.created) || x.id.localeCompare(y.id));

  const fp = fingerprint(bugs, unmarked, since);
  const past = retrosOf(goal);
  // A re-run over unchanged records compares with the same retro the first run did, so it reads the same.
  const last = past[past.length - 1];
  const unchanged = last && last.fp === fp;
  const prior = unchanged ? past[past.length - 2] : last;
  const an = analyse(bugs, unmarked, prior);
  const drafts = draftsFor(goal, an.clusters, true);
  const body = report(goal, bugs, an, drafts, since);

  const rel = a.out ? String(a.out) : (unchanged ? last.path : path.join('docs', 'retros', `${shortName(goal)}-${new Date().toISOString().slice(0, 10)}.md`));
  const file = path.resolve(path.isAbsolute(rel) ? rel : path.join(repoRoot(), rel));
  // A reading written under the report survives a regeneration.
  let reading = '\n## Reading\n\nNot written yet. An agent or the user may add what the clusters mean here.\n';
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    const i = old.indexOf(READING_MARK);
    if (i >= 0) reading = old.slice(i + READING_MARK.length);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${body}\n${READING_MARK}\n${reading.replace(/^\n?/, '\n')}`);
  const recorded = path.relative(repoRoot(), file).replace(/\\/g, '/');

  const counts = { bugs: bugs.length, clusters: an.clusters.length, flagged: an.clusters.filter((c) => c.flagged).length,
    looks_systemic: an.looksSystemic.length, preventive_gaps: an.preventiveGaps.length, unclassified: an.unclassified.length };
  if (!unchanged) {
    emit(goal, 'retro', { path: recorded, fp, since, counts, bugs: bugs.map((t) => t.id),
      clusters: Object.fromEntries(an.clusters.map((c) => [c.key, c.bugs])) });
    emit(goal, 'ref', { path: recorded, why: `bug retro: ${counts.bugs} bugs, ${counts.clusters} clusters, ${counts.flagged} flagged for a systemic fix` });
    emit(newId('R-'), 'request', { path: recorded, why: `Bug retro for ${shortName(goal)}: are the flagged clusters real systemic causes, and which proposed systemic tickets should become work?`, about: goal });
  }
  console.log(`retro written: ${recorded}${unchanged ? '  (records unchanged since the last retro, so nothing new was recorded)' : ''}`);
  console.log(`  ${counts.bugs} bugs, ${counts.clusters} clusters (${counts.flagged} flagged), ${counts.looks_systemic} one-offs that look systemic, `
    + `${counts.preventive_gaps} preventive gaps, ${counts.unclassified} unclassified`);
  for (const d of drafts) console.log(`  proposed: ${d.id} ${d.title} (${d.status})`);
  if (drafts.length) console.log('  These are drafts. Ask the user which to take on; none is started without their yes.');
}

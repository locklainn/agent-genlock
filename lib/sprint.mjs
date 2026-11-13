/**
 * Sprint reports: what got finished, one week at a time.
 *
 * A sprint runs from one Claude weekly usage reset to the next, so a week of work lines up
 * with a week of allowance. The reset is ONE setting, `weekly_reset` in sprint.json in the
 * app's home ("thu 17:00 America/Los_Angeles"): day, time, and an IANA zone (the machine's
 * own zone when left out). Everything else is computed from it.
 *
 * The report is read from `genlock snapshot` of each project, the same document the Mac app
 * and the phone bridge already read, so all three show the same tasks for the same sprint.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { die, repoRoot, shortName, hasChosenName } from './store.mjs';
import { allTickets, summariseReqs } from './tickets.mjs';
import { allGoals } from './goals.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/genlock.mjs');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY = 24 * 3600e3;
const FORMAT = 1;

export const appHome = () => process.env.GENLOCK_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'Genlock');
export const configFile = (home = appHome()) => path.join(home, 'sprint.json');
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** "thu 17:00 America/Los_Angeles" -> { day: 4, hour: 17, minute: 0, zone }. Throws on anything else. */
export function parseReset(text) {
  const m = String(text || '').trim().match(/^([a-z]+)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+(\S+))?$/i);
  if (!m) throw new Error(`weekly_reset "${text}" is not "DAY HH:MM [ZONE]", e.g. "thu 17:00 America/Los_Angeles"`);
  const day = DAYS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (day < 0) throw new Error(`weekly_reset day "${m[1]}" is not a day of the week`);
  let hour = Number(m[2]); const minute = Number(m[3] || 0);
  if (m[4]) { if (hour < 1 || hour > 12) throw new Error(`weekly_reset hour "${m[2]}${m[4]}" is not a 12-hour time`); hour = (hour % 12) + (m[4].toLowerCase() === 'pm' ? 12 : 0); }
  if (hour > 23 || minute > 59) throw new Error(`weekly_reset time "${m[2]}:${m[3]}" is not a time of day`);
  const zone = m[5] || localZone();
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { throw new Error(`weekly_reset zone "${zone}" is not an IANA time zone`); }
  return { day, hour, minute, zone };
}

/** The setting as recorded, or null when nobody has set it yet. */
export function readReset(home = appHome()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configFile(home), 'utf8')).weekly_reset; } catch { return null; }
  return raw ? { text: raw, ...parseReset(raw) } : null;
}

// Until TJ says when his week resets, sprints are cut at this and every report says so.
const PROVISIONAL = 'mon 00:00';

/* ---- time zones, with nothing but Intl ------------------------------------------------ */

/** The wall clock in ZONE at instant MS: { y, mo, d, h, mi, dow }. */
function wall(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute, s: +parts.second, dow: DAYS.indexOf(parts.weekday.slice(0, 3).toLowerCase()) };
}
const offset = (ms, zone) => { const w = wall(ms, zone); return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000; };

/** The instant the wall clock in ZONE reads y-mo-d h:mi. Day overflow (d = 35) rolls over. */
export function zoned(y, mo, d, h, mi, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offset(guess, zone);
  return guess - offset(first, zone);
}

/* ---- sprints -------------------------------------------------------------------------- */

const ymd = (ms, zone) => { const w = wall(ms, zone); return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (ms, zone) => { const w = wall(ms, zone); return `${MONTHS[w.mo - 1]} ${w.d}`; };

/**
 * The sprint OFFSET weeks from the one holding NOW (0 = current, -1 = the last one), as
 * { id, start, end, label }. id is the date it starts on; start and end are ISO instants and
 * end is the next reset, so sprints tile with no gap or overlap, across DST changes too.
 */
// Labels read in the viewer's own clock (the Mac's zone), whatever zone the reset is set in.
const displayZone = () => process.env.GENLOCK_DISPLAY_ZONE || localZone();

export function sprintAt(now, reset, off = 0, shown = displayZone()) {
  const w = wall(now, reset.zone);
  let back = (w.dow - reset.day + 7) % 7;
  if (back === 0 && (w.h * 60 + w.mi) < (reset.hour * 60 + reset.minute)) back = 7;
  const d0 = w.d - back + 7 * off;
  const start = zoned(w.y, w.mo, d0, reset.hour, reset.minute, reset.zone);
  const end = zoned(w.y, w.mo, d0 + 7, reset.hour, reset.minute, reset.zone);
  return { id: ymd(start, reset.zone), start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: `${short(start, shown)} – ${short(end - 1, shown)}`, offset: off };
}

/** Which sprint a selector names: current, previous, -N, or any date inside it (YYYY-MM-DD). */
export function pickSprint(sel, now, reset) {
  const s = String(sel ?? 'current').trim().toLowerCase();
  if (s === 'current' || s === '' || s === '0') return sprintAt(now, reset, 0);
  if (s === 'previous' || s === 'last') return sprintAt(now, reset, -1);
  if (/^-\d+$/.test(s)) return sprintAt(now, reset, Number(s));
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`sprint "${sel}" is not current, previous, -N or a date (YYYY-MM-DD)`);
  // Noon on that day, so the sprint containing the day is found whatever the reset time.
  const at = zoned(+m[1], +m[2], +m[3], 12, 0, reset.zone);
  const off = Math.round((Date.parse(sprintAt(at, reset).start) - Date.parse(sprintAt(now, reset).start)) / (7 * DAY));
  return sprintAt(now, reset, off);
}

/** An arbitrary range of whole days, FROM's midnight to the end of TO, in the reset's zone. */
export function dateRange(from, to, reset) {
  const p = (s, name) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) throw new Error(`--${name} "${s}" is not YYYY-MM-DD`); return [+m[1], +m[2], +m[3]]; };
  const [fy, fm, fd] = p(from, 'from');
  const [ty, tm, td] = p(to || from, 'to');
  const start = zoned(fy, fm, fd, 0, 0, reset.zone);
  const end = zoned(ty, tm, td + 1, 0, 0, reset.zone);
  if (end <= start) throw new Error(`--to ${to} is before --from ${from}`);
  return { id: `${ymd(start, reset.zone)}..${ymd(end - 1, reset.zone)}`, start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: `${short(start, reset.zone)} – ${short(end - 1, reset.zone)}`, offset: null };
}

/* ---- the report ------------------------------------------------------------------------ */

/** A goal or task's name as the Mac shows it: its short name in words, else its title. */
const heading = (x) => {
  if (!x.short || x.named === false) return x.title;
  const w = String(x.short).replace(/-/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const within = (iso, r) => !!iso && iso >= r.start && iso < r.end;

/**
 * What each project finished inside RANGE, from snapshot documents [{ name, path, snap }]:
 * done tasks grouped under their goals, and goals the user closed. Newest first.
 */
export function buildReport(projects, range) {
  const out = projects.map(({ name, path: root, snap }) => {
    const goals = snap?.goals || [];
    const tasks = (snap?.tickets || []).filter((t) => t.status === 'done' && within(t.closed, range))
      .sort((a, b) => b.closed.localeCompare(a.closed))
      .map((t) => {
        const g = goals.find((x) => x.id === t.goal);
        return { id: t.id, name: heading(t), title: t.title, closed: t.closed, proof: t.summary || null,
          goal: g ? { id: g.id, name: heading(g), title: g.title } : null };
      });
    const goalsDone = goals.filter((g) => g.status === 'done' && within(g.completed_at, range))
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
      .map((g) => ({ id: g.id, name: heading(g), title: g.title, completed_at: g.completed_at }));
    return { name, path: root, tasks, goals_done: goalsDone };
  });
  return out.filter((p) => p.tasks.length || p.goals_done.length);
}

/** The app's projects, or just this repository. */
function projectsFor(all, home) {
  if (!all) return [{ name: path.basename(repoRoot()), path: repoRoot() }];
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')); } catch {}
  return list.filter((p) => p?.path && fs.existsSync(p.path)).map((p) => ({ name: path.basename(p.path), path: p.path }));
}

/**
 * Only what the report reads: goals and tickets with their names and when they closed. Not
 * `genlock snapshot`, which also works out every session's follow-ups and took 8s on a busy
 * project; this is a plain read of the records.
 */
export function records() {
  const name = (x) => ({ short: shortName(x.id), named: hasChosenName(x.id) });
  return {
    goals: allGoals().map((g) => ({ id: g.id, ...name(g), title: g.title, status: g.status, completed_at: g.completed_at || null })),
    tickets: allTickets().filter((t) => t.status === 'done')
      .map((t) => ({ id: t.id, ...name(t), title: t.title, status: t.status, closed: t.closed, goal: t.goal, summary: summariseReqs(t) })),
  };
}

/** Each project's records, read by its own genlock process, all at once. */
function recordsOf(root) {
  const env = { ...process.env };
  delete env.GENLOCK_SESSION;
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'sprint', '--records'], { cwd: root, env, timeout: 20000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

/** The whole document the phone and the Mac show: the range, its report, and the picker's sprints. */
export async function sprintDocument({ all = false, sprint, from, to, weeks = 12, home = appHome(), now = Date.now(), snap = recordsOf } = {}) {
  const set = readReset(home);
  const reset = set || { text: PROVISIONAL, ...parseReset(PROVISIONAL) };
  const range = from || to ? dateRange(from, to, reset) : pickSprint(sprint, now, reset);
  const projects = await Promise.all(projectsFor(all, home).map(async (p) => ({ ...p, snap: await snap(p.path) })));
  const count = (r) => buildReport(projects, r).reduce((n, p) => n + p.tasks.length, 0);
  const sprints = Array.from({ length: weeks }, (_, i) => sprintAt(now, reset, -i)).map((s) => ({ ...s, done: count(s) }));
  const report = buildReport(projects, range);
  return {
    format: FORMAT,
    reset: { text: reset.text, confirmed: !!set, day: DAYS[reset.day], hour: reset.hour, minute: reset.minute, zone: reset.zone },
    range: { ...range, kind: from || to ? 'dates' : 'sprint', current: range.offset === 0 },
    totals: { tasks: report.reduce((n, p) => n + p.tasks.length, 0), goals: report.reduce((n, p) => n + p.goals_done.length, 0) },
    projects: report,
    sprints,
  };
}

/* ---- the command ----------------------------------------------------------------------- */

export async function cmdSprint(a) {
  if (a.records) { console.log(JSON.stringify(records())); return; }
  const home = appHome();
  if (a.set_reset !== undefined) {
    let r;
    try { r = parseReset(a.set_reset); } catch (e) { die(e.message); }
    fs.mkdirSync(home, { recursive: true });
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(configFile(home), 'utf8')); } catch {}
    const text = `${DAYS[r.day]} ${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')} ${r.zone}`;
    fs.writeFileSync(configFile(home), `${JSON.stringify({ ...cur, weekly_reset: text }, null, 2)}\n`);
    const s = sprintAt(Date.now(), { text, ...r });
    console.log(`Sprints now start ${text}. This one: ${s.label} (${s.start} -> ${s.end}).`);
    return;
  }
  let doc;
  try {
    doc = await sprintDocument({ all: !!a.all, sprint: a.sprint ?? a._[0], from: a.from, to: a.to, weeks: a.weeks ? Number(a.weeks) : 12, home });
  } catch (e) { die(e.message); }
  if (a.json) { console.log(JSON.stringify(doc)); return; }

  const what = doc.range.kind === 'dates' ? `${doc.range.label}` : `Sprint ${doc.range.label}${doc.range.current ? ' (current)' : ''}`;
  console.log(`${what}: ${doc.totals.tasks} task${doc.totals.tasks === 1 ? '' : 's'} done${doc.totals.goals ? `, ${doc.totals.goals} goal${doc.totals.goals === 1 ? '' : 's'} closed` : ''}`);
  if (!doc.reset.confirmed) console.log(`  (weekly reset not set, so sprints start ${PROVISIONAL} ${doc.reset.zone}: genlock sprint --set-reset "DAY HH:MM ZONE")`);
  for (const p of doc.projects) {
    console.log(`\n${p.name}`);
    for (const g of p.goals_done) console.log(`  goal closed  ${g.name}  ${g.completed_at.slice(0, 10)}`);
    const byGoal = new Map();
    for (const t of p.tasks) { const k = t.goal?.name || 'No goal'; if (!byGoal.has(k)) byGoal.set(k, []); byGoal.get(k).push(t); }
    for (const [g, ts] of byGoal) {
      console.log(`  ${g}`);
      for (const t of ts) console.log(`    ${t.closed.slice(0, 10)}  ${t.name}${t.name !== t.title ? ` -- ${t.title}` : ''}`);
    }
  }
  if (doc.range.kind === 'sprint') {
    console.log('\nRecent sprints:');
    for (const s of doc.sprints.slice(0, 6)) console.log(`  ${s.offset === 0 ? 'current ' : String(s.offset).padEnd(8)} ${s.label.padEnd(16)} ${s.done} done`);
  }
}

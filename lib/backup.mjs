/**
 * Backups of goals and tasks: one archive that can be put back.
 *
 *   genlock backup [--all] [--out DIR]
 *   genlock restore ARCHIVE [--project NAME] [--into DIR] [--force]
 *
 * An archive is a gzipped tar holding manifest.json and, for each project, NAME/.genlock/ exactly
 * as it is on disk. --all takes every project in the Genlock app (projects.json), which is what
 * the phone's Back up button asks for. Archives go to ~/genlock-backups unless --out says.
 *
 * Restore never overwrites records silently: a target that already has records is refused unless
 * --force, and --force backs those records up first, so a restore is itself undoable.
 * Archives with .genlock/ at the top (the hand-made one from 2026-11-13) restore too.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { die, repoRoot } from './store.mjs';
import { appHome } from './sprint.mjs';

const FORMAT = 1;
export const backupDir = () => process.env.GENLOCK_BACKUP_DIR || path.join(os.homedir(), 'genlock-backups');

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function tar(args, cwd) {
  const r = spawnSync('tar', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`tar ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

/** Every file under DIR, as paths relative to it. */
function filesUnder(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

/** The app's projects that have records, or just this repository. Names are unique inside one archive. */
function projectsToSave(all, home, root) {
  let list;
  if (all) {
    let raw = [];
    try { raw = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')); } catch {}
    list = raw.filter((p) => p?.path && fs.existsSync(path.join(p.path, '.genlock'))).map((p) => p.path);
    if (!list.length) throw new Error(`no projects with records in ${path.join(home, 'projects.json')}`);
  } else {
    if (!fs.existsSync(path.join(root, '.genlock'))) throw new Error(`no .genlock/ in ${root}: nothing to back up`);
    list = [root];
  }
  const seen = new Map();
  return [...new Set(list)].map((root) => {
    const base = path.basename(root).replace(/[^\w.\-]+/g, '_') || 'project';
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { name: n === 1 ? base : `${base}-${n}`, path: root };
  });
}

/** Writes one archive and returns { file, projects: [{ name, path, files }] }. */
export function backup({ all = false, root = repoRoot(), out = backupDir(), home = appHome(), now = new Date() } = {}) {
  const projects = projectsToSave(all, home, path.resolve(root));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-backup-'));
  try {
    for (const p of projects) {
      const dest = path.join(stage, p.name, '.genlock');
      fs.cpSync(path.join(p.path, '.genlock'), dest, { recursive: true });
      p.files = filesUnder(dest).length;
      p.records = filesUnder(path.join(dest, 'records')).length;
    }
    const manifest = { format: FORMAT, created: now.toISOString(), host: os.hostname(), projects };
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.mkdirSync(out, { recursive: true });
    const label = all ? 'genlock-all' : `${projects[0].name}-genlock`;
    let file = path.join(out, `${label}-${stamp(now)}.tar.gz`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(out, `${label}-${stamp(now)}-${i}.tar.gz`);
    tar(['-czf', file, 'manifest.json', ...projects.map((p) => p.name)], stage);
    return { file, bytes: fs.statSync(file).size, projects };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** The projects inside an extracted archive: { name, dir } where dir holds .genlock/. */
function projectsIn(dir) {
  if (fs.existsSync(path.join(dir, '.genlock', 'records'))) return [{ name: null, dir }];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.genlock', 'records')))
    .map((e) => ({ name: e.name, dir: path.join(dir, e.name) }));
}

/** Lists what an archive holds, without touching anything. */
export function inspect(archive) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-restore-'));
  try {
    tar(['-xzf', path.resolve(archive), '-C', tmp]);
    return projectsIn(tmp).map((p) => ({ name: p.name, records: filesUnder(path.join(p.dir, '.genlock', 'records')).length }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * Puts one project's .genlock/ from ARCHIVE into INTO. Returns { into, name, records, savedFirst }.
 * Throws with code 'EXISTS' when INTO already has records and force is not set.
 */
export function restore(archive, { into = repoRoot(), project, force = false, out = backupDir() } = {}) {
  if (!fs.existsSync(archive)) throw new Error(`no archive at ${archive}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genlock-restore-'));
  try {
    tar(['-xzf', path.resolve(archive), '-C', tmp]);
    const found = projectsIn(tmp);
    if (!found.length) throw new Error(`${archive} holds no .genlock/records: not a genlock backup`);
    const target = path.basename(path.resolve(into));
    const pick = project ? found.find((p) => p.name === project)
      : found.length === 1 ? found[0]
      : found.find((p) => p.name === target);
    if (!pick) {
      throw new Error(`${project ? `no project "${project}" in` : 'more than one project in'} ${archive}; choose one with --project: `
        + found.map((p) => p.name).join(', '));
    }
    const dest = path.join(into, '.genlock');
    const existing = filesUnder(path.join(dest, 'records')).length;
    let savedFirst = null;
    if (existing) {
      if (!force) {
        const e = new Error(`${dest} already holds ${existing} records. Nothing was changed. Add --force to replace them; `
          + 'they are backed up first.');
        e.code = 'EXISTS';
        throw e;
      }
      savedFirst = backup({ root: into, out }).file;
      fs.rmSync(path.join(dest, 'records'), { recursive: true, force: true });
    }
    fs.mkdirSync(into, { recursive: true });
    fs.cpSync(path.join(pick.dir, '.genlock'), dest, { recursive: true });
    const records = filesUnder(path.join(dest, 'records')).length;
    const expected = filesUnder(path.join(pick.dir, '.genlock', 'records')).length;
    if (records !== expected) throw new Error(`restored ${records} records but the archive holds ${expected}`);
    return { into: path.resolve(into), name: pick.name, records, savedFirst };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- commands */

export function cmdBackup(a) {
  let r;
  try { r = backup({ all: !!a.all, ...(a.out ? { out: path.resolve(a.out) } : {}) }); } catch (e) { die(e.message); }
  if (a.json) { console.log(JSON.stringify(r)); return; }
  const n = r.projects.reduce((s, p) => s + p.records, 0);
  console.log(`backed up ${n} records from ${r.projects.length} project${r.projects.length === 1 ? '' : 's'} to ${r.file}`);
  if (r.projects.length > 1) for (const p of r.projects) console.log(`  ${p.name}  ${p.records} records  (${p.path})`);
  console.log(`put back with: genlock restore ${r.file}${r.projects.length > 1 ? ' --project NAME' : ''}`);
}

export function cmdRestore(a) {
  const archive = a._[0];
  if (!archive) die('usage: genlock restore ARCHIVE [--project NAME] [--into DIR] [--force]  |  genlock restore ARCHIVE --list');
  if (a.list) {
    try { for (const p of inspect(archive)) console.log(`  ${p.name || '(this project)'}  ${p.records} records`); } catch (e) { die(e.message); }
    return;
  }
  let r;
  try {
    r = restore(archive, { ...(a.into ? { into: path.resolve(a.into) } : {}), project: a.project, force: !!a.force });
  } catch (e) {
    if (e.code === 'EXISTS') { console.error(e.message); process.exit(4); }
    die(e.message);
  }
  if (r.savedFirst) console.log(`the records that were there are saved in ${r.savedFirst}`);
  console.log(`restored ${r.records} records${r.name ? ` of ${r.name}` : ''} into ${path.join(r.into, '.genlock')}`);
}

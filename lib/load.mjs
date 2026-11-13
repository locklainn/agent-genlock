import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * `genlock load`: how pressured the Mac is, as the Mac app last read it (load.json, every 5 s
 * while its load panel is on), and the two things agents can ask of its load alerts.
 */
const METRICS = ['cpu', 'memory', 'battery', 'session', 'weekly'];

// Beside the app's session channels: a session's own channel's parent, else the app's default.
export function loadBase() {
  if (process.env.GENLOCK_APP_VOICE_BASE) return process.env.GENLOCK_APP_VOICE_BASE;
  if (process.env.GENLOCK_APP_CHANNEL) return path.dirname(process.env.GENLOCK_APP_CHANNEL);
  const home = process.env.GENLOCK_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'Genlock');
  return path.join(home, 'voice');
}

const die = (msg) => { console.error(msg); process.exit(1); };

export function cmdLoad(a) {
  const [sub, metric] = a._;
  const base = loadBase();
  if (sub === 'snooze' || sub === 'test') {
    if (!METRICS.includes(metric)) die(`genlock load ${sub} needs one of: ${METRICS.join(', ')}`);
    request(base, { op: sub, metric });
    console.log(sub === 'snooze'
      ? `${metric} snoozed: no alert for it until it clears. The app applies it within 5 seconds.`
      : `Test alert for ${metric} queued: the app sends it within 5 seconds, if load alerts are on.`);
    return;
  }
  if (sub) die('usage: genlock load [--json] | genlock load snooze METRIC | genlock load test METRIC');
  const reading = readJSON(path.join(base, 'load.json'));
  const usage = readJSON(path.join(base, 'usage.json'));
  if (a.json) { console.log(JSON.stringify({ load: reading, usage })); return; }
  if (!reading) { console.log('No load reading: the Genlock app is not running, or its System Load panel is off.'); }
  else console.log(describe(reading));
  if (usage) console.log(describeUsage(usage));
}

function request(base, req) {
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, 'load-requests.json');
  let list = readJSON(file);
  if (!Array.isArray(list)) list = [];
  list.push(req);
  const tmp = path.join(base, `load-requests.${process.pid}.${randomBytes(3).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(list));
  fs.renameSync(tmp, file);
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const pct = (v) => `${Math.round(v)}%`;

export function describe(r) {
  const age = Math.round((Date.now() - r.at) / 1000);
  const lines = [`Mac load, read ${age < 60 ? `${age}s` : `${Math.round(age / 60)} min`} ago:`];
  if (r.cpu != null) lines.push(`  CPU ${pct(r.cpu)} of ${r.cores} cores, load average ${r.loadAverage.toFixed(1)}`);
  if (r.memoryPressure != null) {
    const level = { 1: 'normal', 2: 'warning', 4: 'critical' }[r.pressureLevel] || 'unknown';
    lines.push(`  Memory pressure ${pct(r.memoryPressure)} (${level})${r.swapUsedMB != null ? `, ${(r.swapUsedMB / 1024).toFixed(1)} GB swapped` : ''}`);
  }
  if (r.battery) {
    const b = r.battery;
    const state = b.charging ? 'charging' : b.onAC ? 'on power, not charging' : 'on battery';
    const w = b.drainWatts;
    lines.push(`  Battery ${pct(b.level)}, ${state}${w != null && Math.abs(w) >= 0.1 ? (w > 0 ? `, draining ${w.toFixed(1)} W` : `, charging at ${(-w).toFixed(1)} W`) : ''}`);
  }
  return lines.join('\n');
}

function describeUsage(u) {
  const bar = (name, b) => b && b.used != null ? `  ${name} ${pct(b.used)} used` : null;
  return ['Claude limits:', bar('5-hour', u.session), bar('weekly', u.weekly)].filter(Boolean).join('\n');
}

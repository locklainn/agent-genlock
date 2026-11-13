// The phone's Back up button: a "backup" message makes the bridge run `genlock backup --all` and
// send the archive back as "backup-file" chunks, which put back together are the archive itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../bridge.mjs';
import { Assembler } from '../files.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin/genlock.mjs');
const waitFor = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

test('Back up sends every project\'s records to the phone as one archive', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gl-backup-home-')));
  const out = path.join(home, 'backups');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  const env = { ...process.env, HOME: home, GENLOCK_HOME: home, GENLOCK_TERMINAL: 'print', GENLOCK_AGENT_PID: '0', GENLOCK_SESSION: 'backup-test' };
  delete env.GENLOCK_APP_CHANNEL; delete env.CLAUDE_CODE_SESSION_ID;
  spawnSync('git', ['init', '-q'], { cwd: proj });
  const made = spawnSync(process.execPath, [CLI, 'new', 'Ship the widget', '-r', 'The widget renders on the page', '-c', 'manual: open it'], { cwd: proj, env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ path: proj }]));
  fs.writeFileSync(path.join(home, 'sessions.json'), '{"open":[]}');

  const sent = [];
  let sock;
  class FakeSocket {
    constructor() { sock = this; this.readyState = 1; setTimeout(() => this.onopen?.(), 0); }
    send(s) { sent.push(JSON.parse(s)); }
    close() {}
  }
  const prevOut = process.env.GENLOCK_BACKUP_DIR;
  process.env.GENLOCK_BACKUP_DIR = out;
  const bridge = startBridge({ relay: 'http://127.0.0.1:1', room: 'ab'.repeat(16), secret: 'cd'.repeat(32) }, { home, snap: async () => ({}), pollMs: 50, WebSocketImpl: FakeSocket, speak: null });
  try {
    await waitFor(() => sock);
    const id = crypto.randomUUID();
    sock.onmessage({ data: JSON.stringify({ id, t: Date.now(), kind: 'backup' }) });
    const asm = new Assembler();
    const whole = await waitFor(() => {
      for (const m of sent.splice(0)) if (m.kind === 'backup-file' && m.of === id) { const w = asm.add(m); if (w) return w; }
      return null;
    });
    assert.match(whole.name, /^genlock-all-.*\.tar\.gz$/);
    assert.match(whole.caption, /records from 1 project/);
    const onMac = path.join(out, whole.name);
    assert.ok(fs.existsSync(onMac), 'a copy stays on the Mac');
    assert.ok(whole.buf.equals(fs.readFileSync(onMac)), 'the phone gets the same bytes');
    const list = spawnSync('tar', ['tzf', onMac], { encoding: 'utf8' }).stdout;
    assert.match(list, /proj\/\.genlock\/records\/T-.+\.jsonl/);
  } finally {
    bridge.stop();
    if (prevOut === undefined) delete process.env.GENLOCK_BACKUP_DIR; else process.env.GENLOCK_BACKUP_DIR = prevOut;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
